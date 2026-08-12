import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	PHASE_2L_B_AMBIGUITY_CASES,
	PHASE_2L_B_DEATH_TUPLES,
	PHASE_2L_B_EDGES,
	PHASE_2L_B_SCENARIOS,
	PHASE_2L_B_SCHEMA,
} from "./fixtures/phase-2l-b-browser-issuance-contract.js";

describe("Phase 2l-b literal browser issuance authorities", () => {
	it("adds only the explicit issuance subpath and runtime shared owner while root stays byte-identical", () => {
		const packageDirectory = path.resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		expect(manifest.exports?.["./issuance"]).toEqual({
			import: "./dist/src/issuance.js",
			types: "./dist/src/issuance.d.ts",
		});
		expect(manifest.dependencies?.["@ts-drp/issuance-store"]).toBe("0.11.0");
		const rootBytes = fs.readFileSync(path.join(packageDirectory, "src/index.ts"));
		expect(createHash("sha256").update(rootBytes).digest("hex")).toBe(
			"30d32c3b4e9f9b4a7036602fe2338315167112bec41ca83a753b4feaba3bf56c"
		);
	});

	it("freezes one exact v1 native schema and five browser ambiguity cases", () => {
		expect(PHASE_2L_B_SCHEMA).toEqual({
			databaseVersion: 1,
			stores: [
				{ autoIncrement: false, keyPath: ["objectId", "author"], name: "lineages" },
				{
					autoIncrement: false,
					keyPath: ["objectId", "author", "authorSequence"],
					name: "issuedRecords",
				},
				{
					autoIncrement: false,
					keyPath: ["objectId", "author", "authorSequence"],
					name: "issuanceOutbox",
				},
			],
		});
		expect(PHASE_2L_B_AMBIGUITY_CASES).toEqual([
			"exact-pair",
			"absent-old",
			"foreign-pair",
			"torn-or-inconsistent",
			"unreadable",
		]);
	});

	it("freezes exactly eight semantic edges crossed with two scenarios", () => {
		expect(PHASE_2L_B_SCENARIOS).toEqual(["fresh", "existing-lineage"]);
		expect(PHASE_2L_B_EDGES).toHaveLength(8);
		expect(PHASE_2L_B_DEATH_TUPLES).toHaveLength(16);
		expect(new Set(PHASE_2L_B_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(16);
	});

	it("binds lineage-write to fresh add and existing exact-prior put", () => {
		expect(PHASE_2L_B_DEATH_TUPLES.find(({ id }) => id === "fresh/lineage-write")?.nativeRequest).toEqual({
			method: "add",
			store: "lineages",
		});
		expect(PHASE_2L_B_DEATH_TUPLES.find(({ id }) => id === "existing-lineage/lineage-write")?.nativeRequest).toEqual({
			method: "put",
			store: "lineages",
		});
		for (const scenario of PHASE_2L_B_SCENARIOS) {
			expect(PHASE_2L_B_DEATH_TUPLES.find(({ id }) => id === `${scenario}/issued-add`)?.nativeRequest).toEqual({
				method: "add",
				store: "issuedRecords",
			});
			expect(PHASE_2L_B_DEATH_TUPLES.find(({ id }) => id === `${scenario}/outbox-add`)?.nativeRequest).toEqual({
				method: "add",
				store: "issuanceOutbox",
			});
		}
	});

	it("requires controlled abort old and complete exact-new without creating a ninth edge", () => {
		for (const scenario of PHASE_2L_B_SCENARIOS) {
			expect(PHASE_2L_B_DEATH_TUPLES.find(({ id }) => id === `${scenario}/abort`)?.terminalFate).toBe("old");
			expect(PHASE_2L_B_DEATH_TUPLES.find(({ id }) => id === `${scenario}/complete`)?.terminalFate).toBe("exact-new");
		}
		expect(PHASE_2L_B_DEATH_TUPLES.some(({ id }) => id.includes("lineage-put"))).toBe(false);
	});
});
