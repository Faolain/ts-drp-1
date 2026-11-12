import { afterEach, describe, expect, it } from "vitest";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {AHE_BOUNDED_READ_LIMITS, parseStorageObjectId, decodeGenerationRecordV1, encodeGenerationRecordV1, decodeHeadRecordV1, encodeHeadRecordV1} from "@ts-drp/storage";
import {createNodeV3RoomStorageHost} from "../packages/storage-node/src/v3-room-host.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = () => chatSharesRoomFixture({ members: ["genesis"], format: "window",
	genesisStateBytes: createShippingChatWindowGenesisStateBytes });

/**
 * The member's durable settlement plan (read after unresolvedAcceptedWork(), which awaits the drain).
 * @param f - The room fixture.
 * @returns peer-1's plan.
 */
async function memberPlan(f: Awaited<ReturnType<typeof fixture>>) {
	const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
	try {return await store.readSettlementPlan({objectId: f.objectId, author: required(f.identities[1]).author});}
	finally {await store.close();}
}

/**
 * A move retained by a skip install (or a recovery that completes one) that the creator's signed frontier
 * in the installed checkpoint proves was never admitted (v3-live frontierRetainedResolution): its epoch is
 * closed, the frontier's terminalThrough stops below it (null here: the creator received none of this
 * author's rows), and the author's own epoch-0 fence precedes it, so it is in no closed Cut and ingress,
 * which admits only the current anchor, can never admit it. It is no longer unknown: its row is resolved
 * with a signed expiry (sourceResolutionKind "frontier") and its move is handed back to the application
 * exactly once, in a durable record that stays until the move is reissued.
 * @param f - The room fixture.
 * @returns The unconsumed hand-backs (clientOperationId and source epoch) and the frontier-resolved entries.
 */
async function frontierHandBacks(f: Awaited<ReturnType<typeof fixture>>) {
	const plan = await memberPlan(f);
	return {
		handBacks: (plan?.handBacks ?? []).filter(record => record.reissueSequence === null).map(record => ({
			sourceSequence: record.sourceSequence, sourceEpoch: record.sourceEpoch,
			clientOperationId: (decodeCanonical(record.exactCanonicalOperationBytes) as Record<string, unknown>).clientOperationId})),
		resolved: (plan?.entries ?? []).filter(entry => entry.sourceResolutionKind === "frontier").map(entry => ({
			sourceSequence: entry.sourceSequence, disposition: entry.disposition, signed: entry.sourceResolutionDigest?.byteLength})),
	};
}

async function retainedPointRoles(f: Awaited<ReturnType<typeof fixture>>, index: number) {
	const host = createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"});
	const ahe = await host.openAhe(`peer-${index}--ahe`), snapshots = await host.openSnapshots(`peer-${index}`);
	const objectId = parseStorageObjectId(f.objectId); if (!objectId.ok) throw Error("invalid fixture object");
	try {
		const acquired = await ahe.acquireBoundedRecoveryRoleRead({objectId: objectId.value, limits: AHE_BOUNDED_READ_LIMITS});
		if (!acquired.ok) throw Error(`native role census: ${acquired.kind}`);
		try {
			const read = acquired.value, roles: number[] = [], bases: string[] = [];
			let head = read.head;
			while (head.kind === "present" && roles.length < 3) {
				const generation = required(read.generations.find(row => head.kind === "present" && row.generationId === head.generationId));
				const records = generation.closure.map(ref => decodeCanonical(required(read.blobs.find(blob => blob.ref.digest === ref.digest)).bytes) as Record<string, unknown>);
				const projection = records.find(row => row.kind === "v3-live-generation-1" || row.kind === "v3-live-generation-2");
				if (projection === undefined) break;
				roles.push(Number(projection.epoch)); bases.push(generation.baseExpectedHead.kind); head = generation.baseExpectedHead;
			}
			const inventory = await snapshots.captureRecoveryRoleInventory!({objectId: f.objectId});
			const normalizedPoints = read.generations.filter(row => row.baseExpectedHead.kind === "none" && row.closure.some(ref => {
				const decoded = decodeCanonical(required(read.blobs.find(blob => blob.ref.digest === ref.digest)).bytes) as Record<string, unknown>;
				return decoded.kind === "v3-live-generation-2";
			})).length;
			const headers = read.generations.map(row => ({generationId: row.generationId, closureDigest: row.closureDigest, state: row.state,
				baseExpectedHead: row.baseExpectedHead, projectionEpoch: row.closure.map(ref =>
					decodeCanonical(required(read.blobs.find(blob => blob.ref.digest === ref.digest)).bytes) as Record<string, unknown>)
					.find(value => value.kind === "v3-live-generation-1" || value.kind === "v3-live-generation-2")?.epoch}));
			return {roles, bases, normalizedPoints, head: read.head, headers, generations: read.generations.length, snapshots: inventory.scopes.map(row => row.scope.epoch), owner: inventory.owner};
		} finally {await acquired.value.release();}
	} finally {await snapshots.close(); await ahe.close();}
}

describe("native same-replica creator recovery", () => {
	it("attaches custody without rewriting existing settlement disposition or progress", async () => {
		const f = await fixture(), creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message("already-pending"));
		const original = required((await f.issuedAfter(1, null)).at(-1));
		const scope = {objectId: f.objectId, author: required(f.identities[1]).author};
		const store = await createNodeV3RoomStorageHost({directory: f.directory, initialization: () => "reopen"}).openIssuance("peer-1");
		const progress = {version: 1 as const, intentCount: 1, intentDigest: hashDomain("ts-drp/settlement-replacement-intents/v1",
			encodeCanonical([message("already-pending")])), chunks: []};
		try {
			const prior = await store.readSettlementPlan(scope);
			await store.transactWriteSettlementPlan({scope, expectedRevision: prior?.revision ?? null,
				plan: {scope, revision: prior === null ? 0 : prior.revision + 1, fenceSequence: prior?.fenceSequence ?? null,
					entries: [{sourceSequence: original.commit.authorSequence, sourceDigest: original.commit.envelope.digest,
						disposition: "rebase", replacementSequence: null, replacementProgress: progress}]}});
			await creator.room.issue({action: "acl", kind: "revoke", group: "writer", target: scope.author});
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
			await f.install(member);
			expect((await store.readSettlementPlan(scope))?.entries.find(entry => entry.sourceSequence === original.commit.authorSequence))
				.toMatchObject({disposition: "rebase", replacementProgress: progress,
					sourceContextDigest: expect.any(Uint8Array), replacementSequence: null});
			expect(await member.room.unresolvedAcceptedWork()).toMatchObject([{operations: [message("already-pending")], commitment: "unknown"}]);
		} finally {await store.close();}
	}, 120_000);

	it("preserves independently accepted source epochs through repeated checkpoint gaps", async () => {
		const f = await fixture(), creator = await f.open(0);
		let member = await f.open(1);
		let normalizedPoint = false;
		for (let sourceEpoch = 0; sourceEpoch < 16; sourceEpoch += 2) {
			await member.room.issue(message(`unknown-epoch-${sourceEpoch}`));
			for (let step = 0; step < 2; step++) {
				expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
			}
			try {await f.install(member);} catch (cause) {throw new Error(`checkpoint install at epoch ${sourceEpoch + 2} failed`, {cause});}
			// Every source epoch's move is kept: the frontier proves each never admitted, so each is handed
			// back (one durable record per source epoch) rather than left unknown.
			const unresolved = await member.room.unresolvedAcceptedWork();
			expect(unresolved).toEqual([]);
			const given = await frontierHandBacks(f);
			expect(given.handBacks.map(row => [row.sourceEpoch, row.clientOperationId])).toEqual(
				Array.from({length: sourceEpoch / 2 + 1}, (_, n) => [n * 2, `unknown-epoch-${n * 2}`]));
			expect(creator.room.projection().messages.map(row => row.clientOperationId)).not.toContain(`unknown-epoch-${sourceEpoch}`);
			await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
			expect(await member.room.unresolvedAcceptedWork()).toEqual(unresolved);
			expect((await frontierHandBacks(f)).handBacks).toEqual(given.handBacks);
			const census = await retainedPointRoles(f, 1), epoch = sourceEpoch + 2;
			expect(census.roles).toEqual(epoch === 2 ? [2, 0] : [epoch, epoch - 2, epoch - 4]);
			expect(census.generations).toBeLessThanOrEqual(AHE_BOUNDED_READ_LIMITS.maxObjectGenerations);
			expect(census.owner.recoveryScopes).toBeLessThanOrEqual(census.owner.limits.maxRecoveryScopes);
			expect(census.owner.recoveryContentBytes).toBeLessThanOrEqual(census.owner.limits.maxRecoveryContentBytes);
			for (const retained of census.roles.filter(value => value > 0)) expect(census.snapshots).toContain(retained - 1);
			normalizedPoint ||= census.normalizedPoints > 0;
		}
		expect(normalizedPoint).toBe(true);
		await member.room.issue(message("fresh-after-eight-gaps"));
	}, 240_000);

	it("rejects a plausible forged actual rollback edge while every point signature remains authentic", async () => {
		const f = await fixture(), creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message("forged-edge-custody"));
		let creatorEpoch = 0;
		for (const target of [2, 4, 8]) {
			while (creatorEpoch < target) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); creatorEpoch++;}
			await f.install(member);
		}
		expect((await retainedPointRoles(f, 1)).roles).toEqual([8, 4, 2]);
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		const beforeHead = (await f.readHead(1)).head;
		const floorScope = {objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest};
		const beforeFloor = await member.floor.read({scope: floorScope});
		const key = createHash("sha256").update(JSON.stringify(["ahe", "peer-1--ahe"])).digest("hex");
		const db = new DatabaseSync(join(f.directory, `${key}.sqlite`));
		let original: Uint8Array | undefined, selectedId: string | undefined;
		try {
			const rows = db.prepare("SELECT record FROM generations WHERE object_id=?").all(f.objectId).map(row => {
				const result = decodeGenerationRecordV1(row.record as Uint8Array); if (!result.ok) throw Error("invalid fixture generation"); return result.value;});
			if (beforeHead.kind !== "present") throw Error("missing fixture head");
			const current = required(rows.find(row => row.generationId === beforeHead.generationId));
			if (current.baseExpectedHead.kind !== "present") throw Error("missing current base");
			const first = required(rows.find(row => current.baseExpectedHead.kind === "present" && row.generationId === current.baseExpectedHead.generationId));
			if (first.baseExpectedHead.kind !== "present") throw Error("missing rollback base");
			const third = required(rows.find(row => ![current.generationId, first.generationId, first.baseExpectedHead.kind === "present" ? first.baseExpectedHead.generationId : ""].includes(row.generationId) && row.state === "Superseded"));
			original = encodeGenerationRecordV1(first); selectedId = first.generationId;
			const forged = {...first, baseExpectedHead: {...first.baseExpectedHead, generationId: third.generationId, closureDigest: third.closureDigest}};
			db.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?").run(encodeGenerationRecordV1(forged), f.objectId, first.generationId);
			const snapshotKey = createHash("sha256").update(JSON.stringify(["snapshots", "peer-1"])).digest("hex");
			const snapshotDb = new DatabaseSync(join(f.directory, `${snapshotKey}.sqlite.drp-snapshot-quarantine-v1.sqlite`), {readOnly: true});
			try {
				const before = snapshotDb.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch").all(f.objectId);
				await expect(f.install(member)).rejects.toThrow();
				expect((await f.readHead(1)).head).toEqual(beforeHead);
				expect(await member.floor.read({scope: floorScope})).toEqual(beforeFloor);
				const after = snapshotDb.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch").all(f.objectId);
				expect(after).toEqual(expect.arrayContaining(before));
			} finally {snapshotDb.close();}
		} finally {if (original !== undefined) db.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?").run(original, f.objectId, selectedId!); db.close();}
	}, 120_000);

	it("refuses a stale native head after genuine point verification before publication", async () => {
		let mutate = false, mutations = 0;
		const f = await chatSharesRoomFixture({members: ["genesis"], format: "window", genesisStateBytes: createShippingChatWindowGenesisStateBytes,
			beforeFloorWrite(peer, phase) {if (!mutate || peer !== 1 || phase !== "begin") return; mutate = false; mutations++;
				const key = createHash("sha256").update(JSON.stringify(["ahe", "peer-1--ahe"])).digest("hex");
				const db = new DatabaseSync(join(f.directory, `${key}.sqlite`));
				try {const row = required(db.prepare("SELECT head_record FROM objects WHERE object_id=?").get(f.objectId));
					const head = decodeHeadRecordV1(row.head_record as Uint8Array, "head"); if (!head.ok || head.value.kind !== "present") throw Error("fixture native head");
					db.prepare("UPDATE objects SET head_record=? WHERE object_id=?").run(encodeHeadRecordV1({...head.value, revision: head.value.revision + 1}), f.objectId);
				} finally {db.close();}
			}});
		const creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message("stale-native-custody"));
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		const before = (await f.readHead(1)).head; mutate = true;
		await expect(f.install(member)).rejects.toThrow(); expect(mutations).toBe(1);
		expect((await f.readHead(1)).head).toMatchObject({...before, revision: before.kind === "present" ? before.revision + 1 : -1});
		const floor = await member.floor.read({scope: {objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest}});
		expect(floor).toMatchObject({state: {stable: {epoch: 0}}});
	}, 120_000);

	it("rejects a historical absence receipt relabelled as current protected-scope authority", async () => {
		const f = await fixture(), creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message("absence-receipt-custody"));
		for (let target = 2; target <= 12; target += 2) {
			for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
			await f.install(member);
		}
		const census = await retainedPointRoles(f, 1); expect(census.roles).toEqual([12, 10, 8]);
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		const key = createHash("sha256").update(JSON.stringify(["snapshots", "peer-1"])).digest("hex");
		const db = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-snapshot-quarantine-v1.sqlite`));
		db.function("snapshot_writer_v4", {varargs: true}, () => 1);
		let original: string | undefined, descriptorDelta = 0;
		const beforeHead = (await f.readHead(1)).head;
		const floorScope = {objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest};
		const beforeFloor = await member.floor.read({scope: floorScope});
		try {
			const rows = db.prepare("SELECT object_id,epoch,anchor,manifest_digest,incarnation,descriptors FROM snapshot_scopes_v2 WHERE object_id=? ORDER BY epoch").all(f.objectId);
			const historical = required(rows.map(row => ({epoch: Number(row.epoch), descriptor: JSON.parse(String(row.descriptors))}))
				.find(row => row.epoch < 11 && row.descriptor.retirement?.retired?.length > 0));
			expect(historical.descriptor.retirement.currentHead.epoch).toBeLessThan(12);
			original = String(required(rows.find(row => row.epoch === 11)).descriptors);
			const current = JSON.parse(original), currentRow = required(rows.find(row => row.epoch === 11));
			if (!beforeFloor.ok) throw Error("fixture floor unavailable");
			const currentScope = {objectId: f.objectId, epoch: 11, anchor: String(currentRow.anchor), manifestDigest: String(currentRow.manifest_digest)};
			const changed = JSON.stringify({kind: "creator-snapshot-recovery-descriptors", version: 1,
				chunks: Array.isArray(current) ? current : current.chunks,
				retirement: {...historical.descriptor.retirement, currentHead: beforeFloor.state.stable,
					survivor: {scope: currentScope, incarnation: String(currentRow.incarnation)}}});
			descriptorDelta = Buffer.byteLength(changed) - Buffer.byteLength(original);
			db.exec("BEGIN IMMEDIATE");
			db.prepare("UPDATE snapshot_scopes_v2 SET descriptors=? WHERE object_id=? AND epoch=11").run(changed, f.objectId);
			db.prepare("UPDATE snapshot_owner_v2 SET recovery_content_bytes=recovery_content_bytes+? WHERE id=1").run(descriptorDelta);
			db.exec("COMMIT");
			const protectedBefore = db.prepare("SELECT epoch,anchor,manifest_digest,exact_manifest_bytes FROM snapshot_scopes_v2 WHERE object_id=? AND epoch IN (7,9,11) ORDER BY epoch").all(f.objectId);
			expect(protectedBefore).toHaveLength(3);
			await expect(f.install(member)).rejects.toThrow("RECOVERY_CERTIFICATE_RETIREMENT_BINDING");
			expect((await f.readHead(1)).head).toEqual(beforeHead);
			expect(await member.floor.read({scope: floorScope})).toEqual(beforeFloor);
			expect(db.prepare("SELECT epoch,anchor,manifest_digest,exact_manifest_bytes FROM snapshot_scopes_v2 WHERE object_id=? AND epoch IN (7,9,11) ORDER BY epoch").all(f.objectId)).toEqual(protectedBefore);
			// Even a recomputed unkeyed current certificate identity cannot turn an
			// old native receipt into permission to delete a currently protected point.
			const rollback = required(rows.find(row => row.epoch === 7));
			const rebound = JSON.stringify({kind: "creator-snapshot-recovery-descriptors", version: 1,
				chunks: Array.isArray(current) ? current : current.chunks,
				retirement: {...historical.descriptor.retirement, currentHead: beforeFloor.state.stable,
					survivor: {scope: currentScope, incarnation: String(currentRow.incarnation)},
					certificateDigest: Buffer.from(hashDomain("ts-drp/native-checkpoint-recovery-roles/v1", encodeCanonical({
						genesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest, currentAnchorDigest: beforeFloor.state.stable.currentAnchorDigest,
						nativeHead: beforeHead}))).toString("hex"),
					retired: [...historical.descriptor.retirement.retired, {scope: {objectId: f.objectId, epoch: 7,
						anchor: String(rollback.anchor), manifestDigest: String(rollback.manifest_digest)}, incarnation: String(rollback.incarnation)}]}});
			const added = Buffer.byteLength(rebound) - Buffer.byteLength(changed); descriptorDelta += added;
			db.exec("BEGIN IMMEDIATE");
			db.prepare("UPDATE snapshot_scopes_v2 SET descriptors=? WHERE object_id=? AND epoch=11").run(rebound, f.objectId);
			db.prepare("UPDATE snapshot_owner_v2 SET recovery_content_bytes=recovery_content_bytes+? WHERE id=1").run(added); db.exec("COMMIT");
			await expect(f.install(member)).rejects.toThrow("RECOVERY_CERTIFICATE_RETIREMENT_CLASSIFICATION");
			expect((await f.readHead(1)).head).toEqual(beforeHead);
			expect(await member.floor.read({scope: floorScope})).toEqual(beforeFloor);
			expect(db.prepare("SELECT epoch,anchor,manifest_digest,exact_manifest_bytes FROM snapshot_scopes_v2 WHERE object_id=? AND epoch IN (7,9,11) ORDER BY epoch").all(f.objectId)).toEqual(protectedBefore);
		} finally {
			if (original !== undefined) {db.exec("BEGIN IMMEDIATE");
				db.prepare("UPDATE snapshot_scopes_v2 SET descriptors=? WHERE object_id=? AND epoch=11").run(original, f.objectId);
				db.prepare("UPDATE snapshot_owner_v2 SET recovery_content_bytes=recovery_content_bytes-? WHERE id=1").run(descriptorDelta); db.exec("COMMIT");}
			db.close();
		}
	}, 180_000);

	it("reopens both actual rollback points after authorized source-base normalization before publication", async () => {
		let stopBeforeFloor = false;
		const f = await chatSharesRoomFixture({members: ["genesis"], format: "window", genesisStateBytes: createShippingChatWindowGenesisStateBytes,
			beforeFloorWrite(peer, phase) {if (stopBeforeFloor && peer === 1 && phase === "begin") {stopBeforeFloor = false; throw Error("stop after native pruning");}}});
		const creator = await f.open(0); let member = await f.open(1);
		await member.room.issue(message("normalized-base-custody"));
		for (let target = 2; target <= 12; target += 2) {
			for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
			await f.install(member);
		}
		for (let step = 0; step < 2; step++) {expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();}
		stopBeforeFloor = true; await expect(f.install(member)).rejects.toThrow();
		const beforeReopen = await retainedPointRoles(f, 1);
		expect(beforeReopen.roles).toEqual([12, 10, 8]); expect(beforeReopen.normalizedPoints).toBeGreaterThan(0);
		expect(beforeReopen.headers.map(row => row.projectionEpoch).sort((a, b) => Number(a) - Number(b))).toEqual([4, 6, 8, 10, 12, 14]);
		const sourceFloor = required(beforeReopen.headers.find(row => row.projectionEpoch === 4));
		expect(sourceFloor.baseExpectedHead.kind).toBe("none");
		for (const epoch of [6, 8, 10, 12]) {
			const row = required(beforeReopen.headers.find(value => value.projectionEpoch === epoch));
			const base = required(beforeReopen.headers.find(value => value.projectionEpoch === epoch - 2));
			expect(row.baseExpectedHead).toMatchObject({kind: "present", generationId: base.generationId, closureDigest: base.closureDigest});
		}
		expect(beforeReopen.headers.find(row => row.projectionEpoch === 14)).toMatchObject({state: "Complete", baseExpectedHead: beforeReopen.head});
		expect(beforeReopen.snapshots).toEqual([7, 9, 11, 13]);
		await f.stop(member); member = await f.open(1, {reopen: true, promote: true});
		expect(member.room.authority()?.epoch).toBe(14);
		expect((await retainedPointRoles(f, 1)).roles).toEqual([14, 12, 10]);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect((await frontierHandBacks(f)).handBacks).toMatchObject([{sourceEpoch: 0, clientOperationId: "normalized-base-custody"}]);
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).not.toContain("normalized-base-custody");
		await member.room.issue(message("after-normalized-reopen"));
	}, 180_000);

	it.each(["before-begin", "begin", "commit"] as const)("recovers checkpoint adoption after lost %s acknowledgement", async phase => {
		let fail = false;
		const f = await chatSharesRoomFixture({members: ["genesis"], format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes, beforeFloorWrite(peer, selected) {
				if (fail && peer === 1 && phase === "before-begin" && selected === "begin") {fail = false; throw new Error("before checkpoint floor begin");}
			}, afterFloorWrite(peer, selected) {
				if (fail && peer === 1 && selected === phase) {fail = false; throw new Error("lost checkpoint floor acknowledgement");}
			}});
		const creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message("checkpoint-crash-custody"));
		const original = required((await f.issuedAfter(1, null)).at(-1));
		for (let epoch = 0; epoch < 2; epoch++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
		}
		fail = true;
		await expect(f.install(member)).rejects.toThrow();
		await f.stop(member);
		const reopened = await f.open(1, {reopen: true, promote: true});
		expect(reopened.room.authority().epoch).toBe(2);
		expect(await reopened.room.unresolvedAcceptedWork()).toEqual([]);
		expect(await frontierHandBacks(f)).toEqual({
			handBacks: [{sourceSequence: original.commit.authorSequence, sourceEpoch: 0, clientOperationId: "checkpoint-crash-custody"}],
			resolved: [{sourceSequence: original.commit.authorSequence, disposition: "expire", signed: 32}]});
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).not.toContain("checkpoint-crash-custody");
		await reopened.room.issue(message("after-checkpoint-recovery"));
	}, 120_000);

	it("refuses an unauthenticated own source before checkpoint publication or floor advance", async () => {
		const f = await fixture(), creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message("must-preserve-invalid-custody"));
		const original = required((await f.issuedAfter(1, null)).at(-1));
		for (let epoch = 0; epoch < 2; epoch++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		}
		const beforeHead = await f.readHead(1);
		const scope = {objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest};
		const beforeFloor = await member.floor.read({scope});
		const key = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
		const database = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-issuance-v1.sqlite`));
		try {
			database.function("issuance_retirement_connection", {varargs: true}, () => 1);
			database.function("issuance_retirement_record", {varargs: true}, () => 1);
			const signature = new Uint8Array(original.commit.envelope.signature); signature[0] ^= 1;
			database.prepare("UPDATE issued_records SET signature=? WHERE object_id=? AND author=? AND author_sequence=?")
				.run(signature, f.objectId, required(f.identities[1]).author, original.commit.authorSequence);
			const rows = () => database.prepare("SELECT canonical_preimage,digest,signature FROM issued_records ORDER BY author_sequence").all();
			const beforeRows = rows(), beforePlans = database.prepare("SELECT * FROM settlement_plans").all();
			await expect(f.install(member)).rejects.toThrow();
			expect((await f.readHead(1)).head).toEqual(beforeHead.head);
			expect(await member.floor.read({scope})).toEqual(beforeFloor);
			expect(rows()).toEqual(beforeRows);
			expect(database.prepare("SELECT * FROM settlement_plans").all()).toEqual(beforePlans);
		} finally {database.close();}
	}, 120_000);

	// Since 1803f975 the creator's signed frontier in the installed checkpoint resolves the offline row:
	// the creator closed epochs 0 and 1 without it and the row is displaced and fence-guarded (the lowest
	// unsettled own sequence), so it is proven never admitted. It is resolved with the author's own expiry
	// receipt (no manual review) and the move is given back to the app, which offers it again exactly once.
	it("rejoins after two missed installs and gives back the offline move the creator never admitted", async () => {
		const f = await fixture();
		const creator = await f.open(0); let member = await f.open(1);
		await member.room.issue(message("offline-accepted"));
		const original = required((await f.issuedAfter(1, null)).at(-1));
		for (let epoch = 0; epoch < 2; epoch++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		}
		await f.install(member);
		expect(member.room.authority().epoch).toBe(2);
		const ids = () => creator.room.projection().messages.map(row => row.clientOperationId);
		const undelivered = () => required(member.room.settlementStatus?.()).undelivered;
		expect(ids()).not.toContain("offline-accepted");
		expect(await member.room.unresolvedAcceptedWork(), "proven never admitted: not manual review").toEqual([]);
		const given = undelivered();
		expect(given).toMatchObject([{operations: [message("offline-accepted")],
			handBack: {sourceSequence: original.commit.authorSequence}}]);
		await f.stop(member);
		member = await f.open(1, {reopen: true, promote: true});
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(undelivered(), "the hand-back record is durable").toEqual(given);
		await member.room.issue(message("fresh-after-gap"));
		const record = required(given[0]);
		await member.room.issue(required(record.operations[0]), {handBack: record.handBack});
		expect(undelivered(), "the reissue consumed the record").toEqual([]);
		const fresh = await f.issuedAfter(1, original.commit.authorSequence);
		expect(await creator.receive(fresh, 1, 10_000)).toBe(true);
		expect(ids()).toContain("fresh-after-gap");
		expect(ids().filter(id => id === "offline-accepted"), "the given-back move admitted once").toHaveLength(1);
		// The late original can never be admitted: its epoch is closed.
		await creator.receive([original], 1, 2_000).catch(() => false);
		expect(ids().filter(id => id === "offline-accepted"), "the late original is not admitted").toHaveLength(1);
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		expect(member.room.authority().epoch).toBe(3);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(undelivered()).toEqual([]);
		expect(ids().filter(id => id === "offline-accepted")).toHaveLength(1);
	}, 120_000);

	it("retains accepted pending work through removal and re-admission on the same stores", async () => {
		const f = await fixture();
		const creator = await f.open(0); let member = await f.open(1);
		await member.room.issue(message("before-removal"));
		const original = required((await f.issuedAfter(1, null)).at(-1));
		const author = required(f.identities[1]).author;
		await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		expect(member.room.authority().epoch).toBe(1);
		const unresolved = await member.room.unresolvedAcceptedWork();
		expect(unresolved).toMatchObject([{sourceSequence: original.commit.authorSequence, sourceEpoch: 0,
			commitment: "unknown", disposition: "manual-review", operations: [message("before-removal")]}]);
		await expect(member.room.issue(message("must-not-authorize"))).rejects.toThrow();
		await f.stop(member);
		member = await f.open(1, {reopen: true, promote: true});
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unresolved);
		await expect(member.room.issue(message("must-not-authorize-after-restart"))).rejects.toThrow();
		await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		expect(member.room.authority().epoch).toBe(2);
		const retained = await f.issuedAfter(1, null);
		expect(retained.some(row => row.commit.authorSequence === original.commit.authorSequence &&
			Buffer.from(row.commit.envelope.digest).equals(Buffer.from(original.commit.envelope.digest)))).toBe(true);
		await member.room.issue(message("after-readmission"));
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unresolved);
		const fresh = required((await f.issuedAfter(1, original.commit.authorSequence)).at(-1));
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		const replacements = await f.issuedAfter(1, fresh.commit.authorSequence);
		expect(replacements.length).toBeGreaterThan(0);
		expect(await creator.receive(replacements, 1, 10_000)).toBe(true);
		expect(creator.room.projection().messages.map(row => row.clientOperationId)).toContain("after-readmission");
		expect(await member.room.unresolvedAcceptedWork()).toEqual(unresolved);
	}, 120_000);
});
