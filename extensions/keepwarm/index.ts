/**
 * keepwarm — session-scoped prompt-cache keep-alive for pi.
 *
 *   /keepwarm                  toggle; turning on uses the defaults from keepwarm.json
 *   /keepwarm on [5h|forever] [$20|nocap]
 *                              turn on; given limits override the configured defaults.
 *                              While on: update only the given limits (duration counts from now)
 *   /keepwarm off              turn off
 *   /keepwarm status           show state
 *   /keepwarm config           show the config file path and effective defaults
 *
 * Defaults live in `<agentDir>/keepwarm.json` (created on first session start):
 *   autoStart, duration, maxCost, maxRetries — see config.ts.
 *
 * How it works: every real provider request of the session is captured in
 * `before_provider_request`. While on and the agent is idle, shortly before
 * the cache entry expires the last captured payload is re-sent byte-for-byte
 * with a minimal output cap, which reads (and thereby refreshes) the cached
 * prefix without changing it. Nothing enters the conversation context.
 *
 * Refreshes only happen while idle (between `agent_settled` and the next
 * `agent_start`). The schedule is anchored to the start of the last request
 * that touched the cache, because provider TTLs run from request start.
 * During a run, pi's built-in `cacheWarming: "streaming"` (the default)
 * covers long tool calls.
 *
 * Env overrides (for testing): PI_KEEPWARM_TTL_SEC, PI_KEEPWARM_EVERY_SEC.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureConfigFile, type KeepwarmConfig, loadConfig, parseDuration } from "./config.ts";
import { detectTtl, isWarmReplay, type Retention, refreshDelayMs, SUPPORTED_APIS, warmPayload } from "./payload.ts";

const STATUS_KEY = "keepwarm";
const RETRY_DELAY_MS = 15_000;
const USAGE = "usage: /keepwarm [on [5h|forever] [$20|nocap] | off | status | config]";

type Captured = {
	payload: Record<string, unknown>;
	model: any;
	ttlMs: number;
	retention: Retention;
};

type State = {
	enabled: boolean;
	until: number;
	maxCost: number | undefined;
	maxRetries: number;
	last: Captured | undefined;
	lastTouch: number;
	running: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
	nextAt: number;
	inflight: AbortController | undefined;
	warms: number;
	misses: number;
	failures: number;
	cost: number;
	ctx: ExtensionContext | undefined;
	note: string | undefined;
};

function freshState(): State {
	return {
		enabled: false,
		until: 0,
		maxCost: undefined,
		maxRetries: 2,
		last: undefined,
		lastTouch: 0,
		running: false,
		timer: undefined,
		nextAt: 0,
		inflight: undefined,
		warms: 0,
		misses: 0,
		failures: 0,
		cost: 0,
		ctx: undefined,
		note: undefined,
	};
}

type Limits = { durationMs: number; maxCost: number | undefined; maxRetries: number };

function limitsFromConfig(c: KeepwarmConfig): Limits {
	return {
		durationMs: parseDuration(c.duration) ?? 2 * 60 * 60_000,
		maxCost: c.maxCost ?? undefined,
		maxRetries: c.maxRetries,
	};
}

// ---------- formatting ----------

function fmtDollars(v: number): string {
	return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}
function fmtClock(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDur(ms: number): string {
	if (ms === Infinity) return "forever";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.round(ms / 60_000);
	return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${m}m`;
}

export default function keepwarm(pi: ExtensionAPI) {
	let s = freshState();

	// ---------- UI ----------

	const setStatus = () => {
		const ctx = s.ctx;
		if (!ctx?.hasUI) return;
		try {
			if (!s.enabled) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const next = s.running
				? "\u23f3 active"
				: s.inflight
					? "refreshing\u2026"
					: s.timer
						? `next ${fmtClock(s.nextAt)}`
						: (s.note ?? "waiting for a request");
			const spent = s.maxCost !== undefined ? `${fmtDollars(s.cost)}/${fmtDollars(s.maxCost)}` : fmtDollars(s.cost);
			const until = s.until === Infinity ? "" : ` \u00b7 until ${fmtClock(s.until)}`;
			ctx.ui.setStatus(STATUS_KEY, `\ud83d\udd25 keepwarm \u00b7 ${next} \u00b7 ${s.warms}\u00d7 ${spent}${until}`);
		} catch {
			// UI may be gone after session replacement.
		}
	};

	const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			s.ctx?.ui.notify(`keepwarm: ${msg}`, level);
		} catch {}
	};

	const limitsText = (): string => {
		const time = s.until === Infinity ? "no time limit" : `until ${fmtClock(s.until)}`;
		const cap = s.maxCost !== undefined ? `cap ${fmtDollars(s.maxCost)} (spent ${fmtDollars(s.cost)})` : "no cost cap";
		return `${time}, ${cap}`;
	};

	// ---------- scheduling ----------

	const clearTimer = () => {
		if (s.timer) clearTimeout(s.timer);
		s.timer = undefined;
	};

	const disable = (reason?: string, level: "info" | "warning" = "info") => {
		const wasOn = s.enabled;
		clearTimer();
		s.inflight?.abort();
		s.inflight = undefined;
		s.enabled = false;
		setStatus();
		if (wasOn && reason) notify(`off \u2014 ${reason} (${s.warms} refreshes, ${fmtDollars(s.cost)})`, level);
	};

	const armAt = (at: number) => {
		clearTimer();
		s.nextAt = at;
		s.timer = setTimeout(() => void refresh(), Math.max(0, at - Date.now()));
		(s.timer as any).unref?.();
		s.note = undefined;
		setStatus();
	};

	/** Arm the next refresh from the last cache touch. Only while idle. */
	const schedule = () => {
		clearTimer();
		if (!s.enabled || !s.last || s.running) {
			setStatus();
			return;
		}
		armAt(s.lastTouch + refreshDelayMs(s.last.ttlMs));
	};

	/** Forget the captured request: the next real request re-arms warming. */
	const invalidate = (why: string) => {
		s.last = undefined;
		clearTimer();
		s.inflight?.abort();
		s.note = `paused: ${why}`;
		setStatus();
	};

	/** Count a failed refresh; stop after maxRetries in a row, otherwise retry or re-arm. */
	const recordFailure = (why: string, last: Captured, retry: boolean) => {
		s.failures++;
		if (s.failures >= s.maxRetries) {
			disable(`${s.failures} consecutive failed refreshes (last: ${why})`, "warning");
			return;
		}
		if (!retry) {
			notify(`${why} (${s.failures}/${s.maxRetries})`, "warning");
			schedule();
			return;
		}
		const retryAt = Date.now() + RETRY_DELAY_MS;
		if (retryAt < s.lastTouch + last.ttlMs - 5_000) {
			notify(`refresh failed (${s.failures}/${s.maxRetries}): ${why}; retrying in ${fmtDur(RETRY_DELAY_MS)}`, "warning");
			armAt(retryAt);
		} else {
			notify(`refresh failed (${s.failures}/${s.maxRetries}): ${why}; cache will expire, re-arms on next message`, "warning");
			invalidate("last refresh failed");
		}
	};

	const refresh = async () => {
		s.timer = undefined;
		const last = s.last;
		const ctx = s.ctx;
		if (!s.enabled || !last || !ctx) return;
		// Never refresh during a run; agent_settled re-arms from the latest touch.
		if (s.running || !ctx.isIdle()) {
			setStatus();
			return;
		}

		if (Date.now() >= s.until) return disable("time limit reached");
		if (s.maxCost !== undefined && s.cost >= s.maxCost) return disable(`cost cap ${fmtDollars(s.maxCost)} reached`);

		const cur = ctx.model;
		if (!cur || cur.provider !== last.model.provider || cur.id !== last.model.id) {
			return invalidate("model changed");
		}
		// Too late (machine asleep, or the last response streamed longer than the TTL): the
		// entry is probably gone and a refresh would be a full-price cache write.
		if (Date.now() - s.lastTouch > last.ttlMs - 3_000) {
			s.last = undefined;
			s.note = "cache expired; re-arms on next message";
			setStatus();
			notify("cache likely expired before a refresh was possible; will re-arm after next message", "warning");
			return;
		}

		const api = String(last.model.api);
		const payload = warmPayload(api, last.payload);
		const controller = new AbortController();
		s.inflight = controller;
		const sentAt = Date.now();
		setStatus();
		try {
			const msg: any = await ctx.modelRegistry
				.streamSimple(
					last.model,
					{ systemPrompt: "", messages: [{ role: "user", content: "keepwarm", timestamp: sentAt }] } as any,
					{
						maxTokens: 1,
						maxRetries: 0, // keepwarm counts and retries failures itself
						signal: controller.signal,
						sessionId: ctx.sessionManager.getSessionId(),
						cacheRetention: last.retention,
						onPayload: () => payload,
					} as any,
				)
				.result();
			// Superseded by a real request, turned off, or shutting down.
			if (controller.signal.aborted || s.inflight !== controller || s.last !== last) return;
			s.inflight = undefined;
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				recordFailure(msg.errorMessage ?? msg.stopReason, last, true);
				return;
			}
			const u = msg.usage ?? {};
			const c = Number(u.cost?.total ?? 0);
			s.warms++;
			s.cost += c;
			s.lastTouch = sentAt;
			pi.appendEntry("keepwarm", {
				provider: msg.provider,
				model: msg.responseModel ?? msg.model,
				usage: u,
			});
			if (!(u.cacheRead > 0) && u.cacheWrite > 0) {
				// The refresh rewrote the cache instead of reading it. The entry is warm again, but
				// repeated misses mean the replay doesn't match; count toward maxRetries.
				s.misses++;
				recordFailure(`cache miss \u2014 rewrote ${u.cacheWrite} tokens (${fmtDollars(c)})`, last, false);
				return;
			}
			s.failures = 0;
			schedule();
		} catch (err) {
			if (controller.signal.aborted || s.inflight !== controller) return;
			s.inflight = undefined;
			recordFailure((err as Error)?.message ?? String(err), last, true);
		} finally {
			if (s.inflight === controller) s.inflight = undefined;
			setStatus();
		}
	};

	// ---------- on / off / update ----------

	const enable = (ctx: ExtensionContext, limits: Limits, auto = false) => {
		s.ctx = ctx;
		s.enabled = true;
		s.until = limits.durationMs === Infinity ? Infinity : Date.now() + limits.durationMs;
		s.maxCost = limits.maxCost;
		s.maxRetries = limits.maxRetries;
		s.failures = 0;
		s.running = !ctx.isIdle();
		if (s.maxCost !== undefined && s.cost >= s.maxCost) {
			s.enabled = false;
			notify(`cap ${fmtDollars(s.maxCost)} is not above the ${fmtDollars(s.cost)} already spent in this session`, "warning");
			return;
		}
		const model = ctx.model;
		if (model && !SUPPORTED_APIS.has(String(model.api))) {
			s.note = `api ${model.api} not supported`;
			if (!auto) notify(`current model api "${model.api}" is not supported; will warm once a supported model is used`, "warning");
		}
		if (s.last && Date.now() - s.lastTouch > s.last.ttlMs - 3_000) {
			s.last = undefined; // already expired; nothing to keep warm yet
			s.note = "cache already cold; arms on next message";
		}
		schedule();
		if (auto) return; // status bar is enough for auto-start
		const ttl = s.last
			? `TTL ${fmtDur(s.last.ttlMs)}, refresh every ${fmtDur(refreshDelayMs(s.last.ttlMs))}`
			: "arms on next message";
		notify(`on \u2014 ${limitsText()} (${ttl})`);
		if (s.until === Infinity && s.maxCost === undefined) notify("no time limit and no cost cap: runs until /keepwarm off", "warning");
	};

	/** Change limits of an active keepwarm without resetting its schedule. */
	const update = (durationMs: number | undefined, maxCost: number | null | undefined) => {
		if (durationMs !== undefined) s.until = durationMs === Infinity ? Infinity : Date.now() + durationMs;
		if (maxCost !== undefined) s.maxCost = maxCost ?? undefined;
		setStatus();
		notify(`updated \u2014 ${limitsText()}`);
		if (s.maxCost !== undefined && s.cost >= s.maxCost) disable(`cost cap ${fmtDollars(s.maxCost)} already reached`);
	};

	const loadDefaults = (): Limits => {
		const { config, errors } = loadConfig();
		if (errors.length) notify(`config: ${errors.join("; ")}`, "warning");
		return limitsFromConfig(config);
	};

	const statusText = (): string => {
		const lines = [`keepwarm: ${s.enabled ? "ON" : "off"}`];
		if (s.enabled) {
			lines.push(`  ${limitsText()}`);
			lines.push(`  agent ${s.running ? "running (refreshes paused)" : "idle"}`);
		}
		if (s.last) {
			lines.push(`  tracking ${s.last.model.provider}/${s.last.model.id}, ${s.last.retention} retention, TTL ${fmtDur(s.last.ttlMs)}`);
			lines.push(`  last cache touch ${fmtClock(s.lastTouch)}${s.timer ? `, next refresh ${fmtClock(s.nextAt)}` : ""}`);
		} else lines.push(`  no request captured${s.note ? ` (${s.note})` : ""}`);
		lines.push(`  ${s.warms} refreshes (${s.misses} misses), ${fmtDollars(s.cost)} spent`);
		lines.push(`  consecutive failures ${s.failures}/${s.maxRetries}`);
		return lines.join("\n");
	};

	const configText = (): string => {
		const { config, path, errors } = loadConfig();
		const lines = [
			`keepwarm config: ${path}`,
			`  autoStart  ${config.autoStart}`,
			`  duration   ${config.duration}`,
			`  maxCost    ${config.maxCost === null ? "null (no cap)" : fmtDollars(config.maxCost)}`,
			`  maxRetries ${config.maxRetries}`,
		];
		if (errors.length) lines.push(`  errors: ${errors.join("; ")}`);
		lines.push("Edit the file; changes apply to the next /keepwarm and to new sessions.");
		return lines.join("\n");
	};

	// ---------- events ----------

	pi.on("session_start", (_e, ctx) => {
		clearTimer();
		s.inflight?.abort();
		s = freshState();
		s.ctx = ctx;
		ensureConfigFile();
		const { config, errors } = loadConfig();
		if (errors.length) notify(`config: ${errors.join("; ")}`, "warning");
		s.maxRetries = config.maxRetries;
		if (config.autoStart) enable(ctx, limitsFromConfig(config), true);
		setStatus();
	});

	pi.on("session_shutdown", () => {
		clearTimer();
		s.inflight?.abort();
		s.inflight = undefined;
		s.enabled = false;
	});

	pi.on("before_provider_request", (e, ctx) => {
		const p = e.payload as Record<string, any> | undefined;
		if (!p || typeof p !== "object") return undefined;
		if (isWarmReplay(p)) {
			// pi's built-in streaming refresh of the same prefix: counts as a cache touch.
			if (s.last && p.model === s.last.payload.model) s.lastTouch = Date.now();
			return undefined;
		}
		const model = ctx.model;
		s.ctx = ctx;
		if (!model || !SUPPORTED_APIS.has(String(model.api))) {
			s.last = undefined;
			s.note = model ? `api ${model.api} not supported` : undefined;
			return undefined;
		}
		const { ttlMs, retention } = detectTtl(String(model.api), model, p);
		s.last = { payload: structuredClone(p), model, ttlMs, retention };
		s.lastTouch = Date.now();
		s.failures = 0; // a real request starts a new streak
		s.inflight?.abort(); // a real request supersedes any in-flight refresh
		if (s.enabled) schedule();
		return undefined;
	});

	// Runs: pause. Idle: re-arm from the last request start (TTL counts from request start).
	pi.on("agent_start", (_e, ctx) => {
		s.ctx = ctx;
		s.running = true;
		clearTimer();
		s.inflight?.abort();
		setStatus();
	});
	pi.on("agent_settled", (_e, ctx) => {
		s.ctx = ctx;
		s.running = false;
		schedule();
	});

	// Context changes: the captured prefix is no longer what the next request will extend.
	pi.on("model_select", () => invalidate("model changed"));
	pi.on("session_compact", () => invalidate("compacted"));
	pi.on("session_tree", () => invalidate("tree navigation"));

	// While idle, keepwarm owns refreshes; during runs pi's built-in streaming warmer does.
	pi.on("cache_warming_decision" as any, () => (s.enabled && !s.running ? { action: "stop" } : undefined));

	// ---------- command ----------

	pi.registerCommand("keepwarm", {
		description: "Keep this session's prompt cache warm: /keepwarm [on [5h|forever] [$20|nocap] | off | status | config]",
		handler: async (args, ctx) => {
			s.ctx = ctx;
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (sub === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (sub === "config") {
				ensureConfigFile();
				ctx.ui.notify(configText(), "info");
				return;
			}
			if (sub === "off" || (!sub && s.enabled)) {
				disable("turned off");
				return;
			}
			if (sub && sub !== "on") {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			// undefined = not given; maxCost null = remove the cap.
			let durationMs: number | undefined;
			let maxCost: number | null | undefined;
			for (const tok of parts.slice(1)) {
				const cost = /^\$(\d+(?:\.\d+)?)$/.exec(tok);
				if (cost) maxCost = Number(cost[1]);
				else if (tok.toLowerCase() === "nocap") maxCost = null;
				else {
					const d = parseDuration(tok);
					if (d === undefined) {
						ctx.ui.notify(`keepwarm: can't parse "${tok}" (use e.g. 90m, 5h, forever, $20, nocap)`, "warning");
						return;
					}
					durationMs = d;
				}
			}
			if (s.enabled) {
				if (durationMs === undefined && maxCost === undefined) ctx.ui.notify(statusText(), "info");
				else update(durationMs, maxCost);
				return;
			}
			// Turning on: configured defaults, overridden by whatever was given.
			const limits = loadDefaults();
			if (durationMs !== undefined) limits.durationMs = durationMs;
			if (maxCost !== undefined) limits.maxCost = maxCost ?? undefined;
			enable(ctx, limits);
		},
	});
}

