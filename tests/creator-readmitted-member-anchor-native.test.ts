import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// RED for fix/creator-anchor-uncovered without hand-back record overflow (fix/int7-admitted-backlog
// counts every move against the records, so the record-overflow path to a fenceless epoch is refused up front).
// With the fix (g) the fence is not withheld for retained work no frontier can ever prove, so the
// re-admission epoch has its own fence and the first move there is guarded.
//
// creator-rejoin-readmission-native "retains accepted pending work through removal and re-admission on
// the same stores": a member's move made before its removal is retained, and the creator's frontier can
// never prove anything about it (a row of an earlier incarnation: commitment "unknown", disposition
// "manual-review"), so it stays retained until the user decides. Retained work the frontier cannot
// resolve withholds the author fence (drainSettlementOutbox), so the epoch of the member's re-admission
// has no own fence and its first move there is not fence-guarded (settlementOwnRowFenceGuarded). There
// that move's replacement reaches the creator. Here nothing does: the next install replaces it, the
// replaced source is never guarded, so the settlement window never expires it, terminal coverage never
// reaches it and the issuance retirement never covers it; the received-turnover census demands its
// epoch's anchor for as long as it is held, and AHE generation retirement (which does not consult that
// census) retires the generations that authenticate it.

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string): Readonly<Record<string, unknown>> => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
// The epochs the creator seals after the member's skip install.
const EPOCHS = Number(process.env.UNRESOLVED_ANCHOR_EPOCHS ?? 16);

/**
 * An error's message, depth-bounded through its cause chain.
 * @param error - The error.
 * @param depth - The current depth.
 * @returns The explanation.
 */
const explain = (error: unknown, depth = 0): string => {
	if (!(error instanceof Error) || depth > 3) return String(error).slice(0, 400);
	return error.message.slice(0, 400) + (error.cause === undefined ? "" : ` <- ${explain(error.cause, depth + 1)}`);
};

it("a re-admitted member whose earlier incarnation's work withholds its fence keeps certifying its recovery roles", async () => {
	const outcomes: { label: string; outcome: string }[] = [];
	const record = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
		try {
			await run();
			outcomes.push({ label, outcome: "ok" });
			return true;
		} catch (error) {
			outcomes.push({ label, outcome: `failed: ${explain(error)}` });
			return false;
		}
	};
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	const member = await f.open(1);
	await member.room.issue(message("before-removal"));
	const author = required(f.identities[1]).author;
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	expect(member.room.authority().epoch).toBe(2);
	expect(await member.room.unresolvedAcceptedWork()).toMatchObject([
		{ sourceEpoch: 0, commitment: "unknown", disposition: "manual-review" },
	]);
	// Never delivered: the creator seals epoch 2 without it.
	await member.room.issue(message("after-readmission"));
	for (let epoch = 2; epoch < 2 + EPOCHS; epoch++) {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		if (!(await record(`member-install-${epoch + 1}`, () => f.install(member)))) break;
		if (!(await record(`member-lull-after-install-${epoch + 1}`, () => member.room.maintainRecoveryPool()))) break;
	}
	console.log(`READMITTED_MEMBER_ANCHOR ${JSON.stringify(outcomes)}`);
	expect(
		outcomes.filter(({ outcome }) => outcome !== "ok"),
		JSON.stringify(outcomes)
	).toEqual([]);
	expect(member.room.authority().epoch).toBe(2 + EPOCHS);
}, 900_000);
