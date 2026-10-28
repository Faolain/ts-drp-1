/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
// C03 layer 2: a Writer that crashes between signing a replacement intent and committing it.
// The store keeps that intent as pending unsigned custody and refuses every settlement plan
// write and every other issue at that ordinal until the identical intent commits. The next
// reopen must resume it before its startup drain writes a plan, or the Writer is wedged.
// Fault injection: C03's (the second replacement chunk throws after native entry).
// Model: packages/node/formal/creator-pending-intent-resume.qnt.
import "fake-indexeddb/auto";
import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	durable,
	observed,
	openRoom,
	originalStorage,
	type Peer,
	record,
	required,
	sessions,
} from "./fixtures/grid-room-workload.js";

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

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
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
	observed.failSuffixFor = "";
	await Promise.all([...sessions].map((room) => room.close().catch(() => undefined)));
	sessions.clear();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});

// C03's setup up to the suffix crash: a two-intent displaced batch whose replacement needs
// two chunks; the first commits, the second throws after native entry.
async function crashBetweenSignAndCommit() {
	const fixture = await openRoom(2, false, false, true);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "creator-before-close");
	await fixture.issue(writer, "writer-before-close");
	fixture.held.add(writer.databaseName);
	await Promise.all([fixture.issue(writer, "displaced-0"), fixture.issue(writer, "displaced-1")]);
	const scope = { author: writer.author, objectId: fixture.objectId };
	const before = await durable(writer);
	expect(before.lineage.next, "RESUME_SOURCE_ISSUED").toBeGreaterThan(0);
	const source = required(before.rows.at(-1)).commit;
	const transformed = applicationOperations(source).map((operation) =>
		required(writer.input.application.transformDisplacedOperation)(operation)
	);
	expect(transformed, "RESUME_TWO_INTENT_SOURCE").toHaveLength(2);
	await fixture.close();
	fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	observed.failSuffixFor = writer.databaseName;
	await fixture.reopen(writer, 0, true);
	await expect(fixture.issue(writer, "blocked-suffix"), "RESUME_SUFFIX_CRASHES_AFTER_ENTRY").rejects.toThrow();
	expect(observed.faults, "RESUME_FAULT_INJECTED_AFTER_NATIVE_ENTRY").toBeGreaterThan(0);
	const partial = required((await durable(writer)).plan);
	const entry = required(partial.entries.find((row) => row.sourceSequence === source.authorSequence));
	expect(entry.replacementSequence, "RESUME_PARTIAL_LINK_UNFULFILLED").toBeNull();
	expect(required(entry.replacementProgress).chunks, "RESUME_ONE_COMMITTED_PREFIX_CHUNK").toHaveLength(1);
	observed.failSuffixFor = "";
	return {
		fixture,
		creator,
		writer,
		scope,
		source,
		transformed,
		prefix: required(entry.replacementProgress).chunks[0],
	};
}

// The resumed suffix completes the replacement exactly once and the Writer issues again.
async function expectResumed(setup: Awaited<ReturnType<typeof crashBetweenSignAndCommit>>, label: string) {
	const { fixture, writer, source, transformed, prefix } = setup;
	await fixture.issue(writer, `${label}-after-resume`);
	const plan = required((await durable(writer)).plan);
	const completed = required(plan.entries.find((row) => row.sourceSequence === source.authorSequence));
	expect(completed.replacementSequence, "RESUME_REPLACEMENT_COMPLETES").not.toBeNull();
	const chunks = required(completed.replacementProgress).chunks;
	expect(chunks[0], "RESUME_PREFIX_NEVER_REISSUED").toEqual(prefix);
	expect(chunks, "RESUME_EXACT_TWO_CHUNKS").toHaveLength(2);
	const commits = chunks.map((chunk) =>
		required(ownCommits(writer).find((row) => row.authorSequence === chunk.replacementSequence))
	);
	expect(commits.flatMap(applicationOperations), "RESUME_EACH_INTENT_ONCE").toEqual(transformed);
	for (const chunk of chunks)
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === chunk.replacementSequence),
			"RESUME_NO_CHUNK_REISSUED"
		).toHaveLength(1);
	expect(encodeCanonical(plan).byteLength).toBeGreaterThan(0);
	await Promise.all(fixture.peers.map(fixture.stop));
}

describe("C03 layer 2: a Writer crashed between signing and committing a replacement intent", () => {
	// Control: in the same epoch the plan is unchanged, so no plan write precedes the resume.
	it("resumes the pending intent at a same-epoch reopen", async () => {
		const setup = await crashBetweenSignAndCommit();
		await setup.fixture.reopen(setup.writer, 0);
		await expectResumed(setup, "same-epoch");
	});

	it("resumes the pending intent before the next epoch's startup plan write", async () => {
		const setup = await crashBetweenSignAndCommit();
		await setup.fixture.issue(setup.creator, "creator-during-writer-crash");
		await setup.fixture.close();
		setup.fixture.checkpoint();
		await setup.creator.room.adoptCreatorSuccessor();
		await setup.fixture.reopen(setup.writer, 1, true);
		await expectResumed(setup, "next-epoch");
	});
});
