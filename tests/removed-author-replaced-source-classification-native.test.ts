/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";

import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// A removed player must exit cleanly: a Writer removed in epoch E >= 1 while its issuance store still
// holds an own row of an earlier epoch must keep installing every later epoch the creator offers.
// At the removing close the Writer's plane takes source custody only for its current-epoch rows and its
// unresolved entries; an own row of an earlier epoch that is already settled (admitted, or replaced by a
// completed replacement) gets none. From epoch E + 1 on nothing can authenticate that row: the Writer is
// not in the ACL, and the creator's frontier names only successor members (no admitted sequence for a
// removed author), so the rebase outbox refuses it and the install fails.
// RED 1: an ordinary delivered, admitted epoch-0 move; the Writer is removed in epoch 1.
// RED 2: the move m1 is lost in transit, epoch 0 closes without it, the adjacent install replays it (a
// completed `rebase` entry; the replay is admitted, so the move is in history exactly once); the Writer
// is removed in epoch 1. The installs succeed, the lineage stays, the move is never applied twice.
// Control: the same replayed move without the removal installs every later epoch.
const MOVE = "replayed-move";

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
				resolved: entry.sourceResolutionDigest !== undefined })), contexts: plan.sourceContexts?.length ?? 0 },
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
	console.info(`REMOVED_REPLACED ${label} epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	return image;
}

/** m1 signed in epoch 0 and lost; epoch 0 closes without it; the adjacent install replays it and the creator admits the replay. */
async function replayed(f: Fixture, creator: Peer, member: Peer) {
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never delivered.
	await member.room.issue(message(MOVE)).catch(() => undefined);
	const m1 = required((await nativeImage(f)).outbox.find(row => row.id === MOVE));
	expect(m1).toMatchObject({ epoch: 0, publishState: "pending" });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
	await f.install(member);
	const image = await nativeImage(f);
	console.info(`REMOVED_REPLACED replayed epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	expect(image.plan?.entries.find(entry => entry.sequence === m1.sequence)).toMatchObject({ disposition: "rebase" });
	expect(image.plan?.entries.find(entry => entry.sequence === m1.sequence)?.replacement).not.toBeNull();
	// The Writer's epoch-1 rows (its fence and the replay) reach the creator; m1 never does.
	const rows = (await f.issuedAfter(1, m1.sequence)).filter(row => row.commit.authorSequence > m1.sequence);
	expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	expect(count(creator, MOVE)).toBe(1);
	return { m1: m1.sequence, image };
}

const revoke = (f: Fixture, creator: Peer) =>
	creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });

describe("a Writer removed in epoch 1 with an earlier own row installs every later epoch", () => {
	it("removed in epoch 1 after a delivered epoch-0 move: the next installs succeed", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message(MOVE));
		expect(await creator.receive(await f.issuedAfter(1, null), 1, 30_000)).toBe(true);
		expect(count(creator, MOVE)).toBe(1);
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		const before = await nativeImage(f);
		await revoke(f, creator);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `delivered-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect((await nativeImage(f)).lineage).toEqual(before.lineage);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(count(creator, MOVE)).toBe(1);
	}, 300_000);

	it("removed in epoch 1 after its lost move was replayed: the next installs succeed; the lineage stays; the move is applied once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const { image: before } = await replayed(f, creator, member);
		await revoke(f, creator);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `revoked-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect((await nativeImage(f)).lineage).toEqual(before.lineage);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(count(creator, MOVE)).toBe(1);
	}, 300_000);

	it("control: the same replayed move without the revocation installs every later epoch", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		await replayed(f, creator, member);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `member-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect(count(creator, MOVE)).toBe(1);
	}, 300_000);
});
