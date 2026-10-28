import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";

// RED (decision row 74 follow-up): one browser origin hosts several identities (Web Lock
// slots) and names each room database by objectId alone, so two writers of one room in one
// browser share the room database (journal, AHE, issuance) and, in the test host, the
// per-object room-head floor. Both cases below keep that layout: the same database name
// for both writers and the shared floor.
//
// (1) Concurrent tabs. Both writers' first successor install refuses "creator recipient
//     native replay is invalid": sealCreatorDurableReplay walks every journal row of the
//     object and requires each to equal a vertex of THIS session's retained close graph
//     (readCreatorReplayRows, v3-live.ts registration.closeVertices check); the other
//     session's rows in the shared journal are not in it.
// (2) Slot handover. Alice uses the database for six epochs (her rows 0-2 pruned, 3-8
//     retained), closes; Bob opens it, issues, and installs the next successor. The install
//     refuses "creator recovery dependency hold unavailable:outbox-classification:3:
//     displaced:published": the recovery census (readCreatorRecoveryDependencyCensus)
//     reads every author's rows in the object, and every coverage path for a published
//     displaced row requires scope.author === registration.issuanceScope.author (the
//     single-author historical frontier names only Bob). The fully-pruned-lineage and
//     filtered-facade (hidden-native) branches of the same census share that assumption.
//     Bob's plane then stops accepting work and every later install refuses the same way.
afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
const outcome = <T>(task: Promise<T>) =>
	task.then(
		() => "ok",
		(error: unknown) => String((error as Error)?.message ?? error)
	);

async function sharedRoom() {
	const f = await chatSharesRoomFixture({
		members: ["genesis", "genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	const sent = new Map<number, number | null>();
	/** Delivers a writer's new rows (shared database) to the creator. */
	const deliver = async (index: 1 | 2, timeoutMs = 3_000) => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await f.issuedAfter(index, sent.get(index) ?? null, "shared");
		if (rows.length === 0) return;
		await creator.receive(rows, index, timeoutMs);
		sent.set(index, rows.at(-1)!.commit.authorSequence);
	};
	const close = async () => {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	/** Alice's native rows in the shared issuance store. */
	const aliceRows = async () => {
		const store = await createNodeV3RoomStorageHost({ directory: f.directory, initialization: () => "reopen" }).openIssuance(
			"shared"
		);
		try {
			const scope = { objectId: f.objectId, author: f.identities[1]!.author };
			return (await store.readOutboxPage({ scope, afterKey: null, limit: 128 })).map((row) => row.commit.authorSequence);
		} finally {
			await store.close();
		}
	};
	return { f, creator, deliver, close, aliceRows };
}

it("[RED] two writers live on one room database both install the next successor", async () => {
	const { f, creator, deliver, close } = await sharedRoom();
	const alice = await f.open(1, { name: "shared" });
	const bob = await f.open(2, { name: "shared", promote: true });
	await alice.room.issue(message("alice-1"));
	await bob.room.issue(message("bob-1"));
	await deliver(1, 30_000);
	await deliver(2, 30_000);
	await close();
	expect(creator.room.authority()?.epoch).toBe(1);
	expect({ alice: await outcome(f.install(alice)), bob: await outcome(f.install(bob)) }).toEqual({ alice: "ok", bob: "ok" });
}, 300_000);

it("[RED] a writer opening the room database another writer used installs the next successor", async () => {
	const { f, creator, deliver, close, aliceRows } = await sharedRoom();
	const alice = await f.open(1, { name: "shared" });
	await alice.room.issue(message("alice-1"));
	await deliver(1, 30_000);
	for (let step = 0; step < 6; step++) {
		await close();
		await f.install(alice);
		await deliver(1);
	}
	expect(alice.room.authority()?.epoch).toBe(6);
	// Precondition: Alice's oldest rows are pruned, her later author fences retained.
	const retained = await aliceRows();
	expect(retained[0]).toBeGreaterThan(0);
	await f.stop(alice);

	const bob = await f.open(2, { name: "shared", promote: true });
	expect(bob.room.authority()?.epoch).toBe(6);
	await bob.room.issue(message("bob-1"));
	await deliver(2);
	await close();
	expect(creator.room.authority()?.epoch).toBe(7);
	expect(await outcome(f.install(bob))).toBe("ok");
	expect(await outcome(bob.room.issue(message("bob-2")))).toBe("ok");
}, 600_000);
