import { encodeCanonical } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";

import {
	type ChatSharesPeer,
	chatSharesRoomFixture,
	closeChatSharesRooms,
	required,
} from "./fixtures/chat-membership-shares/room.js";
import {
	createShippingChatSharesGenesisStateBytes,
	restoreShippingChatSharesState,
	shippingChatShareUpdate,
} from "../examples/chat/src/v3-chat-shares.js";

// Track W2: membership changes in shipped Chat rooms of the v5 format, on the shipped
// composition (creator-trusted-settlement-v1, the shares catalog, the shipped policy) with
// genuine SQLite, Ed25519 and room owners (tests/fixtures/chat-membership-shares/room.ts):
// - a share update that misses its checkpoint (displaced) expires, and the admin that issued
//   it carries on: today a displaced capacityAllocation ends that admin's session, because
//   the Chat application declares no displacement policy for it;
// - a late joiner granted Writer speaks from the checkpoint after the share update;
// - a revoked member's messages stay until the window needs their space, then leave first.
// The rule itself is tests/track-w2-chat-shares-rule.test.ts.

afterEach(async () => {
	expect(await closeChatSharesRooms()).toEqual([]);
});

const T = 1_791_662_400_000;
const message = (clientOperationId: string, text: string): Readonly<Record<string, unknown>> => ({
	action: "message",
	clientOperationId,
	displayTimeMs: T,
	text,
});
const ids = (peer: ChatSharesPeer): string[] => peer.room.projection().messages.map((row) => row.clientOperationId);
const shares = (peer: ChatSharesPeer) => restoreShippingChatSharesState(peer.stateBytes()).capacity;
const holders = (peer: ChatSharesPeer): string[] => shares(peer).allocations.map((row) => row[0]);
const size = (row: unknown): number => encodeCanonical(row).byteLength;

/**
 * The share update `peer` would issue now: a pure function of its projection's rows and its
 * current latched ACL, as the shipped page computes it.
 * @param peer - An admin's peer.
 * @returns The update, or undefined when the rows already match the ACL.
 */
function updateFor(peer: ChatSharesPeer): ReturnType<typeof shippingChatShareUpdate> {
	return shippingChatShareUpdate({
		capacity: shares(peer),
		exactCanonicalLatchedAclBytes: encodeCanonical(peer.room.previewLatchedAcl().current),
	});
}
function isWriter(acl: unknown, author: string): boolean {
	const members = Reflect.get(acl as object, "members") as readonly { author: string; groups: readonly string[] }[];
	return members.some((member) => member.author === author && member.groups.includes("writer"));
}
async function rollover(creator: ChatSharesPeer, epoch: number): Promise<void> {
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
	await creator.room.adoptCreatorSuccessor();
	expect(creator.room.authority()).toMatchObject({ epoch: epoch + 1, lifecycle: "active" });
}
const lastSequence = (rows: readonly { commit: { authorSequence: number } }[]): number | null =>
	rows.at(-1)?.commit.authorSequence ?? null;

describe("Track W2: membership changes in a v5 Chat room", () => {
	it("a share update that misses its checkpoint expires, and the admin that issued it carries on", async () => {
		const f = await chatSharesRoomFixture({
			members: ["genesis-admin", "late"],
			format: "shares",
			genesisStateBytes: createShippingChatSharesGenesisStateBytes,
		});
		const creator = await f.open(0);
		const admin = await f.open(1);
		const joiner = required(f.identities[2]).author;
		// Checkpoint 0: the creator makes the late joiner a Writer; it latches at checkpoint 1.
		await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: joiner });
		await rollover(creator, 0);
		await f.install(admin);
		expect(admin.room.authority()).toMatchObject({ epoch: 1, lifecycle: "active" });
		// Checkpoint 1: the second admin issues the share update the joiner needs, and the creator
		// seals before it arrives: the update is displaced.
		const update = required(updateFor(admin));
		expect(update).toMatchObject({ action: "capacityAllocation", epoch: 1 });
		const before = lastSequence(await f.issuedAfter(1, null));
		await admin.room.issue(update);
		const displaced = await f.issuedAfter(1, before);
		expect(displaced).toHaveLength(1);
		await rollover(creator, 1);
		// It expires: the admin installs checkpoint 2 and its session carries on.
		await f.install(admin);
		expect(admin.room.authority()).toMatchObject({ epoch: 2, lifecycle: "active" });
		expect(holders(admin)).not.toContain(joiner);
		// Arriving late at the creator, it changes nothing: its checkpoint is sealed.
		await creator.receive(displaced, 1, 5_000);
		expect(holders(creator)).not.toContain(joiner);
		// The admin still works: a message, then the update for checkpoint 2, both admitted.
		await admin.room.issue(message("w2-after", "the admin carries on"));
		const next = required(updateFor(admin));
		expect(next).toMatchObject({ action: "capacityAllocation", epoch: 2 });
		await admin.room.issue(next);
		expect(await creator.receive(await f.issuedAfter(1, lastSequence(displaced)), 1)).toBe(true);
		expect(ids(creator)).toEqual(["w2-after"]);
		expect(shares(creator).allocations.find((row) => row[0] === joiner)).toEqual([joiner, expect.any(Number), 3]);
		expect(updateFor(creator)).toBeUndefined();
	}, 240_000);

	it("a late joiner granted Writer speaks from the checkpoint after the share update", async () => {
		const f = await chatSharesRoomFixture({
			members: ["late"],
			format: "shares",
			genesisStateBytes: createShippingChatSharesGenesisStateBytes,
		});
		const creator = await f.open(0);
		// The shipped page opens a joiner outside the ACL receive-only.
		let joiner = await f.open(1, { receiveOnly: true });
		const author = required(f.identities[1]).author;
		await creator.room.issue(message("w2-hello", "welcome"));
		expect(await joiner.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		expect(ids(joiner)).toEqual(["w2-hello"]);
		// Checkpoint 0: the creator grants Writer; it latches at checkpoint 1.
		await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
		await rollover(creator, 0);
		await f.install(joiner);
		expect(isWriter(joiner.room.previewLatchedAcl().current, author)).toBe(true);
		// The page reopens the joiner's replica as a Writer, over the same databases.
		await f.stop(joiner);
		joiner = await f.open(1, { reopen: true });
		expect(joiner.room.authority()).toMatchObject({ epoch: 1, lifecycle: "active" });
		// Checkpoint 1: no share yet, so a message is refused (the page keeps its text).
		await expect(joiner.room.issue(message("w2-early", "too early"))).rejects.toThrow();
		// The creator's page issues the share update once checkpoint 1 is installed.
		const update = required(updateFor(creator));
		expect(update.capacity.allocations.find((row) => row[0] === author)).toEqual([author, expect.any(Number), 2]);
		await creator.room.issue(update);
		expect(updateFor(creator)).toBeUndefined();
		await rollover(creator, 1);
		await f.install(joiner);
		expect(joiner.room.authority()).toMatchObject({ epoch: 2, lifecycle: "active" });
		// Checkpoint 2: the joiner speaks, and the creator admits it.
		const before = lastSequence(await f.issuedAfter(1, null));
		await joiner.room.issue(message("w2-joiner", "hello from the joiner"));
		expect(await creator.receive(await f.issuedAfter(1, before), 1)).toBe(true);
		expect(ids(creator)).toEqual(["w2-hello", "w2-joiner"]);
		expect(ids(joiner)).toEqual(["w2-hello", "w2-joiner"]);
	}, 240_000);

	it("a revoked member's messages stay until the window needs their space, then leave first, oldest first", async () => {
		const f = await chatSharesRoomFixture({
			members: ["genesis"],
			format: "shares",
			genesisStateBytes: createShippingChatSharesGenesisStateBytes,
		});
		const creator = await f.open(0);
		const member = await f.open(1);
		const creatorAuthor = required(f.identities[0]).author;
		const memberAuthor = required(f.identities[1]).author;
		// The member's last words, within its allowance.
		const spoken = Array.from({ length: 5 }, (_, index) => `w2-member-${index}`);
		for (const id of spoken) await member.room.issue(message(id, "m".repeat(200)));
		expect(await creator.receive(await f.issuedAfter(1, null), 1)).toBe(true);
		await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: memberAuthor });
		await rollover(creator, 0);
		// Checkpoint 1: the creator's page drops the departed member's share.
		const update = required(updateFor(creator));
		expect(update.capacity.allocations.map((row) => row[0])).toEqual([creatorAuthor]);
		await creator.room.issue(update);
		expect(holders(creator)).toEqual([creatorAuthor]);
		const budget = shares(creator).windowBytes;
		const allowance = shares(creator).allowanceBytes;
		const windowTotal = (): number => creator.room.projection().messages.reduce((sum, row) => sum + size(row), 0);
		// The creator fills the window, one allowance-sized message per checkpoint.
		let epoch = 1;
		let reclaimed = false;
		const sentByCreator: string[] = [];
		for (; epoch < 40; epoch++) {
			const kept = ids(creator).filter((id) => id.startsWith("w2-member-"));
			if (kept.length === 0) break;
			const priorTotal = windowTotal();
			const id = `w2-creator-${epoch}`;
			const text = "c".repeat(allowance - 200);
			const record = size({ author: creatorAuthor, clientOperationId: id, displayTimeMs: T, text });
			expect(record).toBeLessThanOrEqual(allowance);
			await creator.room.issue(message(id, text));
			sentByCreator.push(id);
			const now = ids(creator).filter((value) => value.startsWith("w2-member-"));
			// Only when space is needed, oldest first, and before any of the creator's own messages.
			if (now.length < kept.length) {
				expect(priorTotal + record).toBeGreaterThan(budget);
				reclaimed = true;
			} else expect(priorTotal + record).toBeLessThanOrEqual(budget);
			expect(now).toEqual(spoken.slice(spoken.length - now.length));
			const creatorKept = ids(creator).filter((value) => value.startsWith("w2-creator-"));
			if (now.length > 0) expect(creatorKept).toEqual(sentByCreator);
			else expect(creatorKept).toEqual(sentByCreator.slice(sentByCreator.length - creatorKept.length));
			expect(windowTotal()).toBeLessThanOrEqual(budget);
			await rollover(creator, epoch);
			// Every checkpoint the creator signs holds exactly what it shows.
			expect(Buffer.from(await f.exportedApplicationStateBytes()).equals(Buffer.from(creator.stateBytes()))).toBe(true);
		}
		expect(reclaimed).toBe(true);
		expect(ids(creator).filter((id) => id.startsWith("w2-member-"))).toEqual([]);
		expect(epoch).toBeGreaterThan(10);
	}, 600_000);
});
