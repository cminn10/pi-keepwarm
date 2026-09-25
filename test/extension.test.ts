/**
 * End-to-end behavior of the extension against a fake pi runtime.
 * Real timers with PI_KEEPWARM_EVERY_SEC=1, so each test takes a few seconds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import keepwarm from "../extensions/keepwarm/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = { stopReason: string; usage?: any; errorMessage?: string };
const HIT: Reply = { stopReason: "stop", usage: { cacheRead: 1000, cacheWrite: 0, cost: { total: 0.01 } } };
const MISS: Reply = { stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 1000, cost: { total: 0.1 } } };
const ERROR: Reply = { stopReason: "error", errorMessage: "boom" };

function harness() {
	const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
	let command: any;
	const entries: any[] = [];
	const pi = {
		on: (event: string, h: any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), h]);
			return () => {};
		},
		registerCommand: (name: string, opts: any) => {
			if (name === "keepwarm") command = opts;
		},
		appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
	};
	keepwarm(pi as any);

	const notes: string[] = [];
	const statuses: (string | undefined)[] = [];
	const payloads: any[] = [];
	const h = {
		idle: true,
		reply: HIT as Reply,
		notes,
		statuses,
		payloads,
		entries,
		get status() {
			return statuses.at(-1);
		},
	};
	const ctx = {
		hasUI: true,
		ui: { notify: (m: string) => notes.push(m), setStatus: (_k: string, t: string | undefined) => statuses.push(t) },
		isIdle: () => h.idle,
		model: { provider: "p", id: "m", api: "anthropic-messages" },
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: {
			streamSimple: (_model: any, _context: any, options: any) => {
				payloads.push(options.onPayload());
				return { result: async () => h.reply };
			},
		},
	};
	const emit = async (type: string, extra: object = {}) => {
		for (const fn of handlers.get(type) ?? []) await fn({ type, ...extra }, ctx);
	};
	const run = (args: string) => command.handler(args, ctx);
	/** A complete agent run with one real provider request, ending idle. */
	const turn = async () => {
		h.idle = false;
		await emit("agent_start");
		await emit("before_provider_request", {
			payload: { model: "m", max_tokens: 32000, messages: [{ role: "user", content: "hi" }] },
		});
		h.idle = true;
		await emit("agent_settled");
	};
	return Object.assign(h, { emit, run, turn });
}

let dir: string;
let h: ReturnType<typeof harness>;
const writeConfig = (obj: object) => writeFileSync(join(dir, "keepwarm.json"), JSON.stringify(obj));

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "keepwarm-ext-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_KEEPWARM_EVERY_SEC = "1";
	h = harness();
});
afterEach(async () => {
	await h.emit("session_shutdown");
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_KEEPWARM_EVERY_SEC;
});

describe("scheduling", () => {
	test("creates the config file on session start", async () => {
		await h.emit("session_start", { reason: "startup" });
		expect(await Bun.file(join(dir, "keepwarm.json")).exists()).toBe(true);
	});

	test("refreshes only while idle, replaying the captured request", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on");
		h.idle = false;
		await h.emit("agent_start");
		expect(h.status).toContain("\u23f3 active");
		await h.emit("before_provider_request", { payload: { model: "m", max_tokens: 32000, messages: [] } });
		await sleep(1500); // longer than the 1s interval, but the agent is running
		expect(h.payloads).toHaveLength(0);

		h.idle = true;
		await h.emit("agent_settled");
		await sleep(100); // interval already elapsed since the request started: refresh right away
		expect(h.payloads).toHaveLength(1);
		expect(h.payloads[0]).toMatchObject({ model: "m", max_tokens: 1, messages: [] });
		expect(h.entries[0].customType).toBe("keepwarm");

		await sleep(1100);
		expect(h.payloads).toHaveLength(2);
		expect(h.status).toMatch(/next .* 2\u00d7/);

		await h.run("off");
		await sleep(1200);
		expect(h.payloads).toHaveLength(2);
		expect(h.status).toBeUndefined();
	});

	test("ignores pi's own 1-token refreshes as captures", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on");
		await h.emit("before_provider_request", { payload: { model: "m", max_tokens: 1 } });
		expect(h.status).toContain("waiting for a request");
	});

	test("model change pauses until the next real request", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on");
		await h.turn();
		await h.emit("model_select");
		await sleep(1200);
		expect(h.payloads).toHaveLength(0);
		expect(h.status).toContain("paused: model changed");
	});
});

describe("failures", () => {
	test("retries, then stops after maxRetries consecutive errors", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on");
		h.reply = ERROR;
		await h.turn();
		await sleep(1800); // first failure at ~1s, retry after 0.5s
		expect(h.payloads).toHaveLength(2);
		expect(h.notes.some((n) => n.includes("refresh failed (1/2)"))).toBe(true);
		expect(h.notes.at(-1)).toContain("2 consecutive failed refreshes");
		expect(h.status).toBeUndefined();
	});

	test("a success resets the failure streak", async () => {
		writeConfig({ maxRetries: 2 });
		await h.emit("session_start", { reason: "startup" });
		await h.run("on");
		h.reply = ERROR;
		await h.turn();
		await sleep(1100);
		h.reply = HIT;
		await sleep(1200);
		h.reply = ERROR;
		await sleep(1200);
		// Without the reset, the failure after the success would have been the 2nd in a row.
		expect(h.notes.filter((n) => n.includes("refresh failed (1/2)")).length).toBe(2);
	});

	test("repeated cache misses count as failures", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on");
		h.reply = MISS;
		await h.turn();
		await sleep(2300);
		expect(h.payloads).toHaveLength(2);
		expect(h.notes.at(-1)).toContain("2 consecutive failed refreshes");
	});
});

describe("config and command", () => {
	test("plain /keepwarm uses config defaults; arguments override", async () => {
		writeConfig({ duration: "forever", maxCost: 10 });
		await h.emit("session_start", { reason: "startup" });
		await h.run("");
		expect(h.status).toContain("$0.000/$10.00");
		expect(h.status).not.toContain("until");

		await h.run("on 3h"); // while on: update only the duration
		expect(h.status).toContain("until");
		expect(h.status).toContain("/$10.00");

		await h.run("on nocap");
		expect(h.status).not.toContain("/$");

		await h.run("");
		expect(h.status).toBeUndefined();
		await h.run("on 90m $2");
		expect(h.status).toContain("/$2.00");
		expect(h.status).toContain("until");
	});

	test("autoStart turns keepwarm on at session start", async () => {
		writeConfig({ autoStart: true, maxCost: 5 });
		await h.emit("session_start", { reason: "startup" });
		expect(h.status).toContain("keepwarm");
		expect(h.status).toContain("/$5.00");
		expect(h.notes).toHaveLength(0);
	});

	test("cost cap stops refreshing", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on $0.015"); // one refresh costs $0.01
		await h.turn();
		await sleep(3300); // refreshes at 1s and 2s; the cap check at 3s stops it
		expect(h.payloads).toHaveLength(2);
		expect(h.notes.at(-1)).toContain("cost cap");
	});

	test("bad arguments are rejected", async () => {
		await h.emit("session_start", { reason: "startup" });
		await h.run("on soon");
		expect(h.notes.at(-1)).toContain("can't parse");
		expect(h.status).toBeUndefined();
	});
});
