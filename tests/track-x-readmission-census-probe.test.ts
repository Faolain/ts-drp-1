import { afterEach, describe, expect, it } from "vitest";

import {
	type ChatSharesPeer,
	chatSharesRoomFixture,
	closeChatSharesRooms,
	required,
} from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// Track X probe for CONTRACT.md D8 (a fact-finding test, not a RED): what a Writer that is
// removed from the ACL and later re-admitted does today, on the shipped Chat composition
// (window catalog, creator-trusted-settlement-v1, genuine SQLite and Ed25519 owners).
// The creator gives a re-admitted author the frontier [A, m, null] (creator-close.ts:1383-1385),
// so its rows of epochs below m are "old-incarnation" (v3-live.ts settlementOwnRowClass).
// The probe tries each way the removed member's replica could follow the room and come back:
// - "same-replica": its Writer replica tries the install at the removal, then reopens
//   receive-only over the same databases (the shipped page's path for a member outside the
//   ACL, as tests/track-w2-chat-shares-room.test.ts does for a late joiner);
// - "same-replica-no-install": the same, without the refused Writer install first;
// - "fresh-replica": a new replica of the same identity, receive-only from genesis, promoted to
//   a Writer after re-admission (no old-incarnation rows in its own store).
// It records every step's outcome and the member's issuance rows, so the census's handling of
// the old incarnation is observed rather than assumed. Each step is printed as one JSON line
// prefixed "TRACK_X_D8".

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

type Variant = "same-replica" | "same-replica-no-install" | "fresh-replica";

async function probe(variant: Variant): Promise<void> {
	const steps: Record<string, unknown>[] = [];
	const record = async <Value>(label: string, run: () => Promise<Value>): Promise<Value | undefined> => {
		try {
			const value = await run();
			steps.push({ label, ok: true, ...(value === undefined ? {} : { value }) });
			console.log(`TRACK_X_D8 ${variant} ${JSON.stringify({ label, ok: true, value })}`);
			return value;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			steps.push({ label, ok: false, error: text });
			console.log(`TRACK_X_D8 ${variant} ${JSON.stringify({ label, ok: false, error: text })}`);
			return undefined;
		}
	};
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	let member = await f.open(1);
	const author = required(f.identities[1]).author;
	const replica = variant === "fresh-replica" ? "peer-1-fresh" : "peer-1";
	const memberRows = async (name = replica) =>
		(await f.issuedAfter(1, null, name)).map((row) => ({
			sequence: row.commit.authorSequence,
			publishState: row.publishState,
		}));
	const rollover = async (epoch: number) =>
		record(`creator-rollover-${epoch}`, async () => {
			const sealed = await creator.room.sealEpoch();
			if (!sealed.ok) throw new TypeError(`seal refused: ${JSON.stringify(sealed)}`);
			await creator.room.adoptCreatorSuccessor();
			return creator.room.authority().epoch;
		});
	const install = async (label: string) =>
		record(label, async () => {
			await f.install(member);
			return member.room.authority();
		});
	const finish = async () => {
		await record("creator-ids", async () => ids(creator));
		console.log(`TRACK_X_D8_SUMMARY ${variant} ${JSON.stringify(steps)}`);
	};

	// Epoch 0: one admitted move and one the creator never sees (displaced at the seal).
	await member.room.issue(message("x-kept", "admitted in epoch 0"));
	expect(await creator.receive(await f.issuedAfter(1, null), 1)).toBe(true);
	await member.room.issue(message("x-unsent", "issued in epoch 0, never delivered"));
	await record("member-rows-epoch-0", () => memberRows("peer-1"));

	// Removal latches at epoch 1.
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
	await rollover(0);
	if (variant === "same-replica") await install("member-writer-install-1-after-removal");
	await record("member-stop-old-writer", () => f.stop(member));
	const reopened = await record("member-open-receive-only", async () => {
		member =
			variant === "fresh-replica"
				? await f.open(1, { receiveOnly: true, name: replica })
				: await f.open(1, { reopen: true, receiveOnly: true });
		return member.room.authority();
	});
	if (reopened === undefined) {
		const writer = await record("member-reopen-as-writer-after-refusal", async () => {
			member = await f.open(1, { reopen: true });
			return member.room.authority();
		});
		if (writer !== undefined) await install("member-writer-install-1-after-reopen");
		return finish();
	}
	await install("member-receive-only-install-1");

	// Re-admission latches at epoch 2.
	await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
	await rollover(1);
	await install("member-receive-only-install-2");
	await record("member-stop-receive-only", () => f.stop(member));
	const promoted = await record("member-promote", async () => {
		member = await f.open(1, { promote: true, name: replica });
		return member.room.authority();
	});
	if (promoted === undefined) return finish();
	await record("member-rows-after-promote", memberRows);
	let sent = await record("member-issue-readmitted", async () => {
		await member.room.issue(message("x-readmitted", "issued after re-admission"));
		const rows = await f.issuedAfter(1, null, replica);
		return creator.receive(rows, 1, 30_000);
	});

	// Several rollovers with the re-admitted Writer installing each, moving in some.
	for (let epoch = 2; epoch < 8; epoch++) {
		await rollover(epoch);
		const installed = await install(`member-writer-install-${epoch + 1}`);
		await record(`member-rows-after-install-${epoch + 1}`, memberRows);
		if (installed === undefined) break;
		if (epoch % 2 === 0)
			sent = await record(`member-issue-epoch-${epoch + 1}`, async () => {
				await member.room.issue(message(`x-move-${epoch + 1}`, "a move after re-admission"));
				return creator.receive(await f.issuedAfter(1, null, replica), 1, 30_000);
			});
	}
	void sent;
	await record("member-ids", async () => ids(member));
	return finish();
}

describe("Track X probe: a removed then re-admitted Writer's old-incarnation rows (CONTRACT D8)", () => {
	for (const variant of ["same-replica", "same-replica-no-install", "fresh-replica"] as const)
		it(`records each step for the ${variant} path`, () => probe(variant), 900_000);
});
