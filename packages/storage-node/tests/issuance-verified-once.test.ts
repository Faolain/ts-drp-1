import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueScope } from "@ts-drp/issuance-store";
import {
	resetIssuanceRetirementVerificationCounts,
	closeIssuanceRetirementProtectedRecords,
	decodeIssuanceRetirementControl,
	durableIssuancePruningMaintenanceForStore,
	encodeIssuanceRetirementControl,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementVerificationCounts,
} from "@ts-drp/issuance-store/maintenance";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import {
	resetNodeSettlementPlanRowVerificationCounts,
	nodeSettlementPlanRowVerificationCounts,
} from "../src/internal/node-issuance-store.js";
import { d109bCommit, d109bIssue, d109bPruningInput } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Verify-once work counts for the durable issuance records that every native issue
// re-reads: the retirement control (which embeds whole settlement-plan bytes in its
// plan rewrite) and the stored settlement plan. A verification is a pure function of
// the exact stored bytes, so each distinct byte image needs verifying at most once.

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const scope = { objectId: "verified-once-room", author: "writer" };
// A realistic tens-of-KB retained source context, embedded in the plan and therefore
// in the control's plan rewrite once the retirement commits.
const contextBytes = encodeCanonical({ historicalSource: new Uint8Array(40_000).map((_, index) => index % 251) });
const context = { digest: hashDomain("ts-drp/settlement-source-context/v1", contextBytes), exactCanonicalContextBytes: contextBytes };

async function retiredStore(): Promise<{ store: DurableIssuanceStore; primaryFilename: string; epoch: number }> {
	const directory = await mkdtemp(join(tmpdir(), "issuance-verified-once-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const store = createNodeDurableIssuanceStore({ primaryFilename });
	stores.push(store);
	const commits: DurableIssueCommit[] = [];
	for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch));
	await store.transactWriteSettlementPlan({ scope, expectedRevision: null, plan: {
		scope, revision: 0, fenceSequence: 4, sourceContexts: [context],
		entries: [0, 1, 2].map((sequence) => ({
			sourceContextDigest: context.digest, sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
			disposition: "rebase" as const, replacementSequence: sequence + 1,
		})),
	} });
	// Prune sources 0 and 1, then retire epochs 0..1: the rewrite drops their entries
	// (a completed entry whose source is still held is custody and stays) and keeps
	// the shared context, so both sides of the rewrite carry ~40 KB.
	const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
	await maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, 1));
	const read = await maintenance.acquireRetirementControl!({ objectId: scope.objectId });
	try {
		const native = await maintenance.readBoundedRecoveryCensus!({ objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		const protectedRecords = closeIssuanceRetirementProtectedRecords({ control: read.control, rows: native.rows,
			throughEpoch: 1, protectedRecords: [] });
		const p = issuanceRetirementPreparationWithPlanRewrite(read.control, { throughEpoch: 1,
			decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords }, native.rows);
		expect(p.planRewrite?.plans[0]?.before.byteLength).toBeGreaterThan(40_000);
		expect(p.planRewrite?.plans[0]?.after.byteLength).toBeGreaterThan(40_000);
		await read.prepareFence(p);
	} finally {
		await read.release();
	}
	const prepared = await maintenance.acquireRetirementControl!({ objectId: scope.objectId });
	try {
		const committed = await prepared.commitPrepared();
		expect(committed.completed?.planRewrite).toBeDefined();
	} finally {
		await prepared.release();
	}
	return { store, primaryFilename, epoch: 5 };
}

/** The production issue shape: census, then native admission with quote currency. */
async function nativeIssue(store: DurableIssuanceStore, issueScope: DurableIssueScope, epoch: number): Promise<number> {
	const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
	const census = await maintenance.readBoundedRecoveryCensus!({ objectId: issueScope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
	const expected = {
		expectedIssuanceImageDigest: census.image.imageDigest,
		expectedIssuanceControlBytes: census.control === null ? null : encodeIssuanceRetirementControl(census.control),
	};
	const commit = await store.transactIssue(issueScope, async (sequence, admission) => {
		const fixture = d109bCommit(issueScope, sequence, epoch);
		const bytes = fixture.envelope.canonicalPreimageBytes;
		if (!admission) throw new Error("native admission missing");
		const signature = await admission(bytes, () => Promise.resolve(fixture.envelope.signature), expected);
		const envelope = { canonicalPreimageBytes: bytes, digest: hashDomain("ts-drp/vertex/v3", bytes), signature };
		return { authorSequence: sequence, envelope, issuedRecord: { authorSequence: sequence, envelope, scope: issueScope },
			outboxEntry: { authorSequence: sequence, envelope, scope: issueScope } };
	});
	await store.compareAndMarkOutboxPublished({ scope: issueScope, authorSequence: commit.authorSequence, digest: commit.envelope.digest });
	return commit.authorSequence;
}

function controlRevision(primaryFilename: string): number {
	const database = new DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`, { readOnly: true });
	try {
		const row = database.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(scope.objectId) as { record: Uint8Array };
		return decodeIssuanceRetirementControl(row.record).revision;
	} finally {
		database.close();
	}
}

describe("native issuance verify-once work counts", () => {
	it("verifies each exact control image once and never re-verifies unchanged embedded plans or plan rows", async () => {
		const { store, primaryFilename, epoch } = await retiredStore();
		// Warm: the first issue after the retirement sees the rewrite's plan bytes for the first time.
		await nativeIssue(store, scope, epoch);
		const perIssue: { control: number; plan: number; planRow: number; images: number; reads: number }[] = [];
		for (let index = 1; index <= 4; index++) {
			const before = controlRevision(primaryFilename);
			resetIssuanceRetirementVerificationCounts();
			resetNodeSettlementPlanRowVerificationCounts();
			await nativeIssue(store, scope, epoch + index);
			const counts = issuanceRetirementVerificationCounts();
			perIssue.push({ control: counts.control.verifications, plan: counts.plan.verifications,
				planRow: nodeSettlementPlanRowVerificationCounts().verifications,
				images: controlRevision(primaryFilename) - before + 1,
				reads: counts.control.verifications + counts.control.hits });
		}
		console.info("verify-once per issue", JSON.stringify(perIssue));
		for (const issue of perIssue) {
			// Every distinct control byte image observed during the issue (the starting
			// revision plus each revision the issue writes) is verified at most once.
			expect(issue.control).toBeLessThanOrEqual(issue.images);
			// The embedded plan bytes never change during an ordinary issue.
			expect(issue.plan).toBe(0);
			// Neither does the stored settlement plan row.
			expect(issue.planRow).toBe(0);
		}
	}, 60_000);
});

function rawConnection(primaryFilename: string): DatabaseSync {
	const database = new DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`);
	database.exec("PRAGMA busy_timeout=5000");
	// An out-of-band writer: the store's own trigger guards are not under test here.
	database.function("issuance_retirement_connection", (_objectId) => 1);
	database.function("issuance_retirement_record", (_o, _a, _s, _p, _d) => 1);
	return database;
}

function rawControl(database: DatabaseSync) {
	const row = database.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(scope.objectId) as { record: Uint8Array };
	return decodeIssuanceRetirementControl(row.record);
}

async function censusControl(store: DurableIssuanceStore) {
	const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
	return (await maintenance.readBoundedRecoveryCensus!({ objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS })).control!;
}

describe("native issuance verify-once soundness across connections, rollback and reopen", () => {
	it("sees another connection's committed control bytes and never a verified neighbour, through rollback", async () => {
		const { store, primaryFilename } = await retiredStore();
		const current = await censusControl(store);
		expect(await censusControl(store)).toEqual(current);
		const raw = rawConnection(primaryFilename);
		try {
			// Same byte length, different exact bytes: a later revision of the same control.
			const later = { ...current, revision: current.revision + 7 };
			expect(encodeIssuanceRetirementControl(later).byteLength).toBe(encodeIssuanceRetirementControl(current).byteLength);
			raw.exec("BEGIN IMMEDIATE");
			raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(encodeIssuanceRetirementControl(later), scope.objectId);
			expect(rawControl(raw).revision).toBe(current.revision + 7);
			raw.exec("ROLLBACK");
			expect(rawControl(raw).revision).toBe(current.revision);
			expect((await censusControl(store)).revision).toBe(current.revision);
			raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(encodeIssuanceRetirementControl(later), scope.objectId);
			expect((await censusControl(store)).revision).toBe(current.revision + 7);
			raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(encodeIssuanceRetirementControl(current), scope.objectId);
			expect((await censusControl(store)).revision).toBe(current.revision);
			// A same-length corruption of the verified image is refused, never served from memory.
			const corrupt = encodeIssuanceRetirementControl(current);
			const incarnation = new TextEncoder().encode(current.incarnation);
			const at = corrupt.findIndex((_, index) => incarnation.every((byte, offset) => corrupt[index + offset] === byte));
			corrupt[at] = "z".charCodeAt(0);
			raw.prepare("UPDATE retirement_controls SET record=? WHERE object_id=?").run(corrupt, scope.objectId);
			await expect(censusControl(store)).rejects.toThrow();
		} finally {
			raw.close();
		}
	}, 60_000);

	it("re-reads a settlement plan whose exact stored row changed, through writes, refusals and reopen", async () => {
		const { store: opened, primaryFilename } = await retiredStore();
		let store = opened;
		const plan = (await store.readSettlementPlan(scope))!;
		expect(await store.readSettlementPlan(scope)).toEqual(plan);
		// The returned plan is the caller's own: mutating it cannot reach a later read.
		(plan.entries as unknown[]).length = 0;
		(plan.sourceContexts![0]!.exactCanonicalContextBytes as Uint8Array).fill(0);
		const fresh = (await store.readSettlementPlan(scope))!;
		expect(fresh.entries.length).toBe(1);
		expect(fresh.sourceContexts![0]!.exactCanonicalContextBytes).toEqual(contextBytes);
		// The census hands out the native row plans directly (no outer clone).
		const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
		const census = () => maintenance.readBoundedRecoveryCensus!({ objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		const censusPlan = (await census()).rows.plans[0]!;
		expect(censusPlan).toEqual(fresh);
		(censusPlan.entries as unknown[]).length = 0;
		(censusPlan.sourceContexts![0]!.exactCanonicalContextBytes as Uint8Array).fill(0);
		expect((await census()).rows.plans[0]).toEqual(fresh);
		expect(await store.readSettlementPlan(scope)).toEqual(fresh);
		// A refused write leaves the exact prior row.
		await expect(store.transactWriteSettlementPlan({ scope, expectedRevision: fresh.revision + 5,
			plan: { ...fresh, revision: fresh.revision + 6 } })).rejects.toThrow();
		expect(await store.readSettlementPlan(scope)).toEqual(fresh);
		// An accepted write is read back, and survives reopen.
		await store.transactWriteSettlementPlan({ scope, expectedRevision: fresh.revision, plan: { ...fresh, revision: fresh.revision + 1 } });
		expect((await store.readSettlementPlan(scope))!.revision).toBe(fresh.revision + 1);
		await store.close();
		stores.splice(stores.indexOf(store), 1);
		// Another connection changes only the row's revision column while the store is closed:
		// identical plan text, different exact row. Reopen must refuse it.
		const raw = rawConnection(primaryFilename);
		try {
			raw.prepare("UPDATE settlement_plans SET revision=revision+1 WHERE object_id=? AND author=?").run(scope.objectId, scope.author);
		} finally {
			raw.close();
		}
		store = createNodeDurableIssuanceStore({ primaryFilename, initialization: "reopen" });
		stores.push(store);
		await expect(store.readSettlementPlan(scope)).rejects.toThrow();
	}, 60_000);
});
