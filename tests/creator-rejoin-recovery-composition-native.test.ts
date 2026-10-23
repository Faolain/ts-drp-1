import {afterEach, describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {decodeCanonical, hashDomain} from "@ts-drp/canonical";
import {createNodeV3RoomStorageHost} from "../packages/storage-node/src/v3-room-host.js";
import {createShippingChatWindowGenesisStateBytes} from "../examples/chat/src/v3-chat-window.js";
import {chatSharesRoomFixture, closeChatSharesRooms} from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));
const message = (clientOperationId: string) => ({action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId});
const fixture = () => chatSharesRoomFixture({members: ["genesis"], format: "window",
	genesisStateBytes: createShippingChatWindowGenesisStateBytes});

describe("native recovery across ordinary and checkpoint histories", () => {
	it.each([{targets: [1, 3, 5, 7]}, {targets: [2, 3, 5, 7]}, {targets: [1, 2, 4, 5, 7, 9]},
		{targets: [1, 2, 3, 4, 5]}])("preserves install history $targets", async ({targets}) => {
		const f = await fixture(), creator = await f.open(0);
		let member = await f.open(1), epoch = 0;
		for (const target of targets) {
			await member.room.issue(message(`pending-${epoch}`));
			while (epoch < target) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); epoch++;}
			await f.install(member);
			await member.room.issue(message(`after-${epoch}`));
			const pending = await member.room.unresolvedAcceptedWork();
			await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
			expect(member.room.authority()?.epoch).toBe(epoch);
			expect(await member.room.unresolvedAcceptedWork()).toEqual(pending);
		}
	}, 180_000);

	it.each(["native", "signed", "foreign"] as const)("checks %s retirement identity on ordinary cold reopen before a checkpoint jump", async identity => {
		const f = await fixture(), creator = await f.open(0); let member = await f.open(1);
		for (let epoch = 1; epoch <= 5; epoch++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); await f.install(member);
		}
		const head = await f.readHead(1), cut = head.candidates.find(row =>
			Reflect.get(decodeCanonical(row.bytes) as object, "kind") === "drp-hard-epoch-cut");
		if (cut === undefined) throw Error("fixture cut unavailable");
		const signedDigest = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)).toString("hex");
		await member.room.issue(message("legacy-identity-pending"));
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		// Stop after original turnover has durably recorded absence, before a new
		// received intent exists. The old signed certificate names this same head.
		const issuanceKey = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
		const issuance = new DatabaseSync(join(f.directory, `${issuanceKey}.sqlite.drp-issuance-v1.sqlite`));
		issuance.exec("CREATE TRIGGER interrupt_received BEFORE UPDATE ON settlement_plans BEGIN SELECT RAISE(ABORT, 'legacy receipt checkpoint'); END");
		try {await expect(f.install(member)).rejects.toThrow();}
		finally {issuance.exec("DROP TRIGGER interrupt_received"); issuance.close();}
		expect((await f.readHead(1)).head).toEqual(head.head);
		await f.stop(member);
		const foreignCut = (await f.readHead(0)).candidates.find(row =>
			Reflect.get(decodeCanonical(row.bytes) as object, "kind") === "drp-hard-epoch-cut");
		if (foreignCut === undefined) throw Error("fixture foreign signed cut unavailable");
		const foreignDigest = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", foreignCut.bytes)).toString("hex");
		expect(foreignDigest).not.toBe(signedDigest);
		const key = createHash("sha256").update(JSON.stringify(["snapshots", "peer-1"])).digest("hex");
		const snapshotPath = join(f.directory, `${key}.sqlite.drp-snapshot-quarantine-v1.sqlite`);
		const db = new DatabaseSync(snapshotPath);
		let scopesBefore: unknown;
		try {
			db.function("snapshot_writer_v4", {varargs: true}, () => 1);
			const row = db.prepare("SELECT descriptors FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=4").get(f.objectId);
			if (row === undefined) throw Error("fixture current snapshot unavailable");
			const descriptor = JSON.parse(String(row.descriptors)) as Record<string, unknown>;
			const retirement = descriptor.retirement as Record<string, unknown> | undefined;
			if (retirement === undefined) throw Error("fixture current retirement unavailable");
			const replacement = JSON.stringify({...descriptor, retirement: {...retirement, certificateDigest:
				identity === "native" ? retirement.certificateDigest : identity === "signed" ? signedDigest : foreignDigest}});
			expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(String(row.descriptors)));
			db.prepare("UPDATE snapshot_scopes_v2 SET descriptors=? WHERE object_id=? AND epoch=4").run(replacement, f.objectId);
			scopesBefore = db.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch").all(f.objectId);
		} finally {db.close();}
		if (identity === "foreign") {
			const pendingBefore = await f.issuedAfter(1, null);
			await expect(f.open(1, {reopen: true, promote: true})).rejects.toThrow();
			await expect(member.room.issue(message("foreign-receipt-must-not-resume"))).rejects.toThrow();
			expect((await f.readHead(1)).head).toEqual(head.head);
			expect(await f.issuedAfter(1, null)).toEqual(pendingBefore);
			const unchanged = new DatabaseSync(snapshotPath, {readOnly: true});
			try {expect(unchanged.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch").all(f.objectId)).toEqual(scopesBefore);}
			finally {unchanged.close();}
			return;
		}
		member = await f.open(1, {reopen: true, promote: true});
		expect(member.room.authority()?.epoch).toBe(5);
		await f.install(member); expect(member.room.authority()?.epoch).toBe(7);
		await member.room.issue(message("fresh-after-legacy-retirement"));
	}, 120_000);

	it("preserves proven completion and unknown omission across Writer revocation and same-key readmission", async () => {
		const role = "genesis-admin";
		const f = await chatSharesRoomFixture({members: [role], format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes});
		const creator = await f.open(0); let member = await f.open(1);
		await member.room.issue(message("committed-before-revocation"));
		const committed = (await f.issuedAfter(1, null)).at(-1)!;
		expect(await creator.receive(await f.issuedAfter(1, null), 1, 10_000)).toBe(true);
		await member.room.issue(message("omitted-before-revocation"));
		await creator.room.issue({action: "acl", kind: "revoke", group: "writer", target: f.identities[1]!.author});
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		const unknown = await member.room.unresolvedAcceptedWork();
		expect(unknown).toMatchObject([{commitment: "unknown", operations: [message("omitted-before-revocation")]}]);
		expect(unknown).toHaveLength(1);
		const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
		try {const plan = await store.readSettlementPlan({objectId: f.objectId, author: f.identities[1]!.author});
			expect(plan?.entries.find(entry => entry.sourceSequence === committed.commit.authorSequence)?.sourceContextDigest).toBeUndefined();
			expect(plan?.entries.some(entry => entry.sourceSequence === committed.commit.authorSequence)).toBe(false);}
		finally {await store.close();}
		await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unknown);
		await expect(member.room.issue(message("revoked-cannot-write"))).rejects.toThrow();
		await creator.room.issue({action: "acl", kind: "grant", group: "writer", target: f.identities[1]!.author});
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		await member.room.issue(message("fresh-after-completion-readmission"));
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unknown);
		const later = await f.issuedAfter(1, committed.commit.authorSequence);
		for (const row of later) expect(JSON.stringify(decodeCanonical(row.commit.envelope.canonicalPreimageBytes))).not.toContain("committed-before-revocation");
	}, 120_000);

	it("reopens an observer with no local settlement plan after a checkpoint gap", async () => {
		const f = await chatSharesRoomFixture({members: ["late"], format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes});
		const creator = await f.open(0); let member = await f.open(1, {receiveOnly: true});
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		await f.install(member); await f.stop(member); member = await f.open(1, {reopen: true, receiveOnly: true});
		expect(member.room.authority()?.epoch).toBe(2);
		expect(await f.issuedAfter(1, null)).toEqual([]);
		await expect(member.room.issue(message("observer-cannot-write"))).rejects.toThrow();
	}, 120_000);

	it.each(["source-custody", "candidate-stage"] as const)("recovers an interruption at %s without reusing an obsolete source commitment", async phase => {
		const f = await fixture(), creator = await f.open(0); let member = await f.open(1);
		await member.room.issue(message("accepted-before-intent"));
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		const family = phase === "source-custody" ? "issuance" : "ahe", name = family === "issuance" ? "peer-1" : "peer-1--ahe";
		const key = createHash("sha256").update(JSON.stringify([family, name])).digest("hex");
		const db = new DatabaseSync(join(f.directory, `${key}.sqlite${family === "issuance" ? ".drp-issuance-v1.sqlite" : ""}`));
		db.exec(phase === "source-custody"
			? "CREATE TRIGGER interrupt_received BEFORE UPDATE ON settlement_plans BEGIN SELECT RAISE(ABORT, 'interrupted source custody'); END"
			: "CREATE TRIGGER interrupt_received BEFORE INSERT ON generations BEGIN SELECT RAISE(ABORT, 'interrupted candidate stage'); END");
		try {await expect(f.install(member)).rejects.toThrow();}
		finally {db.exec("DROP TRIGGER interrupt_received"); db.close();}
		if (phase === "candidate-stage") {
			await expect(member.room.issue(message("old-source-after-intent"))).rejects.toThrow();
			for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
			await expect(f.install(member)).rejects.toThrow();
		}
		const snapshots = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openSnapshots("peer-1");
		try {
			const inventory = await snapshots.captureRecoveryRoleInventory!({objectId: f.objectId});
			const receipts = await Promise.all(inventory.scopes.map(({scope}) => snapshots.lookupReceivedRecoveryCertificate(
				{objectId: scope.objectId, epoch: scope.epoch, anchor: scope.anchor})));
			expect(receipts.filter(Boolean)).toHaveLength(phase === "source-custody" ? 0 : 1);
		} finally {await snapshots.close();}
		await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
		if (phase === "candidate-stage") expect(member.room.authority()?.epoch).toBe(2);
		await member.room.issue(message("accepted-after-reopen"));
		if (phase === "source-custody") await f.install(member);
		expect(member.room.authority()?.epoch).toBe(2);
		const unresolved = await member.room.unresolvedAcceptedWork();
		expect(unresolved.flatMap(row => row.operations).map(operation => Reflect.get(operation as object, "clientOperationId")))
			.toEqual(phase === "source-custody" ? ["accepted-before-intent", "accepted-after-reopen"] : ["accepted-before-intent"]);
		await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
		expect(member.room.authority()?.epoch).toBe(2);
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unresolved);
		await member.room.issue(message("fresh-after-second-reopen"));
	}, 120_000);
});
