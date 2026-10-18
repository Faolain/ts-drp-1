import { describe, expect, test, vi } from "vitest";

import { createCliProgram } from "../src/cli/index.js";
import { captureV3CanvasCliConfig } from "../src/cli/v3-canvas.js";
import { run } from "../src/run.js";

// The original test imported an auto-starting v1 host and never awaited its bare-ID
// callback. That retired behavior is not evidence of v3 admission or CLI closure.
// Actual configured Node/SQLite/gRPC acceptance lives in the existing R9 native fixture.
describe("explicit v3 CLI entry", () => {
	test("requires a configured file and rejects the removed mode option", () => {
		const parser = createCliProgram().exitOverride();
		parser.configureOutput({ writeErr: () => undefined });
		expect(() => parser.parse(["node", "run"])).toThrow("required option");
		expect(() => parser.parse(["node", "run", "--config", "local.json", "--mode", "bootstrap"])).toThrow(
			"unknown option"
		);
	});

	test("has no default startup or v1 fallback", async () => {
		await expect(run("")).rejects.toThrow("V3_CLI_CONFIG_REQUIRED");
		await expect(run("/private/tmp/ts-drp-nonexistent-cli-config.json")).rejects.toThrow("ENOENT");
		expect(() => captureV3CanvasCliConfig({})).toThrow();
	});

	test("rejects executable node config before invoking accessors", () => {
		const getter = vi.fn(() => "not a seed");
		const node = { keychain_config: Object.defineProperty({}, "private_key_seed", { enumerable: true, get: getter }) };
		const config = {
			node,
			rpc: { port: 0, maxActiveEntries: 1, maxCustomGroups: 1, maxPayloadBytes: 8, maxNameBytes: 8 },
			canvas: { width: 2, height: 2, directory: "/private/tmp/canvas-unused", rooms: [] },
		};
		expect(() => captureV3CanvasCliConfig(config)).toThrow("ROOM_HEAD_INVALID_RECORD");
		expect(getter).not.toHaveBeenCalled();
	});

	test("rejects executable room array entries without invoking accessors", () => {
		const getter = vi.fn(() => ({}));
		const roomBindings = Object.defineProperty(new Array(1), "0", { enumerable: true, get: getter });
		const config = {
			node: {},
			rpc: { port: 0, maxActiveEntries: 1, maxCustomGroups: 1, maxPayloadBytes: 8, maxNameBytes: 8 },
			canvas: { width: 2, height: 2, directory: "/private/tmp/canvas-unused", rooms: roomBindings },
		};
		expect(() => captureV3CanvasCliConfig(config)).toThrow("V3_CLI_INVALID_NODE_CONFIG");
		expect(getter).not.toHaveBeenCalled();
	});
});
