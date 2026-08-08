import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	getPhase2dStorageDecisionBinding,
	PHASE_2D_GENERATIONS_STORE,
	PHASE_2D_SCHEMA_VERSION,
	PHASE_2D_VOTES_OBJECT_EPOCH_INDEX,
	PHASE_2D_VOTES_STORE,
} from "../src/internal/schema-idb.js";
import { requirePhase2dDecisionConsumptionReady } from "./opfs-idb-spike/fixtures/s4-decision-consumption-gate.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINK_PATH = "tests/opfs-idb-spike/artifacts/phase-2d-storage-substrate-decision-link-v1.json";

describe("Phase 2d1 selected schema authority", () => {
	it("keeps the minimal schema shell limited to plan-owned names and fields", () => {
		expect({
			generationKeyPath: ["objectId", "generationId"],
			generationsStore: PHASE_2D_GENERATIONS_STORE,
			schemaVersion: PHASE_2D_SCHEMA_VERSION,
			voteIndexKeyPath: ["objectId", "epoch"],
			voteIndexName: PHASE_2D_VOTES_OBJECT_EPOCH_INDEX,
			votesStore: PHASE_2D_VOTES_STORE,
		}).toEqual({
			generationKeyPath: ["objectId", "generationId"],
			generationsStore: "generations",
			schemaVersion: 1,
			voteIndexKeyPath: ["objectId", "epoch"],
			voteIndexName: "by-object-epoch",
			votesStore: "votes",
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

		expect(getPhase2dStorageDecisionBinding()).toEqual({ chosen: decision.chosen, linkSha256 });
	});
});
