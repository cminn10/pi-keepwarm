/** Provider payload helpers: detecting refresh replays, cache TTLs, and building refresh payloads. */

export const SUPPORTED_APIS = new Set([
	"anthropic-messages",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"openai-completions",
]);

export type Retention = "short" | "long";

/** Output cap fields that pi's own 1-token cache refreshes set; used to skip them. */
export function isWarmReplay(p: Record<string, any>): boolean {
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

/** Cache lifetime of the entry a request writes. A model's `promptCache` declaration wins. */
export function detectTtl(api: string, model: any, p: Record<string, any>): { ttlMs: number; retention: Retention } {
	let retention: Retention = "short";
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

/** When to refresh after the last cache touch: 90% of the TTL, and at least 15s before expiry. */
export function refreshDelayMs(ttlMs: number): number {
	const forced = Number(process.env.PI_KEEPWARM_EVERY_SEC);
	if (forced > 0) return forced * 1000;
	return Math.max(5_000, Math.min(ttlMs * 0.9, ttlMs - 15_000));
}

/** The captured request with the smallest output cap the API accepts. The prefix is untouched. */
export function warmPayload(api: string, p: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = { ...p };
	if (api === "anthropic-messages") out.max_tokens = 1;
	else if (api.includes("responses")) out.max_output_tokens = 16; // OpenAI Responses minimum
	else if ("max_completion_tokens" in out) out.max_completion_tokens = 1;
	else out.max_tokens = 1;
	// Testing only: make the provider reject the refresh to exercise failure handling.
	if (process.env.PI_KEEPWARM_TEST_FAIL) out.max_tokens = -1;
	return out;
}
