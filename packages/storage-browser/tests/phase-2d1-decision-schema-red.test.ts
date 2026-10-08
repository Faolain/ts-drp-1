import type { StorageAdapterWrite } from "@ts-drp/storage/adapter";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as phase2dSchema from "../src/internal/schema-idb.js";
import { requirePhase2dDecisionConsumptionReady } from "./opfs-idb-spike/fixtures/s4-decision-consumption-gate.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINK_PATH = "tests/opfs-idb-spike/artifacts/phase-2d-storage-substrate-decision-link-v1.json";
type Phase2dStore = "blobs" | "generations" | "objects" | "promotions";
type Phase2e3LoadKind = "blob" | "generation" | "generation-page" | "head" | "promotion";

function isDeeplyFrozen(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (!Object.isFrozen(value)) return false;
	return Object.values(value).every((child) => isDeeplyFrozen(child));
}

const ADAPTER_STORE_OWNERSHIP = Object.freeze({
	loads: {
		"blob": ["blobs"],
		"generation": ["generations"],
		"generation-page": ["generations"],
		"head": ["objects"],
		"promotion": ["promotions"],
	} satisfies Record<Phase2e3LoadKind, readonly Phase2dStore[]>,
	writes: {
		"insert-blob": "blobs",
		"insert-promotion": "promotions",
		"replace-generation": "generations",
		"replace-head": "objects",
	} satisfies Record<StorageAdapterWrite["kind"], Phase2dStore>,
});

describe("Phase 2d2d private-v1 schema authority", () => {
	it("exposes one frozen four-store zero-index authority without speculative vote aliases", () => {
		const authority = phase2dSchema as unknown as Readonly<Record<string, unknown>>;
		expect({
			partialDataStoreInventoryPresent: Reflect.has(authority, "PHASE_2D_DATA_STORE_INVENTORY"),
			schema: authority.PHASE_2D_SCHEMA_AUTHORITY,
			votesObjectEpochIndexAliasPresent: Reflect.has(authority, "PHASE_2D_VOTES_OBJECT_EPOCH_INDEX"),
			votesStoreAliasPresent: Reflect.has(authority, "PHASE_2D_VOTES_STORE"),
		}).toEqual({
			partialDataStoreInventoryPresent: false,
			schema: {
				stores: [
					{ autoIncrement: false, indexes: [], keyPath: "objectId", name: "objects" },
					{
						autoIncrement: false,
						indexes: [],
						keyPath: ["objectId", "generationId"],
						name: "generations",
					},
					{ autoIncrement: false, indexes: [], keyPath: "digest", name: "blobs" },
					{
						autoIncrement: false,
						indexes: [],
						keyPath: ["objectId", "generationId", "digest"],
						name: "promotions",
					},
				],
				version: 1,
			},
			votesObjectEpochIndexAliasPresent: false,
			votesStoreAliasPresent: false,
		});
		expect(isDeeplyFrozen(authority.PHASE_2D_SCHEMA_AUTHORITY)).toBe(true);
	});

	it("maps every frozen adapter load and write kind to its physical store owners", () => {
		expect(ADAPTER_STORE_OWNERSHIP).toEqual({
			loads: {
				"blob": ["blobs"],
				"generation": ["generations"],
				"generation-page": ["generations"],
				"head": ["objects"],
				"promotion": ["promotions"],
			},
			writes: {
				"insert-blob": "blobs",
				"insert-promotion": "promotions",
				"replace-generation": "generations",
				"replace-head": "objects",
			},
		});
		const adapterSource = fs.readFileSync(path.join(PACKAGE_DIRECTORY, "../storage/src/adapter.ts"), "utf8");
		const browserAdapterSource = fs.readFileSync(path.join(PACKAGE_DIRECTORY, "src/internal/idb-adapter.ts"), "utf8");
		expect.soft(adapterSource).toContain('kind: "generation"');
		expect.soft(adapterSource).not.toContain('kind: "object-state"');
		expect.soft(adapterSource).not.toContain('kind: "generation-closure"');
		expect.soft(browserAdapterSource).not.toContain('case "object-state"');
		expect.soft(browserAdapterSource).not.toContain("generation closure loaded without its object state");
		expect.soft(browserAdapterSource).not.toContain("getAll(generationPrefix(");
	});

	it("preserves the stable browser root while publishing additive bounded subpaths", () => {
		const packageManifest = JSON.parse(
			fs.readFileSync(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")
		) as Readonly<Record<string, unknown>>;

		expect(packageManifest).not.toHaveProperty("private");
		expect(packageManifest.exports).toEqual({
			".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
			"./issuance": { import: "./dist/src/issuance.js", types: "./dist/src/issuance.d.ts" },
			"./issuance-maintenance": {
				import: "./dist/src/issuance-maintenance.js",
				types: "./dist/src/issuance-maintenance.d.ts",
			},
			"./live-journal": { import: "./dist/src/live-journal.js", types: "./dist/src/live-journal.d.ts" },
			"./maintenance": { import: "./dist/src/maintenance.js", types: "./dist/src/maintenance.d.ts" },
			"./seal-evidence": {
				import: "./dist/src/seal-evidence.js",
				types: "./dist/src/seal-evidence.d.ts",
			},
			"./seal-vote": { import: "./dist/src/seal-vote.js", types: "./dist/src/seal-vote.d.ts" },
			"./snapshot-transfer": {
				import: "./dist/src/snapshot-transfer.js",
				types: "./dist/src/snapshot-transfer.d.ts",
			},
		});
	});

	it("binds production opening to the accepted S4 idb-strict decision link digest", () => {
		const decision = requirePhase2dDecisionConsumptionReady({
			linkPath: LINK_PATH,
			rootDirectory: PACKAGE_DIRECTORY,
		});
		const linkSha256 = crypto
			.createHash("sha256")
			.update(fs.readFileSync(path.join(PACKAGE_DIRECTORY, LINK_PATH)))
			.digest("hex");

		expect(phase2dSchema.getPhase2dStorageDecisionBinding()).toEqual({ chosen: decision.chosen, linkSha256 });
	});
});
