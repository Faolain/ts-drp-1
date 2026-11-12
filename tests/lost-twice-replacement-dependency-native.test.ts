/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";

import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// A player on a bad link loses a move and then loses its replay, across two epochs. The Writer's move
// m1 is signed in epoch 0 and never reaches the creator; epoch 0 closes without it. The adjacent
// install replays it as r1 (epoch 1): m1's plan entry is a completed `rebase` (replacement r1), but r1
// is published and never received either, so epoch 1 closes without it too. The Writer must still
// install epoch 2: r1 (and through it m1) was never admitted, so the move is re-offered (a fresh
// replacement or a hand-back), reaches the creator in epoch 2, and is in history exactly once (counted
// on the creator and on the member). The aged case loses it three times, so m1 outlives the displaced
// adjacency before the move lands.
const MOVE = "lost-twice-move";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = () => chatSharesRoomFixture({ members: ["genesis"], format: "window", localMembers: [1],
	genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const count = (peer: Peer, text: string) =>
	peer.room.projection().messages.filter((entry) => entry.clientOperationId === text).length;

async function nativeImage(f: Fixture) {
	const author = required(f.identities[1]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(1, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const completed = control.control.completed; await control.release();
		const plan = await store.readSettlementPlan(scope);
		return {
			plan: plan === null ? null : { fenceSequence: plan.fenceSequence, entries: plan.entries.map(entry => ({
				sequence: entry.sourceSequence, disposition: entry.disposition, replacement: entry.replacementSequence,
				resolved: entry.sourceResolutionDigest !== undefined })), handBacks: plan.handBacks?.length ?? 0 },
			lineage: await store.readLineage(scope),
			outbox: (await store.readOutboxPage({ scope, limit: 128 })).map(row => {
				const value = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as
					{ epoch: number; operation: { action?: unknown; clientOperationId?: unknown } };
				return { sequence: row.commit.authorSequence, epoch: value.epoch, publishState: row.publishState,
					action: value.operation.action, ...(value.operation.clientOperationId === undefined ? {} : { id: value.operation.clientOperationId }) };
			}),
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null,
		};
	});
}

async function roll(f: Fixture, creator: Peer, member: Peer, label: string) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	const image = await nativeImage(f);
	console.info(`LOST_TWICE ${label} epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	return image;
}

/** Delivers the Writer's rows of one epoch above `after` to the creator. */
async function deliverEpoch(f: Fixture, creator: Peer, after: number, epoch: number) {
	const rows = (await f.issuedAfter(1, after)).filter(row =>
		(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { epoch: number }).epoch === epoch);
	if (rows.length !== 0) expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	return rows.length;
}

describe("a move lost twice across two epochs", () => {
	it("the next install succeeds; the move lands exactly once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never delivered.
		await member.room.issue(message(MOVE)).catch(() => undefined);
		const m1 = required((await nativeImage(f)).outbox.find(row => row.id === MOVE));
		expect(m1).toMatchObject({ epoch: 0, publishState: "pending" });
		Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
		// Rows reach the creator only when delivered: nothing of epochs 0 and 1 is (r1 is published, never received).
		const lost = await roll(f, creator, member, "lost-1");
		const r1 = required(lost.outbox.find(row => row.id === MOVE && row.epoch === 1));
		expect(lost.plan?.entries.find(entry => entry.sequence === m1.sequence)).toMatchObject({ disposition: "rebase", replacement: r1.sequence });
		// The epoch-2 install succeeds although neither m1 nor r1 was admitted.
		const after = await roll(f, creator, member, "lost-2");
		expect(member.room.authority().epoch).toBe(2);
		expect(await deliverEpoch(f, creator, r1.sequence, 2)).toBeGreaterThan(0);
		expect(count(creator, MOVE)).toBe(1);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member, `settled-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect((await nativeImage(f)).lineage.next).toBeGreaterThanOrEqual(after.lineage.next);
	}, 300_000);

	// Custody age: the move misses three epochs (m1, r1, r2 never received), so m1 ages past the displaced
	// adjacency before r3 lands. Every install still authenticates the whole chain, and the move lands once.
	it("lost three times: m1 ages past the displaced adjacency; r3 lands exactly once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
		await member.room.issue(message(MOVE)).catch(() => undefined);
		Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
		for (let epoch = 1; epoch <= 3; epoch++) {
			const image = await roll(f, creator, member, `aged-${epoch}`);
			expect(image.outbox.filter(row => row.id === MOVE).at(-1)?.epoch).toBe(epoch);
		}
		expect(member.room.authority().epoch).toBe(3);
		expect(await deliverEpoch(f, creator, 0, 3)).toBeGreaterThan(0);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member, `aged-settled-${seal}`);
		expect(member.room.authority().epoch).toBe(6);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
	}, 300_000);
});
