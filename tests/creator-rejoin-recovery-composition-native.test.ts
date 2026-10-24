import {afterEach, describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {LIVE_JOURNAL_RETIREMENT_LIMITS} from "@ts-drp/live-journal";
import {V3Envelope, type Message} from "@ts-drp/types";
import {createNodeV3RoomStorageHost} from "../packages/storage-node/src/v3-room-host.js";
import {createShippingChatWindowGenesisStateBytes} from "../examples/chat/src/v3-chat-window.js";
import {chatSharesRoomFixture, closeChatSharesRooms} from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));
type MutableCompletionContext = {digest: Uint8Array; exactCanonicalContextBytes: Uint8Array};
type MutableCompletionEntry = {disposition: string; sourceDigest: Uint8Array; sourceResolutionDigest?: Uint8Array};
type MutableCompletionPlan = {entries: MutableCompletionEntry[]; sourceContexts: MutableCompletionContext[]};
type MutableCompletionProof = {exactCanonicalCutValueBytes: Uint8Array; exactCanonicalCommitQcBytes: Uint8Array;
	exactCanonicalSuccessorTrustStateRecordBytes: Uint8Array; exactCanonicalMembershipSubsetBytes: Uint8Array};
type MutableSubsetMember = {leafIndex: number; treeSize: number; auditPath: Uint8Array; vertexDigest: Uint8Array};
type MutableCompletionSubset = {cutValueDigest: string; members: MutableSubsetMember[]};

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

	it.each(["genesis", "genesis-admin"] as const)("preserves proven completion and unknown omission across %s revocation and same-key readmission", async role => {
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
			const completed = plan?.entries.find(entry => entry.sourceSequence === committed.commit.authorSequence);
			expect(completed).toMatchObject({disposition: "committed", replacementSequence: null});
			expect(completed?.sourceContextDigest).toHaveLength(32);
			expect(completed?.sourceResolutionDigest).toHaveLength(32);
			expect(plan?.sourceContexts).toHaveLength(2);}
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

	it.each([false, true])("releases completion after its final consumer while retaining a shared unknown source: %s", async sharedUnknown => {
		const f = await fixture(), creator = await f.open(0); let member = await f.open(1);
		for (let epoch = 1; epoch <= 2; epoch++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); await f.install(member);
		}
		Reflect.set(member.networkNode, "publishMessage", async (_topic: string, wire: Message) =>
			!JSON.stringify(decodeCanonical(V3Envelope.decode(wire.data).canonicalPreimage)).includes("committed-only-at-two"));
		await expect(member.room.issue(message("committed-only-at-two"))).rejects.toThrow("publication failed");
		const committed = (await f.issuedAfter(1, null)).at(-1)!;
		expect(await creator.receive(await f.issuedAfter(1, null), 1, 10_000)).toBe(true);
		if (sharedUnknown) await member.room.issue(message("unknown-shared-source-at-two")).catch(error =>
			expect(String(error)).toContain("publication failed"));
		const expectedUnknown = sharedUnknown ? [{commitment: "unknown", operations: [message("unknown-shared-source-at-two")]}] : [];
		await creator.room.issue({action: "acl", kind: "revoke", group: "writer", target: f.identities[1]!.author});
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); await f.install(member).catch(cause => {throw new Error("completion removal at 3", {cause});});
		expect(await member.room.unresolvedAcceptedWork()).toMatchObject(expectedUnknown);
		for (const target of [5, 7, 9, 11]) {
			for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
			await f.install(member).catch(cause => {throw new Error(`completion gap at ${target}: ${String(cause)}`, {cause});});
			expect(member.room.authority()?.epoch).toBe(target);
			expect(await member.room.unresolvedAcceptedWork()).toMatchObject(expectedUnknown);
		}
		const nativeHost = createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"});
		const journal = await nativeHost.openJournal("peer-1");
		try {
			const fullMembership = await journal.readClosedMembership!({scope: {objectId: f.objectId, epoch: 2,
				anchorDigest: Reflect.get(decodeCanonical(committed.commit.envelope.canonicalPreimageBytes) as object, "anchor")},
				maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes});
			if (!sharedUnknown) expect(fullMembership).toEqual({ok: true, kind: "missing"});
			const image = await journal.readRetirementImage!({objectId: f.objectId});
			if (!image.ok) throw new Error("fixture journal image unavailable");
			const sourceRows = image.value.canonicalRows.map(bytes => decodeCanonical(bytes) as [string, [string, number]])
				.filter(frame => frame[0] === "accepted_entries" && frame[1][1] === 2);
			expect(sourceRows.length > 0).toBe(sharedUnknown);
		}
		finally {await journal.close();}
		const beforeStore = await nativeHost.openIssuance("peer-1");
		let sourceContext: Uint8Array, completionContext: Uint8Array;
		try {const plan = await beforeStore.readSettlementPlan({objectId: f.objectId, author: f.identities[1]!.author});
			const entry = plan!.entries.find(value => value.sourceSequence === committed.commit.authorSequence)!;
			sourceContext = entry.sourceContextDigest!; completionContext = entry.sourceResolutionDigest!;}
		finally {await beforeStore.close();}
		const retained = async () => (await f.issuedAfter(1, null)).find(row => row.commit.authorSequence === committed.commit.authorSequence)!;
		expect((await retained()).publishState).toBe("pending");
		await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
		expect(member.room.authority()?.epoch).toBe(11);
		expect(await member.room.unresolvedAcceptedWork()).toMatchObject(expectedUnknown);
		await expect(member.room.issue(message("removed-committed-only-cannot-write"))).rejects.toThrow();
		const exactSource = (wire: Message) => {
			const envelope = V3Envelope.decode(wire.data);
			return Buffer.from(envelope.canonicalPreimage).equals(Buffer.from(committed.commit.envelope.canonicalPreimageBytes)) &&
				Buffer.from(envelope.signature).equals(Buffer.from(committed.commit.envelope.signature));
		};
		let targeted = false;
		Reflect.set(member.networkNode, "getAllPeers", () => ["connected-history-peer"]);
		Reflect.set(member.networkNode, "sendMessage", async (_peer: string, wire: Message) => {targeted ||= exactSource(wire);});
		await member.republish("connected-history-peer");
		expect(targeted).toBe(true); expect((await retained()).publishState).toBe("pending");
		let failed = false;
		Reflect.set(member.networkNode, "publishMessage", async (_topic: string, wire: Message) => {
			if (!exactSource(wire)) return true; failed = true; return false;
		});
		await expect(member.republish()).rejects.toThrow("publication failed");
		expect(failed).toBe(true); expect((await retained()).publishState).toBe("pending");
		let release!: (success: boolean) => void, entered!: () => void;
		const heldSend = new Promise<boolean>(resolve => {release = resolve;});
		const sending = new Promise<void>(resolve => {entered = resolve;});
		Reflect.set(member.networkNode, "publishMessage", async (_topic: string, wire: Message) => {
			if (!exactSource(wire)) return true; entered(); return heldSend;
		});
		const replay = member.republish(); await sending;
		let closeJoined = false;
		const closing = f.stop(member).then(() => {closeJoined = true;});
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(closeJoined).toBe(false);
		release(true); await Promise.all([replay, closing]);
		expect((await retained()).publishState).toBe("pending");
		member = await f.open(1, {reopen: true, promote: true});
		let sent = false;
		Reflect.set(member.networkNode, "publishMessage", async (_topic: string, wire: Message) => {sent ||= exactSource(wire); return true;});
		await member.republish();
		expect(sent).toBe(true); expect((await retained()).publishState).toBe("published");
		await creator.room.issue({action: "acl", kind: "grant", group: "writer", target: f.identities[1]!.author});
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); await f.install(member);
		await member.room.issue(message("fresh-after-long-completed-removal"));
		expect(await member.room.unresolvedAcceptedWork()).toMatchObject(expectedUnknown);
		expect(await creator.receive(await f.issuedAfter(1, null), 1, 10_000)).toBe(true);
		for (const epoch of [13, 14]) {
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); await f.install(member).catch(cause => {throw new Error(`post-ACK retirement at ${epoch}`, {cause});});
			expect(member.room.authority()?.epoch).toBe(epoch);
			if (epoch === 13) {
				// Original metadata has retired the completed source, but a prefix
				// consumer still holds its native pair. New FENCE/plan progress must
				// not invalidate durable proof custody across a cold reopen.
				await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
				expect(member.room.authority()?.epoch).toBe(epoch);
				expect(await member.room.unresolvedAcceptedWork()).toMatchObject(expectedUnknown);
			}
		}
		const heldHead = (await f.readHead(1)).head;
		const floorScope = {objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest};
		const heldFloor = await member.floor.read({scope: floorScope});
		await member.room.maintainRecoveryPool();
		expect((await f.readHead(1)).head).toEqual(heldHead);
		expect(await member.floor.read({scope: floorScope})).toEqual(heldFloor);
		const later = await f.issuedAfter(1, null);
		for (const row of later.filter(row => row.commit.authorSequence !== committed.commit.authorSequence))
			expect(JSON.stringify(decodeCanonical(row.commit.envelope.canonicalPreimageBytes))).not.toContain("committed-only-at-two");
		const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
		try {
			const plan = await store.readSettlementPlan({objectId: f.objectId, author: f.identities[1]!.author});

			expect(later.some(row => row.commit.authorSequence === committed.commit.authorSequence)).toBe(sharedUnknown);
			expect(plan?.entries.some(entry => entry.sourceSequence === committed.commit.authorSequence) ?? false).toBe(sharedUnknown);
			for (const digest of [sourceContext, completionContext]) expect(plan?.sourceContexts?.some(context =>
				Buffer.from(context.digest).equals(Buffer.from(digest))) ?? false).toBe(sharedUnknown);
		} finally {await store.close();}
	}, 180_000);

	it("rejects native completion forgery without granting Writer or losing accepted custody", async () => {
		const prepare = async () => {
			const f = await fixture(), creator = await f.open(0), member = await f.open(1);
			await member.room.issue(message("first-proven-source"));
			await member.room.issue(message("second-proven-source"));
			expect(await creator.receive(await f.issuedAfter(1, null), 1, 10_000)).toBe(true);
			await creator.room.issue({action: "acl", kind: "revoke", group: "writer", target: f.identities[1]!.author});
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); await f.install(member);
			await f.stop(member);
			const key = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
			return {f, member, path: join(f.directory, `${key}.sqlite.drp-issuance-v1.sqlite`)};
		};
		const {f, member, path} = await prepare(), foreign = await prepare();
		const original = new DatabaseSync(path), other = new DatabaseSync(foreign.path, {readOnly: true});
		original.function("issuance_retirement_connection", {varargs: true}, () => 1);
		const raw = original.prepare("SELECT entries_json FROM settlement_plans WHERE object_id=?").get(f.objectId)!;
		const wrapper = JSON.parse(String(raw.entries_json)) as {kind: string; bytes: string};
		const foreignWrapper = JSON.parse(String(other.prepare("SELECT entries_json FROM settlement_plans WHERE object_id=?").get(foreign.f.objectId)!.entries_json));
		const foreignPlan = decodeCanonical(Buffer.from(foreignWrapper.bytes, "base64")) as MutableCompletionPlan;
		const foreignContext = foreignPlan.sourceContexts.find((context: MutableCompletionContext) =>
			Reflect.get(decodeCanonical(context.exactCanonicalContextBytes) as object, "kind") === "creator-settlement-source-completion-1")!;
		other.close();
		const head = (await f.readHead(1)).head, issued = await f.issuedAfter(1, null);
		const floor = new DatabaseSync(join(f.directory, "peer-1-external-floor.sqlite"), {readOnly: true});
		const floorBefore = floor.prepare("SELECT * FROM room_head").all();
		const nativeRows = () => ["lineages", "issued_records", "issuance_outbox", "settlement_plans"].map(table =>
			original.prepare(`SELECT * FROM ${table}`).all());
		try {
			for (const mutation of ["unreferenced-extra", "index", "tree-size", "audit-path", "root", "signature", "missing-source", "foreign-proof"]) {
				const plan = decodeCanonical(Buffer.from(wrapper.bytes, "base64")) as MutableCompletionPlan;
				const context = plan.sourceContexts.find((value: MutableCompletionContext) => Reflect.get(decodeCanonical(value.exactCanonicalContextBytes) as object, "kind") ===
					"creator-settlement-source-completion-1")!;
				const beforeDigest = new Uint8Array(context.digest);
				const proof = decodeCanonical(context.exactCanonicalContextBytes) as MutableCompletionProof;
				const subset = decodeCanonical(proof.exactCanonicalMembershipSubsetBytes) as MutableCompletionSubset;
				if (mutation === "unreferenced-extra") {
					const referenced = new Set(plan.entries.filter((entry: MutableCompletionEntry) => entry.disposition === "committed")
						.map((entry: MutableCompletionEntry) => Buffer.from(entry.sourceDigest).toString("hex")));
					const unused = subset.members.findIndex((member: MutableSubsetMember) => !referenced.has(Buffer.from(member.vertexDigest).toString("hex")));
					expect(unused).toBeGreaterThanOrEqual(0); subset.members.splice(unused, 1);
				}
				if (mutation === "index") subset.members[0].leafIndex++;
				if (mutation === "tree-size") subset.members[0].treeSize++;
				if (mutation === "audit-path") subset.members[0].auditPath[0] ^= 1;
				if (mutation === "missing-source") {
					const referenced = plan.entries.find((entry: MutableCompletionEntry) => entry.disposition === "committed")!.sourceDigest;
					subset.members = subset.members.filter((member: MutableSubsetMember) => !Buffer.from(member.vertexDigest).equals(Buffer.from(referenced)));
				}
				if (mutation === "root") {
					const cut = decodeCanonical(proof.exactCanonicalCutValueBytes) as Record<string, unknown>;
					cut.closeSetRoot = "ff".repeat(32); proof.exactCanonicalCutValueBytes = encodeCanonical(cut);
					subset.cutValueDigest = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", proof.exactCanonicalCutValueBytes)).toString("hex");
				}
				if (mutation === "signature") {
					const qc = decodeCanonical(proof.exactCanonicalCommitQcBytes) as {votes: {signature: string}[]};
					qc.votes[0].signature = "00".repeat(64); proof.exactCanonicalCommitQcBytes = encodeCanonical(qc);
				}
				proof.exactCanonicalMembershipSubsetBytes = encodeCanonical(subset);
				context.exactCanonicalContextBytes = mutation === "foreign-proof" ? foreignContext.exactCanonicalContextBytes : encodeCanonical(proof);
				context.digest = hashDomain("ts-drp/settlement-source-context/v1", context.exactCanonicalContextBytes);
				plan.sourceContexts.sort((a,b) => Buffer.compare(a.digest, b.digest));
				for (const entry of plan.entries) if (entry.sourceResolutionDigest !== undefined &&
					Buffer.from(entry.sourceResolutionDigest).equals(Buffer.from(beforeDigest))) entry.sourceResolutionDigest = context.digest;
				original.prepare("UPDATE settlement_plans SET entries_json=? WHERE object_id=?").run(JSON.stringify({...wrapper,
					bytes: Buffer.from(encodeCanonical(plan)).toString("base64")}), f.objectId);
				const expected = nativeRows();
				const opened = await f.open(1, {reopen: true, promote: true}).then(value => ({value}), error => ({error}));
				if (mutation === "unreferenced-extra") {
					expect("value" in opened).toBe(true);
					if (!("value" in opened)) throw opened.error;
					expect(await opened.value.room.unresolvedAcceptedWork()).toEqual([]);
					await expect(opened.value.room.issue(message("valid-completion-cannot-grant-writer"))).rejects.toThrow();
					await f.stop(opened.value);
				} else if ("value" in opened) {
					await expect(opened.value.room.unresolvedAcceptedWork(), mutation).rejects.toThrow();
					await expect(opened.value.room.issue(message("forged-completion-fallback-cannot-write")), mutation).rejects.toThrow();
					let sent = false;
					Reflect.set(opened.value.networkNode, "publishMessage", async () => {sent = true; return true;});
					await expect(opened.value.republish(), mutation).rejects.toThrow();
					expect(sent, mutation).toBe(false);
					await f.stop(opened.value);
				}
				await expect(member.room.issue(message("forged-completion-must-not-grant-writer")), mutation).rejects.toThrow();
				expect((await f.readHead(1)).head, mutation).toEqual(head);
				expect(await f.issuedAfter(1, null), mutation).toEqual(issued);
				expect(nativeRows(), mutation).toEqual(expected);
				expect(floor.prepare("SELECT * FROM room_head").all(), mutation).toEqual(floorBefore);
			}
		} finally {original.close(); floor.close();}
	}, 180_000);

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
