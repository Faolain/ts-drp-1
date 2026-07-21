import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";

const environmentKeys = [
	"ANNOUNCE_ADDRESSES",
	"BOOTSTRAP",
	"BOOTSTRAP_PEERS",
	"BROWSER_METRICS",
	"LISTEN_ADDRESSES",
	"PRIVATE_KEY_SEED",
] as const;

describe("Phase 2 config migration", () => {
	let temporaryDirectory: string | undefined;

	beforeEach(() => {
		for (const key of environmentKeys) delete process.env[key];
	});

	afterEach(() => {
		for (const key of environmentKeys) delete process.env[key];
		if (temporaryDirectory !== undefined) fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	test("JSON with the removed bootstrap field fails loudly and names both replacements", () => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-phase-2-config-"));
		const configPath = path.join(temporaryDirectory, "legacy-bootstrap.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				network_config: {
					bootstrap: true,
					bootstrap_peers: ["peer-a"],
				},
			})
		);

		expect(() => loadConfig(configPath)).toThrow(/bootstrap.*removed.*seed.*relay_service/i);
	});

	test("BOOTSTRAP=true is the documented legacy env mapping to seed, relay service, and AutoNAT", () => {
		process.env.BOOTSTRAP = "true";
		process.env.BOOTSTRAP_PEERS = "peer-a,peer-b";

		const loaded = loadConfig();

		expect(loaded?.network_config).toMatchObject({
			autonat: true,
			bootstrap_peers: ["peer-a", "peer-b"],
			relay_service: { enabled: true },
			seed: true,
		});
		expect(loaded?.network_config).not.toHaveProperty("bootstrap");
	});

	test("JSON with the removed nested relay field fails loudly and names relay_service", () => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-phase-2-config-"));
		const configPath = path.join(temporaryDirectory, "legacy-relay.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				network_config: {
					relay: { max_reservations: 4 },
				},
			})
		);

		expect(() => loadConfig(configPath)).toThrow(/network_config\.relay.*removed.*relay_service/i);
	});
});
