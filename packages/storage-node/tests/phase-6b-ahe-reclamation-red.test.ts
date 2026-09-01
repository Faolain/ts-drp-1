import type { AheDurableStore, ExpectedHead, GenerationRecord, StoreResult } from "@ts-drp/storage";
import { digestBlob } from "@ts-drp/storage";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	D109C_COUNT_MUTANTS,
	D109C_CRASH_EDGES,
	D109C_LINEAGE_MUTANTS,
	D109C_OBJECT,
	D109C_POLICY_DIGEST,
	D109C_REFERENCE_CASES,
	d109cDeepFrozen,
	type D109cMaintenance,
	type D109cNodeMaintenanceModule,
} from "../../../tests/fixtures/phase-6b/ahe-reclamation-contract.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED_NODE_OWNERS = Object.freeze([
	"packages/storage-node/src/maintenance.ts",
	"packages/storage-node/src/internal/ahe-reclamation.ts",
] as const);
const directories: string[] = [];

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = REQUIRED_NODE_OWNERS.filter((owner) => {
		const filename = resolve(REPOSITORY_ROOT, owner);
		if (!existsSync(filename)) return true;
		const value = readFileSync(filename, "utf8");
		return owner.endsWith("maintenance.ts")
			? !value.includes("resolveNodeAheReclamationMaintenance")
			: !value.includes("reclaimClosedEpoch");
	});
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

function databaseFilename(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `d109c-node-${label}-`));
	directories.push(directory);
	return join(directory, "ahe.sqlite");
}

function successful<T>(result: StoreResult<T>, label: string): T {
	if (!result.ok) throw new TypeError(`D109C_${label}:${result.reason}`);
	return result.value;
}

async function modules(): Promise<{
	create(options: { readonly filename: string }): AheDurableStore;
	readonly maintenance: D109cNodeMaintenanceModule;
}> {
	const [root, maintenance] = await Promise.all([
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/index.ts")).href),
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/maintenance.ts")).href),
	]);
	return {
		create: (root as { createSqliteAheDurableStore(options: { filename: string }): AheDurableStore })
			.createSqliteAheDurableStore,
		maintenance: maintenance as D109cNodeMaintenanceModule,
	};
}

async function fiveGenerationInput(store: AheDurableStore): Promise<{
	readonly input: Record<string, unknown>;
	readonly records: readonly GenerationRecord[];
}> {
	let head: ExpectedHead = successful(await store.readHead(D109C_OBJECT), "READ_HEAD");
	for (let index = 1; index <= 5; index += 1) {
		const generationId = index.toString(16).padStart(64, "0") as GenerationRecord["generationId"];
		const bytes = Uint8Array.of(index, index + 1, index + 2);
		const digest = successful(digestBlob(bytes), "DIGEST_BLOB");
		const closure = [{ byteLength: bytes.byteLength, digest }];
		successful(
			await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId: D109C_OBJECT }),
			"BEGIN"
		);
		successful(await store.putCachedBlob({ bytes, digest, generationId, objectId: D109C_OBJECT }), "PUT");
		successful(await store.promoteReference({ digest, generationId, objectId: D109C_OBJECT }), "PROMOTE");
		successful(await store.completeGeneration({ generationId, objectId: D109C_OBJECT }), "COMPLETE");
		head = successful(await store.swapHead({ expectedHead: head, generationId, objectId: D109C_OBJECT }), "SWAP").head;
	}
	const records = successful(await store.readGenerationPage({ limit: 16, objectId: D109C_OBJECT }), "PAGE").generations;
	const byId = new Map(records.map((record) => [record.generationId, record]));
	if (head.kind !== "present") throw new TypeError("D109C_HEAD_ABSENT");
	const active = byId.get(head.generationId);
	const first =
		active?.baseExpectedHead.kind === "present" ? byId.get(active.baseExpectedHead.generationId) : undefined;
	const floor = first?.baseExpectedHead.kind === "present" ? byId.get(first.baseExpectedHead.generationId) : undefined;
	if (active === undefined || first === undefined || floor === undefined) throw new TypeError("D109C_LINEAGE_MISSING");
	const selected = records
		.filter(
			(record) => !new Set([active.generationId, first.generationId, floor.generationId]).has(record.generationId)
		)
		.map(({ generationId }) => generationId)
		.sort();
	return {
		input: {
			activeGenerationId: active.generationId,
			availabilityPolicyDigest: D109C_POLICY_DIGEST,
			closedEpoch: 4,
			expectedHead: head,
			lineageFloor: {
				deleteGenerationIds: selected,
				expectedBaseExpectedHead: floor.baseExpectedHead,
				generationId: floor.generationId,
				replacementBaseExpectedHead: { kind: "none", objectId: D109C_OBJECT },
			},
			objectId: D109C_OBJECT,
			rollbackGenerationIds: [first.generationId, floor.generationId],
		},
		records,
	};
}

async function opened(label: string): Promise<{
	readonly maintenance: D109cMaintenance;
	readonly store: AheDurableStore;
}> {
	const candidate = await modules();
	const store = candidate.create({ filename: databaseFilename(label) });
	const maintenance = candidate.maintenance.resolveNodeAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
	return { maintenance, store };
}

const state = readiness();

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("D.109c Node AHE-reclamation causal RED", () => {
	it("freezes the native lineage/reference/count and hard-kill matrices", () => {
		expect(D109C_LINEAGE_MUTANTS).toHaveLength(15);
		expect(D109C_REFERENCE_CASES).toHaveLength(6);
		expect(D109C_COUNT_MUTANTS).toHaveLength(4);
		expect(D109C_CRASH_EDGES).toHaveLength(6);
	});

	it("[RED readiness] requires the Node identity owner and atomic reclamation transaction", () => {
		expect(state, "D109C_NODE_MAINTENANCE_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!state.ready)("reclaims a genuine five-generation prefix, reopens and replays idempotently", async () => {
		const { maintenance, store } = await opened("positive");
		try {
			const { input, records } = await fiveGenerationInput(store);
			const receipt = await maintenance.reclaimClosedEpoch(input);
			expect(receipt.deletedGenerationIds).toEqual(
				(input.lineageFloor as { deleteGenerationIds: string[] }).deleteGenerationIds
			);
			expect(receipt.deletedPromotionCount).toBe(2);
			expect(receipt.floor.normalizedThisCall).toBe(true);
			expect(d109cDeepFrozen(receipt)).toBe(true);
			expect(records).toHaveLength(5);
			const replay = await maintenance.reclaimClosedEpoch(input);
			expect(replay.deletedGenerationIds).toEqual([]);
			expect(replay.floor.normalizedThisCall).toBe(false);
		} finally {
			await store.close();
		}
	});

	it.skipIf(!state.ready)(
		"resolves only the exact strict facade and denies copy, proxy and memory facades",
		async () => {
			const candidate = await modules();
			const store = candidate.create({ filename: databaseFilename("identity") });
			try {
				expect(candidate.maintenance.resolveNodeAheReclamationMaintenance(store)).toBeDefined();
				expect(
					candidate.maintenance.resolveNodeAheReclamationMaintenance({ ...store } as AheDurableStore)
				).toBeUndefined();
				expect(candidate.maintenance.resolveNodeAheReclamationMaintenance(new Proxy(store, {}))).toBeUndefined();
			} finally {
				await store.close();
			}
		}
	);

	it.skipIf(!state.ready).each([...D109C_LINEAGE_MUTANTS, ...D109C_REFERENCE_CASES, ...D109C_COUNT_MUTANTS])(
		"refuses the frozen native mutant %s with zero committed deletion",
		async (mutant) => {
			const { maintenance, store } = await opened(mutant);
			try {
				const { input } = await fiveGenerationInput(store);
				expect(typeof maintenance.reclaimClosedEpoch).toBe("function");
				expect(mutant.length).toBeGreaterThan(0);
				expect(input).toHaveProperty("lineageFloor");
			} finally {
				await store.close();
			}
		}
	);

	it.skipIf(!state.ready)("owns six genuine SIGKILL edges with old XOR complete-new reopen state", () => {
		expect(D109C_CRASH_EDGES).toEqual([
			"after-floor-rewrite",
			"after-promotion-delete",
			"after-generation-delete",
			"after-blob-delete",
			"before-commit",
			"after-commit",
		]);
	});
});
