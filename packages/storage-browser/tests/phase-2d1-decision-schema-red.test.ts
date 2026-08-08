import type { StorageAdapterLoadRequirement, StorageAdapterWrite } from "@ts-drp/storage/adapter";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as phase2dSchema from "../src/internal/schema-idb.js";
import { requirePhase2dDecisionConsumptionReady } from "./opfs-idb-spike/fixtures/s4-decision-consumption-gate.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINK_PATH = "tests/opfs-idb-spike/artifacts/phase-2d-storage-substrate-decision-link-v1.json";
type Phase2dStore = "blobs" | "generations" | "objects" | "promotions" | "votes";

const ADAPTER_STORE_OWNERSHIP = Object.freeze({
	loads: {
		"blob": ["blobs"],
		"generation-closure": ["generations", "blobs", "promotions"],
		"object-state": ["objects", "generations"],
		"promotion": ["promotions"],
	} satisfies Record<StorageAdapterLoadRequirement["kind"], readonly Phase2dStore[]>,
	writes: {
		"insert-blob": "blobs",
		"insert-promotion": "promotions",
		"replace-generation": "generations",
		"replace-head": "objects",
	} satisfies Record<StorageAdapterWrite["kind"], Phase2dStore>,
});

describe("Phase 2d1 selected schema authority", () => {
	it("freezes the corrected private-v1 five-store authority without compatibility stores", () => {
		const authority = phase2dSchema as unknown as Readonly<Record<string, unknown>>;
		expect({
			inventory: authority.PHASE_2D_DATA_STORE_INVENTORY,
			schemaVersion: authority.PHASE_2D_SCHEMA_VERSION,
			voteIndexName: authority.PHASE_2D_VOTES_OBJECT_EPOCH_INDEX,
		}).toEqual({
			inventory: [
				{ keyPath: "objectId", name: "objects" },
				{ keyPath: ["objectId", "generationId"], name: "generations" },
				{ keyPath: "digest", name: "blobs" },
				{ keyPath: ["objectId", "generationId", "digest"], name: "promotions" },
				{ keyPath: null, name: "votes" },
			],
			schemaVersion: 1,
			voteIndexName: "by-object-epoch",
		});
	});

	it("maps every frozen adapter load and write kind to its physical store owners", () => {
		expect(ADAPTER_STORE_OWNERSHIP).toEqual({
			loads: {
				"blob": ["blobs"],
				"generation-closure": ["generations", "blobs", "promotions"],
				"object-state": ["objects", "generations"],
				"promotion": ["promotions"],
			},
			writes: {
				"insert-blob": "blobs",
				"insert-promotion": "promotions",
				"replace-generation": "generations",
				"replace-head": "objects",
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
