// Endurance rollback gate: genuine forward promotion from BOTH usable rollback
// slots of the original creator, on real SQLite owners, with a physical census.
//
// Method. The creator itself produces its checkpoint chain, ordinarily stops,
// and is cold-opened again over the SAME native stores with its genuine
// creatorFinalitySigner (the shared fixture derives it from the creator's real
// seed; nothing is mocked). The only selector is the public
// room.promoteCreatorCheckpoint({closedEpoch}); this file never edits a head,
// floor or generation to select history, never relabels a normalized
// source-floor header as a usable slot, and never bypasses candidate
// authentication. Usable slots are the two the original source law admits:
// closedEpoch = floor - 1 and floor - 2.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, hex, required } from "./fixtures/chat-membership-shares/room.js";
import { type NativeCensus, floorCensus, nativeCensus } from "./fixtures/rollback-promotion/census.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const log = (label: string, value: unknown): void => console.log(`ROLLBACK_CENSUS ${label} ${JSON.stringify(value)}`);
const SOURCE_REFUSAL = /^creator promotion source failed: .*"kind":"snapshot-unavailable"/u;

type Fixture = Awaited<ReturnType<typeof chatSharesRoomFixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;

/** Produces the creator's own ordinary chain to `floor`, recording each closed projection. */
async function creatorChain(floor: number) {
	const f = await chatSharesRoomFixture({ members: ["genesis"], format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes });
	const creator = await f.open(0);
	const closed = new Map<number, Readonly<{ state: string; messages: readonly string[] }>>();
	for (let epoch = 0; epoch < floor; epoch++) {
		await creator.room.issue(message(`creator-epoch-${epoch}`));
		closed.set(epoch, { state: hex(creator.stateBytes()),
			messages: creator.room.projection().messages.map(row => row.clientOperationId) });
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	}
	expect(creator.room.authority()?.epoch).toBe(floor);
	// Open-epoch work makes the current projection differ from every closed slot.
	await creator.room.issue(message(`creator-epoch-${floor}`));
	return { f, creator, closed };
}

const census = async (f: Fixture, peer: Peer) => ({
	epoch: peer.room.authority()?.epoch ?? null,
	floor: await floorCensus(peer, f.objectId, f.invite.pinnedGenesisAnchorDigest),
	native: await nativeCensus(f.directory, f.objectId, "peer-0"),
});

/** Normalized/source-floor headers: physically present, base `none`, never a usable slot. */
const sourceFloorHeaders = (native: NativeCensus) => native.generations.filter(row => row.base === "none");

// Floor 4 is the first steady-state floor (bounded generations full) beside floor 6.
describe.each([2, 4, 6])("original creator at floor %i", floor => {
	it.each([1, 2])(`promotes usable rollback slot floor-%i after a genuine cold open`, async offset => {
		const selected = floor - offset;
		const { f, creator: live, closed } = await creatorChain(floor);
		const historical = required(closed.get(selected));
		const liveCensus = await census(f, live);
		log(`floor${floor}-slot${selected}-live`, liveCensus);
		await f.stop(live);
		const closedNative = await nativeCensus(f.directory, f.objectId, "peer-0");
		log(`floor${floor}-slot${selected}-stopped`, closedNative);
		expect(closedNative).toEqual(liveCensus.native);

		// Genuine original owners: same SQLite stores, real creator seed and finality signer.
		let creator = await f.open(0, { reopen: true });
		const before = await census(f, creator);
		log(`floor${floor}-slot${selected}-before`, before);
		expect(before.epoch).toBe(floor);
		expect(before.floor).toMatchObject({ stableEpoch: floor, pending: null });
		expect(before.native.head.kind).toBe("present");
		expect(before.native.chain[0]).toBe(floor);
		// The selected slot is an actual retained closed snapshot whose own native
		// headers agree on one closed state digest (the source identity).
		expect(before.native.snapshots.map(row => row.epoch)).toContain(selected);
		const sourceRows = before.native.generations.filter(row => row.cutEpoch === selected);
		expect(sourceRows.length).toBeGreaterThan(0);
		expect(new Set(sourceRows.map(row => row.cutStateDigest)).size).toBe(1);
		const sourceStateDigest = required(sourceRows[0]).cutStateDigest;
		expect(creator.room.projection().messages.map(row => row.clientOperationId))
			.toEqual(Array.from({ length: floor + 1 }, (_, epoch) => `creator-epoch-${epoch}`));
		expect(hex(creator.stateBytes())).not.toBe(historical.state);

		await creator.room.promoteCreatorCheckpoint({ closedEpoch: selected });

		// Exact historical projection at a fresh epoch above the prior floor.
		expect(creator.room.authority()?.epoch).toBe(floor + 1);
		expect(hex(creator.stateBytes())).toBe(historical.state);
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toEqual(historical.messages);
		const promoted = await census(f, creator);
		log(`floor${floor}-slot${selected}-promoted`, promoted);
		expect(promoted.floor).toMatchObject({ stableEpoch: floor + 1, pending: null });
		expect(promoted.floor.stableEpoch).toBeGreaterThan(before.floor.stableEpoch);
		expect(promoted.native.head.generationId).not.toBe(before.native.head.generationId);
		expect(Number(promoted.native.head.revision)).toBeGreaterThan(Number(before.native.head.revision));
		const head = required(promoted.native.generations.find(row => row.generationId === promoted.native.head.generationId));
		expect(head).toMatchObject({ projectionEpoch: floor + 1, cutEpoch: floor,
			forwardPromotionClosedEpoch: selected, forwardPromotionStateDigest: sourceStateDigest });

		// Useful subsequent issue: a real accepted, durable operation on the promoted epoch.
		const useful = `after-promotion-floor${floor}-slot${selected}`;
		await creator.room.issue(message(useful));
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toEqual([...historical.messages, useful]);
		const issued = await f.issuedAfter(0, null);
		expect(issued.some(row => row.commit.envelope.canonicalPreimageBytes.byteLength > 0 &&
			Buffer.from(row.commit.envelope.canonicalPreimageBytes).includes(Buffer.from(useful)))).toBe(true);
		const afterIssue = await census(f, creator);
		log(`floor${floor}-slot${selected}-issued`, afterIssue);

		// Another genuine cold reopen preserves the promoted epoch, history and issue.
		await f.stop(creator);
		creator = await f.open(0, { reopen: true });
		const reopened = await census(f, creator);
		log(`floor${floor}-slot${selected}-reopened`, reopened);
		expect(reopened.epoch).toBe(floor + 1);
		expect(reopened.floor).toEqual(afterIssue.floor);
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toEqual([...historical.messages, useful]);
		expect(reopened.native.generations.find(row => row.generationId === promoted.native.head.generationId))
			.toMatchObject({ forwardPromotionClosedEpoch: selected });
		await creator.room.issue(message(`${useful}-after-reopen`));
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toEqual([...historical.messages, useful, `${useful}-after-reopen`]);
	}, 600_000);

	it("keeps a promotion across a genuine cold reopen before any further issue", async () => {
		const selected = floor - 1;
		const { f, creator: live, closed } = await creatorChain(floor);
		const historical = required(closed.get(selected));
		await f.stop(live);
		let creator = await f.open(0, { reopen: true });
		await creator.room.promoteCreatorCheckpoint({ closedEpoch: selected });
		const promoted = await census(f, creator);
		log(`floor${floor}-reopen-promoted`, promoted);
		await f.stop(creator);
		creator = await f.open(0, { reopen: true });
		const reopened = await census(f, creator);
		log(`floor${floor}-reopen-reopened`, reopened);
		expect(reopened.epoch).toBe(floor + 1);
		expect(reopened.floor).toEqual(promoted.floor);
		expect(reopened.native.head).toEqual(promoted.native.head);
		expect(hex(creator.stateBytes())).toBe(historical.state);
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toEqual(historical.messages);
		expect(reopened.native.generations.find(row => row.generationId === promoted.native.head.generationId))
			.toMatchObject({ forwardPromotionClosedEpoch: selected });
	}, 600_000);

	it.runIf(floor !== 4)("refuses a non-slot or tampered selection with no physical effect", async () => {
		const { f, creator: live } = await creatorChain(floor);
		await f.stop(live);
		const creator = await f.open(0, { reopen: true });
		const before = await census(f, creator);
		log(`floor${floor}-controls-before`, { floor: before.floor, native: before.native, sourceFloorHeaders: sourceFloorHeaders(before.native) });
		const unchanged = async (label: string): Promise<void> => {
			const after = await census(f, creator);
			log(`floor${floor}-controls-after-${label}`, { floor: after.floor, head: after.native.head });
			expect(after).toEqual(before);
		};

		// The open current epoch is not a closed rollback slot.
		await expect(creator.room.promoteCreatorCheckpoint({ closedEpoch: floor })).rejects.toThrow(SOURCE_REFUSAL);
		await unchanged("current");

		// A physically present normalized source-floor header is never relabelled as a usable slot.
		if (floor - 3 >= 0) {
			const header = required(sourceFloorHeaders(before.native).find(row => row.cutEpoch === floor - 3));
			expect(header.state).toBe("Superseded");
			await expect(creator.room.promoteCreatorCheckpoint({ closedEpoch: floor - 3 })).rejects.toThrow(SOURCE_REFUSAL);
			await unchanged("source-floor-header");
		}

		// A genuine slot whose retained snapshot bytes were tampered must fail authentication.
		const selected = floor - 1;
		const key = createHash("sha256").update(JSON.stringify(["snapshots", "peer-0"])).digest("hex");
		const db = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-snapshot-quarantine-v1.sqlite`));
		db.function("snapshot_writer_v4", { varargs: true }, () => 1);
		let original: Uint8Array | undefined, row: Record<string, unknown> | undefined;
		const scopeRows = () => db.prepare("SELECT epoch,anchor,manifest_digest,state,retention,incarnation,expires_at,length(exact_manifest_bytes) AS manifest_bytes FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch").all(f.objectId);
		const scopesBefore = scopeRows();
		log(`floor${floor}-controls-snapshot-rows-before-tamper`, scopesBefore);
		try {
			row = required(db.prepare("SELECT anchor,manifest_digest,chunk_index,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? ORDER BY chunk_index LIMIT 1")
				.get(f.objectId, selected));
			original = Uint8Array.from(row.exact_bytes as Uint8Array);
			const tampered = Uint8Array.from(original); tampered[tampered.length - 1]! ^= 1;
			db.prepare("UPDATE snapshot_chunks_v2 SET exact_bytes=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?")
				.run(tampered, f.objectId, selected, row.anchor as string, row.manifest_digest as string, row.chunk_index as number);
			const refusal = await creator.room.promoteCreatorCheckpoint({ closedEpoch: selected }).then(() => undefined, (error: unknown) => error);
			log(`floor${floor}-controls-tamper-refusal`, { message: String(refusal), cause: JSON.stringify((refusal as Error | undefined)?.cause ?? null) });
			expect(refusal).toBeInstanceOf(TypeError);
			expect(String((refusal as Error).message)).toBe(
				'creator promotion source failed: {"ok":false,"kind":"snapshot-invalid","cause":{"owner":"snapshot","reason":"poisoned"}}');
		} finally {
			if (original !== undefined && row !== undefined)
				db.prepare("UPDATE snapshot_chunks_v2 SET exact_bytes=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?")
					.run(original, f.objectId, selected, row.anchor as string, row.manifest_digest as string, row.chunk_index as number);
			const restored = scopeRows();
			log(`floor${floor}-controls-snapshot-rows-after-restore`, restored);
			db.close();
			// The refused read poisons only its own in-flight verification; the native
			// scope rows (state, retention, incarnation, expiry) are byte-for-byte unchanged.
			expect(restored).toEqual(scopesBefore);
		}
		await unchanged("tampered-snapshot");

		// Refusals left the room usable: a real operation is still accepted.
		await creator.room.issue(message(`after-refusals-floor${floor}`));
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toContain(`after-refusals-floor${floor}`);
	}, 600_000);
});
