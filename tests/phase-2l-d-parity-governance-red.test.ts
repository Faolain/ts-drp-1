import { MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS } from "@ts-drp/issuance-store";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-2l-d/parity-contract.json" with { type: "json" };
import {
	PHASE_2L_B_AMBIGUITY_CASES,
	PHASE_2L_B_DEATH_TUPLES,
} from "../packages/storage-browser/tests/fixtures/phase-2l-b-browser-issuance-contract.js";
import {
	PHASE_2L_C_AMBIGUITY_CASES,
	PHASE_2L_C_DEATH_TUPLES,
} from "../packages/storage-node/tests/fixtures/phase-2l-c-node-issuance-contract.js";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");

interface RegistryField {
	readonly constraints: { readonly maximumUtf16Units?: number };
	readonly name: string;
}

describe("Phase 2l-d parity inventory and public binding", () => {
	it("freezes one complete observable/backend/preservation inventory", () => {
		expect(contract.schemaVersion).toBe(1);
		expect(contract.observableCases).toEqual([
			"builder-sync-rejection-identity",
			"builder-async-rejection-identity",
			"builder-exactly-once",
			"malformed-candidate-old-state",
			"complete-lineage-issued-outbox-recovery-closure",
			"source-and-return-copy-detachment",
			"public-misuse-taxonomy",
			"pending-outbox",
			"post-close-rejection",
		]);
		expect(contract.requiredPreservation).toEqual([
			"phase-0g2i-transactional-issuer",
			"phase-0g2s-strict-admission",
			"phase-0i-public-boundary",
			"storage-ahe",
			"phase-2h-process-death",
			"phase-2k-browser-currency",
			"greenfield-no-plain-id",
		]);
		expect(contract.backends.map(({ id }) => id)).toEqual(["browser", "node"]);
		expect(contract.backends.map(({ allowedPhysicalDivergence }) => allowedPhysicalDivergence)).toEqual([
			[
				"IndexedDB strict readwrite transaction",
				"database identity suffix --drp-issuance-v1",
				"native compound keys",
				"16 request/event death tuples",
			],
			[
				"SQLite BEGIN IMMEDIATE transaction",
				"filename suffix .drp-issuance-v1.sqlite",
				"WITHOUT ROWID tables and WAL sidecars",
				"18 statement-boundary SIGKILL tuples",
			],
		]);
	});

	it("binds the inventory to the accepted 16/18 death and five/five ambiguity registries", () => {
		expect(contract.backends.map(({ deathTupleCount }) => deathTupleCount)).toEqual([
			PHASE_2L_B_DEATH_TUPLES.length,
			PHASE_2L_C_DEATH_TUPLES.length,
		]);
		expect(contract.backends.map(({ ambiguityOutcomeCount }) => ambiguityOutcomeCount)).toEqual([
			PHASE_2L_B_AMBIGUITY_CASES.length,
			PHASE_2L_C_AMBIGUITY_CASES.length,
		]);
		expect(new Set(PHASE_2L_B_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(16);
		expect(new Set(PHASE_2L_C_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(18);
		expect(PHASE_2L_B_AMBIGUITY_CASES).toEqual([
			"exact-pair",
			"absent-old",
			"foreign-pair",
			"torn-or-inconsistent",
			"unreadable",
		]);
		expect(PHASE_2L_C_AMBIGUITY_CASES).toEqual(PHASE_2L_B_AMBIGUITY_CASES);
		expect(new Set(PHASE_2L_B_AMBIGUITY_CASES)).toHaveLength(5);
		expect(new Set(PHASE_2L_C_AMBIGUITY_CASES)).toHaveLength(5);
	});

	it("binds every preservation label to a checked-in executable owner", () => {
		const expectedOwners = {
			"greenfield-no-plain-id": "tests/phase-2l-a-shared-issuance-contract.test.ts",
			"phase-0g2i-transactional-issuer": "tests/protocol-v3-transactional-issuance-0g2i.test.ts",
			"phase-0g2s-strict-admission": "tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts",
			"phase-0i-public-boundary": "tests/fixtures/phase-0i-v3/tsconfig.public-entry-audit.json",
			"phase-2h-process-death": "packages/storage-browser/tests/phase-2h-a-contract-aggregate-red.test.ts",
			"phase-2k-browser-currency": "tests/platform/phase-2k-browser-currency-governance-red.test.ts",
			"storage-ahe": "packages/storage-node/tests/phase-2e4-lifecycle-backend-red.test.ts",
		} as const;
		expect(Object.keys(expectedOwners).sort()).toEqual([...contract.requiredPreservation].sort());
		for (const owner of Object.values(expectedOwners)) {
			expect(readFileSync(resolve(REPOSITORY_ROOT, owner), "utf8").length).toBeGreaterThan(0);
		}
	});

	it("joins the shared 1024 bound to both exact registered vertex scope fields", () => {
		const registry = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json"), "utf8")
		) as { kinds: { vertex: { fields: RegistryField[] } } };
		const scopeFields = registry.kinds.vertex.fields.filter(({ name }) => name === "author" || name === "objectId");
		expect(scopeFields.map(({ name }) => name)).toEqual(["objectId", "author"]);
		expect(scopeFields.map(({ constraints }) => constraints.maximumUtf16Units)).toEqual([1024, 1024]);
		expect(contract.sharedScopeUtf16Units).toBe(MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS);
		expect(contract.sharedScopeUtf16Units).toBe(scopeFields[0]?.constraints.maximumUtf16Units);
		expect(contract.sharedScopeUtf16Units).toBe(scopeFields[1]?.constraints.maximumUtf16Units);
	});

	it("compile-proves mutual issuer/store assignability through only public package subpaths", () => {
		const compiler = resolve(REPOSITORY_ROOT, "node_modules/typescript/lib/tsc.js");
		const config = resolve(CURRENT_DIRECTORY, "fixtures/phase-2l-d/tsconfig.json");
		const result = spawnSync(process.execPath, [compiler, "-p", config], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(`${result.stdout}${result.stderr}`).toBe("");
		expect(result.status).toBe(0);
	});

	it("keeps issuance factories on exact explicit subpaths and absent from both roots", async () => {
		const browserManifest = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/storage-browser/package.json"), "utf8")
		) as { exports: Record<string, unknown> };
		const nodeManifest = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/storage-node/package.json"), "utf8")
		) as { exports: Record<string, unknown> };
		expect(Object.keys(browserManifest.exports).sort()).toEqual([
			".",
			"./issuance",
			"./issuance-maintenance",
			"./live-journal",
			...(Object.hasOwn(browserManifest.exports, "./maintenance") ? ["./maintenance"] : []),
			"./seal-evidence",
			"./seal-vote",
			"./snapshot-transfer",
		]);
		expect(Object.keys(nodeManifest.exports).sort()).toEqual([
			".",
			"./issuance",
			"./issuance-maintenance",
			"./live-journal",
			...(Object.hasOwn(nodeManifest.exports, "./maintenance") ? ["./maintenance"] : []),
			"./snapshot-transfer",
		]);
		expect(contract.backends.map(({ factorySubpath }) => factorySubpath)).toEqual([
			"@ts-drp/storage-browser/issuance",
			"@ts-drp/storage-node/issuance",
		]);
		const browserRoot = await import("@ts-drp/storage-browser");
		const nodeRoot = await import("@ts-drp/storage-node");
		expect(browserRoot).not.toHaveProperty("createBrowserDurableIssuanceStore");
		expect(nodeRoot).not.toHaveProperty("createNodeDurableIssuanceStore");
	});

	it("wires the real browser parity harness into the standing storage-browser gate exactly once", () => {
		const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const standingGate = manifest.scripts?.["e2e-test:storage-browser"] ?? "";
		const config = "packages/storage-browser/playwright.phase-2l-d-parity.config.ts";
		expect(standingGate.split(config)).toHaveLength(2);
		expect(standingGate).toContain(`playwright test --config ${config} --fail-on-flaky-tests`);
	});
});
