import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, DEFAULT_CONFIG, ensureConfigFile, loadConfig, parseDuration } from "../extensions/keepwarm/config.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "keepwarm-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

const write = (obj: unknown) => writeFileSync(configPath(), typeof obj === "string" ? obj : JSON.stringify(obj));

describe("parseDuration", () => {
	test("minutes, hours, forever", () => {
		expect(parseDuration("90m")).toBe(90 * 60_000);
		expect(parseDuration("90")).toBe(90 * 60_000);
		expect(parseDuration("2h")).toBe(2 * 3_600_000);
		expect(parseDuration("1.5h")).toBe(90 * 60_000);
		expect(parseDuration("forever")).toBe(Infinity);
	});
	test("rejects garbage and zero", () => {
		expect(parseDuration("soon")).toBeUndefined();
		expect(parseDuration("0m")).toBeUndefined();
		expect(parseDuration("-1h")).toBeUndefined();
	});
});

describe("config file", () => {
	test("is created with defaults and never overwritten", () => {
		expect(configPath()).toBe(join(dir, "keepwarm.json"));
		expect(ensureConfigFile()).toBe(true);
		const created = JSON.parse(readFileSync(configPath(), "utf8"));
		expect(created).toMatchObject(DEFAULT_CONFIG);
		expect(created._help).toBeDefined();

		write({ autoStart: true });
		expect(ensureConfigFile()).toBe(false);
		expect(loadConfig().config.autoStart).toBe(true);
	});

	test("missing file uses defaults", () => {
		expect(loadConfig()).toMatchObject({ config: DEFAULT_CONFIG, errors: [] });
	});

	test("valid values are applied", () => {
		write({ autoStart: true, duration: "forever", maxCost: 10, maxRetries: 3, _note: "ignored" });
		expect(loadConfig()).toMatchObject({
			config: { autoStart: true, duration: "forever", maxCost: 10, maxRetries: 3 },
			errors: [],
		});
	});

	test("null duration means forever", () => {
		write({ duration: null });
		expect(loadConfig().config.duration).toBe("forever");
	});

	test("invalid values fall back per field and are reported", () => {
		write({ autoStart: "yes", duration: "soon", maxCost: -5, maxRetries: 0, foo: 1 });
		const { config, errors } = loadConfig();
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(errors).toHaveLength(5);
	});

	test("unparseable JSON falls back to defaults", () => {
		write("{ not json");
		const { config, errors } = loadConfig();
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(errors[0]).toContain("cannot parse");
	});
});
