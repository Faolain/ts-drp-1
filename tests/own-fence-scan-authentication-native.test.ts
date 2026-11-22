import {afterEach, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {scanOwnFences} from "../packages/node/src/v3-live.js";
import {createNodeV3RoomStorageHost} from "../packages/storage-node/src/v3-room-host.js";
import {createShippingChatWindowGenesisStateBytes} from "../examples/chat/src/v3-chat-window.js";
import {chatSharesRoomFixture, closeChatSharesRooms, required} from "./fixtures/chat-membership-shares/room.js";

// G5 (durable store bytes are carriers, not authenticity), independent of call order. scanOwnFences is
// the one reader of a Writer's own fence rows. The settlement "guarded" rule, the frontier's "committed"
// rule, the window expiry and hand-back, the rebase's frontierDisplaced and the retention census
// (readCreatorRecoveryDependencyCensus, settledLocalSourceFacts, ownSourceSettlementIsComplete,
// cleanupCreatorSettlementSuccessor) all decide on what it reports. The scan is called here directly on
// a Writer's real native issuance store with one stored own fence row forged (the store's write triggers
// bypassed, as the other native tamper tests do). A forged fence must end the scan with a typed, closed
// refusal (code V3_OWN_FENCE_UNAUTHENTICATED, reason signature | digest | identity), never be reported.

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const FENCE = "$drp.author-fence.v1";
type Preimage = Record<string, unknown> & {epoch: number; authorSequence: number; operation?: Record<string, unknown>};
type Row = {sequence: number; preimageBytes: Uint8Array; preimage: Preimage; digest: Uint8Array; signature: Uint8Array};
type Forgery = "forged-epoch" | "signature" | "digest";

/**
 * A Writer whose own outbox holds its epoch-0 fence and one later own move, closed so that only the
 * test touches its stores.
 * @returns The fixture, the Writer's scope and its issuance database path.
 */
async function writerStores() {
	const f = await chatSharesRoomFixture({members: ["genesis"], format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes});
	await f.open(0); const member = await f.open(1);
	await member.room.issue({action: "message", clientOperationId: "own-move", displayTimeMs: 1_791_662_400_000, text: "own-move"});
	await f.stop(member);
	const scope = {objectId: f.objectId, author: required(f.identities[1]).author};
	const key = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
	return {f, scope, path: join(f.directory, `${key}.sqlite.drp-issuance-v1.sqlite`)};
}

/**
 * Runs the scan on the Writer's native issuance store.
 * @param f - The fixture.
 * @param scope - The Writer's own scope.
 * @returns What the scan reported, or its refusal.
 */
async function scan(f: Awaited<ReturnType<typeof writerStores>>["f"], scope: {objectId: string; author: string}) {
	const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
	try {
		return await scanOwnFences(store as Parameters<typeof scanOwnFences>[0], scope).then(
			value => ({reported: {lowest: [...value.lowest], highest: value.highest, highestEpoch: value.highestEpoch}}),
			(error: {code?: unknown; reason?: unknown; authorSequence?: unknown}) =>
				({refused: {code: error.code, reason: error.reason, authorSequence: error.authorSequence}}));
	} finally {await store.close();}
}

function ownRows(database: DatabaseSync, scope: {objectId: string; author: string}): Row[] {
	return database.prepare("SELECT author_sequence, canonical_preimage, digest, signature FROM issued_records WHERE object_id=? AND author=? ORDER BY author_sequence")
		.all(scope.objectId, scope.author).map(row => ({sequence: Number(row.author_sequence), preimageBytes: row.canonical_preimage as Uint8Array,
			preimage: decodeCanonical(row.canonical_preimage as Uint8Array) as Preimage, digest: row.digest as Uint8Array, signature: row.signature as Uint8Array}));
}

it("reports the genuine own fence of an untouched store", async () => {
	const {f, scope, path} = await writerStores();
	const database = new DatabaseSync(path, {readOnly: true});
	let fence: Row;
	try {fence = required(ownRows(database, scope).find(row => row.preimage.operation?.action === FENCE && row.preimage.epoch === 0));}
	finally {database.close();}
	expect(await scan(f, scope)).toEqual({reported: {lowest: [[0, fence.sequence]], highest: fence.sequence, highestEpoch: 0}});
}, 120_000);

it.each([
	// The fence's preimage rewritten to claim epoch 2 (stored digest and signature left as they were).
	["forged-epoch", "signature"],
	// One byte of the stored signature flipped.
	["signature", "signature"],
	// The stored digest (issued record and outbox entry) replaced: the bytes no longer name this vertex.
	["digest", "digest"],
] as const)("refuses an own fence row forged by %s instead of reporting it", async (forgery: Forgery, reason) => {
	const {f, scope, path} = await writerStores();
	const database = new DatabaseSync(path);
	let target: number;
	try {
		database.function("issuance_retirement_connection", {varargs: true}, () => 1);
		database.function("issuance_retirement_record", {varargs: true}, () => 1);
		const rows = ownRows(database, scope);
		const fence = required(rows.find(row => row.preimage.operation?.action === FENCE && row.preimage.epoch === 0 &&
			row.preimage.operation.fenceSequence === row.sequence));
		const issued = database.prepare("UPDATE issued_records SET canonical_preimage=?, digest=?, signature=? WHERE object_id=? AND author=? AND author_sequence=?");
		const outbox = database.prepare("UPDATE issuance_outbox SET digest=? WHERE object_id=? AND author=? AND author_sequence=?");
		const write = (sequence: number, preimage: Uint8Array, digest: Uint8Array, signature: Uint8Array) => {
			issued.run(preimage, digest, signature, scope.objectId, scope.author, sequence);
			outbox.run(digest, scope.objectId, scope.author, sequence);
		};
		target = fence.sequence;
		if (forgery === "forged-epoch") write(fence.sequence, encodeCanonical({...fence.preimage, epoch: 2}), fence.digest, fence.signature);
		if (forgery === "signature") {const signature = new Uint8Array(fence.signature); signature[0] ^= 1; write(fence.sequence, fence.preimageBytes, fence.digest, signature);}
		if (forgery === "digest") {const digest = new Uint8Array(fence.digest); digest[0] ^= 1; write(fence.sequence, fence.preimageBytes, digest, fence.signature);}
	} finally {database.close();}
	const outcome = await scan(f, scope);
	console.error(`OWN_FENCE_SCAN ${forgery} ${JSON.stringify(outcome)}`);
	expect(outcome).toEqual({refused: {code: "V3_OWN_FENCE_UNAUTHENTICATED", reason, authorSequence: target}});
}, 120_000);

// Guard (green before the fix): the genuine signed fence copied into the later move's slot (an authentic
// vertex stored as another sequence) is already refused by the store's own preimage-header check.
it("refuses a genuine own fence stored in another sequence's slot", async () => {
	const {f, scope, path} = await writerStores();
	const database = new DatabaseSync(path);
	try {
		database.function("issuance_retirement_connection", {varargs: true}, () => 1);
		database.function("issuance_retirement_record", {varargs: true}, () => 1);
		const rows = ownRows(database, scope);
		const fence = required(rows.find(row => row.preimage.operation?.action === FENCE && row.preimage.epoch === 0));
		const later = required(rows.find(row => row.sequence > fence.sequence));
		database.prepare("UPDATE issued_records SET canonical_preimage=?, digest=?, signature=? WHERE object_id=? AND author=? AND author_sequence=?")
			.run(fence.preimageBytes, fence.digest, fence.signature, scope.objectId, scope.author, later.sequence);
		database.prepare("UPDATE issuance_outbox SET digest=? WHERE object_id=? AND author=? AND author_sequence=?")
			.run(fence.digest, scope.objectId, scope.author, later.sequence);
	} finally {database.close();}
	expect(await scan(f, scope)).toMatchObject({refused: {code: "ISSUANCE_RECOVERY_CORRUPT"}});
}, 120_000);
