/* eslint-disable @typescript-eslint/explicit-function-return-type -- Conformance helpers retain inferred report types. */
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
	DurableUnsignedBatchIntent,
	SettlementPlan,
	SettlementPlanEntry,
} from "@ts-drp/issuance-store";

// transactIssueBatch conformance, one driver for every store (ephemeral control, SQLite, IndexedDB).
// Each case opens fresh stores from the factory and returns a plain report the caller asserts:
// - commit:        a batch of 8 replacements lands whole; lineage +8; plan bytes AND revision equal
//                  to 8 single transactIssue calls of the same rows (revision equivalence);
// - revision-cas:  a stale expectedPlanRevision refuses (ISSUANCE_RETRY_REQUIRED) before any signature,
//                  nothing written;
// - validation:    a commit at the wrong sequence refuses the whole batch (ISSUANCE_COMMIT_INVALID),
//                  nothing written;
// - duplicate:     two effects on one source refuse before any signature, nothing written;
// - mixed:         plan-effect and ordinary commits never share a batch;
// - precondition:  an entry already replaced refuses the batch before any signature, nothing written;
// - progress:      a source split in two replacement chunks across two batches leaves the plan in the
//                  same partial and final progress states as the same singles;
// - resume (native stores only): a batch that fails after its entered marker reports
//                  ISSUANCE_OUTCOME_UNKNOWN, writes no row, and the same whole batch then commits.

export type BatchStoreFactory = (name: string) => Promise<DurableIssuanceStore>;

export const SCOPE: DurableIssueScope = Object.freeze({ objectId: "issuance-batch-room", author: "c".repeat(64) });
const hex = (seed: number): string => seed.toString(16).padStart(64, "0");
const digestOf = (bytes: Uint8Array) => hashDomain("ts-drp/vertex/v3", bytes);

function preimage(sequence: number, epoch: number, operation: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({
		anchor: hex(epoch + 1),
		author: SCOPE.author,
		authorSequence: sequence,
		dependencies: [hex(1_000_000 + sequence)],
		epoch,
		kind: "drp-vertex",
		logicalTime: 1_000 + 2 * sequence,
		objectId: SCOPE.objectId,
		operation,
		protocolMajor: 3,
	});
}

const move = (sequence: number, epoch: number) => preimage(sequence, epoch, { action: "place", id: `m-${sequence}`, x: 1, y: 2 });

function commitOf(sequence: number, bytes: Uint8Array, signature: Uint8Array, planEffect?: DurableIssueCommit["planEffect"]) {
	const envelope = { canonicalPreimageBytes: bytes, digest: digestOf(bytes), signature };
	return {
		authorSequence: sequence,
		envelope,
		issuedRecord: { authorSequence: sequence, envelope, scope: SCOPE },
		outboxEntry: { authorSequence: sequence, envelope, scope: SCOPE },
		...(planEffect === undefined ? {} : { planEffect }),
	} as DurableIssueCommit;
}

const signatureFor = (sequence: number) => new Uint8Array(64).fill((sequence % 250) + 1);

type Row = Readonly<{ effect?: DurableIssueCommit["planEffect"]; bytes: (sequence: number) => Uint8Array }>;

/** One single issue as the live plane drives it (native admission when the store offers it). */
async function issueOne(store: DurableIssuanceStore, row: Row): Promise<DurableIssueCommit> {
	return store.transactIssue(SCOPE, async (sequence, admission) => {
		const bytes = row.bytes(sequence);
		const signature =
			admission === undefined
				? signatureFor(sequence)
				: await admission(bytes, () => Promise.resolve(signatureFor(sequence)),
						row.effect === undefined ? undefined : { planEffect: row.effect });
		return commitOf(sequence, bytes, signature, row.effect);
	});
}

type BatchOptions = Readonly<{
	expectedPlanRevision?: number | null;
	/** Alter the returned commits after signing (validation / resume cases). */
	tamper?: (commits: DurableIssueCommit[]) => DurableIssueCommit[];
	/** Skip the native admission even when offered (raw builder). */
	raw?: boolean;
}>;

/** One batch, driven as the drain drives it; returns the commits or the refusal, and the signatures made. */
export async function issueBatch(store: DurableIssuanceStore, rows: readonly Row[], options: BatchOptions = {}) {
	const signed: number[] = [];
	const batch = store.transactIssueBatch;
	if (batch === undefined) throw new Error("store has no transactIssueBatch");
	const expectedPlanRevision =
		options.expectedPlanRevision !== undefined
			? options.expectedPlanRevision
			: ((await store.readSettlementPlan(SCOPE))?.revision ?? null);
	try {
		const commits = await batch({ scope: SCOPE, count: rows.length, expectedPlanRevision }, async (first, admission) => {
			const intents: DurableUnsignedBatchIntent[] = rows.map((row, index) => ({
				exactCanonicalUnsignedVertexBytes: row.bytes(first + index),
				...(row.effect === undefined ? {} : { planEffect: row.effect }),
			}));
			const signatures =
				admission === undefined || options.raw === true
					? intents.map((_, index) => {
							signed.push(first + index);
							return signatureFor(first + index);
						})
					: await admission(intents, (index) => {
							signed.push(first + index);
							return Promise.resolve(signatureFor(first + index));
						});
			const commits = intents.map((intent, index) =>
				commitOf(first + index, intent.exactCanonicalUnsignedVertexBytes, signatures[index]!, rows[index]!.effect)
			);
			return options.tamper === undefined ? commits : options.tamper(commits);
		});
		return { ok: true as const, commits, signed };
	} catch (error) {
		return { ok: false as const, code: String((error as { code?: unknown }).code), message: String((error as Error).message), signed };
	}
}

const rebase = (sourceSequence: number, sourceDigest: Uint8Array): SettlementPlanEntry => ({
	sourceSequence,
	sourceDigest,
	disposition: "rebase",
	replacementSequence: null,
});

/** Epoch-0 moves, then the plan over them and its fence (single issue), as an install leaves them. */
export async function settledStore(factory: BatchStoreFactory, name: string, moves: number, progress?: Readonly<Record<number, Uint8Array>>) {
	const store = await factory(name);
	const sources: DurableIssueCommit[] = [];
	for (let index = 0; index < moves; index++) sources.push(await issueOne(store, { bytes: (sequence) => move(sequence, 0) }));
	const plan: SettlementPlan = {
		scope: SCOPE,
		revision: 0,
		fenceSequence: null,
		entries: sources.map((source) => {
			const entry = rebase(source.authorSequence, source.envelope.digest);
			const intentDigest = progress?.[source.authorSequence];
			return intentDigest === undefined
				? entry
				: { ...entry, replacementProgress: { version: 1 as const, intentCount: 4, intentDigest, chunks: [] } };
		}),
	};
	await store.transactWriteSettlementPlan({ scope: SCOPE, expectedRevision: null, plan });
	await issueOne(store, {
		effect: { kind: "fence" },
		bytes: (sequence) => preimage(sequence, 1, { action: "$drp.author-fence.v1", fenceSequence: sequence, version: 1 }),
	});
	return { store, sources };
}

export const replacement = (sourceSequence: number): Row => ({
	effect: { kind: "replacement", sourceSequence },
	bytes: (sequence) => preimage(sequence, 1, { action: "place", id: `m-${sourceSequence}`, x: 1, y: 2 }),
});

export async function snapshot(store: DurableIssuanceStore, from: number, through: number) {
	const lineage = await store.readLineage(SCOPE);
	const issued: (number | null)[] = [];
	for (let sequence = from; sequence <= through; sequence++)
		issued.push((await store.readIssued(SCOPE, sequence).catch(() => null))?.authorSequence ?? null);
	const plan = await store.readSettlementPlan(SCOPE);
	const pending = (await store.readOutboxPage({ scope: SCOPE, limit: 128 })).filter((row) => row.publishState === "pending").length;
	return {
		lineage,
		issued,
		planRevision: plan?.revision ?? null,
		planBytes: plan === null ? null : Array.from(encodeCanonical(plan)),
		pendingOutbox: pending,
	};
}

const sameBytes = (left: readonly number[] | null, right: readonly number[] | null) =>
	JSON.stringify(left) === JSON.stringify(right);

export async function runBatchConformance(factory: BatchStoreFactory, native: boolean) {
	const report: Record<string, unknown> = {};

	// commit + revision equivalence
	{
		const batched = await settledStore(factory, "commit-batch", 8);
		const singles = await settledStore(factory, "commit-singles", 8);
		const rows = batched.sources.map((source) => replacement(source.authorSequence));
		const before = await snapshot(batched.store, 9, 16);
		const result = await issueBatch(batched.store, rows);
		for (const row of rows) await issueOne(singles.store, row);
		const after = await snapshot(batched.store, 9, 16);
		const twin = await snapshot(singles.store, 9, 16);
		report.commit = {
			ok: result.ok,
			sequences: result.ok ? result.commits.map((commit) => commit.authorSequence) : [],
			signed: result.signed,
			lineageBefore: before.lineage,
			lineageAfter: after.lineage,
			issuedAfter: after.issued,
			revisionBefore: before.planRevision,
			revisionAfter: after.planRevision,
			revisionSingles: twin.planRevision,
			planEqualsSingles: sameBytes(after.planBytes, twin.planBytes),
			pendingOutbox: after.pendingOutbox,
			replaced: (await batched.store.readSettlementPlan(SCOPE))?.entries.map((entry) => entry.replacementSequence),
		};
	}

	// revision CAS
	{
		const { store, sources } = await settledStore(factory, "revision-cas", 3);
		const before = await snapshot(store, 4, 6);
		const result = await issueBatch(store, sources.map((source) => replacement(source.authorSequence)), {
			expectedPlanRevision: (before.planRevision ?? 0) - 1,
		});
		const after = await snapshot(store, 4, 6);
		const retry = await issueBatch(store, sources.map((source) => replacement(source.authorSequence)));
		report.revisionCas = {
			ok: result.ok,
			code: result.ok ? null : result.code,
			signed: result.signed.length,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
			retryOk: retry.ok,
		};
	}

	// per-commit validation (raw builder: the store's own validation, no crypto admission)
	{
		const { store, sources } = await settledStore(factory, "validation", 4);
		const before = await snapshot(store, 5, 8);
		const result = await issueBatch(store, sources.map((source) => replacement(source.authorSequence)), {
			raw: true,
			tamper: (commits) => commits.map((commit, index) => (index === 2 ? { ...commit, authorSequence: commit.authorSequence + 1 } : commit)),
		});
		const after = await snapshot(store, 5, 8);
		report.validation = { ok: result.ok, code: result.ok ? null : result.code, unchanged: JSON.stringify(before) === JSON.stringify(after) };
	}

	// duplicate effect target and mixed batches: refused before any signature, nothing written
	{
		const { store, sources } = await settledStore(factory, "duplicate", 3);
		const before = await snapshot(store, 4, 6);
		const first = sources[0]!.authorSequence;
		const duplicate = await issueBatch(store, [replacement(first), replacement(sources[1]!.authorSequence), replacement(first)]);
		const mixed = await issueBatch(store, [replacement(first), { bytes: (sequence) => move(sequence, 1) }]);
		const after = await snapshot(store, 4, 6);
		const valid = await issueBatch(store, sources.map((source) => replacement(source.authorSequence)));
		report.duplicate = {
			duplicateOk: duplicate.ok,
			duplicateCode: duplicate.ok ? null : duplicate.code,
			duplicateSigned: duplicate.signed.length,
			mixedOk: mixed.ok,
			mixedCode: mixed.ok ? null : mixed.code,
			mixedSigned: mixed.signed.length,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
			thenValidOk: valid.ok,
		};
	}

	// precondition: an entry another write already replaced refuses the whole batch before crypto
	{
		const { store, sources } = await settledStore(factory, "precondition", 3);
		await issueOne(store, replacement(sources[1]!.authorSequence));
		const before = await snapshot(store, 5, 7);
		const result = await issueBatch(store, sources.map((source) => replacement(source.authorSequence)));
		const after = await snapshot(store, 5, 7);
		const rest = await issueBatch(store, [replacement(sources[0]!.authorSequence), replacement(sources[2]!.authorSequence)]);
		report.precondition = {
			ok: result.ok,
			code: result.ok ? null : result.code,
			signed: result.signed.length,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
			restOk: rest.ok,
		};
	}

	// a multi-intent source split into two chunks across two batches = the same singles
	{
		const intentDigest = new Uint8Array(32).fill(7);
		const chunk = (source: number, fromIntent: number, throughIntent: number): Row => ({
			effect: { kind: "replacement", sourceSequence: source, fromIntent, throughIntent, intentDigest },
			bytes: (sequence) => preimage(sequence, 1, { action: "place", id: `m-${source}-${throughIntent}`, x: 1, y: 2 }),
		});
		const progressOf = (sources: number[]) => Object.fromEntries(sources.map((source) => [source, intentDigest]));
		const batched = await settledStore(factory, "progress-batch", 3, progressOf([0]));
		const singles = await settledStore(factory, "progress-singles", 3, progressOf([0]));
		const [a, b, c] = batched.sources.map((source) => source.authorSequence) as [number, number, number];
		const firstRows = [chunk(a, 0, 2), replacement(b)];
		const secondRows = [chunk(a, 2, 4), replacement(c)];
		const first = await issueBatch(batched.store, firstRows);
		for (const row of firstRows) await issueOne(singles.store, row);
		const mid = await snapshot(batched.store, 4, 7);
		const midTwin = await snapshot(singles.store, 4, 7);
		const second = await issueBatch(batched.store, secondRows);
		for (const row of secondRows) await issueOne(singles.store, row);
		const end = await snapshot(batched.store, 4, 7);
		const endTwin = await snapshot(singles.store, 4, 7);
		const twoChunks = await issueBatch(
			(await settledStore(factory, "progress-twice", 1, progressOf([0]))).store,
			[chunk(0, 0, 2), chunk(0, 2, 4)]
		);
		report.progress = {
			firstOk: first.ok,
			secondOk: second.ok,
			midEqualsSingles: sameBytes(mid.planBytes, midTwin.planBytes) && mid.planRevision === midTwin.planRevision,
			endEqualsSingles: sameBytes(end.planBytes, endTwin.planBytes) && end.planRevision === endTwin.planRevision,
			twoChunksOneBatchOk: twoChunks.ok,
			twoChunksOneBatchCode: twoChunks.ok ? null : twoChunks.code,
		};
	}

	if (native) {
		// A batch that fails after its entered marker: unknown outcome, no row; the same batch then commits whole.
		const { store, sources } = await settledStore(factory, "resume", 4);
		const rows = sources.map((source) => replacement(source.authorSequence));
		const failed = await issueBatch(store, rows, {
			tamper: (commits) => commits.map((commit, index) => (index === 1 ? { ...commit, authorSequence: commit.authorSequence + 7 } : commit)),
		});
		const between = await snapshot(store, 5, 8);
		const foreign = await issueBatch(store, rows.slice(0, 3));
		const resumed = await issueBatch(store, rows);
		const after = await snapshot(store, 5, 8);
		report.resume = {
			failedOk: failed.ok,
			failedCode: failed.ok ? null : failed.code,
			between: between.issued,
			foreignOk: foreign.ok,
			resumedOk: resumed.ok,
			after: after.issued,
			lineageAfter: after.lineage,
		};
	}
	return report;
}
