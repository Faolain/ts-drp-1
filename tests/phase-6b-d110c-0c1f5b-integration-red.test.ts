/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */

// Parent case ownership (each independent continuation has its own causal close):
// 1: delayedDependency; 2-3,10,13-negative,14,22,26: checkpoint-terminal progress.
// 4,15,16,19: delayedPublication; 5,11: manualReviewHold; 6-9: sameKeyReentry.
// 12,23: creatorFenceScan; 13-positive: positiveAuthenticatedPruning;
// 14,24c and the 64-writer product golden path: sixtyFourWriterGoldenPath;
// 17: nullBoundaryClose plus v1 source-shape custody; 19-21: displacedControls; 24a: staleLocalHead;
// 25: ambiguousPlanIssue. Case 24 follows signed clarification 62f71f4d:
// no committed floor regression, no Superseded-generation readoption.
// Closed nonduplicated primitives: 18 and 26-27 are exact vectors in
// d110c-0c1f5b0a-settlement-codec-red.test.ts, "puts ACL membership, genesis
// admission, adjacency, and monotonicity in the bounded advance predicate",
// "signs with successor authority and cold-opens with floor trust only, without
// predecessor bytes", and "keeps predecessor checks shape-only in the opener
// and rejects malformed predecessor fields". Interrupted adoption: retained
// phase-6b-d110c-0b0a-staged-handoff-red.test.ts, "stages without a head swap and
// publishes through one owner-bound CAS" and "recovers equivalent Complete
// retries deterministically across both AHE orderings", plus D.110c-b evidence.
// Later >=100-transition acceptance remains a retained, separately authorized
// same-room workload with bounded durable structures/custody/fresh-process
// memory checks. This fixture executes three wide transitions, not that campaign.
import "fake-indexeddb/auto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit, SettlementPlan } from "@ts-drp/issuance-store";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Install observers before the room/node consumers below.
import {
	aheFacts,
	assertRetainedRollbackPair,
	durable,
	floorOwner,
	hex,
	observed,
	openRoom,
	originalStorage,
	type Peer,
	productState,
	record,
	required,
	sessions,
	STALE_LOCAL_HEAD_FAILURE,
	wideDiagnostic,
} from "./fixtures/grid-room-workload.js";
import {
	type SnapshotOracleVertex,
	snapshotStateOracle,
} from "./fixtures/phase-6b-d110c-0c1f5b/snapshot-state-oracle.js";
import type { CreateV3RoomSessionInput } from "../examples/v3-room/src/index.js";
import { frontierFor } from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";

function messages(peer: Peer) {
	return decodeCanonical(productState(peer)) as { clientOperationId: string; text: string }[];
}

function ownCommits(peer: Peer) {
	return observed.commits.filter(
		(row) => row.issuedRecord.scope.objectId === peer.input.objectId && row.issuedRecord.scope.author === peer.author
	);
}

function applicationOperations(commit: DurableIssueCommit): Record<string, unknown>[] {
	const operation = record(commit.envelope.canonicalPreimageBytes).operation as Record<string, unknown>;
	return operation.action === "applicationBatch"
		? (operation.batch as { entries: { operation: Record<string, unknown> }[] }).entries.map((entry) => entry.operation)
		: operation.action === "message"
			? [operation]
			: [];
}

async function displacedFixture() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "timing-creator");
	await fixture.issue(writer, "timing-writer");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "timing-displaced");
	const source = required((await durable(writer)).rows.at(-1));
	expect(source.publishState, "F5B_C19_PUBLISHED_SOURCE_REALLY_DURABLE").toBe("published");
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	return { fixture, creator, writer, source: source.commit, checkpoint };
}

async function delayedDependency() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "dependency-creator");
	await fixture.issue(writer, "dependency-admitted-prefix");
	const prefix = required(ownCommits(writer).at(-1));
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "dependency-n");
	const delayed = required(ownCommits(writer).at(-1));
	await fixture.issue(writer, "dependency-n-plus-one");
	const dependent = required(ownCommits(writer).at(-1));
	expect(dependent.authorSequence, "F5B_C01_TWO_DISTINCT_ADJACENT_AUTHOR_SEQUENCES").toBe(delayed.authorSequence + 1);
	expect(
		record(dependent.envelope.canonicalPreimageBytes).dependencies,
		"F5B_C01_REAL_ISSUE_CAUSALLY_DEPENDS_ON_DELAYED_VERTEX"
	).toContain(hex(delayed.envelope.digest));
	const envelope = required(
		fixture.envelopes.find(
			(message) =>
				hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) ===
				hex(dependent.envelope.digest)
		)
	);
	fixture.deliver(envelope); // Deliver n+1, never n, through real signed ingress.
	await fixture.issue(creator, "dependency-before-close");
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	expect(frontierFor(checkpoint.capability, writer.author)?.[2], "F5B_C01_CLOSE_STAYS_AT_ADMITTED_PREFIX").toBe(
		prefix.authorSequence
	);
	const graph = required(observed.closeGraphs.at(-1));
	for (const row of [delayed, dependent])
		expect(
			graph.input.vertices.has(hex(row.envelope.digest)),
			"F5B_C01_DEPENDENT_NEVER_IN_REAL_CLOSE_GRAPH_WITHOUT_PREDECESSOR"
		).toBe(false);
	for (const row of [delayed, dependent])
		expect(fixture.received.has(hex(row.envelope.digest)), "F5B_C01_NEITHER_DEPENDENCY_NOR_DEPENDENT_ADMITTED").toBe(
			false
		);
	expect(messages(creator).map((row) => row.clientOperationId)).not.toContain("dependency-n-plus-one");
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "dependency-after-recovery");
	const plan = required((await durable(writer)).plan);
	for (const source of [delayed, dependent]) {
		const entry = required(plan.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(entry.sourceDigest).toEqual(source.envelope.digest);
		expect(required(entry.replacementSequence)).toBeGreaterThan(required(plan.fenceSequence));
		expect(
			ownCommits(writer).filter(
				(row) => row.planEffect?.kind === "replacement" && row.planEffect.sourceSequence === source.authorSequence
			),
			"F5B_C01_EXACT_ONE_REPLACEMENT_FOR_EACH_DISTINCT_SOURCE"
		).toHaveLength(1);
	}
	await fixture.close();
	expect(
		frontierFor(fixture.checkpoint().capability, writer.author)?.[2],
		"F5B_C01_FENCE_AND_CONTIGUOUS_REPLACEMENTS_ADVANCE"
	).toBe(required(ownCommits(writer).at(-1)).authorSequence);
	for (const id of ["dependency-n", "dependency-n-plus-one"])
		expect(messages(creator).filter((row) => row.clientOperationId === id)).toEqual([
			{ clientOperationId: id, text: "r".repeat(256) },
		]);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function nullBoundaryClose() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "null-boundary-initial");
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toBeUndefined();
	await creator.room.adoptCreatorSuccessor();
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toEqual([writer.author, 2, null]);
	await creator.room.adoptCreatorSuccessor();
	// Member is authentically re-admitted but stays offline: there is no current
	// slot 0, fence or application from it. Never manufacture a frontier or row.
	await fixture.issue(creator, "null-boundary-close-continues");
	await fixture.close();
	expect(
		frontierFor(fixture.checkpoint().capability, writer.author),
		"F5B_C17_NULL_NO_FENCE_NO_SLOT_ZERO_CLOSE_SUCCEEDS"
	).toEqual([writer.author, 2, null]);
	expect(
		ownCommits(writer).filter((row) => Number(record(row.envelope.canonicalPreimageBytes).epoch) >= 2)
	).toHaveLength(0);
	await fixture.stop(creator);
}

async function delayedPublication(mode: "unpublished-fence" | "delayed-replacement" | "delayed-fence") {
	const { fixture, creator, writer, source, checkpoint } = await displacedFixture();
	if (mode === "unpublished-fence") fixture.publicationFailures.add(writer.databaseName);
	if (mode === "delayed-replacement") fixture.heldApplications.add(writer.databaseName);
	if (mode === "delayed-fence") fixture.held.add(writer.databaseName);
	await fixture.reopen(writer, 0, true);
	if (mode === "unpublished-fence") await expect(fixture.issue(writer, "unpublished-fence-barrier")).rejects.toThrow();
	else await fixture.issue(writer, "delayed-dependent-application");
	const before = await durable(writer);
	const plan = required(before.plan);
	const fence = required(plan.fenceSequence);
	const sourceEntry = required(plan.entries.find((entry) => entry.sourceSequence === source.authorSequence));
	if (mode === "unpublished-fence") {
		expect(
			required(before.rows.find((row) => row.commit.authorSequence === fence)).publishState,
			"F5B_C04_FENCE_DURABLE_UNPUBLISHED"
		).toBe("pending");
		expect(sourceEntry.replacementSequence, "F5B_C04_NO_REPLACEMENT_BEFORE_FENCE_PUBLICATION").toBeNull();
		await fixture.stop(writer);
		fixture.publicationFailures.delete(writer.databaseName);
		await fixture.reopen(writer, 0);
		await fixture.issue(writer, "after-unpublished-fence-crash");
		expect((await durable(writer)).plan?.fenceSequence, "F5B_C04_REPUBLISH_SAME_FENCE_BEFORE_CHECKPOINT").toBe(fence);
		expect(
			ownCommits(writer).filter(
				(row) => row.planEffect?.kind === "fence" && record(row.envelope.canonicalPreimageBytes).epoch === 1
			),
			"F5B_C04_ONE_FENCE_FOR_SAME_PLAN"
		).toHaveLength(1);
	} else {
		const replacement = required(sourceEntry.replacementSequence);
		await fixture.stop(writer);
		await fixture.issue(creator, "close-while-transport-delayed");
		await fixture.close();
		const next = fixture.checkpoint();
		expect(
			frontierFor(next.capability, writer.author)?.[2],
			mode === "delayed-fence" ? "F5B_C16_DELAYED_FENCE_DEPENDENTS_NOT_ADMITTED" : "F5B_C15_ONLY_FENCE_ADMITTED"
		).toBe(mode === "delayed-fence" ? frontierFor(checkpoint.capability, writer.author)?.[2] : fence);
		await creator.room.adoptCreatorSuccessor();
		fixture.held.delete(writer.databaseName);
		fixture.heldApplications.delete(writer.databaseName);
		await fixture.reopen(writer, 1, true);
		await fixture.issue(writer, "after-delayed-close");
		const recovered = required((await durable(writer)).plan);
		expect(recovered.fenceSequence, "F5B_C16_NEXT_EPOCH_LARGER_FENCE").toBeGreaterThan(fence);
		expect(
			recovered.entries.some((entry) => entry.sourceSequence === replacement && entry.replacementSequence !== null),
			"F5B_C15_DISPLACED_REPLACEMENT_BECOMES_SOURCE"
		).toBe(true);
	}
	expect(
		messages(creator).filter((row) => row.clientOperationId === "timing-displaced"),
		"F5B_C15_C16_ONE_APPLICATION_EFFECT"
	).toEqual([{ clientOperationId: "timing-displaced", text: "r".repeat(256) }]);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function ambiguousPlanIssue(kind: "fence" | "replacement", committed: boolean, recoveryFails = false) {
	const { fixture, creator, writer, source } = await displacedFixture();
	observed.ambiguous = { database: writer.databaseName, kind, committed, recoveryFails };
	await fixture.reopen(writer, 0, true);
	// Clarification: the ambiguous owner must halt, but the existing room owner
	// may authenticate a fresh owner and retry once inside the same public call.
	// No activation result/capability is supplied by this fixture.
	const issue = fixture.issue(writer, "unknown-outcome-barrier");
	if (recoveryFails) await expect(issue, "F5B_C25_FAILED_RECOVERY_STAYS_CLOSED").rejects.toThrow();
	else await issue;
	const boundary = required(observed.ambiguities.findLast((row) => row.database === writer.databaseName));
	const entry = required(boundary.plan?.entries.find((row) => row.sourceSequence === source.authorSequence));
	const link = kind === "fence" ? boundary.plan?.fenceSequence : entry.replacementSequence;
	expect(link !== null, `F5B_C25_${kind}_${committed ? "ROW_AND_LINK" : "NEITHER"}`).toBe(committed);
	const candidate = boundary.candidate;
	// planEffect is an atomic transaction instruction, not an issued-row field.
	expect(boundary.row, "F5B_C25_EXACT_DURABLE_ROW_AT_AMBIGUITY").toEqual(
		committed
			? {
					authorSequence: candidate.authorSequence,
					envelope: candidate.envelope,
					issuedRecord: candidate.issuedRecord,
					outboxEntry: candidate.outboxEntry,
				}
			: null
	);
	const priorPlan = required(observed.issuePlans.get(candidate));
	const effect = required(candidate.planEffect);
	let committedPlan: SettlementPlan;
	if (kind === "fence") {
		expect(effect, "F5B_C25_EXACT_FENCE_INSTRUCTION").toEqual({ kind: "fence" });
		expect(priorPlan.fenceSequence, "F5B_C25_FENCE_LINK_ABSENT_BEFORE_TRANSACTION").toBeNull();
		committedPlan = { ...priorPlan, fenceSequence: candidate.authorSequence, revision: priorPlan.revision + 1 };
	} else {
		const priorEntry = required(priorPlan.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(effect, "F5B_C25_EXACT_REPLACEMENT_INSTRUCTION").toStrictEqual({
			kind: "replacement",
			sourceSequence: source.authorSequence,
		});
		expect(priorEntry, "F5B_C25_EXACT_UNCOMMITTED_SCALAR_ENTRY").toStrictEqual({
			sourceSequence: source.authorSequence,
			sourceDigest: source.envelope.digest,
			disposition: "transform",
			replacementSequence: null,
		});
		expect(priorEntry, "F5B_C25_NO_PROGRESS_BEFORE_TRANSACTION").not.toHaveProperty("replacementProgress");
		expect(entry, "F5B_C25_NO_PROGRESS_AT_AMBIGUITY").not.toHaveProperty("replacementProgress");
		expect(priorEntry.replacementSequence, "F5B_C25_REPLACEMENT_LINK_ABSENT_BEFORE_TRANSACTION").toBeNull();
		expect(applicationOperations(candidate), "F5B_C25_EXACT_SINGLE_TRANSFORMED_INTENT").toEqual([
			{ action: "message", clientOperationId: "timing-displaced", text: "r".repeat(256) },
		]);
		committedPlan = {
			...priorPlan,
			revision: priorPlan.revision + 1,
			entries: priorPlan.entries.map((row) =>
				row.sourceSequence === source.authorSequence ? { ...row, replacementSequence: candidate.authorSequence } : row
			),
		};
	}
	expect(boundary.plan, "F5B_C25_EXACT_ATOMIC_PLAN_LINK_AND_PROGRESS").toStrictEqual(
		committed ? committedPlan : priorPlan
	);
	expect(boundary.lineage.next, "F5B_C25_ATOMIC_LINEAGE_WITH_ROW_AND_LINK").toBe(
		boundary.candidate.authorSequence + (committed ? 1 : 0)
	);
	expect(required(boundary.handle).currentEphemeralAuthority(), "F5B_C25_AMBIGUOUS_OWNER_DEACTIVATED").toBeUndefined();
	if (recoveryFails) {
		const unchanged = await durable(writer);
		await expect(fixture.issue(writer, "still-halted")).rejects.toThrow();
		expect(await durable(writer), "F5B_C25_FAILED_RECOVERY_NO_MUTATION").toEqual(unchanged);
		observed.failRecoveryReadFor = "";
		await fixture.reopen(writer, 0);
		await fixture.issue(writer, "recovered-ambiguous-outcome");
	}
	expect(observed.planes.get(writer.databaseName), "F5B_C25_GENUINE_AUTHENTICATED_OWNER_IDENTITY_CHANGES").not.toBe(
		boundary.handle
	);
	for (const row of observed.commits
		.slice(boundary.commitOffset)
		.filter(
			(row) => row.issuedRecord.scope.objectId === fixture.objectId && row.issuedRecord.scope.author === writer.author
		))
		expect(observed.commitHandles.get(row), "F5B_C25_FRESH_OWNER_BEFORE_SUBSEQUENT_ISSUE").not.toBe(boundary.handle);
	for (const publication of observed.publications
		.slice(boundary.publicationOffset)
		.filter((row) => row.database === writer.databaseName))
		expect(publication.handle, "F5B_C25_FRESH_OWNER_BEFORE_SUBSEQUENT_PUBLICATION").not.toBe(boundary.handle);
	const after = required((await durable(writer)).plan);
	if (kind === "replacement")
		expect(
			required(after.entries.find((row) => row.sourceSequence === source.authorSequence)),
			"F5B_C25_NO_PROGRESS_AFTER_RECOVERY"
		).not.toHaveProperty("replacementProgress");
	const recoveredLink =
		kind === "fence"
			? after.fenceSequence
			: required(after.entries.find((row) => row.sourceSequence === source.authorSequence)).replacementSequence;
	if (committed) {
		expect(recoveredLink, "F5B_C25_LINK_FROM_DURABLE_TRUTH").toBe(link);
	} else expect(recoveredLink, "F5B_C25_UNCOMMITTED_SLOT_REUSED").toBe(boundary.lineage.next);
	const surviving = required(ownCommits(writer).find((row) => row.authorSequence === recoveredLink));
	expect(
		observed.publications.filter(
			(row) => row.database === writer.databaseName && row.sequence === surviving.authorSequence
		),
		"F5B_C25_EXACT_ONE_SURVIVING_PUBLICATION_WITH_EXACT_DIGEST"
	).toEqual([
		{
			database: writer.databaseName,
			sequence: surviving.authorSequence,
			digest: hex(surviving.envelope.digest),
			handle: observed.planes.get(writer.databaseName),
		},
	]);
	expect(
		fixture.envelopes.filter(
			(message) =>
				message.sender === writer.databaseName &&
				hex(hashDomain("ts-drp/vertex/v3", V3Envelope.decode(message.data).canonicalPreimage)) ===
					hex(surviving.envelope.digest)
		),
		"F5B_C25_EXACT_ONE_NETWORK_PUBLICATION_NOT_JUST_OUTBOX_MARK"
	).toHaveLength(1);
	expect(
		ownCommits(writer).filter(
			(row) => record(row.envelope.canonicalPreimageBytes).epoch === 1 && row.planEffect?.kind === kind
		),
		"F5B_C25_EXACT_ONE_DURABLE_FENCE_OR_REPLACEMENT"
	).toHaveLength(1);
	const attempts = observed.issueAttempts.filter(
		(row) =>
			row.issuedRecord.scope.objectId === fixture.objectId &&
			row.issuedRecord.scope.author === writer.author &&
			record(row.envelope.canonicalPreimageBytes).epoch === 1 &&
			row.planEffect?.kind === kind
	);
	expect(attempts, "F5B_C25_AT_MOST_ONE_AUTHENTICATED_SIGNED_RETRY").toHaveLength(committed ? 1 : 2);
	expect(
		after.entries.filter((row) => row.sourceSequence === source.authorSequence),
		"F5B_C25_NO_DUPLICATE_DISPOSITION"
	).toHaveLength(1);
	expect(required(after.entries.find((row) => row.sourceSequence === source.authorSequence)).disposition).toBe(
		entry.disposition
	);
	expect(
		messages(creator).filter((row) => row.clientOperationId === "timing-displaced"),
		"F5B_C25_EXACTLY_ONCE_RECOVERY_EFFECT"
	).toHaveLength(1);
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function staleLocalHead() {
	const { fixture, creator, writer } = await displacedFixture();
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "linked-before-newer-floor");
	const linked = await durable(writer);
	expect(
		linked.plan?.entries.some((entry) => entry.replacementSequence !== null),
		"F5B_C24A_REAL_LINKED_PLAN_PRECONDITION"
	).toBe(true);
	await fixture.stop(writer);
	await fixture.close();
	fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	// Only the genuinely newer floor is transported. Local AHE/snapshot and
	// issuance bytes remain untouched; no old floor is restored or manufactured.
	writer.floor.receive(creator.floor.read());
	const newer = writer.floor.read();
	const mutations = observed.commits.length;
	await expect(fixture.reopen(writer, 0), "F5B_C24A_STALE_LOCAL_HEAD_FAILS_CLOSED").rejects.toThrow(
		STALE_LOCAL_HEAD_FAILURE
	);
	expect(
		encodeCanonical(await durable(writer)),
		"F5B_C24A_PLAN_REVISION_FENCE_ENTRIES_PROGRESS_LINEAGE_UNCHANGED"
	).toEqual(encodeCanonical(linked));
	expect(writer.floor.read(), "F5B_C24A_NEWER_FLOOR_NEVER_REGRESSES").toEqual(newer);
	expect(observed.commits.length, "F5B_C24A_REJECTED_REOPEN_ISSUES_NOTHING").toBe(mutations);
	const offset = ownCommits(writer).length;
	await fixture.reopen(writer, 1, true);
	await fixture.issue(writer, "after-authenticated-state-transfer");
	expect(
		ownCommits(writer)
			.slice(offset)
			.filter((row) => row.planEffect?.kind === "replacement"),
		"F5B_C24A_NO_REPLACEMENT_REISSUE"
	).toHaveLength(0);
	const remaining = required((await durable(writer)).plan).entries;
	for (const entry of required(linked.plan).entries) {
		const survived = remaining.find((row) => row.sourceSequence === entry.sourceSequence);
		// Authenticated terminal retirement may remove an entry; it may not
		// erase its link and redisposition its already-replaced source.
		if (survived !== undefined) expect(survived, "F5B_C24A_NO_REDISPOSITION").toEqual(entry);
	}
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function sixtyFourWriterGoldenPath() {
	let wideDiagnosticCompleted = false;
	wideDiagnostic("callback", "begin");
	try {
		wideDiagnostic("initial-open", "begin", 0);
		const fixture = await openRoom(64);
		wideDiagnostic("initial-open", "end", 0);
		const creator = required(fixture.peers[0]);
		const expected = new Map<string, string>();
		const contributions: { peer: Peer; epoch: number; id: string; commit: DurableIssueCommit }[] = [];
		const displaced: { peer: Peer; source: DurableIssueCommit; id: string; epoch: number }[] = [];
		const adopted: { epoch: number; anchor: string; historyRoot: string; historySize: number; revision: number }[] = [];
		const expectedMembers = fixture.peers
			.map((peer, index) => ({
				author: peer.author,
				finalityKey: index === 0 ? peer.author : null,
				groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
			}))
			.sort((left, right) => (left.author < right.author ? -1 : 1));
		let priorCheckpoint: ReturnType<typeof fixture.checkpoint> | undefined;
		let sealedState = encodeCanonical([]);
		const semanticState = (rows: { clientOperationId: string; text: string }[]) =>
			encodeCanonical([...rows].sort((left, right) => left.clientOperationId.localeCompare(right.clientOperationId)));
		const accountEpoch = (epoch: number) => {
			for (const { peer, commit } of contributions.filter((row) => row.epoch === epoch)) {
				const plan = required(observed.issuePlans.get(commit));
				const fenceSequence = required(plan.fenceSequence);
				const fences = ownCommits(peer).filter(
					(row) => row.planEffect?.kind === "fence" && record(row.envelope.canonicalPreimageBytes).epoch === epoch
				);
				expect(fences, "F5B_64_EVERY_AUTHOR_EVERY_EPOCH_EXACT_ONE_FENCE").toHaveLength(1);
				const fence = required(fences[0]);
				expect(fence.authorSequence).toBe(fenceSequence);
				expect(fenceSequence, "F5B_64_FENCE_BEFORE_FIRST_ORDINARY_ISSUE").toBeLessThan(commit.authorSequence);
				const beforeFence = required(observed.issuePlans.get(fence));
				expect(beforeFence.scope).toEqual({ author: peer.author, objectId: fixture.objectId });
				expect(beforeFence.fenceSequence).toBeNull();
				expect(beforeFence.entries.some((entry) => entry.disposition === "manual-review")).toBe(false);
				const events = observed.timeline.filter((event) => event.database === peer.databaseName);
				const planAt = events.findIndex((event) => event.kind === "plan" && event.revision === beforeFence.revision);
				const fenceAt = events.findIndex((event) => event.kind === "commit" && event.sequence === fenceSequence);
				const publishedAt = events.findIndex(
					(event) => event.kind === "publication" && event.sequence === fenceSequence
				);
				const ordinaryAt = events.findIndex(
					(event) => event.kind === "commit" && event.sequence === commit.authorSequence
				);
				expect(planAt, "F5B_64_DURABLE_PLAN_WRITE_EXISTS_BEFORE_FENCE").toBeGreaterThanOrEqual(0);
				expect(planAt).toBeLessThan(fenceAt);
				expect(fenceAt).toBeLessThan(publishedAt);
				expect(publishedAt).toBeLessThan(ordinaryAt);
				const effects = ownCommits(peer).filter(
					(row) =>
						row.authorSequence >= fenceSequence &&
						row.authorSequence < commit.authorSequence &&
						row.planEffect !== undefined
				);
				expect(plan.revision, "F5B_64_EXACT_PLAN_REVISION_ADVANCES_ONLY_WITH_ATOMIC_EFFECTS").toBe(
					beforeFence.revision + effects.length
				);
				expect(
					observed.publications.filter((row) => row.database === peer.databaseName && row.sequence === fenceSequence),
					"F5B_64_EXACT_ONE_FENCE_PUBLICATION"
				).toEqual([
					{
						database: peer.databaseName,
						sequence: fenceSequence,
						digest: hex(fence.envelope.digest),
						handle: observed.commitHandles.get(fence),
					},
				]);
			}
		};
		for (let epoch = 0; epoch <= 3; epoch += 1) {
			wideDiagnostic("epoch", "begin", epoch);
			for (const [index, peer] of fixture.peers.entries()) {
				const acl = peer.room.previewLatchedAcl().current;
				expect(acl, "F5B_64_EXACT_PRODUCT_ACL_AFTER_RECOVERY").toEqual({
					epoch,
					kind: "drp-v3-latched-acl",
					objectId: fixture.objectId,
					permissionless: false,
					version: 3,
					members: expectedMembers,
				});
				const id = `wide-${epoch}-${index}`;
				wideDiagnostic("ordinary-issue", "begin", epoch, peer.databaseName);
				await fixture.issue(peer, id);
				wideDiagnostic("ordinary-issue", "end", epoch, peer.databaseName);
				wideDiagnostic("ordinary-accounting", "begin", epoch, peer.databaseName);
				const matching = ownCommits(peer).filter((commit) =>
					applicationOperations(commit).some((operation) => operation.clientOperationId === id)
				);
				expect(matching, `F5B_64_E${epoch}_AUTHOR_${index}_EXACT_ONE_ISSUED_OPERATION`).toHaveLength(1);
				const commit = required(matching[0]);
				expect(record(commit.envelope.canonicalPreimageBytes).epoch, "F5B_64_OPERATION_ISSUED_IN_CURRENT_EPOCH").toBe(
					epoch
				);
				expect(
					observed.publications.some(
						(row) =>
							row.database === peer.databaseName &&
							row.sequence === commit.authorSequence &&
							row.digest === hex(commit.envelope.digest)
					),
					"F5B_64_BACKEND_CONFIRMED_PUBLICATION"
				).toBe(true);
				expect(fixture.received.has(hex(commit.envelope.digest)), "F5B_64_CREATOR_AUTHENTICATED_ADMISSION_ACK").toBe(
					true
				);
				expect(
					messages(peer).filter((row) => row.clientOperationId === id),
					"F5B_64_AUTHOR_PRODUCT_APPLIED_OWN_OPERATION"
				).toEqual([{ clientOperationId: id, text: id }]);
				contributions.push({ peer, epoch, id, commit });
				expected.set(id, id);
				if (epoch > 0) {
					const current = required(peer.room.authority());
					expect(current.epoch, "F5B_64_REJOIN_CONTRIBUTES_BEFORE_NEXT_CLOSE").toBe(epoch);
					expect(current.anchorDigest).toBe(required(priorCheckpoint).identity.successorAnchorDigest);
					expect(current.aclDigest).toBe(required(priorCheckpoint).identity.successorAclDigest);
					expect(current.aclDigest, "F5B_64_AUTHORITY_BINDS_EXACT_RECOVERED_ACL").toBe(
						hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(acl)))
					);
					expect(current.profileId, "F5B_64_SETTLEMENT_AUTHORITY_NO_DOWNGRADE").toBe("creator-trusted-settlement-v1");
					const floor = peer.floor.read();
					expect(floor.pending).toBeNull();
					expect(floor.stable).toMatchObject({ epoch, currentAnchorDigest: current.anchorDigest });
					const ownRecovered = displaced.filter((row) => row.peer === peer && row.epoch === epoch - 1);
					const expectedLocal = [
						...(decodeCanonical(required(sealedState)) as { clientOperationId: string; text: string }[]),
						...ownRecovered.map((row) => ({ clientOperationId: row.id, text: "r".repeat(256) })),
						{ clientOperationId: id, text: id },
					];
					// Creator also receives peers' automatically drained replacements; its
					// complete shared projection is checked after all 64 admission acks.
					if (peer !== creator)
						expect(semanticState(messages(peer)), "F5B_64_EXACT_RECOVERED_PRODUCT_STATE_PER_AUTHOR").toEqual(
							semanticState(expectedLocal)
						);
					for (const source of ownRecovered) {
						const plan = required((await durable(peer)).plan);
						const entry = required(plan.entries.find((row) => row.sourceSequence === source.source.authorSequence));
						const replacement = required(entry.replacementSequence);
						expect(entry.disposition, "F5B_64_REAL_TRANSFORM_DISPOSITION").toBe("transform");
						expect(required(plan.fenceSequence), "F5B_64_PLAN_FENCE_REPLACEMENT_ORDER").toBeLessThan(replacement);
						expect(
							ownCommits(peer).filter(
								(row) =>
									row.planEffect?.kind === "replacement" &&
									row.planEffect.sourceSequence === source.source.authorSequence
							),
							"F5B_64_EXACT_ONE_REPLACEMENT_LINK"
						).toHaveLength(1);
						expected.set(source.id, "r".repeat(256));
					}
				}
				wideDiagnostic("ordinary-accounting", "end", epoch, peer.databaseName);
			}
			const expectedMessages = [...expected].map(([clientOperationId, text]) => ({ clientOperationId, text }));
			expect(semanticState(messages(creator)), "F5B_64_EXACT_CREATOR_APPLICATION_STATE").toEqual(
				semanticState(expectedMessages)
			);
			expect(
				hex(hashDomain("ts-drp/state/v3", semanticState(messages(creator)))),
				"F5B_64_EXACT_PRODUCT_SEMANTIC_DIGEST"
			).toBe(hex(hashDomain("ts-drp/state/v3", semanticState(expectedMessages))));
			if (epoch === 3) {
				accountEpoch(epoch);
				wideDiagnostic("epoch", "end", epoch);
				break;
			}
			// Rotating eight-author cohort has ALREADY issued/admitted/applied/published
			// in this epoch. It remains genuinely stopped over close/adopt and the
			// selected creator cold restart, then rejoins before the next epoch's issue.
			const cohort = fixture.peers.slice(1 + epoch * 8, 9 + epoch * 8);
			for (const [index, peer] of cohort.slice(0, 2).entries()) {
				const id = `wide-displaced-${epoch}-${index}`;
				if (index === 0) fixture.held.add(peer.databaseName);
				else fixture.publicationFailures.add(peer.databaseName);
				wideDiagnostic("displaced-issue", "begin", epoch, peer.databaseName);
				if (index === 0) await fixture.issue(peer, id);
				else await expect(fixture.issue(peer, id), "F5B_64_SELECTED_PENDING_PUBLICATION_FAILURE").rejects.toThrow();
				wideDiagnostic("displaced-issue", "end", epoch, peer.databaseName);
				const row = required(
					(await durable(peer)).rows.find((candidate) =>
						applicationOperations(candidate.commit).some((operation) => operation.clientOperationId === id)
					)
				);
				expect(row.publishState, "F5B_64_PENDING_AND_PUBLISHED_DISPLACED_INPUTS").toBe(
					index === 0 ? "published" : "pending"
				);
				displaced.push({ peer, source: row.commit, id, epoch });
			}
			wideDiagnostic("cohort-stop", "begin", epoch);
			await Promise.all(cohort.map(fixture.stop));
			wideDiagnostic("cohort-stop", "end", epoch);
			// The live migration view has already passed its independent semantic check.
			// Its order is not the authoritative snapshot's projected-graph Kahn order.
			wideDiagnostic("close", "begin", epoch);
			await fixture.close();
			wideDiagnostic("close", "end", epoch);
			wideDiagnostic("checkpoint-oracle", "begin", epoch);
			const checkpoint = fixture.checkpoint();
			accountEpoch(epoch);
			const graph = required(observed.closeGraphs.at(-1));
			const admitted = fixture.peers
				.flatMap(ownCommits)
				.filter(
					(row) =>
						record(row.envelope.canonicalPreimageBytes).epoch === epoch &&
						!displaced.some((source) => hex(source.source.envelope.digest) === hex(row.envelope.digest))
				);
			const anchor = hex(hashDomain("ts-drp/epoch-anchor/v3", graph.input.exactCanonicalEpochAnchorPreimageBytes));
			const signedGraph = new Map<string, SnapshotOracleVertex>([[anchor, { dependencies: [] }]]);
			for (const row of admitted) {
				const hash = hex(row.envelope.digest);
				const signed = record(row.envelope.canonicalPreimageBytes);
				expect(hex(hashDomain("ts-drp/vertex/v3", row.envelope.canonicalPreimageBytes))).toBe(hash);
				expect(
					ed25519.verify(row.envelope.signature, row.envelope.digest, Buffer.from(row.issuedRecord.scope.author, "hex"))
				).toBe(true);
				const vertex = required(graph.input.vertices.get(hash));
				expect(vertex.dependencies, "F5B_64_CAPTURED_GRAPH_EXACT_SIGNED_DEPENDENCIES").toEqual(signed.dependencies);
				expect(vertex.operation, "F5B_64_CAPTURED_GRAPH_EXACT_SIGNED_OPERATION").toEqual(signed.operation);
				expect([vertex.hash, vertex.epoch, vertex.objectId, vertex.anchor, vertex.kind]).toEqual([
					hash,
					epoch,
					fixture.objectId,
					anchor,
					"drp-vertex",
				]);
				signedGraph.set(hash, {
					dependencies: signed.dependencies as string[],
					operation: signed.operation as Record<string, unknown>,
				});
			}
			expect([...signedGraph.keys()].sort(), "F5B_64_SIGNED_GRAPH_HAS_NO_MISSING_OR_EXTRA_VERTICES").toEqual(
				[...graph.input.vertices.keys()].sort()
			);
			const oracle = snapshotStateOracle(signedGraph, anchor, graph.input.frontier, sealedState);
			expect(oracle.ancestors, "F5B_64_FULL_FRONTIER_ANCESTRY_COVERS_COMPLETE_RAW_GRAPH").toEqual(
				[...signedGraph.keys()].sort()
			);
			sealedState = oracle.state;
			const snapshot = required(
				observed.snapshots.findLast((row) => row.result.manifestDigest === checkpoint.identity.snapshotManifestDigest)
			);
			const payloadBytes = new Uint8Array(Buffer.concat(snapshot.result.chunks));
			expect(payloadBytes, "F5B_64_ACTUAL_TRANSFER_CHUNKS_MATCH_PRODUCED_PAYLOAD").toEqual(
				snapshot.input.exactCanonicalPayloadBytes
			);
			expect([snapshot.input.objectId, snapshot.input.epoch, snapshot.input.anchor]).toEqual([
				fixture.objectId,
				epoch,
				anchor,
			]);
			expect(
				encodeCanonical(record(payloadBytes).application),
				"F5B_64_SNAPSHOT_EXACT_INDEPENDENT_APPLICATION_BYTES"
			).toEqual(sealedState);
			expect(snapshot.input.stateDigest).toBe(hex(hashDomain("ts-drp/state/v3", sealedState)));
			expect(
				[...graph.result.closeSetOrder].sort(),
				"F5B_64_EXACT_CLOSE_SET_COUNTS_APPLICATION_AND_CONTROL_VERTICES"
			).toEqual(admitted.map((row) => hex(row.envelope.digest)).sort());
			for (const row of admitted)
				expect(
					graph.input.authenticatedCanonicalPreimageByteLengths.get(hex(row.envelope.digest)),
					"F5B_64_EXACT_SIGNED_BYTE_CHARGES_INCLUDE_FENCES"
				).toBe(row.envelope.canonicalPreimageBytes.byteLength);
			expect(checkpoint.identity.historySize, "F5B_64_EXACT_HISTORY_SIZE_NOT_ONLY_MONOTONICITY").toBe(
				(priorCheckpoint?.identity.historySize ?? 0) + admitted.length
			);
			expect(checkpoint.identity.historyRoot, "F5B_64_HISTORY_ROOT_BINDS_COMPLETE_REAL_GRAPH").toBe(
				graph.result.historyRoot
			);
			expect(checkpoint.cut.closeSetCount).toBe(admitted.length);
			expect(checkpoint.cut.closeSetRoot).toBe(graph.result.closeSetRoot);
			expect(checkpoint.identity.frontiers, "F5B_64_AUTHENTICATED_ACL_MEMBER_VECTOR").toHaveLength(64);
			expect(checkpoint.cut.stateDigest, "F5B_64_SNAPSHOT_BINDS_EXACT_PRODUCT_STATE").toBe(
				hex(hashDomain("ts-drp/state/v3", sealedState))
			);
			for (const contribution of contributions.filter((row) => row.epoch === epoch))
				expect(
					frontierFor(checkpoint.capability, contribution.peer.author)?.[2],
					"F5B_64_CHECKPOINT_ACCOUNTS_EVERY_AUTHOR_APPLICATION"
				).toBeGreaterThanOrEqual(contribution.commit.authorSequence);
			if (priorCheckpoint !== undefined) {
				expect(checkpoint.identity.closedAnchorDigest, "F5B_64_CONTIGUOUS_ANCHOR_LINEAGE").toBe(
					priorCheckpoint.identity.successorAnchorDigest
				);
				expect(checkpoint.identity.priorCheckpointDigest, "F5B_64_ADJACENT_CHECKPOINT_LINK").toBe(
					hex(hashDomain("ts-drp-storage/blob/v1", priorCheckpoint.bytes))
				);
				expect(checkpoint.identity.historySize, "F5B_64_MONOTONE_HISTORY_ACCOUNTING").toBeGreaterThan(
					priorCheckpoint.identity.historySize
				);
				expect(checkpoint.identity.historyRoot, "F5B_64_HISTORY_ROOT_ADVANCES").not.toBe(
					priorCheckpoint.identity.historyRoot
				);
			}
			wideDiagnostic("checkpoint-oracle", "end", epoch);
			wideDiagnostic("adopt", "begin", epoch);
			await creator.room.adoptCreatorSuccessor();
			wideDiagnostic("adopt", "end", epoch);
			wideDiagnostic("adoption-accounting", "begin", epoch);
			expect(productState(creator), "F5B_64_ADOPTION_EXACT_STATE_BYTES").toEqual(sealedState);
			const authority = required(creator.room.authority());
			const head = await assertRetainedRollbackPair(creator);
			expect(authority.anchorDigest).toBe(checkpoint.identity.successorAnchorDigest);
			expect(authority.aclDigest).toBe(checkpoint.identity.successorAclDigest);
			expect(creator.floor.read().stable.epoch, "F5B_C24C_MONOTONE_AUTHENTICATED_FLOOR").toBe(epoch + 1);
			const previous = adopted.at(-1);
			if (previous !== undefined)
				expect(head.head.revision, "F5B_C24C_MONOTONE_ACTIVE_HEAD_REVISION").toBeGreaterThan(previous.revision);
			adopted.push({
				epoch: authority.epoch,
				anchor: authority.anchorDigest,
				historyRoot: checkpoint.identity.historyRoot,
				historySize: checkpoint.identity.historySize,
				revision: head.head.revision,
			});
			wideDiagnostic("adoption-accounting", "end", epoch);
			if (epoch === 1) {
				await fixture.reopen(creator, epoch);
				expect(productState(creator), "F5B_64_CREATOR_RESTART_EXACT_PRODUCT_STATE").toEqual(sealedState);
				expect(creator.room.authority(), "F5B_64_CREATOR_RESTART_AUTHORITY_IDENTICAL").toEqual(authority);
				expect((await aheFacts(creator)).head, "F5B_64_RESTART_PRESERVES_ACTIVE_HEAD").toEqual(head.head);
			}
			for (const peer of cohort) {
				fixture.held.delete(peer.databaseName);
				fixture.publicationFailures.delete(peer.databaseName);
			}
			// Reopen only: all publication remains explicitly awaited by next epoch's
			// issue. Independent stores/transport receivers can authenticate in parallel.
			wideDiagnostic("peer-reopen-group", "begin", epoch + 1);
			await Promise.all(fixture.peers.slice(1).map((peer) => fixture.reopen(peer, epoch, true)));
			wideDiagnostic("peer-reopen-group", "end", epoch + 1);
			priorCheckpoint = checkpoint;
			wideDiagnostic("epoch", "end", epoch);
		}
		wideDiagnostic("final-accounting", "begin", 3);
		expect(contributions, "F5B_64_EXACT_256_CURRENT_EPOCH_APPLICATION_ISSUES").toHaveLength(256);
		expect(displaced, "F5B_64_SIX_BOUNDED_PENDING_PUBLISHED_RECOVERY_SOURCES").toHaveLength(6);
		expect(
			adopted.map((row) => row.epoch),
			"F5B_C24C_THREE_MONOTONE_TRANSITIONS"
		).toEqual([1, 2, 3]);
		for (const peer of fixture.peers) {
			expect(
				contributions.filter((row) => row.peer === peer).map((row) => row.epoch),
				"F5B_64_PER_AUTHOR_FOUR_EPOCH_ACCOUNTING"
			).toEqual([0, 1, 2, 3]);
			const commits = ownCommits(peer);
			const lineage = (await durable(peer)).lineage;
			expect(
				commits.map((row) => row.authorSequence),
				"F5B_64_NO_HOLE_OR_DUPLICATE_DEVICE_LINEAGE"
			).toEqual(Array.from({ length: lineage.next }, (_, sequence) => sequence));
			const publications = new Set(
				observed.publications.filter((row) => row.database === peer.databaseName).map((row) => row.sequence)
			);
			for (const commit of commits) {
				const marks = observed.publications.filter(
					(row) => row.database === peer.databaseName && row.sequence === commit.authorSequence
				);
				expect(marks, "F5B_64_NO_DUPLICATE_PUBLICATION_MARK").toHaveLength(
					publications.has(commit.authorSequence) ? 1 : 0
				);
				for (const mark of marks) expect(mark.digest).toBe(hex(commit.envelope.digest));
			}
			const intentionallyNeverPublished = displaced
				.filter((row) => row.peer === peer)
				.filter((row) => !publications.has(row.source.authorSequence));
			expect(
				publications.size + intentionallyNeverPublished.length,
				"F5B_64_PER_AUTHOR_OPERATION_PUBLICATION_CONSERVATION"
			).toBe(commits.length);
		}
		const aggregate = fixture.peers.flatMap(ownCommits);
		expect(
			aggregate
				.flatMap(applicationOperations)
				.filter((operation) => String(operation.clientOperationId).startsWith("wide-")).length,
			"F5B_64_AGGREGATE_ISSUES_INCLUDE_SOURCES_AND_REPLACEMENTS"
		).toBe(268);
		expect(messages(creator), "F5B_64_EXACT_262_UNIQUE_APPLICATION_EFFECTS").toHaveLength(262);
		const finalCanonicalState = productState(creator).slice();
		expect(
			finalCanonicalState.byteLength,
			"F5B_64_ACTUAL_FINAL_CANONICAL_STATE_WITHIN_UNCHANGED_CEILING"
		).toBeLessThanOrEqual(32_768);
		const finalAuthority = creator.room.authority();
		const finalAccounting = {
			commits: aggregate.length,
			publications: observed.publications.filter((row) =>
				fixture.peers.some((peer) => peer.databaseName === row.database)
			).length,
		};
		wideDiagnostic("final-accounting", "end", 3);
		wideDiagnostic("final-reopen", "begin", 3, creator.databaseName);
		await fixture.reopen(creator, 2);
		expect(productState(creator), "F5B_64_FINAL_COLD_REOPEN_EXACT_CANONICAL_STATE_BYTES").toEqual(finalCanonicalState);
		expect(creator.room.authority(), "F5B_64_FINAL_COLD_REOPEN_EXACT_AUTHORITY").toEqual(finalAuthority);
		expect(
			{
				commits: fixture.peers.flatMap(ownCommits).length,
				publications: observed.publications.filter((row) =>
					fixture.peers.some((peer) => peer.databaseName === row.database)
				).length,
			},
			"F5B_64_FINAL_COLD_REOPEN_NO_DUPLICATE_ISSUE_PUBLICATION"
		).toEqual(finalAccounting);
		expect(semanticState(messages(creator)), "F5B_64_FINAL_CREATOR_COLD_REOPEN_EXACT_STATE").toEqual(
			semanticState([...expected].map(([clientOperationId, text]) => ({ clientOperationId, text })))
		);
		wideDiagnostic("final-reopen", "end", 3, creator.databaseName);
		wideDiagnostic("final-stop", "begin", 3);
		await Promise.all(fixture.peers.map(fixture.stop));
		wideDiagnostic("final-stop", "end", 3);
		wideDiagnosticCompleted = true;
	} finally {
		wideDiagnostic("callback", "settled", null, null, wideDiagnosticCompleted);
	}
}

async function positiveAuthenticatedPruning() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	for (let epoch = 0; epoch < 3; epoch += 1) {
		await Promise.all(fixture.peers.map((peer, index) => fixture.issue(peer, `prune-${epoch}-${index}`)));
		const before = observed.prunes.length;
		await fixture.close();
		const checkpoint = fixture.checkpoint();
		expect(
			observed.prunes
				.slice(before)
				.some((event) => event.receipt?.deletedAuthorSequenceRange !== null && event.receipt !== undefined),
			"F5B_C13_NO_PRUNING_FROM_STAGING_ALONE"
		).toBe(false);
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(required(fixture.peers[1]), epoch, true);
		await fixture.issue(required(fixture.peers[1]), `prune-reopened-${epoch}`);
		for (const peer of fixture.peers) {
			await assertRetainedRollbackPair(peer);
			const events = observed.prunes.filter(
				(event) =>
					event.database === peer.databaseName &&
					event.receipt?.deletedAuthorSequenceRange !== null &&
					event.receipt !== undefined
			);
			if (epoch < 2) {
				// Physical rollback custody is already complete; no authenticated
				// older issuance prefix is deletable at these logical boundaries.
				expect(events, "F5B_C13_NO_PREFIX_DELETE_BEFORE_FULL_WINDOW_AND_OLDER_PREFIX").toHaveLength(0);
				continue;
			}
			expect(events.length, "F5B_C13_PARENT_OWNER_ACTUALLY_DELETES_ISSUANCE").toBeGreaterThan(0);
			const first = required(events[0]);
			expect(
				first.receipt?.deletedAuthorSequenceRange?.from,
				"F5B_C13_PARENT_IS_FIRST_DELETING_MUTATION_NOT_RECEIPT_REPLAY"
			).toBe(0);
			expect(first.stack, "F5B_C13_PRODUCT_OWNER_CALL_CHAIN").toMatch(/packages\/node\/|examples\/v3-room\//u);
			const current = required(events.at(-1));
			const receipt = required(current.receipt);
			expect(receipt.scope).toEqual({ objectId: fixture.objectId, author: peer.author });
			expect(receipt.snapshotManifestDigest).toBe(checkpoint.identity.snapshotManifestDigest);
			expect(receipt.commitQcRef).toEqual(checkpoint.identity.commitQcRef);
			const proof = observed.cleanup.findLast((event) => {
				const input = event.input as {
					issuance?: { scope?: { author?: string } };
					close?: { closedEpoch?: number; objectId?: string };
				};
				return (
					input.issuance?.scope?.author === peer.author &&
					input.close?.closedEpoch === epoch &&
					input.close.objectId === fixture.objectId
				);
			});
			expect(required(proof).result, "F5B_C13_AUTHENTICATED_ADOPTION_ROLLBACK_AVAILABILITY_GATE_OWNER").toMatchObject({
				ok: true,
			});
			expect(required(proof).input).toMatchObject({
				adoption: { adopted: true },
				close: { verified: true, closedEpoch: epoch, commitQcRef: checkpoint.identity.commitQcRef },
				snapshot: { adopted: true, manifestDigest: checkpoint.identity.snapshotManifestDigest },
				issuance: { complete: true },
			});
			const durableState = await durable(peer);
			expect(
				durableState.rows.every((row) => row.commit.authorSequence > receipt.prunedThroughAuthorSequence),
				"F5B_C13_REAL_ISSUANCE_PREFIX_GONE"
			).toBe(true);
		}
	}
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function displacedControls() {
	const fixture = await openRoom(2, false, true);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "control-creator");
	await fixture.issue(writer, "control-writer");
	fixture.held.add(writer.databaseName);
	await writer.room.issue({ action: "join", clientId: "alice" });
	const join = required(ownCommits(writer).at(-1));
	await writer.room.issue({ action: "acl", group: "writer", kind: "revoke", target: creator.author });
	const acl = required(ownCommits(writer).at(-1));
	await fixture.close();
	fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	const decisions: { action: string; commits: number; planWrites: number }[] = [];
	const application: CreateV3RoomSessionInput["application"] = {
		...writer.input.application,
		displacedOperationIdentity: (operation) =>
			operation.action === "acl"
				? hex(encodeCanonical(operation))
				: writer.input.application.displacedOperationIdentity(operation),
		displacementPolicies: {
			...writer.input.application.displacementPolicies,
			get acl() {
				decisions.push({ action: "acl", commits: ownCommits(writer).length, planWrites: observed.planWrites.length });
				return "manual-review" as const;
			},
		},
	};
	const before = ownCommits(writer).length;
	await fixture.reopen(writer, 0, true, application);
	await expect(
		fixture.issue(writer, "acl-review-barrier"),
		"F5B_C21_DISPLACED_ACL_HOLDS_BEFORE_FENCE"
	).rejects.toThrow();
	expect(decisions.length, "F5B_C21_ACL_SURFACED_TO_REAL_APPLICATION_POLICY").toBeGreaterThan(0);
	expect(
		decisions.every((decision) => decision.commits === before),
		"F5B_C21_POLICY_PRECEDES_ANY_NEW_ISSUE"
	).toBe(true);
	const held = await durable(writer);
	expect(held.plan).toMatchObject({
		fenceSequence: null,
		entries: [{ sourceSequence: acl.authorSequence, disposition: "manual-review", replacementSequence: null }],
	});
	expect(
		held.plan?.entries.some((entry) => entry.sourceSequence === join.authorSequence),
		"F5B_C21_DISPLACED_JOIN_HAS_NO_APPLICATION_DISPOSITION"
	).toBe(false);
	expect(messages(creator), "F5B_C21_CONTROL_HAS_NO_APPLICATION_EFFECT").toHaveLength(2);
	const plane = required(observed.planes.get(writer.databaseName));
	await expect(
		plane.completeRebaseSource({ authorSequence: acl.authorSequence, digest: hex(acl.envelope.digest) }),
		"F5B_C20_REAL_SETTLEMENT_HANDLE_CANNOT_MARK_SOURCE_COMPLETE"
	).resolves.toMatchObject({
		ok: false,
		kind: "not-active",
		detail: "v3 displaced source completion is unavailable under settlement",
	});
	expect(await durable(writer), "F5B_C20_PLAN_IS_ONLY_COMPLETION_OWNER").toEqual(held);
	// No new parent behavior is duplicated for the identical structural-no-intent
	// causalJoin classifier: exact closed signed cross-anchor vector is retained in
	// phase-6b-d110c-0c1f5b0b-node-red.test.ts, "[control] classifies signed same-key
	// cross-anchor causalJoin without application intents". Its reserved local ABI
	// remains covered by phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts.
	await Promise.all(fixture.peers.map(fixture.stop));
}

async function sameKeyReentry() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "reentry-creator-initial");
	await fixture.issue(writer, "reentry-writer-initial");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "old-incarnation-unadmitted");
	const previous = await durable(writer);
	const oldEnvelope = required(fixture.envelopes.findLast((message) => message.sender === writer.databaseName));
	const oldVertex = record(V3Envelope.decode(oldEnvelope.data).canonicalPreimage);
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	for (let epoch = 0; epoch < 3; epoch += 1) {
		await fixture.issue(creator, `removed-epoch-${epoch}`);
		await fixture.close();
		const checkpoint = fixture.checkpoint();
		expect(frontierFor(checkpoint.capability, writer.author), "F5B_C06_ABSENT_ACROSS_MULTIPLE_CLOSES").toBeUndefined();
		await creator.room.adoptCreatorSuccessor();
	}
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	const returning = required(frontierFor(checkpoint.capability, writer.author));
	// Unlike a role-only transition, complete removal and regrant creates a new
	// authenticated incarnation, with no retired-key dictionary or lineage jump.
	expect(returning, "F5B_C07_SAME_KEY_NEW_INCARNATION").toEqual([writer.author, 4, null]);
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	const offset = observed.commits.length;
	await fixture.reopen(writer, 3, true);
	await fixture.issue(writer, "same-device-reentry");
	const issued = observed.commits
		.slice(offset)
		.filter((row) => record(row.envelope.canonicalPreimageBytes).author === writer.author);
	const first = required(issued[0]);
	expect(first.authorSequence, "F5B_C07_NEVER_RESET_DEVICE_SEQUENCE").toBe(previous.lineage.next);
	expect(record(first.envelope.canonicalPreimageBytes).operation, "F5B_C07_EMPTY_PLAN_STILL_FENCES").toMatchObject({
		action: "$drp.author-fence.v1",
	});
	expect((await durable(writer)).plan?.entries, "F5B_C07_OLD_INCARNATION_NOT_REBASED").toHaveLength(0);
	expect(oldVertex.epoch, "F5B_C09_OLD_VERTEX_REMAINS_ON_ITS_DEAD_ANCHOR").toBeLessThan(returning[1]);
	expect(oldVertex.anchor, "F5B_C09_CROSS_ANCHOR_PAIR_IS_NOT_EQUIVOCATION").not.toBe(
		creator.room.authority()?.anchorDigest
	);
	fixture.deliver(oldEnvelope);
	await fixture.issue(writer, "after-rejected-stale-envelope");
	const accepted = Reflect.get(creator.room.projection(), "accepted") as { clientOperationId: string }[];
	expect(
		accepted.map((row) => row.clientOperationId),
		"F5B_C09_STALE_INCARNATION_REJECTED_AT_REAL_INGRESS"
	).not.toContain("old-incarnation-unadmitted");
	await fixture.stop(writer);
	// A fresh installation receives the very same published authenticated bytes;
	// no issued/outbox/plan row from the returning device is copied to it.
	const fresh = {
		...writer,
		databaseName: `${writer.databaseName}-fresh`,
		floor: floorOwner(),
		input: {
			...writer.input,
			databaseName: `${writer.databaseName}-fresh`,
			issuanceDatabaseName: `${writer.databaseName}-fresh`,
			openTransport: fixture.transportFor(`${writer.databaseName}-fresh`),
		},
	};
	await fixture.reopen(fresh, 3, true);
	await fixture.issue(fresh, "fresh-device-reentry");
	expect((await durable(fresh)).lineage.next, "F5B_C08_FRESH_DEVICE_STARTS_AT_ZERO").toBeGreaterThanOrEqual(2);
	const freshStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: fresh.databaseName });
	try {
		const zero = required(await freshStore.readIssued({ author: fresh.author, objectId: fixture.objectId }, 0));
		expect(record(zero.envelope.canonicalPreimageBytes).operation, "F5B_C08_FRESH_DEVICE_FENCE_ZERO").toMatchObject({
			action: "$drp.author-fence.v1",
			fenceSequence: 0,
		});
	} finally {
		await freshStore.close();
	}
	await fixture.stop(fresh);
	await fixture.stop(creator);
}

async function manualReviewHold() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "manual-creator-before");
	await fixture.issue(writer, "manual-writer-before");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "manual-displaced");
	await fixture.close();
	const first = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	const before = await durable(writer);
	await fixture.reopen(writer, 0, true, {
		...writer.input.application,
		displacementPolicies: { message: "manual-review" },
	});
	await expect(fixture.issue(writer, "must-stay-held"), "F5B_C11_MANUAL_REVIEW_BARRIER").rejects.toThrow();
	const held = await durable(writer);
	expect(held.lineage, "F5B_C05_C11_NO_FENCE_OR_REPLACEMENT_WHILE_HELD").toEqual(before.lineage);
	expect(held.plan?.fenceSequence, "F5B_C11_DURABLE_UNFENCED_PLAN").toBeNull();
	expect(
		held.plan?.entries.some((entry) => entry.disposition === "manual-review"),
		"F5B_C11_PLAN_HOLD_DURABLE"
	).toBe(true);
	await fixture.issue(creator, "manual-other-author-progress");
	await fixture.close();
	const second = fixture.checkpoint();
	expect(frontierFor(second.capability, creator.author)?.[2], "F5B_C11_ONLY_HELD_AUTHOR_STALLS").toBeGreaterThan(
		required(frontierFor(first.capability, creator.author)?.[2])
	);
	expect(frontierFor(second.capability, writer.author)?.[2], "F5B_C11_HELD_BOUNDARY_UNCHANGED").toBe(
		frontierFor(first.capability, writer.author)?.[2]
	);
	await creator.room.adoptCreatorSuccessor();
	// The original source must still exist while unlinked; backend primitive
	// conformance additionally tests direct prune refusal under the same gate.
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: writer.databaseName });
	try {
		for (const entry of required(held.plan).entries)
			expect(
				await store.readIssued({ author: writer.author, objectId: fixture.objectId }, entry.sourceSequence),
				"F5B_C13_UNLINKED_SOURCE_RETAINED_ACROSS_CLOSE"
			).not.toBeNull();
	} finally {
		await store.close();
	}
	// Hold survives an authenticated transition and cold reopen byte-for-byte.
	const heldPolicy = Object.freeze({
		...writer.input.application,
		displacementPolicies: Object.freeze({ message: "manual-review" as const }),
	});
	await fixture.reopen(writer, 1, true, heldPolicy);
	await expect(fixture.issue(writer, "held-after-cold-reopen")).rejects.toThrow(
		"v3 room settlement plan requires manual review"
	);
	expect(encodeCanonical((await durable(writer)).plan), "F5B_C11_CROSS_CLOSE_COLD_REOPEN_PRESERVES_HELD_PLAN").toEqual(
		encodeCanonical(held.plan)
	);
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toBeUndefined();
	await creator.room.adoptCreatorSuccessor();
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	expect(frontierFor(fixture.checkpoint().capability, writer.author)).toEqual([writer.author, 4, null]);
	await creator.room.adoptCreatorSuccessor();
	await fixture.reopen(writer, 3, true, heldPolicy);
	await fixture.issue(writer, "readmitted-after-hold");
	expect(
		(await durable(writer)).plan?.entries,
		"F5B_C11_AUTHENTICATED_READMISSION_RETIRES_OLD_HOLD_NO_RESOLVER"
	).toEqual([]);
	expect(
		messages(creator).map((row) => row.clientOperationId),
		"F5B_C11_AUTHOR_WIDE_READMISSION_DISCARDS_OLD_CONTENT_NOT_MODERATOR_APPROVAL"
	).not.toContain("manual-displaced");
	await fixture.stop(writer);
	await fixture.stop(creator);
}

async function creatorFenceScan(duplicate = false, stale = false) {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "scan-creator-before");
	await fixture.issue(writer, "scan-writer-before");
	await fixture.close();
	const first = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "scan-writer-current");
	const authority = required(creator.room.authority());
	const makeFence = (sequence: number, fenceSequence: number, dependency = authority.anchorDigest) => {
		const canonicalPreimage = encodeCanonical({
			anchor: authority.anchorDigest,
			author: writer.author,
			authorSequence: sequence,
			dependencies: [dependency],
			epoch: authority.epoch,
			kind: "drp-vertex",
			logicalTime: 10_000 + sequence,
			objectId: fixture.objectId,
			operation: { action: "$drp.author-fence.v1", fenceSequence, version: 1 },
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimage);
		return {
			digest: hex(digest),
			message: Message.create({
				objectId: required(observed.planes.get(creator.databaseName)).topic,
				data: V3Envelope.encode({ canonicalPreimage, signature: ed25519.sign(digest, writer.seed) }).finish(),
				sender: writer.databaseName,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			}),
		};
	};
	// Adversarial author signs its own operations. Only operation bytes are
	// adversarial; creator graph, signature checking, close and checkpoint are real.
	const lower = makeFence(10_000, 10_000);
	const largest = makeFence(10_001, 10_001, lower.digest);
	if (stale) {
		fixture.deliver(makeFence(10_000, required(frontierFor(first.capability, writer.author)?.[2])).message);
	} else {
		fixture.deliver(lower.message);
		if (duplicate) fixture.deliver(makeFence(10_000, 9999).message);
		fixture.deliver(largest.message);
	}
	fixture.deliver(makeFence(10_002, 10_003).message); // m > f: malformed control
	await fixture.issue(writer, "scan-after-fences"); // FIFO ingress acknowledgement
	await fixture.issue(creator, "scan-independent-creator");
	await fixture.close();
	const second = fixture.checkpoint();
	expect(
		frontierFor(second.capability, writer.author)?.[2],
		duplicate
			? "F5B_C23_SAME_SLOT_DUPLICATE_BELOW_FENCE_FREEZES_PRIOR_BOUNDARY"
			: "F5B_C12_LARGEST_VALID_FENCE_THEN_CONTIGUOUS_SCAN"
	).toBe(
		duplicate
			? frontierFor(first.capability, writer.author)?.[2]
			: stale
				? required(ownCommits(writer).at(-1)).authorSequence
				: 10_001
	);
	if (stale)
		expect(
			frontierFor(second.capability, writer.author)?.[2],
			"F5B_C12_M_AT_OR_BELOW_TERMINAL_CANNOT_BRIDGE_UNKNOWN_SLOTS"
		).toBeLessThan(10_000);
	expect(
		frontierFor(second.capability, creator.author)?.[2],
		duplicate ? "F5B_C23_OTHER_AUTHOR_ADVANCES_DESPITE_DUPLICATE" : "F5B_C12_BYZANTINE_JUMP_ONLY_BURNS_OWN_SPACE"
	).toBeGreaterThan(required(frontierFor(first.capability, creator.author)?.[2]));
	await creator.room.adoptCreatorSuccessor();
	await fixture.stop(writer);
	await fixture.stop(creator);
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: {
			estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }),
		},
	});
	observed.stores.clear();
	observed.planes.clear();
	observed.commits = [];
	observed.advances = [];
	observed.failSuffixFor = "";
	observed.faults = 0;
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	observed.issueAttempts = [];
	observed.commitHandles.clear();
	observed.issuePlans.clear();
	observed.timeline = [];
	observed.ambiguities = [];
	observed.publications = [];
	observed.planWrites = [];
	observed.prunes = [];
	observed.cleanup = [];
	observed.closeGraphs = [];
	observed.snapshots = [];
});
afterEach(async () => {
	wideDiagnostic("afterEach", "begin");
	observed.failSuffixFor = "";
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	await Promise.all([...sessions].map((room) => room.close().catch(() => undefined)));
	sessions.clear();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
	wideDiagnostic("afterEach", "end");
});

describe("D.110c-0c1f5b parent genuine settlement composition", () => {
	it("snapshot oracle removes controls before Kahn while ACL vertices retain their ordering effect", () => {
		const message = (id: string) => ({ action: "message", clientOperationId: id, text: id });
		const graph = new Map<string, SnapshotOracleVertex>([
			["00", { dependencies: [] }],
			["80", { dependencies: ["00"], operation: { action: "$drp.author-fence.v1" } }],
			["90", { dependencies: ["80"], operation: { action: "join" } }],
			["05", { dependencies: ["90"], operation: { action: "acl" } }],
			["85", { dependencies: ["05"], operation: { action: "causalJoin" } }],
			["95", { dependencies: ["80"], operation: { action: "join" } }],
			["10", { dependencies: ["85", "95"], operation: message("A") }],
			["20", { dependencies: ["00"], operation: message("B") }],
		]);
		// 85 and 95 are incomparable: elision expands them to 05 and its
		// ancestor 00, so the projected dependencies must reduce to just 05.
		// Raw minimum-hash Kahn is 00,20,80,90,05,85,95,10: filtering that order
		// would yield B,A. Elision before ordering must instead yield A,B.
		const result = snapshotStateOracle(graph, "00", ["10", "20"], encodeCanonical([]));
		expect(result.order).toEqual(["00", "05", "10", "20"]);
		expect([...result.dependencies]).toEqual([
			["00", []],
			["05", ["00"]],
			["10", ["05"]],
			["20", ["00"]],
		]);
		expect(result.ancestors).toEqual(["00", "05", "10", "20", "80", "85", "90", "95"]);
		expect(result.state).toEqual(
			encodeCanonical([
				{ clientOperationId: "A", text: "A" },
				{ clientOperationId: "B", text: "B" },
			])
		);
		expect(result.state).not.toEqual(
			encodeCanonical([
				{ clientOperationId: "B", text: "B" },
				{ clientOperationId: "A", text: "A" },
			])
		);
	});
	it("snapshot oracle preserves prior state atomic batch entry order and duplicate effects", () => {
		const duplicate = { clientOperationId: "dup", text: "same" };
		const operation = { action: "message", ...duplicate };
		const base = encodeCanonical([duplicate]);
		const graph = new Map<string, SnapshotOracleVertex>([
			["00", { dependencies: [] }],
			["10", { dependencies: ["00"], operation }],
			[
				"30",
				{
					dependencies: ["00"],
					operation: {
						action: "applicationBatch",
						batch: {
							version: 1,
							entries: [
								{ logicalTime: 2, operation: { action: "message", clientOperationId: "z", text: "first-in-batch" } },
								{ logicalTime: 3, operation },
							],
						},
					},
				},
			],
			[
				"35",
				{ dependencies: ["00"], operation: { action: "message", clientOperationId: "tail", text: "after-batch" } },
			],
		]);
		const result = snapshotStateOracle(graph, "00", ["10", "30", "35"], base);
		expect(result.order).toEqual(["00", "10", "30", "35"]);
		expect(result.state).toEqual(
			encodeCanonical([
				duplicate,
				duplicate,
				{ clientOperationId: "z", text: "first-in-batch" },
				duplicate,
				{ clientOperationId: "tail", text: "after-batch" },
			])
		);
		expect(base).toEqual(encodeCanonical([duplicate]));
	});
	it("retains checkpoint-terminal open progress through cold recovery across three transitions", async () => {
		const fixture = await openRoom(2, false, false, true);
		const creator = required(fixture.peers[0]);
		const writer = required(fixture.peers[1]);
		const application = creator.input.application;
		const blueprintDigest = required(application.catalog.blueprintDigests[0]);
		const artifact = application.catalog.resolve(blueprintDigest);
		expect(artifact.canonicalBlueprintPackageBytes, "F5B_C03_CATALOG_PACKAGE_MATCHES_REAL_APPLICATION").toEqual(
			application.canonicalBlueprintPackageBytes
		);
		expect(blueprintDigest, "F5B_C03_REAL_LOCAL_PACKAGE_DIGEST").toBe(
			hex(hashDomain("ts-drp/blueprint-admission/v3", application.canonicalBlueprintPackageBytes))
		);
		expect(
			record(application.canonicalBlueprintPackageBytes).implementation,
			"F5B_C03_LOCAL_ARTIFACT_ID_AND_DIGEST_COUPLED"
		).toEqual({
			artifactId: "f5b-transient-payload.v1",
			artifactDigest: hex(hashDomain("ts-drp/blueprint-artifact/v3", artifact.exactArtifactBytes)),
			runtimeProfile: "ecmascript-2024-sync-v1",
		});
		const invite = creator.input.creatorInvite;
		if (typeof invite === "string") throw new TypeError("F5B_C03_EXACT_CREATOR_INVITE_MATERIAL_REQUIRED");
		expect(
			record(invite.exactCanonicalGenesisAnchorPreimageBytes).blueprintDigest,
			"F5B_C03_GENUINE_INVITE_BINDS_LOCAL_BLUEPRINT"
		).toBe(blueprintDigest);
		await fixture.issue(creator, "creator-before-close");
		await fixture.issue(writer, "writer-before-close");
		fixture.held.add(writer.databaseName);
		await Promise.all([fixture.issue(writer, "displaced-0"), fixture.issue(writer, "displaced-1")]);
		const scope = { author: writer.author, objectId: fixture.objectId };
		const sourceStore = required(observed.stores.get(writer.databaseName));
		const before = await sourceStore.readLineage(scope);
		const source = required(await sourceStore.readIssued(scope, before.next - 1));
		expect(record(source.envelope.canonicalPreimageBytes).operation, "F5B_REAL_BATCH_SOURCE").toMatchObject({
			action: "applicationBatch",
		});
		const sourceOperation = record(source.envelope.canonicalPreimageBytes).operation as {
			action: string;
			batch: { entries: { logicalTime: number; operation: Record<string, unknown> }[]; version: number };
		};
		expect(
			sourceOperation.batch.entries.map((entry) => entry.operation),
			"F5B_C03_REAL_TWO_INTENT_SOURCE_BYTES"
		).toEqual([
			{ action: "message", clientOperationId: "displaced-0", text: "displaced-0" },
			{ action: "message", clientOperationId: "displaced-1", text: "displaced-1" },
		]);
		const transformed = sourceOperation.batch.entries.map((entry) => ({
			...entry,
			operation: required(application.transformDisplacedOperation)(entry.operation),
		}));
		for (const entry of transformed) {
			expect(entry.operation).toEqual({
				action: "message",
				clientOperationId: entry.operation.clientOperationId,
				text: "r".repeat(33_000),
			});
			expect(
				encodeCanonical(entry.operation).byteLength,
				"F5B_C03_SINGLE_TRANSIENT_OPERATION_WITHIN_UNCHANGED_LIMIT"
			).toBeLessThan(65_536);
		}
		expect(
			encodeCanonical({ action: "applicationBatch", batch: { entries: transformed, version: 1 } }).byteLength,
			"F5B_C03_PAIR_REQUIRES_REAL_MULTIPLE_REPLACEMENT_CHUNKS"
		).toBeGreaterThan(65_536);
		expect(productState(creator).byteLength, "F5B_C03_INITIAL_REAL_STATE_WITHIN_UNCHANGED_CEILING").toBeLessThan(
			32_768
		);
		// The only intended RED terminus: genuine production close, before any
		// frontier fixture or capability can exist. All subsequent code is GREEN
		// continuation, not a claim that RED physically entered openProgressSources.
		await fixture.close();
		const first = fixture.checkpoint();
		expect(frontierFor(first.capability, writer.author)?.[2], "F5B_C03_BATCH_SOURCE_NOT_ADMITTED").toBeLessThan(
			source.authorSequence
		);
		for (const peer of fixture.peers)
			expect(frontierFor(first.capability, peer.author)?.[1], "F5B_C22_GENESIS_INCARNATION").toBe(0);
		const creatorZero = required(ownCommits(creator).find((row) => row.authorSequence === 0));
		expect(
			required(observed.closeGraphs.at(-1)).result.closeSetOrder,
			"F5B_C22_REAL_CLOSE_SET_INCLUDES_CREATOR_SLOT_ZERO"
		).toContain(hex(creatorZero.envelope.digest));
		expect(
			record(creatorZero.envelope.canonicalPreimageBytes).epoch,
			"F5B_C22_REAL_CREATOR_SLOT_ZERO_GENESIS_ROW"
		).toBe(0);
		expect(
			record(creatorZero.envelope.canonicalPreimageBytes).operation,
			"F5B_C22_SLOT_ZERO_ACCOUNTED_WITHOUT_BEING_A_FENCE"
		).not.toMatchObject({ action: "$drp.author-fence.v1" });
		expect(
			frontierFor(first.capability, creator.author)?.[2],
			"F5B_C22_EXACT_CREATOR_GENESIS_FRONTIER_INCLUDES_SLOT_ZERO"
		).toBe(required(ownCommits(creator).at(-1)).authorSequence);
		await creator.room.adoptCreatorSuccessor();
		fixture.held.delete(writer.databaseName);
		observed.failSuffixFor = writer.databaseName;
		await fixture.reopen(writer, 0, true);
		await expect(fixture.issue(writer, "blocked-suffix"), "F5B_C03_CRASH_AFTER_COMMITTED_PREFIX").rejects.toThrow();
		const partial = required((await durable(writer)).plan);
		const entry = required(partial.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(entry.replacementSequence, "F5B_C10_PARTIAL_LINK_UNFULFILLED").toBeNull();
		expect(required(entry.replacementProgress).chunks, "F5B_REAL_ROOM_CREATED_PARTIAL_PROGRESS").toHaveLength(1);
		expect(partial.fenceSequence, "F5B_C02_FENCE_PRECEDES_REPLACEMENT").toBeLessThan(
			required(required(entry.replacementProgress).chunks[0]).replacementSequence
		);
		const prefixSequence = required(required(entry.replacementProgress).chunks[0]).replacementSequence;
		const prefix = required(ownCommits(writer).find((row) => row.authorSequence === prefixSequence));
		expect(applicationOperations(prefix), "F5B_C03_COMMITTED_PREFIX_RETAINS_REAL_TRANSIENT_BYTES").toEqual([
			required(transformed[0]).operation,
		]);
		const failedOwner = writer.room;
		expect(() => failedOwner.projection(), "F5B_C03_FAILED_PREFIX_OWNER_PROJECTION_REMAINS_TERMINAL").toThrow();
		const beforeRestartProjection = fixture.emittedProjection(writer);
		const beforeRestartState = beforeRestartProjection.bytes;
		await fixture.reopen(writer, 0);
		await expect(
			fixture.issue(writer, "same-epoch-blocked-suffix"),
			"F5B_C03_SAME_EPOCH_RESTART_RETRIES_ONLY_UNCOMMITTED_SUFFIX"
		).rejects.toThrow();
		expect((await durable(writer)).plan, "F5B_C03_SAME_EPOCH_RESTART_PRESERVES_EXACT_PARTIAL_PLAN").toEqual(partial);
		expect(writer.room, "F5B_C03_SAME_EPOCH_RESTART_HAS_FRESH_ROOM_OWNER").not.toBe(failedOwner);
		expect(() => writer.room.projection(), "F5B_C03_FAILED_RESTART_OWNER_PROJECTION_REMAINS_TERMINAL").toThrow();
		const afterRestartProjection = fixture.emittedProjection(writer);
		expect(afterRestartProjection.generation, "F5B_C03_RESTART_CANNOT_REUSE_PRIOR_OWNER_EMISSION").toBe(
			beforeRestartProjection.generation + 1
		);
		expect(afterRestartProjection.bytes, "F5B_C03_SAME_EPOCH_RESTART_PRESERVES_EXACT_BOUNDED_STATE").toEqual(
			beforeRestartState
		);
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === prefixSequence),
			"F5B_C03_SAME_EPOCH_RESTART_NO_PREFIX_REISSUE"
		).toEqual([prefix]);
		expect(
			observed.publications.filter((row) => row.database === writer.databaseName && row.sequence === prefixSequence),
			"F5B_C03_SAME_EPOCH_RESTART_NO_PREFIX_REPUBLICATION"
		).toHaveLength(1);
		await fixture.issue(creator, "creator-during-writer-crash");
		expect(productState(creator).byteLength, "F5B_C03_PREFIX_FOLD_STATE_WITHIN_UNCHANGED_CEILING").toBeLessThan(32_768);
		await fixture.close();
		const second = fixture.checkpoint();
		expect(
			frontierFor(second.capability, writer.author)?.[2],
			"F5B_AUTHENTICATED_SOURCE_IS_TERMINAL"
		).toBeGreaterThanOrEqual(source.authorSequence);
		await creator.room.adoptCreatorSuccessor();
		const incompleteSource = await durable(writer);
		expect(
			incompleteSource.rows.some((row) => row.commit.authorSequence === source.authorSequence),
			"F5B_C13_INCOMPLETE_PLAN_SOURCE_RETAINED_AFTER_AUTHENTICATED_ADOPTION"
		).toBe(true);
		expect(
			observed.prunes
				.filter((event) => event.database === writer.databaseName)
				.every((event) => event.receipt?.deletedAuthorSequenceRange === null || event.receipt === undefined),
			"F5B_C13_PARENT_REFUSES_DELETE_WHILE_PLAN_UNLINKED"
		).toBe(true);
		observed.failSuffixFor = "";
		await fixture.reopen(writer, 1, true);
		await fixture.issue(writer, "after-cold-reopen");
		const recoverySource = readFileSync(new URL("../packages/node/src/v3-live.ts", import.meta.url), "utf8");
		// Together with the real terminal checkpoint + partial-progress completion
		// below, forbid the current unconditional undefined-frontier bypass. This
		// does not inject the context: only production checkpoint custody may do so.
		expect(recoverySource, "F5B_OPEN_PROGRESS_NO_UNAUTHENTICATED_UNDEFINED_FRONTIER_CALL").not.toMatch(
			/readSettlementSources\(registration\)/u
		);
		const complete = required(await required(observed.stores.get(writer.databaseName)).readSettlementPlan(scope));
		const completed = required(complete.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(
			completed.replacementSequence,
			"F5B_OPEN_PROGRESS_SOURCES_AUTHENTICATED_FRONTIER_REACHABILITY"
		).not.toBeNull();
		expect(required(completed.replacementProgress).chunks[0], "F5B_C10_LINKED_PREFIX_NEVER_REISSUED").toEqual(
			required(entry.replacementProgress).chunks[0]
		);
		expect(required(completed.replacementProgress).chunks.at(-1)?.throughIntent, "F5B_C03_UNLINKED_SUFFIX_ONCE").toBe(
			2
		);
		const chunks = required(completed.replacementProgress).chunks;
		expect(chunks, "F5B_C03_EXACT_TWO_GENUINE_COMMITTED_REPLACEMENT_CHUNKS").toHaveLength(2);
		const chunkCommits = chunks.map((chunk) =>
			required(ownCommits(writer).find((row) => row.authorSequence === chunk.replacementSequence))
		);
		expect(
			chunkCommits.flatMap(applicationOperations),
			"F5B_C03_EXACT_TRANSIENT_INTENTS_NO_PREFIX_REISSUE_SUFFIX_ONCE"
		).toEqual(transformed.map((entry) => entry.operation));
		for (const chunk of chunkCommits) {
			expect(ownCommits(writer).filter((row) => row.authorSequence === chunk.authorSequence)).toHaveLength(1);
			expect(
				observed.publications.filter(
					(row) =>
						row.database === writer.databaseName &&
						row.sequence === chunk.authorSequence &&
						row.digest === hex(chunk.envelope.digest)
				)
			).toHaveLength(1);
			expect(encodeCanonical(record(chunk.envelope.canonicalPreimageBytes).operation).byteLength).toBeLessThan(65_536);
		}
		for (const id of ["displaced-0", "displaced-1"])
			expect(
				messages(creator).filter((row) => row.clientOperationId === id),
				"F5B_C03_TRANSIENT_BYTES_NOT_RETAINED_ONE_STATE_EFFECT_PER_INTENT"
			).toEqual([{ clientOperationId: id, text: id }]);
		expect(productState(creator).byteLength, "F5B_C03_COMPLETE_REAL_STATE_WITHIN_UNCHANGED_CEILING").toBeLessThan(
			32_768
		);
		await fixture.close();
		fixture.checkpoint();
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(creator, 2);
		await fixture.issue(creator, "creator-cold-reopen");
		await fixture.reopen(writer, 2, true);
		await fixture.issue(writer, "writer-third-reopen");
		for (const peer of fixture.peers)
			expect(peer.room.authority()?.epoch, "F5B_C14_THREE_TRANSITIONS_AND_COLD_REOPEN").toBe(3);
		for (const peer of fixture.peers)
			expect(
				productState(peer).byteLength,
				"F5B_C03_THIRD_TRANSITION_REAL_STATE_WITHIN_UNCHANGED_CEILING"
			).toBeLessThan(32_768);
		await Promise.all(fixture.peers.map(fixture.stop));
	});

	// Independently attributable continuations replace the old aggregate timeout.
	// The authorized 90s runner watchdog belongs only to the fixed 64-writer
	// functional fixture; it is NOT a product latency/performance acceptance gate.
	// No complete GREEN duration is claimed by this pre-codec RED.
	it(
		"composes 64 active writers with universal plan fence and exact state accounting across three transitions",
		sixtyFourWriterGoldenPath,
		90_000
	);
	it(
		"case 1 withholds a distinct dependent author sequence until its delayed predecessor is settled",
		delayedDependency
	);
	it("cases 6-9 authenticate same-key removal and same-device and fresh-device readmission", sameKeyReentry);
	it(
		"case 11 retains the hold across close and cold reopen until authenticated author-wide readmission",
		manualReviewHold
	);
	it("case 12 scans the largest valid fence without burning another author space", () => creatorFenceScan());
	it("case 12 ignores a stale fence at or below the authenticated terminal boundary", () =>
		creatorFenceScan(false, true));
	it("case 23 freezes only the equivocating author below a fence", () => creatorFenceScan(true));
	it.each(["unpublished-fence", "delayed-replacement", "delayed-fence"] as const)(
		"cases 4 15 16 preserve %s custody",
		delayedPublication
	);
	it("case 17 closes an authenticated null-boundary member without a fence or slot zero", nullBoundaryClose);
	it("cases 19-21 retain displaced control and sole plan completion ownership", displacedControls);
	it("case 24a rejects a stale local head without regressing the authenticated floor", staleLocalHead);
	it.each([
		["fence", false],
		["fence", true],
		["replacement", false],
		["replacement", true],
	] as const)("case 25 accounts exact surviving %s publication with committed=%s", ambiguousPlanIssue);
	it("case 25 retains custody when bounded authenticated recovery cannot read durable truth", () =>
		ambiguousPlanIssue("fence", false, true));
	it("case 13 prunes only beyond the fully retained authenticated rollback window", positiveAuthenticatedPruning);
	it("case 17 retains the exact legacy v1 reentry guard source custody", () => {
		const source = readFileSync(new URL("../packages/node/src/creator-close.ts", import.meta.url), "utf8");
		expect(source).toContain('"D110C_0C1F1_AUTHOR_REENTRY_PROOF_REQUIRED"');
		expect(source.replace(/\s+/gu, " "), "F5B_C17_V1_PRIORLESS_REENTRY_GUARD_UNCHANGED").toContain(
			"if (priorBoundary === undefined) { const observedNext = author === input.issuanceScope.author ? localNext : undefined; if ((sequences[0] ?? observedNext ?? 0) > 1) { throw new TypeError( priorIdentity === undefined ? LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED : AUTHOR_REENTRY_PROOF_REQUIRED ); }"
		);
	});

	it("keeps the genuine v1 room issue, close, adoption and cold reopen control unchanged", async () => {
		const fixture = await openRoom(1, true);
		const creator = required(fixture.peers[0]);
		await fixture.issue(creator, "v1-control");
		const closed = await fixture.close();
		expect(closed.successorEpoch, "F5B_C17_CV1_COMPATIBILITY_CLOSE").toBe(1);
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(creator, 0);
		await fixture.issue(creator, "v1-after-reopen");
		expect(creator.room.authority()?.epoch, "F5B_V1_COLD_REOPEN_CONTROL").toBe(1);
		await fixture.stop(creator);
		// Observe the exact pre-existing floor rejection independently of the
		// settlement carrier RED. Case 24a uses this same error with a linked plan.
		const floorControl = await openRoom(2, true);
		const floorCreator = required(floorControl.peers[0]);
		const floorWriter = required(floorControl.peers[1]);
		await floorControl.issue(floorCreator, "v1-floor-creator");
		await floorControl.issue(floorWriter, "v1-floor-writer");
		await floorControl.close();
		await floorCreator.room.adoptCreatorSuccessor();
		await floorControl.reopen(floorWriter, 0, true);
		await floorControl.issue(floorWriter, "v1-floor-writer-next");
		await floorControl.stop(floorWriter);
		const untouched = await durable(floorWriter);
		await floorControl.close();
		await floorCreator.room.adoptCreatorSuccessor();
		floorWriter.floor.receive(floorCreator.floor.read());
		const currentFloor = floorWriter.floor.read();
		// No live owner competes with this stale durable-copy probe. The newer
		// creator floor stays committed; stopping a session never rewinds it.
		await floorControl.stop(floorCreator);
		await expect(
			floorControl.reopen(floorWriter, 0),
			"F5B_C24A_EXACT_REACHABLE_FLOOR_REJECTION_CONTROL"
		).rejects.toThrow(STALE_LOCAL_HEAD_FAILURE);
		expect(await durable(floorWriter)).toEqual(untouched);
		expect(floorWriter.floor.read()).toEqual(currentFloor);
	});
});
