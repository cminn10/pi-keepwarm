/**
 * keepwarm — manually toggled, session-scoped prompt-cache keep-alive.
 *
 *   /keepwarm                  toggle (on uses the default 2h)
 *   /keepwarm on [5h] [$20]    enable with a duration and/or cost cap
 *                              (cap alone = no time limit; `forever` = no time limit)
 *   /keepwarm on 5h | $30      while on: update only the given limit (duration counts
 *                              from now; `nocap` removes the cap)
 *   /keepwarm off              disable
 *   /keepwarm status           show state
 *
 * The cost cap counts all keepwarm spend in this session (across off/on).
 *
 * How it works: every real provider request of the session is captured in
 * `before_provider_request`. While enabled and the agent is idle, shortly
 * before the cache entry expires the last captured payload is re-sent
 * byte-for-byte with a minimal output cap, which reads (and thereby
 * refreshes) the cached prefix without changing it. Nothing enters the
 * conversation context.
 *
 * Refreshes only happen while idle (between `agent_settled` and the next
 * `agent_start`). The schedule is anchored to the start of the last request
 * that touched the cache (real request, keepwarm refresh, or pi's built-in
 * streaming refresh), because provider TTLs run from request start. During a
 * run, pi's built-in `cacheWarming: "streaming"` (the default) covers long
 * tool calls; keepwarm does not interfere with it.
 *
 * Unlike pi's built-in `cacheWarming: "idle"`, there is no fixed 30-minute
 * idle horizon: warming continues until you turn it off, the duration or
 * cost cap is reached, or the context changes (model switch, compaction, tree
 * navigation, session switch).
 *
 * Env overrides (mostly for testing):
 *   PI_KEEPWARM_TTL_SEC   force the assumed cache lifetime
 *   PI_KEEPWARM_EVERY_SEC force the refresh interval
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_DURATION_MS = 2 * 60 * 60_000;
const STATUS_KEY = "keepwarm";
const SUPPORTED_APIS = new Set([
	"anthropic-messages",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"openai-completions",
]);

type Captured = {
	payload: Record<string, unknown>;
	model: any;
	ttlMs: number;
	retention: "short" | "long";
};

type State = {
	enabled: boolean;
	until: number;
	maxCost: number | undefined;
	last: Captured | undefined;
	lastTouch: number;
	running: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
	nextAt: number;
	inflight: AbortController | undefined;
	warms: number;
	misses: number;
	cost: number;
	ctx: ExtensionContext | undefined;
	note: string | undefined;
};

function freshState(): State {
	return {
		enabled: false,
		until: 0,
		maxCost: undefined,
		last: undefined,
		lastTouch: 0,
		running: false,
		timer: undefined,
		nextAt: 0,
		inflight: undefined,
		warms: 0,
		misses: 0,
		cost: 0,
		ctx: undefined,
		note: undefined,
	};
}

// ---------- payload helpers ----------

/** Output cap fields that pi's own 1-token cache refreshes set; used to skip them. */
function isWarmReplay(p: Record<string, any>): boolean {
	const caps = [p.max_tokens, p.max_output_tokens, p.max_completion_tokens].filter((v) => typeof v === "number");
	return caps.length > 0 && caps.every((v) => v <= 16);
}

function hasLongAnthropicTtl(p: Record<string, any>): boolean {
	const blocks: any[] = [];
	if (Array.isArray(p.system)) blocks.push(...p.system);
	if (Array.isArray(p.tools)) blocks.push(...p.tools);
	if (Array.isArray(p.messages)) {
		for (const m of p.messages.slice(-4)) {
			if (Array.isArray(m?.content)) blocks.push(...m.content);
		}
	}
	return blocks.some((b) => b?.cache_control?.ttl === "1h");
}

function detectTtl(api: string, model: any, p: Record<string, any>): { ttlMs: number; retention: "short" | "long" } {
	let retention: "short" | "long" = "short";
	let fallbackSec = 300;
	if (api === "anthropic-messages") {
		if (hasLongAnthropicTtl(p)) {
			retention = "long";
			fallbackSec = 3600;
		}
	} else if (api.includes("responses")) {
		if (p.prompt_cache_options?.ttl === "30m") fallbackSec = 1800;
		if (p.prompt_cache_retention === "24h") {
			retention = "long";
			fallbackSec = 1800; // OpenAI: 24h entries are typically available ~30 min, best effort beyond
		}
	}
	const forced = Number(process.env.PI_KEEPWARM_TTL_SEC);
	const sec = forced > 0 ? forced : (model?.promptCache?.[retention] ?? fallbackSec);
	return { ttlMs: sec * 1000, retention };
}

function refreshDelayMs(ttlMs: number): number {
	const forced = Number(process.env.PI_KEEPWARM_EVERY_SEC);
	if (forced > 0) return forced * 1000;
	// 90% of the TTL, but always at least 15s before expiry.
	return Math.max(5_000, Math.min(ttlMs * 0.9, ttlMs - 15_000));
}

function warmPayload(api: string, p: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = { ...p };
	if (api === "anthropic-messages") out.max_tokens = 1;
	else if (api.includes("responses")) out.max_output_tokens = 16; // OpenAI Responses minimum
	else {
		if ("max_completion_tokens" in out) out.max_completion_tokens = 1;
		else out.max_tokens = 1;
	}
	return out;
}

// ---------- formatting ----------

function fmtDollars(v: number): string {
	return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}
function fmtClock(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDur(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.round(ms / 60_000);
	return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${m}m`;
}
function parseDuration(s: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(m|min|h|hr)?$/i.exec(s);
	if (!m) return undefined;
	const n = Number(m[1]);
	return (m[2]?.toLowerCase().startsWith("h") ? n * 60 : n) * 60_000;
}

export default function keepwarm(pi: ExtensionAPI) {
	let s = freshState();

	const setStatus = () => {
		const ctx = s.ctx;
		if (!ctx?.hasUI) return;
		try {
			if (!s.enabled) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const next = s.running
				? "⏳ active"
				: s.inflight
					? "refreshing…"
					: s.timer
						? `next ${fmtClock(s.nextAt)}`
						: (s.note ?? "waiting for a request");
			const spent = s.maxCost !== undefined ? `${fmtDollars(s.cost)}/${fmtDollars(s.maxCost)}` : fmtDollars(s.cost);
			const until = s.until === Infinity ? "" : ` · until ${fmtClock(s.until)}`;
			ctx.ui.setStatus(STATUS_KEY, `🔥 keepwarm · ${next} · ${s.warms}× ${spent}${until}`);
		} catch {
			// UI may be gone after session replacement.
		}
	};

	const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			s.ctx?.ui.notify(`keepwarm: ${msg}`, level);
		} catch {}
	};

	const clearTimer = () => {
		if (s.timer) clearTimeout(s.timer);
		s.timer = undefined;
	};

	const disable = (reason?: string) => {
		const wasOn = s.enabled;
		clearTimer();
		s.inflight?.abort();
		s.inflight = undefined;
		s.enabled = false;
		setStatus();
		if (wasOn && reason) notify(`off — ${reason} (${s.warms} refreshes, ${fmtDollars(s.cost)})`);
	};

	/** Arm the next refresh from the last cache touch. Only while idle. */
	const schedule = () => {
		clearTimer();
		if (!s.enabled || !s.last || s.running) {
			setStatus();
			return;
		}
		const at = s.lastTouch + refreshDelayMs(s.last.ttlMs);
		s.nextAt = at;
		s.timer = setTimeout(() => void refresh(), Math.max(0, at - Date.now()));
		(s.timer as any).unref?.();
		s.note = undefined;
		setStatus();
	};

	/** Forget the captured request: the next real request re-arms warming. */
	const invalidate = (why: string) => {
		s.last = undefined;
		clearTimer();
		s.inflight?.abort();
		s.note = `paused: ${why}`;
		setStatus();
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

		if (Date.now() >= s.until) return disable("duration reached");
		if (s.maxCost !== undefined && s.cost >= s.maxCost) return disable(`cost cap ${fmtDollars(s.maxCost)} reached`);

		const cur = ctx.model;
		if (!cur || cur.provider !== last.model.provider || cur.id !== last.model.id) {
			return invalidate("model changed");
		}
		// Too late (machine asleep, or the last response streamed longer than the TTL): the
		// entry is probably gone and a refresh would be a full-price cache write.
		// Wait for the next real request instead.
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
						maxRetries: 1,
						signal: controller.signal,
						sessionId: ctx.sessionManager.getSessionId(),
						cacheRetention: last.retention,
						onPayload: () => payload,
					} as any,
				)
				.result();
			// Superseded by a real request, turned off, or shutting down.
			if (controller.signal.aborted || s.inflight !== controller || s.last !== last) return;
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				notify(`refresh failed: ${msg.errorMessage ?? msg.stopReason}`, "warning");
				// Retry once more on the normal cadence if there's still time before expiry.
				if (Date.now() - s.lastTouch < last.ttlMs - 30_000) {
					s.timer = setTimeout(() => void refresh(), 20_000);
					(s.timer as any).unref?.();
					s.nextAt = Date.now() + 20_000;
				}
				setStatus();
				return;
			}
			const u = msg.usage ?? {};
			const c = Number(u.cost?.total ?? 0);
			s.warms++;
			s.cost += c;
			if (!(u.cacheRead > 0) && u.cacheWrite > 0) {
				s.misses++;
				notify(`cache was already cold — rewrote ${u.cacheWrite} tokens (${fmtDollars(c)})`, "warning");
			}
			pi.appendEntry("keepwarm", {
				provider: msg.provider,
				model: msg.responseModel ?? msg.model,
				usage: u,
			});
			s.lastTouch = sentAt;
			schedule();
		} catch (err) {
			if (!controller.signal.aborted) notify(`refresh error: ${(err as Error)?.message ?? err}`, "warning");
		} finally {
			if (s.inflight === controller) {
				s.inflight = undefined;
				setStatus();
			}
		}
	};

	const limitsText = (): string => {
		const time = s.until === Infinity ? "no time limit" : `until ${fmtClock(s.until)}`;
		const cap = s.maxCost !== undefined ? `cap ${fmtDollars(s.maxCost)} (spent ${fmtDollars(s.cost)})` : "no cost cap";
		return `${time}, ${cap}`;
	};

	/** Change limits of an active keepwarm without resetting its schedule. */
	const update = (durationMs: number | undefined, maxCost: number | null | undefined) => {
		if (durationMs !== undefined) s.until = durationMs === Infinity ? Infinity : Date.now() + durationMs;
		if (maxCost !== undefined) s.maxCost = maxCost ?? undefined;
		setStatus();
		notify(`updated \u2014 ${limitsText()}`);
		if (s.maxCost !== undefined && s.cost >= s.maxCost) disable(`cost cap ${fmtDollars(s.maxCost)} already reached`);
	};

	const enable = (ctx: ExtensionContext, durationMs: number, maxCost: number | undefined) => {
		s.ctx = ctx;
		s.enabled = true;
		s.until = durationMs === Infinity ? Infinity : Date.now() + durationMs;
		s.maxCost = maxCost;
		if (maxCost !== undefined && s.cost >= maxCost) {
			s.enabled = false;
			notify(`cap ${fmtDollars(maxCost)} is not above the ${fmtDollars(s.cost)} already spent in this session`, "warning");
			return;
		}
		s.running = !ctx.isIdle();
		const model = ctx.model;
		if (!model || !SUPPORTED_APIS.has(String(model.api))) {
			notify(`current model api "${model?.api}" is not supported`, "error");
			s.enabled = false;
			return;
		}
		if (s.last && Date.now() - s.lastTouch > s.last.ttlMs - 3_000) {
			s.last = undefined; // already expired; nothing to keep warm yet
			s.note = "cache already cold; arms on next message";
		}
		schedule();
		const ttl = s.last ? `TTL ${fmtDur(s.last.ttlMs)}, refresh every ${fmtDur(refreshDelayMs(s.last.ttlMs))}` : "arms on next message";
		notify(`on \u2014 ${limitsText()} (${ttl})`);
		if (s.until === Infinity && s.maxCost === undefined) notify("no time limit and no cost cap: runs until /keepwarm off", "warning");
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
		return lines.join("\n");
	};

	// ---------- events ----------

	pi.on("session_start", (_e, ctx) => {
		clearTimer();
		s.inflight?.abort();
		s = freshState();
		s.ctx = ctx;
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
		if (!model || !SUPPORTED_APIS.has(String(model.api))) return undefined;
		s.ctx = ctx;
		const { ttlMs, retention } = detectTtl(String(model.api), model, p);
		s.last = { payload: structuredClone(p), model, ttlMs, retention };
		s.lastTouch = Date.now();
		s.inflight?.abort(); // a real request supersedes any in-flight refresh
		if (s.enabled) schedule();
		return undefined;
	});

	// Context changes: the captured prefix is no longer what the next request will extend.
	pi.on("model_select", () => invalidate("model changed"));
	pi.on("session_compact", () => invalidate("compacted"));
	pi.on("session_tree", () => invalidate("tree navigation"));

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

	// While idle, keepwarm owns refreshes; during runs pi's built-in streaming warmer does.
	pi.on("cache_warming_decision" as any, () => (s.enabled && !s.running ? { action: "stop" } : undefined));

	// ---------- command ----------

	pi.registerCommand("keepwarm", {
		description:
			"Keep this session's prompt cache warm: /keepwarm [on [2h|forever] [$20|nocap] | off | status]. While on, `on ...` updates the limits.",
		handler: async (args, ctx) => {
			s.ctx = ctx;
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (sub === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (sub === "off" || (!sub && s.enabled)) {
				disable("turned off");
				return;
			}
			if (sub && sub !== "on") {
				ctx.ui.notify("usage: /keepwarm [on [2h|forever] [$20|nocap] | off | status]", "warning");
				return;
			}
			// undefined = not specified; maxCost null = remove the cap.
			let durationMs: number | undefined;
			let maxCost: number | null | undefined;
			for (const tok of parts.slice(1)) {
				const lower = tok.toLowerCase();
				const cost = /^\$(\d+(?:\.\d+)?)$/.exec(tok);
				if (cost) maxCost = Number(cost[1]);
				else if (lower === "nocap") maxCost = null;
				else if (["forever", "inf", "\u221e", "notime"].includes(lower)) durationMs = Infinity;
				else {
					const d = parseDuration(tok);
					if (d === undefined || d <= 0) {
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
			// Fresh start: a cap alone means "no time limit"; nothing at all means the default duration.
			const cap = maxCost ?? undefined;
			enable(ctx, durationMs ?? (cap !== undefined ? Infinity : DEFAULT_DURATION_MS), cap);
		},
	});
}
