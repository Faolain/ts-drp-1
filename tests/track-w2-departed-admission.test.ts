import { afterEach, describe, expect, it } from "vitest";

import {
	type ChatSharesPeer,
	type ChatSharesRoom,
	chatSharesRoomFixture,
	closeChatSharesRooms,
	required,
} from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// Track W2's precondition (OPTIONS.md, C5): an author absent from a checkpoint's latched ACL
// cannot have any work admitted in that checkpoint, whatever it sends: a message the creator
// never saw before the seal (displaced), arriving after the seal or after adoption; a new
// message issued on its stale replica; or its own rebase, which needs it to install the
// successor first. W2 releases a departed member's Chat share at the first share update after
// the member leaves the ACL, and that is safe only because of this. The library decides it
// (ordinary issue needs `writer`; a settlement source needs membership of the target ACL;
// installing a successor as a Writer needs membership), so this pins library behaviour on the
// shipped Chat composition (window catalog, creator-trusted-settlement-v1, the shipped policy).

afterEach(async () => {
	expect(await closeChatSharesRooms()).toEqual([]);
});

const message = (clientOperationId: string, text: string): Readonly<Record<string, unknown>> => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text,
});

const ids = (peer: ChatSharesPeer): string[] => peer.room.projection().messages.map((row) => row.clientOperationId);

async function room(): Promise<{ f: ChatSharesRoom; creator: ChatSharesPeer; member: ChatSharesPeer }> {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	return { f, creator: await f.open(0), member: await f.open(1) };
}

/**
 * Delivers every row the member has issued to the creator and waits a while.
 * @param f - The room.
 * @param creator - The creator peer.
 * @param member - The member whose rows are delivered.
 * @returns How many of the member's rows the creator accepted.
 */
async function deliverAll(f: ChatSharesRoom, creator: ChatSharesPeer, member: ChatSharesPeer): Promise<number> {
	const rows = await f.issuedAfter(member.index, null);
	if (rows.length === 0) return 0;
	await creator.receive(rows, member.index, 5_000);
	return rows.filter((row) => creator.wasAccepted(row)).length;
}

describe("Track W2: a departed author has no work admitted in a checkpoint whose ACL lacks it", () => {
	for (const arrival of ["after-seal", "after-adoption"] as const)
		it(`a member removed from the ACL at epoch 1 gets nothing admitted in epoch 1 (displaced message arrives ${arrival})`, async () => {
			const { f, creator, member } = await room();
			const author = required(f.identities[1]).author;
			// Admitted while a Writer: in the window from then on.
			await member.room.issue(message("w2-kept", "admitted while a Writer"));
			expect(await creator.receive(await f.issuedAfter(1, null), 1)).toBe(true);
			const kept = await f.issuedAfter(1, null);
			const afterKept = required(kept.at(-1)).commit.authorSequence;
			// Issued in epoch 0 but never seen by the creator before the seal: displaced.
			await member.room.issue(message("w2-displaced", "issued before the removal latched"));
			const displaced = await f.issuedAfter(1, afterKept);
			expect(displaced).toHaveLength(1);
			// The admin removes the member entirely (its only group is writer).
			await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
			const sealed = await creator.room.sealEpoch();
			expect(sealed).toMatchObject({ ok: true, epoch: 0, successorEpoch: 1 });
			if (arrival === "after-seal") await creator.receive(displaced, 1, 5_000);
			await creator.room.adoptCreatorSuccessor();
			const current = creator.room.previewLatchedAcl().current as { epoch: number; members: { author: string }[] };
			expect(current.epoch).toBe(1);
			expect(current.members.map((row) => row.author)).not.toContain(author);
			if (arrival === "after-adoption") await creator.receive(displaced, 1, 5_000);
			expect(ids(creator)).toEqual(["w2-kept"]);

			// The departed member's stale replica: installing the successor as a Writer needs
			// membership, so it is refused, and no rebase of the displaced message can follow.
			await expect(f.install(member)).rejects.toThrow();
			// Whatever its stale replica still accepts locally, none of it reaches epoch 1.
			await Promise.race([
				member.room.issue(message("w2-stale", "issued on the stale replica")).catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 20_000)),
			]);
			await deliverAll(f, creator, member);
			expect(ids(creator)).toEqual(["w2-kept"]);

			// Sealed into the next checkpoint exactly as admitted: the departed member's work is absent.
			expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch: 1, successorEpoch: 2 });
			await creator.room.adoptCreatorSuccessor();
			expect(ids(creator)).toEqual(["w2-kept"]);
			const exported = await f.exportedApplicationStateBytes();
			expect(Buffer.from(exported).includes(Buffer.from("w2-displaced"))).toBe(false);
			expect(Buffer.from(exported).includes(Buffer.from("w2-stale"))).toBe(false);
			// The creator still works in the checkpoint that lacks the member.
			await creator.room.issue(message("w2-creator", "the room continues"));
			expect(ids(creator)).toEqual(["w2-kept", "w2-creator"]);
		}, 180_000);
});

describe("Track W2: a member who loses only `writer` stays a member and keeps its old work's custody", () => {
	// W2 keeps the share row of such a member (a "custodian") while it stays in the ACL: it still
	// installs successors as a non-receive-only member holding its old-source custody, so W2 does
	// not treat it as departed. (In this composition, with no settlement-source approval, its
	// displaced message was not re-issued automatically; W2 does not rely on either outcome.)
	it("installs the next checkpoint as a member without new-work authority", async () => {
		const f = await chatSharesRoomFixture({
			members: ["genesis-admin"],
			format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes,
		});
		const creator = await f.open(0);
		const member = await f.open(1);
		const author = required(f.identities[1]).author;
		await member.room.issue(message("w2-kept", "admitted while a Writer"));
		expect(await creator.receive(await f.issuedAfter(1, null), 1)).toBe(true);
		const afterKept = required((await f.issuedAfter(1, null)).at(-1)).commit.authorSequence;
		await member.room.issue(message("w2-displaced", "issued before writer was revoked"));
		expect(await f.issuedAfter(1, afterKept)).toHaveLength(1);
		await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
		expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch: 0, successorEpoch: 1 });
		await creator.room.adoptCreatorSuccessor();
		const current = creator.room.previewLatchedAcl().current as {
			members: { author: string; groups: string[] }[];
		};
		expect(current.members.find((row) => row.author === author)?.groups).toEqual(["admin"]);
		// Still a member: it installs the successor (old-source custody, not new Writer authority),
		// and new work is refused.
		await f.install(member);
		expect(member.room.authority()).toMatchObject({ epoch: 1, lifecycle: "active" });
		await expect(member.room.issue(message("w2-new", "new work needs writer"))).rejects.toThrow();
		expect(ids(member)).toEqual(["w2-kept"]);
	}, 180_000);
});
