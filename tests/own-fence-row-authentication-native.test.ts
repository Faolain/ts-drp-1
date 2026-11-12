import {afterEach, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {createNodeV3RoomStorageHost} from "../packages/storage-node/src/v3-room-host.js";
import {createShippingChatWindowGenesisStateBytes} from "../examples/chat/src/v3-chat-window.js";
import {chatSharesRoomFixture, closeChatSharesRooms, required} from "./fixtures/chat-membership-shares/room.js";

// G5 (durable store bytes are carriers, not authenticity). The settlement "guarded" rule
// (v3-live settlementOwnRowFenceGuarded) treats a displaced own row as never admitted when the author's
// own fence of that epoch precedes it. The fence evidence comes from scanOwnFences, which reads the
// author's own outbox rows and checks their shape but not their signature. Every decision built on it
// (the frontier resolution of retained work, the settlement window's expiry and hand-back, the
// rebase's frontierDisplaced, the past-window pruner) then rests on unauthenticated bytes.
//
// The case: a Writer's move never reaches the creator, the creator closes two epochs, and the Writer
// skip-installs. The only evidence that the move was never admitted is the Writer's own epoch-0 fence,
// which precedes it (the frontier's terminalThrough is null, so the move is not the next slot). Its
// stored signature is corrupted before the install, just as "refuses an unauthenticated own source"
// corrupts the move itself. A fence that does not verify is no evidence: the Writer must refuse
// (fail closed), or keep the move as unknown retained work. It must not sign an expiry and hand the
// move back on the strength of it.

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const FENCE = "$drp.author-fence.v1";
const message = (clientOperationId: string) => ({action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId});

// Guard (passes at 4109c500): an install replays and authenticates every own row, so it refuses here.
it("never resolves retained work on an own fence row whose signature does not verify", async () => {
	const f = await chatSharesRoomFixture({members: ["genesis"], format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes});
	const creator = await f.open(0), member = await f.open(1);
	await member.room.issue(message("offline-accepted"));
	const original = required((await f.issuedAfter(1, null)).at(-1));
	for (let epoch = 0; epoch < 2; epoch++) {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	}
	const author = required(f.identities[1]).author;
	const key = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
	const database = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-issuance-v1.sqlite`));
	let fenceSequence: number;
	try {
		database.function("issuance_retirement_connection", {varargs: true}, () => 1);
		database.function("issuance_retirement_record", {varargs: true}, () => 1);
		const rows = database.prepare("SELECT author_sequence, canonical_preimage, signature FROM issued_records WHERE object_id=? AND author=? ORDER BY author_sequence")
			.all(f.objectId, author).map(row => ({sequence: Number(row.author_sequence), signature: row.signature as Uint8Array,
				preimage: decodeCanonical(row.canonical_preimage as Uint8Array) as {epoch: number; operation?: {action?: string; fenceSequence?: number}}}));
		// The Writer's own epoch-0 fence (fenceSequence = its own sequence), before the move.
		const fence = required(rows.find(row => row.preimage.epoch === 0 && row.preimage.operation?.action === FENCE &&
			row.preimage.operation.fenceSequence === row.sequence && row.sequence < original.commit.authorSequence));
		fenceSequence = fence.sequence;
		const signature = new Uint8Array(fence.signature); signature[0] ^= 1;
		database.prepare("UPDATE issued_records SET signature=? WHERE object_id=? AND author=? AND author_sequence=?")
			.run(signature, f.objectId, author, fence.sequence);
	} finally {database.close();}
	let refusal: unknown;
	const installed = await f.install(member).then(() => true, (error: unknown) => {refusal = error; return false;});
	console.error(`OWN_FENCE_RED ${JSON.stringify({installed, refusal: String(refusal), cause: String((refusal as {cause?: unknown} | undefined)?.cause)})}`);
	const unresolved = installed ? await member.room.unresolvedAcceptedWork().catch(() => undefined) : undefined;
	const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
	try {
		const plan = await store.readSettlementPlan({objectId: f.objectId, author});
		const decided = {
			installed, fenceSequence,
			handBacks: (plan?.handBacks ?? []).map(record => record.sourceSequence),
			frontierResolved: (plan?.entries ?? []).filter(entry => entry.sourceResolutionKind === "frontier").map(entry => entry.sourceSequence),
			expired: (plan?.entries ?? []).filter(entry => entry.disposition === "expire").map(entry => entry.sourceSequence),
		};
		// Nothing was decided on the corrupted fence: no hand-back, no frontier resolution, no expiry.
		expect(decided).toMatchObject({handBacks: [], frontierResolved: [], expired: []});
		// If the Writer did not refuse, the move is still unknown retained work.
		if (installed && unresolved !== undefined)
			expect(unresolved).toMatchObject([{sourceSequence: original.commit.authorSequence, commitment: "unknown"}]);
	} finally {await store.close();}
	expect(creator.room.projection().messages.map(row => row.clientOperationId)).not.toContain("offline-accepted");
}, 120_000);

// RED. Between installs, a drain rescans the own fence rows (scanOwnFences) without the install's
// authentication. A re-admitted member (admissionEpoch 2) issues a move at epoch 2 and the creator admits
// it. Its fence stays withheld (the earlier incarnation's move is unknown retained work), so epoch 2 has
// no own fence. The creator's frontier stays terminalThrough null: contiguity from slot 0 never reaches
// this move. After a skip install the move is retained and unprovable ("displaced", not guarded), which
// is correct: it was admitted. Then the stored preimage of the member's own epoch-0 fence is rewritten to
// claim epoch 2, mid-session (the digest and signature bytes are left as they were, so they no longer
// match). The next drain reads that unauthenticated row as an epoch-2 fence before the move, classifies
// the admitted move "never-admitted", signs an expiry and hands the move back. Reissuing it applies the
// move twice. Expected: no decision rests on the forged row (refuse, or leave the move retained), and the
// move is applied at most once.
it("never hands back an admitted move on an own fence row forged mid-session", async () => {
	const f = await chatSharesRoomFixture({members: ["genesis"], format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes});
	const creator = await f.open(0), member = await f.open(1);
	const author = required(f.identities[1]).author;
	await member.room.issue(message("before-removal"));
	await creator.room.issue({action: "acl", kind: "revoke", group: "writer", target: author});
	expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	await creator.room.issue({action: "acl", kind: "grant", group: "writer", target: author});
	expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	expect(member.room.authority().epoch).toBe(2);
	const before = required((await f.issuedAfter(1, null)).at(-1)).commit.authorSequence;
	await member.room.issue(message("after-readmission"));
	const moved = required((await f.issuedAfter(1, before)).find(row =>
		JSON.stringify(decodeCanonical(row.commit.envelope.canonicalPreimageBytes)).includes("after-readmission")));
	expect(await creator.receive(await f.issuedAfter(1, before), 1, 10_000)).toBe(true);
	const applied = () => creator.room.projection().messages.filter(row => row.clientOperationId === "after-readmission").length;
	expect(applied(), "the creator admitted the move at epoch 2").toBe(1);
	for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
	await f.install(member);
	expect(member.room.authority().epoch).toBe(4);
	const plan = async () => {
		const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
		try {return await store.readSettlementPlan({objectId: f.objectId, author});} finally {await store.close();}
	};
	// Unprovable before the forgery: it stays retained, nothing handed back.
	const unresolved = await member.room.unresolvedAcceptedWork();
	expect(unresolved.map(row => row.sourceSequence)).toContain(moved.commit.authorSequence);
	expect(((await plan())?.handBacks ?? []).map(record => record.sourceSequence)).not.toContain(moved.commit.authorSequence);
	// Forge: the member's own epoch-0 fence now claims epoch 2 (fenceSequence = its own sequence, below the move).
	const key = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
	const database = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-issuance-v1.sqlite`));
	try {
		database.function("issuance_retirement_connection", {varargs: true}, () => 1);
		database.function("issuance_retirement_record", {varargs: true}, () => 1);
		const fence = required(database.prepare("SELECT author_sequence, canonical_preimage FROM issued_records WHERE object_id=? AND author=? ORDER BY author_sequence")
			.all(f.objectId, author).map(row => ({sequence: Number(row.author_sequence),
				preimage: decodeCanonical(row.canonical_preimage as Uint8Array) as Record<string, unknown> & {epoch: number; operation?: Record<string, unknown>}}))
			.find(row => row.preimage.epoch === 0 && row.preimage.operation?.action === FENCE && row.preimage.operation.fenceSequence === row.sequence &&
				row.sequence < moved.commit.authorSequence));
		database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE object_id=? AND author=? AND author_sequence=?")
			.run(encodeCanonical({...fence.preimage, epoch: 2}), f.objectId, author, fence.sequence);
	} finally {database.close();}
	// The next drain (any local issue runs one).
	const issuedAfterForgery = await member.room.issue(message("after-forgery")).then(() => "ok", (error: unknown) => String(error));
	await member.room.unresolvedAcceptedWork().catch(() => undefined);
	const after = await plan();
	const given = (after?.handBacks ?? []).filter(record => record.sourceSequence === moved.commit.authorSequence);
	const listed = member.room.settlementStatus?.().undelivered.filter(row => row.handBack?.sourceSequence === moved.commit.authorSequence) ?? [];
	console.error(`OWN_FENCE_FORGED ${JSON.stringify({issuedAfterForgery, unresolvedBefore: unresolved.map(row => [row.sourceSequence, row.sourceEpoch, row.disposition]), moved: moved.commit.authorSequence, handBacks: given.length, listed: listed.length,
		frontierResolved: (after?.entries ?? []).filter(entry => entry.sourceResolutionKind === "frontier").map(entry => entry.sourceSequence)})}`);
	// The app offers every listed move again, exactly once.
	for (const row of listed) {
		await member.room.issue(required(row.operations[0]), {handBack: row.handBack});
		await creator.receive(await f.issuedAfter(1, moved.commit.authorSequence), 1, 10_000).catch(() => false);
	}
	expect({handBacks: given.length, frontierResolved: (after?.entries ?? []).some(entry =>
		entry.sourceSequence === moved.commit.authorSequence && entry.sourceResolutionKind === "frontier")},
	"no decision rests on the forged fence").toEqual({handBacks: 0, frontierResolved: false});
	expect(applied(), "the move is applied at most once").toBe(1);
	// The next transition that drains (a reopen) replays and authenticates every own row first.
	await f.stop(member);
	const reopened = await f.open(1, {reopen: true, promote: true}).then(value => ({value}), (error: unknown) => ({error: String(error)}));
	const final = await plan();
	console.error(`OWN_FENCE_REOPEN ${JSON.stringify({reopened: "value" in reopened ? "opened" : reopened.error,
		handBacks: (final?.handBacks ?? []).map(record => record.sourceSequence),
		frontierResolved: (final?.entries ?? []).filter(entry => entry.sourceResolutionKind === "frontier").map(entry => entry.sourceSequence)})}`);
	expect((final?.handBacks ?? []).map(record => record.sourceSequence)).not.toContain(moved.commit.authorSequence);
	if ("value" in reopened) {
		const listedAfter = reopened.value.room.settlementStatus?.().undelivered.filter(row => row.handBack?.sourceSequence === moved.commit.authorSequence) ?? [];
		expect(listedAfter).toEqual([]);
		await f.stop(reopened.value);
	}
	expect(applied()).toBe(1);
}, 180_000);
