import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
	PHASE_2L_C_AMBIGUITY_CASES,
	PHASE_2L_C_DDL,
	PHASE_2L_C_DEATH_TUPLES,
	PHASE_2L_C_EDGES,
	PHASE_2L_C_SCENARIOS,
} from "./fixtures/phase-2l-c-node-issuance-contract.js";

describe("Phase 2l-c literal Node issuance authorities", () => {
	it("adds only the explicit issuance subpath and shared runtime owner while root stays byte-identical", () => {
		const packageDirectory = path.resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		expect(manifest.exports?.["./issuance"]).toEqual({
			import: "./dist/src/issuance.js",
			types: "./dist/src/issuance.d.ts",
		});
		expect(manifest.exports?.["./live-journal"]).toEqual({
			import: "./dist/src/live-journal.js",
			types: "./dist/src/live-journal.d.ts",
		});
		expect(manifest.dependencies?.["@ts-drp/issuance-store"]).toBe("0.11.0");
		expect(manifest.dependencies?.["@ts-drp/live-journal"]).toBe("0.11.0");
		expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
			"@ts-drp/compaction",
			"@ts-drp/issuance-store",
			"@ts-drp/live-journal",
			"@ts-drp/storage",
		]);
		expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([
			".",
			"./issuance",
			"./issuance-maintenance",
			"./live-journal",
			...(Object.hasOwn(manifest.exports ?? {}, "./maintenance") ? ["./maintenance"] : []),
			"./snapshot-transfer",
		]);
		const root = fs.readFileSync(path.join(packageDirectory, "src/index.ts"));
		expect(createHash("sha256").update(root).digest("hex")).toBe(
			"14688ec0442cf331f329a5cb944bfa893f6a6ef08eeedd8bb6352651283d7211"
		);
	});

	it("compile-checks the exact named options type and synchronous factory return", () => {
		const packageDirectory = path.resolve(import.meta.dirname, "..");
		const fixtureDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2l-c-types-"));
		try {
			fs.writeFileSync(
				path.join(fixtureDirectory, "index.ts"),
				[
					'import type { DurableIssuanceStore } from "@ts-drp/issuance-store";',
					'import { createNodeDurableIssuanceStore, type NodeDurableIssuanceStoreOptions } from "@ts-drp/storage-node/issuance";',
					"declare const options: NodeDurableIssuanceStoreOptions;",
					"const store: DurableIssuanceStore = createNodeDurableIssuanceStore(options);",
					"void store;",
				].join("\n")
			);
			fs.writeFileSync(
				path.join(fixtureDirectory, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						baseUrl: ".",
						composite: false,
						declaration: false,
						declarationMap: false,
						noEmit: true,
						paths: {
							"@ts-drp/issuance-store": ["../../../packages/issuance-store/src/index.ts"],
							"@ts-drp/storage-node/issuance": ["../../../packages/storage-node/src/issuance.ts"],
						},
					},
					extends: "../../../tsconfig.json",
					include: ["index.ts"],
				})
			);
			const compiler = path.resolve(packageDirectory, "../../node_modules/typescript/lib/tsc.js");
			const result = spawnSync(process.execPath, [compiler, "-p", path.join(fixtureDirectory, "tsconfig.json")], {
				encoding: "utf8",
			});
			expect(`${result.stdout}${result.stderr}`).toBe("");
			expect(result.status).toBe(0);
		} finally {
			fs.rmSync(fixtureDirectory, { force: true, recursive: true });
		}
	});

	it("freezes one byte-exact normalized DDL authority", () => {
		expect(Object.keys(PHASE_2L_C_DDL)).toEqual(["lineages", "issued_records", "issuance_outbox"]);
		for (const [name, sql] of Object.entries(PHASE_2L_C_DDL)) {
			expect(sql.startsWith(`CREATE TABLE ${name} (`)).toBe(true);
			expect(sql.endsWith("WITHOUT ROWID")).toBe(true);
			expect(sql).not.toContain("IF NOT EXISTS");
			expect(sql).not.toMatch(/^\s|\s$|;$/u);
		}
		expect(PHASE_2L_C_DDL.lineages).toContain("CHECK(exhausted IN (0,1))");
		expect(PHASE_2L_C_DDL.issuance_outbox).toContain("CHECK(publish_state IN ('pending','published'))");
	});

	it("round-trips the exact DDL constants through the pinned native sqlite catalog", () => {
		const database = new DatabaseSync(":memory:", {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
			readOnly: false,
		});
		try {
			for (const sql of Object.values(PHASE_2L_C_DDL)) database.exec(sql);
			const statement = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name");
			statement.setReadBigInts(false);
			expect(statement.all()).toEqual([
				expect.objectContaining({ name: "issuance_outbox", sql: PHASE_2L_C_DDL.issuance_outbox }),
				expect.objectContaining({ name: "issued_records", sql: PHASE_2L_C_DDL.issued_records }),
				expect.objectContaining({ name: "lineages", sql: PHASE_2L_C_DDL.lineages }),
			]);
		} finally {
			database.close();
		}
	});

	it("freezes exactly nine edges crossed with two scenarios and five ambiguity cases", () => {
		expect(PHASE_2L_C_SCENARIOS).toEqual(["fresh", "existing-lineage"]);
		expect(PHASE_2L_C_EDGES).toHaveLength(9);
		expect(PHASE_2L_C_DEATH_TUPLES).toHaveLength(18);
		expect(new Set(PHASE_2L_C_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(18);
		expect(PHASE_2L_C_AMBIGUITY_CASES).toEqual([
			"exact-pair",
			"absent-old",
			"foreign-pair",
			"torn-or-inconsistent",
			"unreadable",
		]);
		for (const scenario of PHASE_2L_C_SCENARIOS) {
			for (const edge of PHASE_2L_C_EDGES.filter((value) => value !== "commit")) {
				expect(PHASE_2L_C_DEATH_TUPLES.find(({ id }) => id === `${scenario}/${edge}`)?.terminalFate).toBe("old");
			}
			expect(PHASE_2L_C_DEATH_TUPLES.find(({ id }) => id === `${scenario}/commit`)?.terminalFate).toBe("exact-new");
		}
	});
});
