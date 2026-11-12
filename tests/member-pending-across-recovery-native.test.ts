// A move held as pending ingress when the plane is recovered within its epoch (lull trace st2:
// "creator issuance maintenance admission was revoked", then TRACK_M_APPS_REMOTE_ADMISSION_TIMEOUT).
//
// A same-epoch recovery (v3-room recoverSettlementOwner) deactivates the live plane and activates
// a successor of the same epoch from durable truth. Deactivation clears pending ingress
// (v3-live deactivateRegistration), and nothing hands those rows to the successor: the transport
// counts them as delivered, so only a later child naming the row as missing or the room's periodic
// repair sweep would bring them back, and an in-process harness has neither.
//
// Here Writer 1 installs epoch 1. Its successor projection is reported, and Writer 2's later move B
// (whose parent A it does not have) reaches it at that moment, so B is held as pending ingress. Its
// settlement drain then issues work for its own displaced move; that one signature fails (an issue
// the store refuses after signing), which the room answers with a same-epoch recovery of the plane.
// Writer 2's A then arrives. B must be admitted once its parent is.
//
// Rule (model packages/node/formal/plane-recovery-pending-carry.qnt): the recovery carries the
// predecessor's pending rows' exact signed bytes to the successor of the same epoch and re-offers
// them through its ordinary ingress (re-authenticated, deduplicated, bounded).
// Genuine SQLite, Ed25519, room owners, floor and creator material server.
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { openV3PendingIngressCarries } from "../packages/node/src/v3-live.js";

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const digestOf = (row: { commit: { envelope: { digest: Uint8Array } } }): string =>
	Buffer.from(row.commit.envelope.digest).toString("hex");

// "held": B is already pending ingress when the recovery starts. "in-flight": B reaches Writer 1
// inside the failing settlement signature, so its ingress job is queued in the predecessor's FIFO
// behind that issue and runs while the recovery replaces the plane (the st2 trace's
// "received-maintenance-capture: ... admission was revoked" is the creator-side form of this).
it.each([
	["[RED] a move held as pending ingress at a same-epoch plane recovery is admitted once its parent arrives", "held"],
	[
		"[RED] a move in flight in the predecessor's ingress at a same-epoch plane recovery is admitted once its parent arrives",
		"in-flight",
	],
	["[control] the same install without the recovery: the held move is admitted once its parent arrives", "control"],
] as const)(
	"%s",
	async (_name, mode) => {
		const recover = mode !== "control";
		const fixture = await readinessHoldRoom({ writers: 2 });
		// Writer 1's hooks: inject B at its successor projection, then fail its next operation signature once.
		const hold = { rows: undefined as Parameters<ReadinessHoldPeer["inject"]>[0] | undefined, injected: 0 };
		const fault = { armed: false, failed: 0, heldAtFault: undefined as boolean | undefined };
		const target = { held: undefined as string | undefined };
		const creator = await fixture.open(0);
		const member = await fixture.open(1, {
			onProjection: (hook) => {
				if (hold.rows === undefined) return;
				fault.armed = recover;
				if (mode === "in-flight") return;
				const rows = hold.rows;
				hold.rows = undefined;
				hook.inject(rows, 2);
				hold.injected += 1;
			},
			sign: async (digest, _request, sign) => {
				if (!fault.armed) return sign(digest);
				fault.armed = false;
				fault.failed += 1;
				if (mode === "in-flight" && hold.rows !== undefined) {
					// Queued behind this issue in the predecessor's FIFO.
					member.inject(hold.rows, 2);
					hold.rows = undefined;
					hold.injected += 1;
				}
				fault.heldAtFault = target.held !== undefined && !member.accepted.has(target.held);
				// 63 bytes: the issue is refused after its signer resolved, with no plan change.
				return (await sign(digest)).slice(0, 63);
			},
		});
		const other = await fixture.open(2);
		const peers: ReadinessHoldPeer[] = [creator, member, other];
		const cursor = new Map<string, number | null>();
		const key = (from: number, to: number): string => `${from}->${to}`;
		const deliverRows = async (
			to: number,
			from: number,
			rows: Awaited<ReturnType<typeof fixture.publishedAfter>>
		): Promise<void> => {
			const receiver = required(peers[to]);
			for (let start = 0; start < rows.length; start += 16) {
				const chunk = rows.slice(start, start + 16);
				const last = chunk.findLastIndex((row) => !isControl(row));
				if (last >= 0) await receiver.receive(chunk.slice(0, last + 1), from);
				receiver.inject(chunk.slice(last + 1), from);
			}
			if (rows.length !== 0) cursor.set(key(from, to), required(rows.at(-1)).commit.authorSequence);
		};
		const deliver = async (from: number, to: number): Promise<void> =>
			deliverRows(to, from, await fixture.publishedAfter(from, cursor.get(key(from, to)) ?? null));
		const install = async (peer: ReadinessHoldPeer, index: number): Promise<void> => {
			const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, index);
			Reflect.set(peer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
			await peer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
			expect(peer.room.authority()?.epoch).toBe(1);
		};

		// Epoch 0: every peer's rows reach the others, except Writer 1's last move (displaced: the
		// creator closes without it, so Writer 1's settlement drain has work at its install).
		await creator.room.issue({ action: "placeBlock", id: "creator-0", kind: "stone", x: 1, y: 0 });
		await deliver(0, 1);
		await deliver(0, 2);
		await member.room.issue({ action: "placeBlock", id: "member-0", kind: "stone", x: 2, y: 0 });
		await deliver(1, 0);
		await deliver(1, 2);
		await other.room.issue({ action: "placeBlock", id: "other-0", kind: "gold", x: 3, y: 0 });
		await deliver(2, 0);
		await deliver(2, 1);
		await member.room.issue({ action: "placeBlock", id: "member-displaced", kind: "stone", x: 2, y: 1 });
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();

		// Epoch 1: Writer 2 installs first and makes two moves, A then B.
		await install(other, 2);
		await deliver(0, 2);
		await other.room.issue({ action: "placeBlock", id: "other-a", kind: "gold", x: 4, y: 1 });
		await other.room.issue({ action: "placeBlock", id: "other-b", kind: "gold", x: 5, y: 1 });
		const otherRows = await fixture.publishedAfter(2, cursor.get(key(2, 1)) ?? null);
		const moves = otherRows.filter((row) => !isControl(row));
		const later = required(moves.at(-1));
		const held = digestOf(later);
		target.held = held;
		const beforeLater = otherRows.slice(0, otherRows.indexOf(later));

		// Writer 1 installs epoch 1; B reaches it at its successor projection (held: A is missing).
		hold.rows = [later];
		await install(member, 1);
		expect(hold.injected, "B reached Writer 1 during its install").toBe(1);
		expect(member.accepted.has(held), "B is held while A is missing").toBe(false);
		if (recover) {
			expect(fault.failed, "one settlement signature failed, so the room recovered the plane").toBe(1);
			expect(fault.heldAtFault, "B was not admitted when the plane was recovered").toBe(true);
		}

		// A (and the rest of Writer 2's epoch-1 rows before B) arrives; the creator's epoch-1 rows too.
		await deliver(0, 1);
		await deliverRows(1, 2, beforeLater);
		const started = performance.now();
		for (const deadline = started + 15_000; performance.now() < deadline && !member.accepted.has(held); )
			await sleep(50);
		const landedMs = member.accepted.has(held) ? Math.round(performance.now() - started) : null;
		console.log("PENDING_ACROSS_RECOVERY", JSON.stringify({ mode, failed: fault.failed, landedMs }));
		expect(landedMs, "B is admitted once its parent A arrives").not.toBeNull();
		// The carry ended (its predecessor's last ingress job settled): the successor keeps no
		// reference to the revoked plane, and the process holds no open carry.
		expect(openV3PendingIngressCarries(), "no same-epoch recovery carry is left open").toBe(0);
	},
	300_000
);
