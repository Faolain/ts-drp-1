import "fake-indexeddb/auto";

import type { DurableIssueCommit, DurableIssuanceStore } from "@ts-drp/issuance-store";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
	D109B_CRASH_EDGES,
	D109B_GREEN_PATHS,
	D109B_NATIVE_MUTANTS,
	D109B_NODE_MIGRATION_CASES,
	D109B_OTHER_SCOPE,
	D109B_PAGE_BOUNDARIES,
	D109B_RED_PATHS,
	D109B_SCOPE,
	D109B_SEMANTIC_CASES,
	d109bDeepFrozen,
	d109bErrorCode,
	d109bIssue,
	d109bPruningInput,
	type D109bConformanceModule,
} from "./fixtures/phase-6b/issuance-retention-contract.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const REQUIRED_SHARED_OWNERS = Object.freeze([
	"packages/issuance-store/src/maintenance.ts",
	"packages/issuance-store/src/conformance.ts",
	"packages/issuance-store/src/terminal.ts",
	"packages/issuance-store/src/types.ts",
] as const);

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = REQUIRED_SHARED_OWNERS.filter((path) => {
		if (!existsSync(resolve(REPOSITORY_ROOT, path))) return true;
		const source = readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
		if (path.endsWith("maintenance.ts")) return !source.includes("prunePublishedPrefix");
		if (path.endsWith("conformance.ts")) return !source.includes("resolveEphemeralDurableIssuancePruningMaintenance");
		if (path.endsWith("terminal.ts")) return !source.includes("prunedThroughAuthorSequence");
		return !source.includes("ISSUANCE_RECORD_PRUNED");
	});
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

async function candidate(): Promise<D109bConformanceModule> {
	return import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/issuance-store/src/conformance.ts")).href
	) as Promise<D109bConformanceModule>;
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

async function opened(): Promise<{
	readonly maintenance: NonNullable<
		ReturnType<D109bConformanceModule["resolveEphemeralDurableIssuancePruningMaintenance"]>
	>;
	readonly store: DurableIssuanceStore;
}> {
	const module = await candidate();
	const store = module.createEphemeralDurableIssuanceStore();
	const maintenance = module.resolveEphemeralDurableIssuancePruningMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109B_EPHEMERAL_MAINTENANCE_MISSING");
	return { maintenance, store };
}

const state = readiness();

describe("D.109b issuance-retention causal RED", () => {
	it("freezes the exact RED/GREEN owners, semantic matrix, page edges, native mutants, migration cases and crash edges", () => {
		expect(D109B_RED_PATHS).toHaveLength(8);
		expect(new Set(D109B_RED_PATHS).size).toBe(D109B_RED_PATHS.length);
		expect(D109B_GREEN_PATHS).toHaveLength(9);
		expect(D109B_PAGE_BOUNDARIES).toEqual([64, 65, 128, 129]);
		expect(D109B_SEMANTIC_CASES).toHaveLength(27);
		expect(D109B_NATIVE_MUTANTS).toHaveLength(17);
		expect(D109B_NODE_MIGRATION_CASES).toHaveLength(10);
		expect(D109B_CRASH_EDGES).toEqual([
			"before-delete",
			"after-issued-delete",
			"after-pair-delete",
			"after-watermark-write",
			"before-commit",
			"after-commit",
		]);
		for (const path of D109B_RED_PATHS) expect(path.endsWith(".ts") || path.endsWith(".mjs")).toBe(true);
	});

	it("[RED readiness] requires the shared maintenance owner, resolver, watermark observation and pruned error", () => {
		expect(state, "D109B_SHARED_MAINTENANCE_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!state.ready)(
		"resolves only the exact genuine facade and returns detached frozen inspection state",
		async () => {
			const module = await candidate();
			const store = module.createEphemeralDurableIssuanceStore();
			try {
				const maintenance = module.resolveEphemeralDurableIssuancePruningMaintenance(store);
				expect(maintenance).toBeDefined();
				expect(module.resolveEphemeralDurableIssuancePruningMaintenance({ ...store })).toBeUndefined();
				expect(module.resolveEphemeralDurableIssuancePruningMaintenance(new Proxy(store, {}))).toBeUndefined();
				if (maintenance === undefined) return;
				const inspected = await maintenance.inspectPruningState(D109B_SCOPE);
				expect(inspected).toEqual({
					lineage: { exhausted: false, next: 0 },
					prunedThroughAuthorSequence: null,
					scope: D109B_SCOPE,
				});
				expect(inspected.scope).not.toBe(D109B_SCOPE);
				expect(d109bDeepFrozen(inspected)).toBe(true);
			} finally {
				await store.close();
			}
		}
	);

	it.skipIf(!state.ready)(
		"atomically removes a published prefix and replays the same lost-receipt input as a no-op",
		async () => {
			const { maintenance, store } = await opened();
			try {
				const commits: DurableIssueCommit[] = [];
				for (let index = 0; index < 3; index += 1) commits.push(await d109bIssue(store, D109B_SCOPE, 4));
				await d109bIssue(store, D109B_OTHER_SCOPE, 4);
				const before = await maintenance.inspectPruningState(D109B_SCOPE);
				const input = d109bPruningInput(before, 4, 1);
				const receipt = await maintenance.prunePublishedPrefix(input);
				expect(receipt).toMatchObject({
					closedEpoch: 4,
					deletedAuthorSequenceRange: { from: 0, through: 1 },
					observedLineage: { exhausted: false, next: 3 },
					prunedThroughAuthorSequence: 1,
					scope: D109B_SCOPE,
				});
				expect(Object.keys(receipt).sort()).toEqual([
					"closedEpoch",
					"commitQcRef",
					"deletedAuthorSequenceRange",
					"observedLineage",
					"prunedThroughAuthorSequence",
					"scope",
					"snapshotManifestDigest",
				]);
				expect(d109bDeepFrozen(receipt)).toBe(true);
				expect(await store.readIssued(D109B_SCOPE, 0)).toBeNull();
				expect(await store.readIssued(D109B_SCOPE, 2)).toEqual(commits[2]);
				expect(await store.readIssued(D109B_OTHER_SCOPE, 0)).not.toBeNull();
				expect(await store.readLineage(D109B_SCOPE)).toEqual({ exhausted: false, next: 3 });
				expect((await store.readOutboxPage({ scope: D109B_SCOPE })).map(({ commit }) => commit.authorSequence)).toEqual(
					[2]
				);
				const replay = await maintenance.prunePublishedPrefix(input);
				expect(replay.deletedAuthorSequenceRange).toBeNull();
				expect(replay.prunedThroughAuthorSequence).toBe(1);
				for (const digest of [commits[0]?.envelope.digest, Uint8Array.of(255)]) {
					if (digest === undefined) throw new TypeError("D109B_COMMIT_MISSING");
					const error = await capture(
						store.compareAndMarkOutboxPublished({ authorSequence: 0, digest, scope: D109B_SCOPE })
					);
					expect(d109bErrorCode(error)).toBe("ISSUANCE_RECORD_PRUNED");
					expect(Object.keys(error as object).sort()).toEqual(["authorSequence", "code", "scope"]);
				}
			} finally {
				await store.close();
			}
		}
	);

	it.skipIf(!state.ready)(
		"keeps a valid pending prefix non-poisoning and a newer pending suffix outside the selected range",
		async () => {
			const { maintenance, store } = await opened();
			try {
				const published = await d109bIssue(store, D109B_SCOPE, 7);
				await d109bIssue(store, D109B_SCOPE, 8, false);
				const stateBefore = await maintenance.inspectPruningState(D109B_SCOPE);
				const pendingError = await capture(maintenance.prunePublishedPrefix(d109bPruningInput(stateBefore, 8, 1)));
				expect(d109bErrorCode(pendingError)).toBe("ISSUANCE_RETRY_REQUIRED");
				expect(await store.readLineage(D109B_SCOPE)).toEqual({ exhausted: false, next: 2 });
				const wrongEpoch = await capture(maintenance.prunePublishedPrefix(d109bPruningInput(stateBefore, 8, 0)));
				expect(d109bErrorCode(wrongEpoch)).toBe("ISSUANCE_INVALID_ARGUMENT");
				expect(await store.readIssued(D109B_SCOPE, 0)).toEqual(published);
			} finally {
				await store.close();
			}
		}
	);

	it.skipIf(!state.ready).each(D109B_PAGE_BOUNDARIES)(
		"walks the exact bounded-page edge %i without retaining the selected prefix",
		async (count) => {
			const { maintenance, store } = await opened();
			try {
				for (let index = 0; index < count; index += 1) await d109bIssue(store, D109B_SCOPE, 11);
				const before = await maintenance.inspectPruningState(D109B_SCOPE);
				const receipt = await maintenance.prunePublishedPrefix(d109bPruningInput(before, 11, count - 1));
				expect(receipt.deletedAuthorSequenceRange).toEqual({ from: 0, through: count - 1 });
				expect(await store.readOutboxPage({ scope: D109B_SCOPE })).toEqual([]);
			} finally {
				await store.close();
			}
		}
	);
});
