/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
// C03 layer 2: a Writer that crashes between signing a replacement intent and committing it.
// The store keeps that intent as pending unsigned custody and refuses every settlement plan
// write and every other issue at that ordinal until the identical intent commits. The next
// reopen must resume it before its startup drain writes a plan, or the Writer is wedged.
// Resuming signs, so only a current session resumes it (sync before sending): a device
// restored from a backup holding the intent, after the original device published that
// ordinal, is refused and signs nothing.
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
	productState,
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

const settle = (task: Promise<unknown>) =>
	task.then(
		() => "issued",
		(error: unknown) => String((error as Error)?.message ?? error)
	);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A device backup under fake-indexeddb: every database of the peer except the room-head floor
// (the room head does not move within the epochs these cases restore into).
type DatabaseDump = Readonly<{
	name: string;
	stores: readonly Readonly<{ name: string; keyPath: unknown; keys: IDBValidKey[]; values: unknown[] }>[];
}>;
const idb = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
const deviceDatabases = async (peer: Peer) =>
	(await indexedDB.databases()).flatMap(({ name }) =>
		name !== undefined &&
		(name === peer.databaseName || name.startsWith(`${peer.databaseName}--`)) &&
		!name.endsWith("--room-head")
			? [name]
			: []
	);
async function backupDevice(peer: Peer): Promise<readonly DatabaseDump[]> {
	const dumps: DatabaseDump[] = [];
	for (const name of await deviceDatabases(peer)) {
		const database = await idb(indexedDB.open(name));
		try {
			const names = [...database.objectStoreNames];
			const reading = database.transaction(names, "readonly");
			const stores = await Promise.all(
				names.map(async (store) => {
					const owner = reading.objectStore(store);
					return {
						name: store,
						keyPath: owner.keyPath,
						keys: await idb(owner.getAllKeys()),
						values: structuredClone(await idb(owner.getAll())),
					};
				})
			);
			dumps.push({ name, stores });
		} finally {
			database.close();
		}
	}
	return dumps;
}
async function restoreDevice(peer: Peer, dumps: readonly DatabaseDump[]) {
	for (const name of await deviceDatabases(peer)) {
		const dump = dumps.find((candidate) => candidate.name === name);
		const database = await idb(indexedDB.open(name));
		try {
			const names = [...database.objectStoreNames];
			const writing = database.transaction(names, "readwrite");
			const done = new Promise<void>((resolve, reject) => {
				writing.oncomplete = () => resolve();
				writing.onerror = () => reject(writing.error);
			});
			for (const store of names) {
				const owner = writing.objectStore(store);
				owner.clear();
				const rows = dump?.stores.find((candidate) => candidate.name === store);
				rows?.values.forEach((value, index) => {
					if (rows.keyPath === null) owner.put(structuredClone(value), rows.keys[index]);
					else owner.put(structuredClone(value));
				});
			}
			await done;
		} finally {
			database.close();
		}
	}
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
	// The resumed vertex is in the Writer's own plane and the creator's: both states converge.
	const same = () => Buffer.from(productState(writer)).equals(Buffer.from(productState(setup.creator)));
	for (let attempt = 0; attempt < 200 && !same(); attempt += 1) await sleep(50);
	expect(Buffer.from(productState(writer)).toString("hex"), "RESUME_STATES_CONVERGE").toBe(
		Buffer.from(productState(setup.creator)).toString("hex")
	);
	await Promise.all(fixture.peers.map(fixture.stop));
}

describe("C03 layer 2: a Writer crashed between signing and committing a replacement intent", () => {
	// Control: in the same epoch the plan is unchanged, so no plan write precedes the resume.
	it("resumes the pending intent at a same-epoch reopen", async () => {
		const setup = await crashBetweenSignAndCommit();
		await setup.fixture.reopen(setup.writer, 0);
		await expectResumed(setup, "same-epoch");
	});

	// The resumed intent belongs to the closed epoch: it commits exactly as signed, with its plan
	// effect, before the startup drain's first plan write (the state a crash just after that
	// commit leaves), so the replacement is complete and the plan write is no longer refused.
	it("resumes the pending intent before the next epoch's startup plan write", async () => {
		const setup = await crashBetweenSignAndCommit();
		const { fixture, creator, writer, source, transformed, prefix } = setup;
		const pendingAt = (await durable(writer)).lineage.next;
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === pendingAt),
			"RESUME_PENDING_UNCOMMITTED"
		).toEqual([]);
		await fixture.issue(creator, "creator-during-writer-crash");
		await fixture.close();
		fixture.checkpoint();
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(writer, 1, true);
		// The startup drain joins before this issue runs. Its outcome past the resume is C03 layer 3.
		expect(await settle(fixture.issue(writer, "next-epoch-after-resume")), "RESUME_BEFORE_PLAN_WRITE").not.toContain(
			"unresolved unsigned intent"
		);
		const after = await durable(writer);
		expect(after.lineage.next, "RESUME_PENDING_ORDINAL_COMMITTED").toBeGreaterThan(pendingAt);
		const completed = required(
			required(after.plan).entries.find((row) => row.sourceSequence === source.authorSequence)
		);
		expect(completed.replacementSequence, "RESUME_REPLACEMENT_COMPLETES").toBe(pendingAt);
		const chunks = required(completed.replacementProgress).chunks;
		expect(chunks[0], "RESUME_PREFIX_NEVER_REISSUED").toEqual(prefix);
		expect(
			chunks.map((chunk) => chunk.replacementSequence),
			"RESUME_EXACT_TWO_CHUNKS"
		).toEqual([prefix.replacementSequence, pendingAt]);
		const resumed = ownCommits(writer).filter((row) => row.authorSequence === pendingAt);
		expect(resumed, "RESUME_SIGNED_ONCE").toHaveLength(1);
		expect(
			[prefix.replacementSequence, pendingAt].flatMap((sequence) =>
				applicationOperations(required(ownCommits(writer).find((row) => row.authorSequence === sequence)))
			),
			"RESUME_EACH_INTENT_ONCE"
		).toEqual(transformed);
		await Promise.all(fixture.peers.map(fixture.stop));
	});

	// [RED] C03 layer 3, independent of the pending intent: the epoch-1 startup drain committed its
	// author fence (published only after readiness) and the replacement prefix, then died. In the
	// next epoch that fence is an unpublished displaced row with no plan entry, and the recovery
	// census refuses it, so the startup drain fails:
	//   creator recovery dependency hold unavailable:outbox-classification:<fence>:displaced:pending
	// The same failure with no pending intent at all (the suffix failing before native entry):
	// .logs/realtime-resume-2026-10-23/preexisting/c03l2-int7/control-before-entry-01.log.
	it("[RED layer 3] the Writer issues again in the next epoch after its startup drain died with its fence unpublished", async () => {
		const setup = await crashBetweenSignAndCommit();
		await setup.fixture.issue(setup.creator, "creator-during-writer-crash");
		await setup.fixture.close();
		setup.fixture.checkpoint();
		await setup.creator.room.adoptCreatorSuccessor();
		await setup.fixture.reopen(setup.writer, 1, true);
		await expectResumed(setup, "next-epoch");
	});

	// Sync before sending, the honest device: reopened before it has the creator's statement, its
	// startup drain leaves the intent pending and signs nothing; the statement makes it current
	// and that drain then runs, resuming the intent before any held move.
	it("holds the pending intent unsigned until the reopened Writer is current, then resumes it", async () => {
		const setup = await crashBetweenSignAndCommit();
		const { fixture, creator, writer } = setup;
		const pendingAt = (await durable(writer)).lineage.next;
		// The fixture's reopen hands the creator's statement over only from a live creator session.
		sessions.delete(creator.room);
		try {
			await fixture.reopen(writer, 0);
		} finally {
			sessions.add(creator.room);
		}
		expect(writer.room.localIssueCurrency?.(), "CURRENCY_NOT_YET_CURRENT").toBe("not-yet-current");
		const held = settle(fixture.issue(writer, "held-until-current"));
		await sleep(1_500);
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === pendingAt),
			"CURRENCY_NOTHING_SIGNED_BEFORE"
		).toEqual([]);
		expect((await durable(writer)).lineage.next, "CURRENCY_INTENT_STILL_PENDING").toBe(pendingAt);
		expect(await writer.room.confirmCurrent?.(required(creator.room.currencyStatement)()), "CURRENCY_CONFIRMED").toBe(
			"current"
		);
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === pendingAt),
			"CURRENCY_RESUMED_BEFORE_MOVES"
		).toHaveLength(1);
		expect(await held, "CURRENCY_HELD_MOVE_ISSUED").toBe("issued");
		await expectResumed(setup, "after-currency");
	});

	// Sync before sending: the backup holds the intent at k, the original device resumed it and
	// published k, and the creator admitted it. The restored device reopens and drains: its
	// statement check refuses it (this author's admitted frontier is at k), it never resumes the
	// intent, and no second signature exists at k.
	it("a device restored from a backup holding the pending intent never signs it after the original published it", async () => {
		const setup = await crashBetweenSignAndCommit();
		const { fixture, creator, writer } = setup;
		const pendingAt = (await durable(writer)).lineage.next;
		const backup = await backupDevice(writer);
		// The original device resumes the intent at k and publishes it.
		await fixture.reopen(writer, 0);
		await fixture.issue(writer, "original-after-resume");
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === pendingAt),
			"RESTORE_ORIGINAL_SIGNED_K"
		).toHaveLength(1);
		const admitted = () =>
			required(creator.room.currencyStatement)().frontiers.find(([author]) => author === writer.author)?.[1] ?? -1;
		for (let attempt = 0; attempt < 200 && admitted() < pendingAt; attempt += 1) await sleep(50);
		expect(admitted(), "RESTORE_CREATOR_ADMITTED_K").toBeGreaterThanOrEqual(pendingAt);
		// The restored device.
		await fixture.stop(writer);
		await restoreDevice(writer, backup);
		expect((await durable(writer)).lineage.next, "RESTORE_BACKUP_HOLDS_PENDING_K").toBe(pendingAt);
		const commitsBefore = observed.commits.length;
		await fixture.reopen(writer, 0);
		expect(writer.room.localIssueCurrency?.(), "RESTORE_NOT_CURRENT").toBe("not-yet-current");
		expect(await settle(fixture.issue(writer, "restored-move")), "RESTORE_REFUSED_BEHIND_FRONTIER").toContain(
			"V3_ROOM_NOT_YET_CURRENT: behind-frontier"
		);
		expect(observed.commits.slice(commitsBefore), "RESTORE_NOTHING_SIGNED").toEqual([]);
		expect((await durable(writer)).lineage.next, "RESTORE_INTENT_LEFT_PENDING").toBe(pendingAt);
		expect(
			ownCommits(writer).filter((row) => row.authorSequence === pendingAt),
			"RESTORE_NO_SECOND_VERTEX_AT_K"
		).toHaveLength(1);
	});

	// The ordering the startup drain relies on, asserted: the same backup restored after the epoch
	// that admitted k closed. The successor reopen authenticates the closed frontier, which
	// covers k, before any drain: it refuses the stale lineage, so the drain never runs, the
	// intent stays pending and nothing is signed. (Only the live epoch needs the statement.)
	it("a restored device whose pending intent is inside the closed frontier never reaches its startup drain", async () => {
		const setup = await crashBetweenSignAndCommit();
		const { fixture, creator, writer } = setup;
		const pendingAt = (await durable(writer)).lineage.next;
		const backup = await backupDevice(writer);
		await fixture.reopen(writer, 0);
		await fixture.issue(writer, "original-after-resume");
		const admitted = () =>
			required(creator.room.currencyStatement)().frontiers.find(([author]) => author === writer.author)?.[1] ?? -1;
		for (let attempt = 0; attempt < 200 && admitted() < pendingAt; attempt += 1) await sleep(50);
		expect(admitted(), "FRONTIER_CREATOR_ADMITTED_K").toBeGreaterThanOrEqual(pendingAt);
		await fixture.close();
		fixture.checkpoint();
		await creator.room.adoptCreatorSuccessor();
		await fixture.stop(writer);
		await restoreDevice(writer, backup);
		expect((await durable(writer)).lineage.next, "FRONTIER_BACKUP_HOLDS_PENDING_K").toBe(pendingAt);
		const commitsBefore = observed.commits.length;
		await expect(fixture.reopen(writer, 1, true), "FRONTIER_REOPEN_REFUSES_BEFORE_DRAIN").rejects.toThrow(
			"creator issuance lineage is invalid"
		);
		expect(observed.commits.slice(commitsBefore), "FRONTIER_NOTHING_SIGNED").toEqual([]);
		expect((await durable(writer)).lineage.next, "FRONTIER_INTENT_LEFT_PENDING").toBe(pendingAt);
	});
});
