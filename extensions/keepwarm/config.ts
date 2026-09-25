/**
 * Persistent defaults in `<agentDir>/keepwarm.json` (usually ~/.pi/agent/keepwarm.json).
 *
 * The file is created with the built-in defaults the first time a session starts,
 * and re-read whenever defaults are needed (session start, `/keepwarm`, `/keepwarm on`),
 * so edits apply without reloading pi.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type KeepwarmConfig = {
	/** Turn keepwarm on automatically in every session. */
	autoStart: boolean;
	/** Default time limit: "90m", "2h", ... or "forever". */
	duration: string;
	/** Default cost cap in USD for the session's keepwarm spend, or null for no cap. */
	maxCost: number | null;
	/** Stop after this many consecutive failed refreshes (errors or cache misses). */
	maxRetries: number;
};

export const DEFAULT_CONFIG: KeepwarmConfig = {
	autoStart: false,
	duration: "2h",
	maxCost: null,
	maxRetries: 2,
};

const HELP: Record<string, string> = {
	autoStart: "true = turn keepwarm on automatically in every session",
	duration: "default time limit for /keepwarm: e.g. \"90m\", \"2h\", or \"forever\"",
	maxCost: "default cost cap in USD for keepwarm spend per session (e.g. 10), or null for no cap",
	maxRetries: "stop after this many consecutive failed refreshes (errors or cache misses); >= 1",
};

export type LoadedConfig = {
	config: KeepwarmConfig;
	path: string;
	errors: string[];
};

export function configPath(): string {
	return join(getAgentDir(), "keepwarm.json");
}

/** Write the default config file if it does not exist yet. Returns true when created. */
export function ensureConfigFile(): boolean {
	const path = configPath();
	if (existsSync(path)) return false;
	try {
		writeFileSync(path, `${JSON.stringify({ ...DEFAULT_CONFIG, _help: HELP }, null, 2)}\n`, { flag: "wx" });
		return true;
	} catch {
		return false; // raced with another session or read-only dir: fall back to built-in defaults
	}
}

export function parseDuration(s: string): number | undefined {
	const lower = s.trim().toLowerCase();
	if (["forever", "inf", "\u221e", "notime", "none"].includes(lower)) return Infinity;
	const m = /^(\d+(?:\.\d+)?)(m|min|h|hr)?$/.exec(lower);
	if (!m) return undefined;
	const n = Number(m[1]);
	const ms = (m[2]?.startsWith("h") ? n * 60 : n) * 60_000;
	return ms > 0 ? ms : undefined;
}

/** Read and validate the config. Invalid fields fall back to built-in defaults and are reported. */
export function loadConfig(): LoadedConfig {
	const path = configPath();
	const config: KeepwarmConfig = { ...DEFAULT_CONFIG };
	const errors: string[] = [];
	if (!existsSync(path)) return { config, path, errors };

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { config, path, errors: [`cannot parse ${path}: ${(err as Error).message}; using built-in defaults`] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, path, errors: [`${path} must contain a JSON object; using built-in defaults`] };
	}
	const obj = raw as Record<string, unknown>;

	for (const key of Object.keys(obj)) {
		if (!key.startsWith("_") && !(key in DEFAULT_CONFIG)) errors.push(`unknown key "${key}" ignored`);
	}
	if ("autoStart" in obj) {
		if (typeof obj.autoStart === "boolean") config.autoStart = obj.autoStart;
		else errors.push(`autoStart must be true or false`);
	}
	if ("duration" in obj) {
		const d = obj.duration;
		if (d === null) config.duration = "forever";
		else if (typeof d === "string" && parseDuration(d) !== undefined) config.duration = d;
		else errors.push(`duration must be like "90m", "2h" or "forever"`);
	}
	if ("maxCost" in obj) {
		const c = obj.maxCost;
		if (c === null) config.maxCost = null;
		else if (typeof c === "number" && Number.isFinite(c) && c > 0) config.maxCost = c;
		else errors.push(`maxCost must be a positive number or null`);
	}
	if ("maxRetries" in obj) {
		const r = obj.maxRetries;
		if (typeof r === "number" && Number.isInteger(r) && r >= 1) config.maxRetries = r;
		else errors.push(`maxRetries must be an integer >= 1`);
	}
	return { config, path, errors };
}
