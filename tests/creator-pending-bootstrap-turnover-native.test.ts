/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native fixtures preserve inferred owner types. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, expect, it } from "vitest";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";
import { creatorDeliveryRoom, eventually } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, directories, heads, rooms, required } from "./fixtures/track-m/room-retention-fixture.js";
import { linkSuccessorProtocol } from "./fixtures/track-x/successor-link.js";

afterEach(async () => expect(await closeFixtures()).toEqual([]));

async function pendingBootstrapRoom() {
	const fixture = await creatorDeliveryRoom({ profile: "shipped" });
	const creator = await fixture.open(0);
	await creator.room.issue({ action: "placeBlock", id: "retained", kind: "stone", x: 0, y: 0 });
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	// The recipient starts after the creator closed genesis; its exact locally
	// accepted bootstrap remains pending while snapshots advance its authority.
	const recipient = await fixture.open(1);
	linkSuccessorProtocol(creator, recipient, { joinHandlersOnClose: true });
	const directory = required([...directories].at(-1));
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const readBootstrap = async () => {
		const store = await host.openIssuance(recipient.name);
		try { return required((await store.readOutboxPage({
			scope: { objectId: fixture.objectId, author: required(fixture.identities[1]).author }, limit: 1,
		}))[0]); }
		finally { await store.close(); }
	};
	const original = await readBootstrap();
	expect(original).toMatchObject({ publishState: "pending", commit: { authorSequence: 0 } });
	const adopt = async (epoch: number) => {
		const offer = await creator.room.exportCreatorSuccessor();
		await creator.room.adoptCreatorSuccessor();
		await recipient.room.installCreatorSuccessor({ offer, peers: [creator.peerId] });
		expect(recipient.room.authority()?.epoch).toBe(epoch);
		expect(recipient.room.projection()).toEqual(creator.room.projection());
	};
	await adopt(1);
	const closeNext = async (epoch: number) => {
		await creator.room.issue({ action: "placeBlock", id: "retained", kind: "stone", x: 0, y: epoch });
		expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	};
	return { fixture, creator, recipient, directory, host, original, readBootstrap, adopt, closeNext };
}

it("retains and authenticates an unpublished pinned bootstrap after old snapshots retire", async () => {
	const f = await pendingBootstrapRoom();
	for (let epoch = 2; epoch <= 8; epoch++) {
		await f.closeNext(epoch);
		await f.adopt(epoch);
		await f.creator.room.maintainRecoveryPool();
		const retained = await f.readBootstrap();
		expect(retained.publishState).toBe("pending");
		expect(retained.commit).toEqual(f.original.commit);
	}
	const snapshots = await f.host.openSnapshots(f.recipient.name);
	try {
		const inventory = required(await snapshots.captureRecoveryRoleInventory?.({ objectId: f.fixture.objectId }));
		expect(inventory.scopes.length).toBeGreaterThan(0);
		expect(inventory.scopes.every(row => row.scope.epoch > 0)).toBe(true);
	} finally { await snapshots.close(); }
	await f.recipient.room.close(); rooms.delete(f.recipient.room);
	await f.recipient.floor.close(); heads.delete(f.recipient.floor);
	const reopened = await f.fixture.open(1, { reopen: true });
	linkSuccessorProtocol(f.creator, reopened, { joinHandlersOnClose: true });
	expect(reopened.room.authority()?.epoch).toBe(8);
	expect((await f.readBootstrap()).commit).toEqual(f.original.commit);
	await expect(f.recipient.room.issue({ action: "placeBlock", id: "stale", kind: "gold", x: 1, y: 8 })).rejects.toThrow();
	await reopened.room.issue({ action: "placeBlock", id: "recipient-current", kind: "gold", x: 1, y: 8 });
	expect(await eventually(() => f.creator.room.projection().blocks.some(block => block.id === "recipient-current"), 10_000)).toBe(true);
}, 120_000);

it.each(["operation", "object", "author", "genesis", "signature"] as const)(
	"refuses a pending bootstrap %s substitution before successor publication", async change => {
		const f = await pendingBootstrapRoom();
		for (let epoch = 2; epoch <= 3; epoch++) { await f.closeNext(epoch); await f.adopt(epoch); }
		await f.closeNext(4);
		const offer = await f.creator.room.exportCreatorSuccessor();
		await f.creator.room.adoptCreatorSuccessor();
		const preimage = decodeCanonical(f.original.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;
		const substituted = { ...preimage,
			...(change === "operation" ? { operation: { action: "placeBlock", id: "arbitrary-pending", kind: "gold", x: 1, y: 1 } } : {}),
			...(change === "object" ? { objectId: `${f.fixture.objectId}-alien` } : {}),
			...(change === "author" ? { author: required(f.fixture.identities[0]).author } : {}),
			...(change === "genesis" ? { anchor: "00".repeat(32), dependencies: ["00".repeat(32)] } : {}),
		};
		const bytes = encodeCanonical(substituted), digest = hashDomain("ts-drp/vertex/v3", bytes);
		const signature = ed25519.sign(digest, required(f.fixture.identities[change === "author" ? 0 : 1]).seed);
		if (change === "signature") signature[0] = signature[0]! ^ 1;
		const address = createHash("sha256").update(JSON.stringify(["issuance", f.recipient.name])).digest("hex");
		const database = new DatabaseSync(join(f.directory, `${address}.sqlite.drp-issuance-v1.sqlite`));
		try {
			// Adversarial native-byte fixture, matching the storage conformance
			// corruption controls. No protocol/adoption capability is supplied.
			database.function("issuance_retirement_connection", { varargs: true }, () => 1);
			database.function("issuance_retirement_record", { varargs: true }, () => 1);
			database.exec("BEGIN IMMEDIATE");
			database.prepare("UPDATE issued_records SET canonical_preimage=?,digest=?,signature=? WHERE author_sequence=0")
				.run(bytes, digest, signature);
			database.prepare("UPDATE issuance_outbox SET digest=? WHERE author_sequence=0").run(digest);
			database.exec("COMMIT");
		} finally { database.close(); }
		await expect(f.recipient.room.installCreatorSuccessor({ offer, peers: [f.creator.peerId] })).rejects.toThrow();
		expect(await f.recipient.floor.read({ scope: { objectId: f.fixture.objectId,
		pinnedGenesisAnchorDigest: f.fixture.invite.pinnedGenesisAnchorDigest } }))
		.toMatchObject({ ok: true, state: { stable: { epoch: 3 }, pending: null } });
	}, 120_000
);
