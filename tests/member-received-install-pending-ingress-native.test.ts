// The hold-unavailable family, branch B: a Writer's received install that starts while its plane
// still holds pending ingress.
//
// Observed in the 4-writer scorecard (r2-w3-r2-behind16, load ~1, so not load-induced): 35 of 103
// member installs failed with "creator recovery dependency hold unavailable:live:1:0:1:active:N:..."
// (blueprintClosing=1, folded=0, N = 1..22 pending rows). A member's received recovery turnover
// seals its dependencies with the closing (non-active) observation, which requires an empty pending
// ingress (v3-live captureCreatorRecoveryRuntime). Rows retained before beginReceived can never be
// admitted into the closing plane (authenticateV3Ingress returns on blueprintClosing, and the hot
// handoff clears the predecessor's pending rows), so every received turnover that starts with one
// fails; the install then terminalizes the plane and the member must recover by a fresh install.
//
// Rule (model packages/node/formal/member-received-close-pending-release.qnt): beginReceived
// releases the closing plane's pending rows, the same clear the hot handoff applies, only earlier.
// The close census rule (empty pending ingress) is unchanged. A released copy counts as lost for
// the closing plane: the successor snapshot carries the moves the creator admitted, and the author
// re-offers the rest in the successor epoch.
//
// Here Writer 2's moves reach Writer 1 out of order (its later move first), so Writer 1 holds the
// later move as pending ingress at each install. Both moves reach the creator, so the successor
// snapshot carries them. Genuine SQLite, Ed25519, room owners, floor and creator material server.
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

type TurnoverEvent = { kind: "recipient-received-turnover"; epoch: number; outcome: string };

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const explain = (error: unknown, depth = 0): string => {
	if (!(error instanceof Error) || depth > 3) return String(error).slice(0, 400);
	return error.message.slice(0, 400) + (error.cause === undefined ? "" : ` <- ${explain(error.cause, depth + 1)}`);
};

// The control delivers Writer 2's moves to Writer 1 in order (nothing held): the install cost without
// pending ingress, for comparison (the released rows cost a refetch only when they are outside the cut).
it.each([
	["[RED] a Writer's received install that starts with pending ingress succeeds, and the held moves land", true],
	["[control] the same rollovers with Writer 2's moves delivered to Writer 1 in order (nothing held)", false],
])(
	"%s",
	async (_name, held) => {
		const turnovers: TurnoverEvent[] = [];
		Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
			if (typeof event === "object" && event !== null && Reflect.get(event, "kind") === "recipient-received-turnover")
				turnovers.push(event as TurnoverEvent);
		});
		const fixture = await readinessHoldRoom({ writers: 2 });
		const creator = await fixture.open(0);
		const member = await fixture.open(1);
		const other = await fixture.open(2);
		const peers: ReadinessHoldPeer[] = [creator, member, other];
		// Delivery cursor per (sender, receiver).
		const cursor = new Map<string, number | null>();
		const key = (from: number, to: number): string => `${from}->${to}`;
		/**
		 * Delivers every published row of one peer to another in order; resolves when the last move is accepted.
		 * @param from - The sender's index.
		 * @param to - The receiver's index.
		 */
		const deliver = async (from: number, to: number): Promise<void> => {
			const rows = await fixture.publishedAfter(from, cursor.get(key(from, to)) ?? null);
			const receiver = required(peers[to]);
			for (let start = 0; start < rows.length; start += 16) {
				const chunk = rows.slice(start, start + 16);
				const last = chunk.findLastIndex((row) => !isControl(row));
				if (last >= 0) await receiver.receive(chunk.slice(0, last + 1), from);
				receiver.inject(chunk.slice(last + 1), from);
			}
			if (rows.length !== 0) cursor.set(key(from, to), required(rows.at(-1)).commit.authorSequence);
		};
		const installs: { epoch: number; ok: boolean; ms: number; error?: string; heldLanded?: boolean }[] = [];
		const install = async (peer: ReadinessHoldPeer, index: number, epoch: number): Promise<boolean> => {
			const started = performance.now();
			try {
				const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, index);
				Reflect.set(peer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
				await peer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
				expect(peer.room.authority()?.epoch).toBe(epoch);
				if (peer === member) installs.push({ epoch, ok: true, ms: Math.round(performance.now() - started) });
				return true;
			} catch (error) {
				if (peer === member)
					installs.push({ epoch, ok: false, ms: Math.round(performance.now() - started), error: explain(error) });
				return false;
			}
		};
		const state = (peer: ReadinessHoldPeer): string =>
			Buffer.from(
				required(fixture.application.migration).canonicalStateBytes(peer.room.projection() as never)
			).toString("hex");

		const EPOCHS = 6;
		for (let epoch = 0; epoch < EPOCHS; epoch++) {
			await creator.room.issue({ action: "placeBlock", id: `creator-${epoch}`, kind: "stone", x: 1, y: epoch });
			await deliver(0, 1);
			await deliver(0, 2);
			await member.room.issue({ action: "placeBlock", id: `member-${epoch}`, kind: "stone", x: 2, y: epoch });
			await deliver(1, 0);
			await deliver(1, 2);
			// Writer 2 makes two moves; the creator receives both, Writer 1 only the later one first.
			await other.room.issue({ action: "placeBlock", id: `other-a-${epoch}`, kind: "gold", x: 3, y: epoch });
			await other.room.issue({ action: "placeBlock", id: `other-b-${epoch}`, kind: "gold", x: 4, y: epoch });
			await deliver(2, 0);
			const otherRows = await fixture.publishedAfter(2, cursor.get(key(2, 1)) ?? null);
			const moves = otherRows.filter((row) => !isControl(row));
			const later = required(moves.at(-1));
			if (held) {
				member.inject([later], 2);
				await sleep(300);
				expect(
					member.accepted.has(Buffer.from(later.commit.envelope.digest).toString("hex")),
					"the later move is held"
				).toBe(false);
				await sleep(200);
			} else {
				await deliver(2, 1);
				await sleep(500);
			}
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			const memberInstalled = await install(member, 1, epoch + 1);
			const record = required(installs.at(-1));
			if (memberInstalled) record.heldLanded = state(member) === state(creator);
			// Writer 2 follows; its rows up to here are in the creator's cut.
			expect(await install(other, 2, epoch + 1), "Writer 2 installs").toBe(true);
			if (held) cursor.set(key(2, 1), required(otherRows.at(-1)).commit.authorSequence);
			if (!memberInstalled) break;
		}
		console.log(
			"MEMBER_INSTALL_WITH_PENDING",
			JSON.stringify({ held, installs, turnovers: turnovers.map((event) => `${event.epoch}:${event.outcome}`) })
		);
		expect(
			installs.filter((row) => !row.ok).map((row) => `${row.epoch}: ${row.error ?? ""}`),
			"no received install fails on pending ingress"
		).toEqual([]);
		expect(installs.length, "the member followed every epoch").toBe(EPOCHS);
		expect(
			installs.every((row) => row.heldLanded === true),
			"after each install the held moves are in the member's state (it matches the creator's)"
		).toBe(true);
		expect(
			turnovers.some((event) => event.outcome === "ran"),
			"some install ran its received turnover (the path that seals with the closing observation)"
		).toBe(true);
	},
	900_000
);
