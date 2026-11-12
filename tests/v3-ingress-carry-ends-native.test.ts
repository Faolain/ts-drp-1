// The ends of a same-epoch recovery's ingress carry (model packages/node/formal/plane-recovery-pending-carry.qnt),
// on genuine planes of one object, epoch and anchor: P (the predecessor), S (the recovered successor) and T (the
// plane after S, standing in for the next epoch's plane on the room's stable topic).
//
// P's ingress jobs are held in flight behind one of P's local issues whose signer the test releases, so
// they end on the revoked P exactly when the test chooses:
//   1. forwarding ends at the predecessor's last job: a late row is forwarded to S and the carry closes;
//   2. at an epoch change (S deactivated first) a late row is refused and named to repair on the current
//      plane, never carried across, and the carry closes once P's last job settles;
//   3. past the carry's bound (maxPendingEntries) the excess is refused and named to repair, and every
//      carried row reaches S's verdict: nothing is silently lost.
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import {
	activateV3LivePlane,
	bindV3MissingDependencyRequest,
	carryV3PendingIngress,
	openV3PendingIngressCarries,
	readV3RuntimeOwnerCensus,
	recoverV3LiveReplica,
	reofferV3CarriedPendingIngress,
	routeV3RetainedIngress,
	type V3PlaneHandle,
} from "../packages/node/src/v3-live.js";

type Fixture = Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>;

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const LATE_SENDER = "peer:carry-ends:late";
const MAX_PENDING_ENTRIES = 4096;

async function eventually(check: () => boolean, ms = 30_000): Promise<boolean> {
	for (const deadline = performance.now() + ms; performance.now() < deadline; ) {
		if (check()) return true;
		await sleep(20);
	}
	return check();
}

async function room() {
	const fixture = await createGenuinePreparedV3Fixture();
	fixtures.push(fixture);
	const recovered = await recover(fixture, fixture.capability);
	const network = fakeNetwork("peer:carry-ends");
	const admitted = new Map<V3PlaneHandle, string[]>();
	const activate = (capability: Parameters<typeof activateV3LivePlane>[0]["capability"]): V3PlaneHandle => {
		const seen: string[] = [];
		const activation = activateV3LivePlane({
			capability,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: network,
			onAdmittedVertex: vi.fn(async ({ vertex }: { vertex: { digest: Uint8Array } }) => {
				seen.push(Buffer.from(vertex.digest).toString("hex"));
				return Object.freeze({ kind: "continue" as const });
			}) as never,
		});
		if (!activation.ok) throw new TypeError(`activation failed: ${activation.kind}`);
		admitted.set(activation.handle, seen);
		return activation.handle;
	};
	// A recovered capability of the same object, epoch and anchor (a same-epoch recovery's successor).
	const recoverAgain = async () => {
		const prepared = await fixture.prepareAgain();
		const reopened = await recoverV3LiveReplica({
			capability: prepared.capability,
			exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes,
			issuanceScope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
			issuanceStore: recovered.issuanceStore,
			liveJournalStore: recovered.journal,
		} as Parameters<typeof recoverV3LiveReplica>[0]);
		if (!reopened.ok) throw new TypeError(`successor recovery failed: ${reopened.kind}`);
		return reopened.capability;
	};
	const predecessor = activate(recovered.capability);
	const topic = predecessor.topic;
	const gaps: { kind: string; peerId?: string }[] = [];
	bindV3MissingDependencyRequest(network, topic, (gap) => {
		if (gap !== undefined) gaps.push({ kind: gap.kind, ...(gap.peerId === undefined ? {} : { peerId: gap.peerId }) });
	});
	const row = async (authorSequence: number, dependency: string, value: number, sender: string) => {
		const canonicalPreimageBytes = encodeCanonical({
			anchor: fixture.anchorDigest,
			author: fixture.author,
			authorSequence,
			dependencies: [dependency],
			epoch: 0,
			kind: "drp-vertex",
			logicalTime: 2,
			objectId: fixture.objectId,
			operation: Object.freeze({ action: "add", value }),
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
		const signature = await fixture.signRegisteredVertexDigest(digest);
		return {
			digest: Buffer.from(digest).toString("hex"),
			message: Message.create({
				data: V3Envelope.encode({ canonicalPreimage: canonicalPreimageBytes, signature }).finish(),
				objectId: topic,
				sender,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			}),
		};
	};
	// Holds P's FIFO: a local issue parked in its signer; ingress routed after it waits behind it.
	const holdFifo = async (plane: V3PlaneHandle) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const signing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const issued = plane.issueLocal({
			operations: [Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 77 }) })],
			signRegisteredVertexDigest: async (digest: Uint8Array) => {
				entered();
				await gate;
				return fixture.signRegisteredVertexDigest(digest);
			},
		});
		await signing;
		return { release, issued };
	};
	const census = (plane: V3PlaneHandle) => required(readV3RuntimeOwnerCensus(plane));
	return { fixture, recovered, network, predecessor, activate, recoverAgain, gaps, row, holdFifo, admitted, census };
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("value is unavailable");
	return value;
}

const refusedFrom = (gaps: readonly { kind: string; peerId?: string }[], peerId: string): number =>
	gaps.filter((gap) => gap.kind === "refused" && gap.peerId === peerId).length;

it("forwarding ends at the predecessor's last ingress job: a late row is forwarded to the successor", async () => {
	const r = await room();
	const base = openV3PendingIngressCarries();
	const late = await r.row(1, r.recovered.recoveryVertexDigest, 8, LATE_SENDER);
	const hold = await r.holdFifo(r.predecessor);
	expect(routeV3RetainedIngress(r.predecessor, late.message), "the late row is in P's FIFO").toBe(true);
	const carried = required(carryV3PendingIngress(r.predecessor));
	r.predecessor.deactivate();
	const successor = r.activate(await r.recoverAgain());
	expect(reofferV3CarriedPendingIngress(successor, carried)).toBe(0);
	expect(openV3PendingIngressCarries(), "the carry forwards while P's jobs are in flight").toBe(base + 1);
	hold.release();
	await hold.issued.catch(() => undefined);
	expect(
		await eventually(() => required(r.admitted.get(successor)).includes(late.digest)),
		"the late row reaches the successor and is admitted there"
	).toBe(true);
	expect(await eventually(() => openV3PendingIngressCarries() === base), "the carry closed").toBe(true);
	expect(refusedFrom(r.gaps, LATE_SENDER), "nothing was refused").toBe(0);
	successor.deactivate();
}, 120_000);

it("at an epoch change forwarding ends: a late row is refused and named to repair, not carried across", async () => {
	const r = await room();
	const base = openV3PendingIngressCarries();
	const late = await r.row(1, r.recovered.recoveryVertexDigest, 9, LATE_SENDER);
	const hold = await r.holdFifo(r.predecessor);
	expect(routeV3RetainedIngress(r.predecessor, late.message)).toBe(true);
	const carried = required(carryV3PendingIngress(r.predecessor));
	r.predecessor.deactivate();
	const successorCapability = await r.recoverAgain();
	const nextCapability = await r.recoverAgain();
	const successor = r.activate(successorCapability);
	expect(reofferV3CarriedPendingIngress(successor, carried)).toBe(0);
	// The successor is retired (the epoch changes) while P's job is still in flight.
	successor.deactivate();
	const next = r.activate(nextCapability);
	hold.release();
	await hold.issued.catch(() => undefined);
	expect(
		await eventually(() => refusedFrom(r.gaps, LATE_SENDER) === 1),
		"the late row is refused and named to repair on the current plane"
	).toBe(true);
	await sleep(500);
	expect(required(r.admitted.get(next)).includes(late.digest), "it is not carried to the next plane").toBe(false);
	expect(required(r.admitted.get(successor)).includes(late.digest), "nor to the retired successor").toBe(false);
	expect(await eventually(() => openV3PendingIngressCarries() === base), "the carry closed").toBe(true);
	next.deactivate();
}, 120_000);

it("past the carry's bound the excess is refused and named to repair, and every carried row reaches the successor", async () => {
	const r = await room();
	const base = openV3PendingIngressCarries();
	// P holds maxPendingEntries rows whose parent it does not have.
	const missing = "ab".repeat(32);
	for (let start = 0; start < MAX_PENDING_ENTRIES; start += 32) {
		const batch = await Promise.all(
			Array.from({ length: Math.min(32, MAX_PENDING_ENTRIES - start) }, (_, offset) =>
				r.row(2 + start + offset, missing, start + offset, "peer:carry-ends:held")
			)
		);
		for (const held of batch) expect(routeV3RetainedIngress(r.predecessor, held.message)).toBe(true);
		expect(await eventually(() => r.census(r.predecessor).admittedInputJobs === 0)).toBe(true);
	}
	expect(r.census(r.predecessor).pendingIngress, "P holds a full pending set").toBe(MAX_PENDING_ENTRIES);
	const lateRows = await Promise.all(
		Array.from({ length: 8 }, (_, index) => r.row(10_000 + index, missing, 10_000 + index, LATE_SENDER))
	);
	const hold = await r.holdFifo(r.predecessor);
	for (const late of lateRows) expect(routeV3RetainedIngress(r.predecessor, late.message)).toBe(true);
	const carried = required(carryV3PendingIngress(r.predecessor));
	r.predecessor.deactivate();
	const successor = r.activate(await r.recoverAgain());
	hold.release();
	await hold.issued.catch(() => undefined);
	expect(await eventually(() => r.census(r.predecessor).admittedInputJobs === 0), "P's late jobs ended").toBe(true);
	const gapsBefore = refusedFrom(r.gaps, LATE_SENDER);
	expect(reofferV3CarriedPendingIngress(successor, carried), "the carry re-offers its full bound").toBe(
		MAX_PENDING_ENTRIES
	);
	expect(
		await eventually(() => refusedFrom(r.gaps, LATE_SENDER) - gapsBefore === lateRows.length),
		"each row past the bound is refused and named to repair"
	).toBe(true);
	expect(
		await eventually(() => r.census(successor).pendingIngress === MAX_PENDING_ENTRIES, 120_000),
		"every carried row reaches the successor's verdict (held: its parent is missing)"
	).toBe(true);
	expect(refusedFrom(r.gaps, "peer:carry-ends:held"), "no carried row was refused").toBe(0);
	expect(openV3PendingIngressCarries(), "the carry closed").toBe(base);
	successor.deactivate();
}, 300_000);
