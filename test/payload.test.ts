import { describe, expect, test } from "bun:test";
import { detectTtl, isWarmReplay, refreshDelayMs, warmPayload } from "../extensions/keepwarm/payload.ts";

describe("isWarmReplay", () => {
	test("detects 1-token refreshes", () => {
		expect(isWarmReplay({ max_tokens: 1 })).toBe(true);
		expect(isWarmReplay({ max_output_tokens: 16 })).toBe(true);
	});
	test("real requests are not replays", () => {
		expect(isWarmReplay({ max_tokens: 32000 })).toBe(false);
		expect(isWarmReplay({})).toBe(false);
	});
});

describe("detectTtl", () => {
	const anthropic = (ttl?: string) => ({
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ...(ttl && { ttl }) } }],
		messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
	});

	test("anthropic default is 5 minutes", () => {
		expect(detectTtl("anthropic-messages", {}, anthropic())).toEqual({ ttlMs: 300_000, retention: "short" });
	});
	test("anthropic 1h marker", () => {
		expect(detectTtl("anthropic-messages", {}, anthropic("1h"))).toEqual({ ttlMs: 3_600_000, retention: "long" });
	});
	test("model promptCache declaration wins", () => {
		expect(detectTtl("anthropic-messages", { promptCache: { short: 240 } }, anthropic()).ttlMs).toBe(240_000);
	});
	test("openai retention variants", () => {
		expect(detectTtl("openai-responses", {}, {}).ttlMs).toBe(300_000);
		expect(detectTtl("openai-responses", {}, { prompt_cache_options: { ttl: "30m" } }).ttlMs).toBe(1_800_000);
		expect(detectTtl("openai-responses", {}, { prompt_cache_retention: "24h" })).toEqual({
			ttlMs: 1_800_000,
			retention: "long",
		});
	});
});

describe("refreshDelayMs", () => {
	test("90% of TTL, at least 15s before expiry", () => {
		expect(refreshDelayMs(300_000)).toBe(270_000);
		expect(refreshDelayMs(3_600_000)).toBe(3_240_000);
		expect(refreshDelayMs(60_000)).toBe(45_000);
	});
});

describe("warmPayload", () => {
	test("caps output per API without touching the prefix", () => {
		const original = { model: "m", max_tokens: 32000, messages: [{ role: "user", content: "x" }] };
		const warm = warmPayload("anthropic-messages", original);
		expect(warm.max_tokens).toBe(1);
		expect(warm.messages).toBe(original.messages);
		expect(original.max_tokens).toBe(32000);
		expect(warmPayload("openai-responses", { max_output_tokens: 4000 }).max_output_tokens).toBe(16);
		expect(warmPayload("openai-completions", { max_completion_tokens: 4000 }).max_completion_tokens).toBe(1);
		expect(warmPayload("openai-completions", {}).max_tokens).toBe(1);
	});
});
