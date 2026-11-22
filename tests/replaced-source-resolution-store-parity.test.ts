import "fake-indexeddb/auto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";

import { closeIssuanceRetirementProtectedRecords } from "../packages/issuance-store/src/retirement.js";

import {
	captureFailure,
	errorCode,
	F5B0S_SCOPE,
	pruningInput,
	settlementCommit,
	type TestPlanStore,
	type TestPruningMaintenance,
	type TestSettlementPlan,
} from "./fixtures/phase-6b-d110c-0c1f5b0s/settlement-plan-contract.js";

// fix/creator-replaced-source-resolution (b), conformance parity: the three issuance stores apply one
// structural law. Each accepts the write-once replaced-source frontier resolution on a completed rebase
// of a fenceless plan and reads it back exactly; the retirement closure over each store's own rows then
// stops protecting that source (it still protects the unresolved one). The whole-plan prefix-pruning
// predicate is unchanged: a fenceless plan still permits no authenticated settled prefix either way.

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});
let browserCounter = 0;

type Opened = Readonly<{ store: TestPlanStore; maintenance: TestPruningMaintenance }>;
async function open(adapter: "memory" | "browser" | "node"): Promise<Opened> {
	if (adapter === "memory") {
		const { createEphemeralDurableIssuanceStore, resolveEphemeralDurableIssuancePruningMaintenance } = await import(
			"../packages/issuance-store/src/conformance.js"
		);
		const store = createEphemeralDurableIssuanceStore();
		return {
			store: store as unknown as TestPlanStore,
			maintenance: resolveEphemeralDurableIssuancePruningMaintenance(store) as unknown as TestPruningMaintenance,
		};
	}
	if (adapter === "browser") {
		const [{ createBrowserDurableIssuanceStore }, { resolveBrowserDurableIssuancePruningMaintenance }] = await Promise.all([
			import("../packages/storage-browser/src/issuance.js"),
			import("../packages/storage-browser/src/issuance-maintenance.js"),
		]);
		const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: `replaced-source-${browserCounter++}` });
		return {
			store: store as unknown as TestPlanStore,
			maintenance: resolveBrowserDurableIssuancePruningMaintenance(store) as unknown as TestPruningMaintenance,
		};
	}
	const directory = await mkdtemp(join(tmpdir(), "replaced-source-"));
	directories.push(directory);
	const [{ createNodeDurableIssuanceStore }, { resolveNodeDurableIssuancePruningMaintenance }] = await Promise.all([
		import("../packages/storage-node/src/issuance.js"),
		import("../packages/storage-node/src/issuance-maintenance.js"),
	]);
	const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
	return {
		store: store as unknown as TestPlanStore,
		maintenance: resolveNodeDurableIssuancePruningMaintenance(store) as unknown as TestPruningMaintenance,
	};
}

const receiptBytes = encodeCanonical({ marker: "replaced-source-receipt" });
const receipt = { digest: hashDomain("ts-drp/settlement-source-context/v1", receiptBytes), exactCanonicalContextBytes: receiptBytes };

/**
 * Issues the source (0) and its replacement (1), both published, under a fenceless plan whose
 * entry 0 is a completed rebase; optionally adds the replaced-source resolution in a later write.
 * @param opened - The store under test.
 * @param withResolution - Whether to add the resolution.
 * @returns The lineage after both rows.
 */
async function replacedSource(opened: Opened, withResolution: boolean) {
	const { store } = opened;
	const source = await store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
		Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence))
	);
	await store.compareAndMarkOutboxPublished({ authorSequence: 0, digest: source.envelope.digest, scope: F5B0S_SCOPE });
	const entry = { disposition: "rebase", replacementSequence: null, sourceDigest: source.envelope.digest, sourceSequence: 0 };
	await store.transactWriteSettlementPlan({ expectedRevision: null, scope: F5B0S_SCOPE,
		plan: { entries: [entry], fenceSequence: null, revision: 0, scope: F5B0S_SCOPE } as TestSettlementPlan });
	const replacement = await store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
		Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence, { kind: "replacement", sourceSequence: 0 }))
	);
	await store.compareAndMarkOutboxPublished({ authorSequence: 1, digest: replacement.envelope.digest, scope: F5B0S_SCOPE });
	const linked = await store.readSettlementPlan(F5B0S_SCOPE);
	expect(linked?.entries[0]?.replacementSequence).toBe(1);
	if (withResolution) {
		await store.transactWriteSettlementPlan({ expectedRevision: linked!.revision, scope: F5B0S_SCOPE,
			plan: { ...linked!, revision: linked!.revision + 1, sourceContexts: [receipt],
				entries: [{ ...linked!.entries[0]!, sourceResolutionDigest: receipt.digest, sourceResolutionKind: "frontier",
					sourceResolutionScope: "replaced-source" }] } as unknown as TestSettlementPlan });
	}
	return opened.maintenance.inspectPruningState(F5B0S_SCOPE);
}

type Opened2 = Opened;
/** The store's own rows for the retirement closure (outbox page: issued and outbox rows). */
async function retirementRows(opened: Opened2) {
	const { store } = opened;
	const state = await opened.maintenance.inspectPruningState(F5B0S_SCOPE);
	const page = await (store as unknown as { readOutboxPage(input: unknown): Promise<{ commit: { authorSequence: number;
		envelope: { canonicalPreimageBytes: Uint8Array; digest: Uint8Array; signature: Uint8Array } }; publishState: "pending" | "published" }[]> })
		.readOutboxPage({ scope: F5B0S_SCOPE, limit: 16 });
	const plan = await store.readSettlementPlan(F5B0S_SCOPE);
	// The fixture's row digests are two bytes; the closure validates 32-byte digests, so every digest
	// (rows and plan entries alike) is widened by one injective map.
	const wide = (digest: Uint8Array) => hashDomain("replaced-source-parity/v1", digest);
	return {
		lineages: [{ ...F5B0S_SCOPE, next: state.lineage.next, exhausted: state.lineage.exhausted,
			prunedThroughAuthorSequence: state.prunedThroughAuthorSequence }],
		issued: page.map(row => ({ ...F5B0S_SCOPE, authorSequence: row.commit.authorSequence,
			canonicalPreimageBytes: row.commit.envelope.canonicalPreimageBytes, digest: wide(row.commit.envelope.digest),
			signature: new Uint8Array(64).fill(row.commit.authorSequence + 1) })),
		outbox: page.map(row => ({ ...F5B0S_SCOPE, authorSequence: row.commit.authorSequence, digest: wide(row.commit.envelope.digest),
			publishState: row.publishState })),
		plans: plan === null ? [] : [{ ...plan, entries: plan.entries.map(entry => ({ ...entry, sourceDigest: wide(entry.sourceDigest) })) }],
	};
}
const control = { kind: "v3-issuance-retirement-control-1", objectId: F5B0S_SCOPE.objectId, incarnation: "c".repeat(64),
	revision: 0, sequence: 0, active: null, completed: null } as const;
const held = async (opened: Opened2) => closeIssuanceRetirementProtectedRecords({ control: control as never,
	rows: (await retirementRows(opened)) as never, throughEpoch: 9, protectedRecords: [] }).map(hole => hole.authorSequence);

describe("replaced-source frontier resolution: store parity", () => {
	it.each(["memory", "browser", "node"] as const)("%s stores the resolution and its retirement releases the source", async (adapter) => {
		const opened = await open(adapter);
		try {
			const state = await replacedSource(opened, true);
			const plan = await opened.store.readSettlementPlan(F5B0S_SCOPE);
			expect(plan?.entries[0]).toMatchObject({ disposition: "rebase", replacementSequence: 1, sourceResolutionKind: "frontier",
				sourceResolutionScope: "replaced-source" });
			expect(await held(opened), "the resolved replaced source of a fenceless plan is not protected").not.toContain(0);
			// The whole-plan predicate is unchanged: no fenceless authenticated prefix.
			const error = await captureFailure(opened.maintenance.pruneAuthenticatedSettledPrefix(pruningInput(state.lineage, 0)));
			expect(errorCode(error)).toBe("ISSUANCE_RETRY_REQUIRED");
		} finally {
			await opened.store.close();
		}
	});

	it.each(["memory", "browser", "node"] as const)("%s keeps protecting an unresolved replaced source of a fenceless plan", async (adapter) => {
		const opened = await open(adapter);
		try {
			const state = await replacedSource(opened, false);
			expect(await held(opened)).toContain(0);
			const error = await captureFailure(opened.maintenance.pruneAuthenticatedSettledPrefix(pruningInput(state.lineage, 0)));
			expect(errorCode(error)).toBe("ISSUANCE_RETRY_REQUIRED");
			expect(await opened.store.readIssued(F5B0S_SCOPE, 0)).not.toBeNull();
		} finally {
			await opened.store.close();
		}
	});
});
