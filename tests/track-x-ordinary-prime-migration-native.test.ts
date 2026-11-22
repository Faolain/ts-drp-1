import { encodeCanonical } from "@ts-drp/canonical";
import type { V3RoomStorageHost } from "@ts-drp/node/v3-room-host";
import type { Message } from "@ts-drp/types";
import { afterEach, beforeEach, expect, it } from "vitest";

import { expectedTargetObjectId } from "./fixtures/phase-3h/migration-rehearsal-fixture.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
	readinessHoldRoom,
	stackHere,
} from "./fixtures/track-x/readiness-hold-room.js";

// Track X, decision row 73 (step 14 A, RED first), native: the settlement room on the node SQLite
// host. After a migration, the creator's target runs epoch 0 with the migration source retained;
// every OPTIONAL ordinary prime there declines by design ("native-or-cross-context-source") after
// a complete cold read lifetime. A skips that prime on a private live hint; the mandatory cold quote
// and every check in it stay. Observed through the room's warm-proof diagnostics (bounded,
// primitive events; they grant nothing). The exact helper and predicate are proved in
// tests/track-x-ordinary-prime-migration-skip.test.ts. The Writer joins the target as d9346's
// joiner does: from the target's invite, with the creator's retained republication.

type Event = Readonly<Record<string, unknown>>;
type Journal = Awaited<ReturnType<V3RoomStorageHost["openJournal"]>>;
type Target = Readonly<{ invite: ReadinessHoldRoom["invite"]; objectId: string }>;
const events: Event[] = [];
const SKIPPED = "ordinary-incremental-source-prime-skipped";
const PRIME = "ordinary-incremental-source-prime";
const REFUSED = "ordinary-source-capture-refused";

beforeEach(() => {
	events.length = 0;
	Reflect.set(globalThis, "__warmProofEvent", (event: Event) => {
		if (event !== null && typeof event === "object") events.push({ ...event });
	});
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	// Joined cleanup: every session, floor and port closes without a failure.
	expect(await closeFixtures()).toEqual([]);
});

const block = (id: string, x: number) => ({ action: "placeBlock", id, kind: "stone", x, y: 1 });
const blockIds = (peer: ReadinessHoldPeer): string[] =>
	((peer.room.projection() as { blocks?: { id: string }[] }).blocks ?? []).map((each) => each.id).sort();

/**
 * Waits until a peer's projection holds the given blocks.
 * @param peer - The peer.
 * @param ids - The block ids.
 */
async function blocksArrive(peer: ReadinessHoldPeer, ids: readonly string[]): Promise<void> {
	const deadline = performance.now() + 60_000;
	while (!ids.every((id) => blockIds(peer).includes(id))) {
		if (performance.now() > deadline) throw new TypeError(`TRACK_X_A_BLOCKS_TIMEOUT ${JSON.stringify(blockIds(peer))}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * Migrates the creator's room to a new target and reopens the creator on it (epoch 0 of the
 * target, the migration source retained). The reopened creator's network node keeps what it sends.
 * @param fixture - The room fixture.
 * @param host - An optional wrapper of the reopened creator's storage host.
 * @returns The reopened creator, what it sends, and the target's invite and object id.
 */
async function migrated(fixture: ReadinessHoldRoom, host?: (host: V3RoomStorageHost) => V3RoomStorageHost) {
	const source = await fixture.open(0);
	await source.room.issue(block("before-migration", 1));
	const nonce = new Uint8Array(32).fill(0x72);
	const targetObjectId = expectedTargetObjectId(fixture.objectId, nonce);
	const targetInvite = await fixture.material(targetObjectId);
	const rehearsal = await source.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	expect(
		await source.room.activateMigration({
			exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
			recordVertexDigest: rehearsal.recordVertexDigest,
			targetCreatorInvite: targetInvite,
		})
	).toMatchObject({ activated: true });
	await fixture.stop(source);
	events.length = 0;
	const sent: Message[] = [];
	const creator = await fixture.open(0, {
		reopen: true,
		...(host === undefined ? {} : { host }),
		onNetwork: (networkNode) => {
			Reflect.set(networkNode, "publishMessage", async (_topic: string, message: Message) => {
				sent.push(message);
				return true;
			});
			Reflect.set(networkNode, "sendMessage", async (_peer: string, message: Message) => {
				sent.push(message);
			});
		},
	});
	const target: Target = { invite: targetInvite, objectId: targetObjectId };
	return { creator, sent, target };
}

/**
 * Opens the Writer on the migrated target from the target's invite and hands it the creator's
 * retained republication (the migration record first), as d9346's joiner joins.
 * @param fixture - The room fixture.
 * @param joined - The migrated creator and what it sends.
 * @returns The Writer, once its projection holds the migrated state.
 */
async function joinTarget(fixture: ReadinessHoldRoom, joined: Awaited<ReturnType<typeof migrated>>) {
	const writer = await fixture.open(1, { room: joined.target });
	joined.sent.length = 0;
	await joined.creator.republish();
	for (const message of joined.sent.splice(0)) writer.deliver(message, true);
	await blocksArrive(writer, ["before-migration"]);
	return writer;
}

/**
 * The Writer's rows on the target, handed to the creator's gossip ingress; waits for its blocks.
 * @param fixture - The room fixture.
 * @param creator - The creator.
 * @param target - The target.
 * @param ids - The Writer's block ids to wait for.
 */
async function admitWriterRows(
	fixture: ReadinessHoldRoom,
	creator: ReadinessHoldPeer,
	target: Target,
	ids: readonly string[]
): Promise<void> {
	creator.inject(await fixture.publishedAfter(1, null, target.objectId), 1);
	await blocksArrive(creator, ids);
}

/**
 * The prime decisions in an event slice: each prime report with the event just before it.
 * @param slice - Events in order.
 * @returns One entry per prime report.
 */
const primes = (slice: readonly Event[]) =>
	slice.flatMap((event, index) =>
		event.kind === PRIME ? [{ epoch: event.epoch, phase: event.phase, ok: event.ok, before: slice[index - 1] }] : []
	);

it("on a migrated epoch-0 target, local and received rows skip the optional prime and are still admitted", async () => {
	const fixture = await readinessHoldRoom();
	const joined = await migrated(fixture);
	const { creator, target } = joined;
	const writer = await joinTarget(fixture, joined);
	await writer.room.issue(block("writer-0", 2));
	await writer.room.issue(block("writer-1", 3));
	events.length = 0;
	await admitWriterRows(fixture, creator, target, ["writer-0", "writer-1"]);
	const received = events.splice(0);
	await creator.room.issue(block("creator-0", 4));
	await creator.room.issue(block("creator-1", 5));
	const local = events.splice(0);
	console.log(`TRACK_X_A_NATIVE ${JSON.stringify({ received: primes(received), local: primes(local) })}`);
	expect(blockIds(creator)).toEqual(["before-migration", "creator-0", "creator-1", "writer-0", "writer-1"].sort());
	for (const [label, slice] of [
		["received", received],
		["local", local],
	] as const) {
		const decisions = primes(slice);
		expect(decisions.length, `${label} rows reach the optional prime`).toBeGreaterThan(0);
		for (const decision of decisions) {
			expect(decision, label).toMatchObject({ epoch: 0, ok: false });
			expect(decision.before, `${label}: the prime was skipped, not entered`).toEqual({
				kind: SKIPPED,
				epoch: 0,
				reason: "migration-source",
			});
		}
		expect(
			slice.filter((event) => event.kind === REFUSED && event.reason === "native-or-cross-context-source"),
			`${label}: no optional cold read lifetime ran to be declined`
		).toEqual([]);
	}
	expect(primes(received).some((decision) => decision.phase === "received-append")).toBe(true);
	expect(primes(local).every((decision) => decision.phase === "local-issuance")).toBe(true);
}, 180_000);

it("readiness priming on the migrated target is still entered, never skipped", async () => {
	const fixture = await readinessHoldRoom();
	await migrated(fixture);
	const startup = events.splice(0);
	const refresh = startup.findIndex(
		(event) => event.kind === "ordinary-readiness-source-refresh" && event.outcome === "cold-boundary-fallback"
	);
	expect(refresh, "the reopened target runs its readiness boundary").toBeGreaterThanOrEqual(0);
	const boundary = startup.findIndex((event, index) => index > refresh && event.kind === "ordinary-boundary-readiness");
	expect(boundary).toBeGreaterThan(refresh);
	const readiness = startup.slice(refresh + 1, boundary);
	expect(readiness, "the readiness capture was entered and declined by the data owner").toContainEqual(
		expect.objectContaining({ kind: REFUSED, epoch: 0, reason: "native-or-cross-context-source" })
	);
	expect(readiness.filter((event) => event.kind === SKIPPED)).toEqual([]);
}, 180_000);

it("the hint follows the registration: a reopen at epoch 0 still skips, the rollover and a reopen at epoch 1 never do", async () => {
	const fixture = await readinessHoldRoom();
	let { creator } = await migrated(fixture);
	await creator.room.issue(block("epoch0-a", 2));
	const first = events.splice(0);
	await fixture.stop(creator);
	creator = await fixture.open(0, { reopen: true });
	events.length = 0;
	await creator.room.issue(block("epoch0-b", 3));
	const reopened = events.splice(0);
	for (const [label, slice] of [
		["first open", first],
		["reopen", reopened],
	] as const) {
		expect(primes(slice).length, label).toBeGreaterThan(0);
		for (const decision of primes(slice)) expect(decision.before, label).toMatchObject({ kind: SKIPPED, epoch: 0 });
	}
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	await creator.room.adoptCreatorSuccessor();
	expect(creator.room.authority()).toMatchObject({ epoch: 1 });
	await creator.room.issue(block("epoch1-a", 4));
	await fixture.stop(creator);
	creator = await fixture.open(0, { reopen: true });
	await creator.room.issue(block("epoch1-b", 5));
	const after = events.splice(0);
	expect(after.filter((event) => event.epoch === 1).length, "epoch-1 maintenance ran").toBeGreaterThan(0);
	expect(after.filter((event) => event.kind === SKIPPED)).toEqual([]);
	expect(blockIds(creator)).toEqual(["before-migration", "epoch0-a", "epoch0-b", "epoch1-a", "epoch1-b"].sort());
}, 180_000);

it("without a migration nothing is skipped and warm hits are unchanged", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	await creator.room.issue(block("creator-0", 1));
	await writer.room.issue(block("writer-0", 2));
	creator.inject(await fixture.publishedAfter(1, null), 1);
	await blocksArrive(creator, ["writer-0"]);
	await creator.room.issue(block("creator-1", 3));
	expect(events.filter((event) => event.kind === SKIPPED)).toEqual([]);
	expect(events).toContainEqual(expect.objectContaining({ kind: "ordinary-incremental-hit", epoch: 0 }));
	expect(blockIds(creator)).toEqual(["creator-0", "creator-1", "writer-0"]);
}, 180_000);

it("a corrupted census read in the mandatory cold quote is still refused before effects, and exact work continues", async () => {
	const fault = { enabled: false, mutated: [] as string[] };
	/**
	 * A journal whose page reads inside the mandatory cold quote flip one byte of a received row's
	 * detached signature while the fault is enabled (as the r9 native census tamper does).
	 * @param journal - The genuine journal.
	 * @returns The same journal with a faulting page read.
	 */
	const faulty = (journal: Journal): Journal =>
		Object.freeze({
			...journal,
			readPage: async (input: Parameters<Journal["readPage"]>[0]) => {
				const page = await journal.readPage(input);
				if (!fault.enabled || !page.ok || page.rows.length === 0) return page;
				if (!stackHere().includes("prepareCreatorIssuanceMaintenanceQuote")) return page;
				const selected = page.rows.findIndex((row) => row.sourceKind === "received");
				const row = page.rows[selected];
				if (row === undefined || row.sourceKind !== "received") return page;
				const detachedSignature = Uint8Array.from(row.detachedSignature);
				detachedSignature[0] = (detachedSignature[0] ?? 0) ^ 1;
				fault.mutated.push(String(row.vertexDigest));
				return {
					...page,
					rows: page.rows.map((value, index) => (index === selected ? { ...row, detachedSignature } : value)),
				};
			},
		}) as Journal;
	const fixture = await readinessHoldRoom();
	const joined = await migrated(fixture, (host) => ({
		...host,
		openJournal: async (name: string) => faulty(await host.openJournal(name)),
	}));
	const { creator, target } = joined;
	const writer = await joinTarget(fixture, joined);
	await writer.room.issue(block("writer-0", 2));
	await admitWriterRows(fixture, creator, target, ["writer-0"]);
	const scopeRows = () => fixture.publishedAfter(0, null, target.objectId);
	const beforeOutbox = encodeCanonical(await scopeRows());
	const beforeProjection = encodeCanonical(creator.room.projection());
	const operation = block("after-fault", 3);
	fault.enabled = true;
	await expect(creator.room.issue(operation)).rejects.toThrow();
	fault.enabled = false;
	expect(fault.mutated.length, "the cold quote's census read was actually altered").toBeGreaterThan(0);
	expect(encodeCanonical(await scopeRows())).toEqual(beforeOutbox);
	expect(encodeCanonical(creator.room.projection())).toEqual(beforeProjection);
	await creator.room.issue(operation);
	expect(blockIds(creator)).toContain("after-fault");
	expect(required(fault.mutated[0])).toMatch(/^[0-9a-f]{64}$/u);
}, 180_000);
