import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import {
	aheRetirementGenerationIdentity,
	type AheRetirementPreparation,
	decodeAheRetirementControl,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	encodeGenerationRecordV1,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	parseStorageObjectId,
	type PresentHead,
	type StoreResult,
} from "@ts-drp/storage";

import { database, done, environment, request } from "./browser-owner.js";
import { assertNativeSelectedRead, check, LIMITS } from "./contract.js";
import { state } from "../startup-discovery/floor.js";
import { bootstrap, hex, message, openRoom, roomInput, seed } from "../startup-discovery/room.js";

async function existingNativeImage(name: string): Promise<unknown> {
	check((await indexedDB.databases()).some((entry) => entry.name === name), "native observation never creates a database");
	const db = await database(name);
	try {
		const names = [...db.objectStoreNames];
		check(names.length > 0, "existing native owner has its original stores");
		const tx = db.transaction(names, "readonly"), terminal = done(tx);
		const tables = await Promise.all(names.map(async (table) => {
			const store = tx.objectStore(table);
			const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
			check(keys.length === values.length, "exact native keys and values paired");
			return { table, keys, values };
		}));
		await terminal;
		return { name, version: db.version, names,
			canonicalImage: Array.from(encodeCanonical(tables, { maxBytes: 8_388_608, maxItems: 65_536 })) };
	} finally { db.close(); }
}

async function census(identity: string, objectId: string): Promise<Record<string, unknown>> {
	const db = await database(identity + "--ahe");
	try {
		const tx = db.transaction(["objects", "generations"], "readonly"),
			terminal = done(tx);
		const [headRow, rows] = await Promise.all([
			request(tx.objectStore("objects").get(objectId)),
			request(tx.objectStore("generations").getAll()),
		]);
		await terminal;
		const head = decodeHeadRecordV1(headRow.record);
		check(head.ok && head.value.kind === "present", "genuine head native row");
		const records = rows
			.filter((r: { objectId: string }) => r.objectId === objectId)
			.map((r: { record: Uint8Array }) => {
				const result = decodeGenerationRecordV1(r.record);
				check(result.ok, "genuine native metadata canonical");
				return result.value;
			});
		check(records.filter((r) => r.state === "Adopted").length === 1, "genuine exactly one adopted");
		return { count: records.length, head: head.value, records };
	} finally {
		db.close();
	}
}
Object.assign(globalThis, {
	boundedCreatorFacadeHandoff: async (identity: string, targetEpoch = 2, corruptHistoricalSignature = false, unmatchedPlan = false, censusPositive = false, durableIntent = false): Promise<unknown> => {
		check(targetEpoch === 2 || targetEpoch === 4, "fixed original characterization or genuine turnover workload");
		check(typeof corruptHistoricalSignature === "boolean" && (!corruptHistoricalSignature || targetEpoch === 4), "fixed historical crypto negative only at original turnover");
		check(typeof unmatchedPlan === "boolean" && (!unmatchedPlan || (targetEpoch === 4 && !corruptHistoricalSignature)), "fixed unmatched mechanical plan only at original turnover");
		check(typeof censusPositive === "boolean" && (!censusPositive || (targetEpoch === 4 && !corruptHistoricalSignature && !unmatchedPlan)), "fixed new census positive at original turnover");
		check(typeof durableIntent === "boolean" && (!durableIntent || (targetEpoch === 4 && !corruptHistoricalSignature && !unmatchedPlan && !censusPositive)), "fixed durable intent only at genuine public turnover");
		// The original signed no-settlement profile naturally registers the filtered
		// successor facade at epoch two. No raw recovery or owner substitution.
		const b = await bootstrap(identity, "creator-trusted-v1");
		let room: Awaited<ReturnType<typeof openRoom>> | undefined;
		let nativeFloor:
			| Awaited<ReturnType<typeof import("../../../packages/storage-browser/dist/src/index.js").createBrowserRoomHeadAuthority>>
			| undefined;
		const milestones: Record<string, unknown>[] = [];
		let snapshotObserver:
			| Awaited<ReturnType<typeof import("../../../packages/storage-browser/dist/src/snapshot-transfer.js").createBrowserSnapshotQuarantineStore>>
			| undefined;
		const pool = async (): Promise<unknown> => snapshotObserver?.recoveryStatus();
		let stage = "room-setup",
			failed = false,
			primary: unknown;
		let historicalSignatureNegative: Record<string, unknown> | undefined;
		let unmatchedPlanNegative: Record<string, unknown> | undefined;
		let nativeCensusPositive: Record<string, unknown> | undefined;
		let durableRetirement: Record<string, unknown> | undefined;
		let issuanceObserver:
			| Awaited<ReturnType<typeof import("../../../packages/storage-browser/dist/src/issuance.js").createBrowserDurableIssuanceStore>>
			| undefined;
		try {
			if (targetEpoch === 4) {
				// Host-selected native origin custody; this is not independent anti-rollback
				// storage. All signed invite, application, signer and transport inputs stay original.
				const { createBrowserRoomHeadAuthority } = await import("../../../packages/storage-browser/dist/src/index.js");
				const { createV3RoomSession } = await import("../../../examples/v3-room/src/index.js");
				nativeFloor = await createBrowserRoomHeadAuthority({
					databaseName: identity + "--startup-floor",
					initialization: { kind: "create" },
				});
				room = await createV3RoomSession({ ...(await roomInput(b, "create")), roomHeadAuthority: nativeFloor });
				const { createBrowserSnapshotQuarantineStore } = await import("../../../packages/storage-browser/dist/src/snapshot-transfer.js");
				snapshotObserver = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName: identity });
			} else room = await openRoom(b, "create");
			stage = "issue0";
			await room.issue(message("facade-issue0"));
			milestones.push({ site: "issue0", projection: room.projection(), ...(snapshotObserver ? { pool: await pool() } : {}) });
			for (let epoch = 1; epoch <= targetEpoch; epoch++) {
				stage = "close" + (epoch - 1);
				const closed = await room.sealEpoch();
				milestones.push({ site: stage, closed, ...(snapshotObserver ? { pool: await pool() } : {}) });
				stage = "adopt" + epoch;
				await room.adoptCreatorSuccessor();
				const authority = room.authority();
				check(authority?.epoch === epoch, "genuine public adjacent successor activated");
				milestones.push({ site: stage, authority, native: await census(identity, b.objectId), ...(snapshotObserver ? { pool: await pool() } : {}) });
				stage = "issue" + epoch;
				await room.issue(message("facade-issue" + epoch));
				milestones.push({ site: stage, projection: room.projection() });
			}
			stage = "before-close" + targetEpoch;
			const beforeProjection = room.projection();
			for (let epoch = 0; epoch <= targetEpoch; epoch++)
				check(
					beforeProjection.accepted.filter((v) => v.clientOperationId === "facade-issue" + epoch).length === 1,
					"all original public issues remain projected exactly once"
				);
			const beforePool = await snapshotObserver?.recoveryStatus();
			milestones.push({ site: stage, authority: room.authority(), native: await census(identity, b.objectId), ...(beforePool ? { pool: beforePool } : {}) });
			if (targetEpoch === 4)
				check(beforePool?.recoveryScopes === 4 && beforePool.limits.maxRecoveryScopes === 4, "genuine original pool-full boundary reached without fabricated scopes");
			const retirementImages = async (): Promise<unknown[]> => Promise.all([
				identity, identity + "--ahe", identity + "--drp-issuance-v1",
				identity + "--drp-snapshot-quarantine-v1", identity + "--startup-floor", identity + "--drp-live-journal-v1",
			].map(existingNativeImage));
			const beforeRetirement = durableIntent ? await retirementImages() : undefined;
			stage = "close" + targetEpoch;
			if (censusPositive) {
				const { createBrowserDurableIssuanceStore } = await import("../../../packages/storage-browser/dist/src/issuance.js");
				const { resolveBrowserDurableIssuancePruningMaintenance } = await import("../../../packages/storage-browser/dist/src/issuance-maintenance.js");
				issuanceObserver = await createBrowserDurableIssuanceStore({ primaryDatabaseName: identity });
				const owner = resolveBrowserDurableIssuancePruningMaintenance(issuanceObserver);
				check(owner !== undefined, "original native census owner exists");
				const acquire: unknown = Reflect.get(issuanceObserver, "acquireNativeReadReservation");
				const read: unknown = Reflect.get(owner, "readBoundedRecoveryCensus");
				check(typeof acquire === "function" && typeof read === "function", "original native census and reservation methods exist");
				const before = await existingNativeImage(identity + "--drp-issuance-v1") as { canonicalImage: number[] };
				const held = await Reflect.apply(acquire, issuanceObserver, [{ objectId: b.objectId }]) as { check(): Promise<void>; release(): Promise<void> };
				let failedRead = false, primaryRead: unknown;
				try {
					await held.check();
					const observed = await Reflect.apply(read, owner, [{ objectId: b.objectId, limits: { maxRows: 1024, maxBytes: 262144 } }]) as {
						rows: { lineages: Record<string, unknown>[]; issued: unknown[]; outbox: unknown[]; plans: unknown[] };
						image: { logicalBytes: number; lineageCount: number; issuedCount: number; outboxCount: number; planCount: number };
					};
					const tables = decodeCanonical(Uint8Array.from(before.canonicalImage)) as { table: string; keys: unknown[]; values: unknown[] }[];
					const table = (name: string): unknown[] => {
						const found = tables.find(row => row.table === name);
						check(found !== undefined, "actual original census table present");
						return found.values;
					};
					check(table("settlementPlans").length === 0, "new positive has genuine no-settlement native state");
					// The native owner accepts its original four-field lineage schema and
					// returns an explicit null watermark; no other native field is projected away.
					const lineages = table("lineages").map((value) => {
						check(value !== null && typeof value === "object" && !Array.isArray(value), "actual native lineage record");
						const keys = Object.keys(value).sort();
						const legacyKeys = ["author", "exhausted", "next", "objectId"];
						const currentKeys = [...legacyKeys, "prunedThroughAuthorSequence"].sort();
						const legacy = JSON.stringify(keys) === JSON.stringify(legacyKeys);
						check(legacy || JSON.stringify(keys) === JSON.stringify(currentKeys), "exact original native lineage fields");
						return legacy ? { ...value, prunedThroughAuthorSequence: null } : value;
					});
					const expected = { lineages, issued: table("issuedRecords"), outbox: table("issuanceOutbox"), plans: [] };
					// Retain the actual new read even if a subsequent equality oracle refuses.
					nativeCensusPositive = { before, observed, heldCheck: true, noncreating: false };
					check(JSON.stringify(Array.from(encodeCanonical(observed.rows))) === JSON.stringify(Array.from(encodeCanonical(expected))), "new census carries every exact actual addressed native row");
					check(observed.rows.lineages.length === 1 && observed.rows.lineages[0]?.author === hex(ed25519.getPublicKey(seed(identity))) &&
						observed.image.lineageCount === observed.rows.lineages.length && observed.image.issuedCount === observed.rows.issued.length &&
						observed.image.outboxCount === observed.rows.outbox.length && observed.image.planCount === 0 && observed.image.logicalBytes <= 262144,
						"new census exact known scope counts and unchanged union entitlement");
					const after = await existingNativeImage(identity + "--drp-issuance-v1");
					check(JSON.stringify(after) === JSON.stringify(before), "native census creates no retirement control or other durable bytes");
					await held.check();
					nativeCensusPositive = { before, after, observed, heldCheck: true, noncreating: true };
				} catch (cause) { failedRead = true; primaryRead = cause; }
				try { await held.release(); }
				catch (cause) { if (failedRead) throw new AggregateError([primaryRead, cause], "native census and release failed", { cause: primaryRead }); throw cause; }
				if (failedRead) throw primaryRead;
				let revoked = false;
				try { await held.check(); } catch (cause) { revoked = cause instanceof Error && cause.message === "NATIVE_READ_RESERVATION_RELEASED"; }
				check(revoked, "joined original native reservation release invalidates new checks");
				check(nativeCensusPositive !== undefined, "original native census result retained");
				nativeCensusPositive.releaseJoined = true;
				nativeCensusPositive.afterReleaseRefused = true;
				milestones.push({ site: "native-object-census-held-and-released", nativeCensusPositive });
			}
			if (unmatchedPlan) {
				const { createBrowserDurableIssuanceStore } = await import("../../../packages/storage-browser/dist/src/issuance.js");
				issuanceObserver = await createBrowserDurableIssuanceStore({ primaryDatabaseName: identity });
				const [original] = await issuanceObserver.readOutboxPage({ limit: 1 });
				check(original !== undefined && original.commit.issuedRecord.scope.objectId === b.objectId, "actual original source digest for unknown mechanical debt");
				const scope = { objectId: b.objectId, author: hex(ed25519.getPublicKey(seed(identity + "-unmatched-plan"))) };
				check(scope.author !== original.commit.issuedRecord.scope.author, "unknown plan author differs from the genuine signed source author");
				const plan = await issuanceObserver.transactWriteSettlementPlan({ expectedRevision: null, scope,
					plan: { scope, revision: 0, fenceSequence: null, entries: [{
						sourceSequence: original.commit.authorSequence,
						sourceDigest: new Uint8Array(original.commit.envelope.digest),
						disposition: "rebase", replacementSequence: null,
					}] } });
				const planReadback = await issuanceObserver.readSettlementPlan(scope);
				check(JSON.stringify(Array.from(encodeCanonical(planReadback))) === JSON.stringify(Array.from(encodeCanonical(plan))), "original supported plan write has exact native readback");
				check((await issuanceObserver.readOutboxPage({ scope, limit: 1 })).length === 0 &&
					(await issuanceObserver.readIssued(scope, original.commit.authorSequence)) === null &&
					(await issuanceObserver.readLineage(scope)).next === 0, "plan-only scope has no discovered signed source or lineage");
				const nativeIssuance = await database(identity + "--drp-issuance-v1");
				try {
					const read = nativeIssuance.transaction("lineages", "readonly"), terminal = done(read);
					const rawLineage = await request(read.objectStore("lineages").get([scope.objectId, scope.author]));
					await terminal;
					check(rawLineage === undefined, "native plan scope has no stored lineage, not a default API projection");
				} finally { nativeIssuance.close(); }
				const activeRoom = room;
				const capture = async (): Promise<unknown> => ({
					authority: activeRoom.authority(), projection: activeRoom.projection(), pool: await pool(),
					native: await Promise.all([
						identity, identity + "--ahe", identity + "--drp-issuance-v1",
						identity + "--drp-snapshot-quarantine-v1", identity + "--startup-floor", identity + "--drp-live-journal-v1",
					].map(existingNativeImage)),
				});
				const before = await capture();
				let refused = false, refusal: unknown = null, delivered: unknown = null;
				try { delivered = await activeRoom.sealEpoch(); }
				catch (cause) { refused = true; refusal = { message: String(cause), ...(cause instanceof Error ? { stack: cause.stack, cause: String(cause.cause) } : {}) }; }
				const after = await capture();
				// Save the native result even when the expected refusal assertion is RED.
				unmatchedPlanNegative = { scope, plan, planReadback, mechanicalDebtNotAuthenticatedSource: true,
					refused, refusal, delivered, before, after };
				milestones.push({ site: stage + "-unmatched-plan-result", unmatchedPlanNegative });
				check(refused, "unknown object-level settlement plan must refuse public turnover");
				check(JSON.stringify(Array.from(encodeCanonical(after))) === JSON.stringify(Array.from(encodeCanonical(before))), "unknown debt refusal preserves every native owner image, floor, pool and projection");
			} else if (corruptHistoricalSignature) {
				const activeRoom = room;
				const before = {
					authority: activeRoom.authority(), projection: activeRoom.projection(),
					pool: await pool(), native: await census(identity, b.objectId),
				};
				const db = await database(identity);
				let originalRow: Record<string, unknown> | undefined;
				try {
					const read = db.transaction("voteSlots", "readonly"), readDone = done(read);
					const rows = await request(read.objectStore("voteSlots").getAll(IDBKeyRange.bound([b.objectId, 1], [b.objectId, 1, []])));
					await readDone;
					const selected = rows.filter((row: Record<string, unknown>) => row.objectId === b.objectId &&
						row.epoch === 1 && row.round === 0 && row.phase === "prepare" && row.signerId === "creator");
					check(selected.length === 1, "one genuine retained epoch-one prepare vote");
					originalRow = selected[0] as Record<string, unknown>;
					const corrupted = structuredClone(originalRow);
					const carrier = corrupted.carrier as { exactCanonicalPreimageBytes: Uint8Array; signature: Uint8Array };
					check(carrier.signature instanceof Uint8Array && carrier.signature.byteLength === 64 &&
						carrier.exactCanonicalPreimageBytes instanceof Uint8Array, "original native signed carrier bytes");
					const preimage = decodeCanonical(carrier.exactCanonicalPreimageBytes) as Record<string, unknown>;
					check(preimage.objectId === b.objectId && preimage.epoch === 1 && preimage.phase === "prepare" &&
						preimage.signerId === "creator", "actual canonical vote identity");
					const domain = registry.kinds.sealVote.domain;
					const digest = hashDomain(domain, carrier.exactCanonicalPreimageBytes), publicKey = ed25519.getPublicKey(seed(identity));
					const originalValid = ed25519.verify(carrier.signature, digest, publicKey, { zip215: false });
					check(originalValid, "original retained vote has a real valid signature");
					const first = carrier.signature[0];
					check(first !== undefined, "original detached signature first byte");
					carrier.signature[0] = first ^ 1;
					const corruptedValid = ed25519.verify(carrier.signature, digest, publicKey, { zip215: false });
					check(!corruptedValid, "one changed signature byte is cryptographically invalid");
					const normalized = structuredClone(corrupted);
					(normalized.carrier as { signature: Uint8Array }).signature = (originalRow.carrier as { signature: Uint8Array }).signature;
					check(JSON.stringify(Array.from(encodeCanonical(normalized))) === JSON.stringify(Array.from(encodeCanonical(originalRow))),
						"native address and every non-signature field unchanged");
					const write = db.transaction("voteSlots", "readwrite", { durability: "strict" }), written = done(write);
					await request(write.objectStore("voteSlots").put(corrupted)); await written;
					let refused = false, refusal: unknown;
					try { await activeRoom.sealEpoch(); }
					catch (cause) { refused = true; refusal = { message: String(cause), ...(cause instanceof Error ? { stack: cause.stack, cause: String(cause.cause) } : {}) }; }
					const after = {
						authority: activeRoom.authority(), projection: activeRoom.projection(),
						pool: await pool(), native: await census(identity, b.objectId),
					};
					check(refused, "invalid retained historical signature must refuse public turnover");
					check((refusal as { message: string }).message ===
						'TypeError: creator snapshot role reconciliation refused: internal-invariant; {"ok":false,"kind":"internal-invariant"}',
						"original public reconciliation refusal reached, not unrelated setup refusal");
					check(JSON.stringify(after) === JSON.stringify(before), "refusal preserves authority projection pool and exact native AHE");
					historicalSignatureNegative = {
						originalEpoch: 1, phase: "prepare", round: 0, signerId: "creator", domain,
						preimageBytes: Array.from(carrier.exactCanonicalPreimageBytes), publicKey: Array.from(publicKey),
						originalSignature: Array.from((originalRow.carrier as { signature: Uint8Array }).signature),
						corruptedSignature: Array.from(carrier.signature), originalValid, corruptedValid,
						refused, refusal, before, after, mutationJoined: true,
					};
					milestones.push({ site: stage + "-refused", historicalSignatureNegative });
				} finally {
					try {
						if (originalRow !== undefined) {
							const restore = db.transaction("voteSlots", "readwrite", { durability: "strict" }), restored = done(restore);
							await request(restore.objectStore("voteSlots").put(originalRow)); await restored;
							if (historicalSignatureNegative) historicalSignatureNegative.restoreJoined = true;
						}
					} finally { db.close(); }
				}
			} else {
				const closed = await room.sealEpoch();
				check(room.authority()?.epoch === targetEpoch, "close does not fabricate successor activation");
				check(
					JSON.stringify(room.projection()) === JSON.stringify(beforeProjection),
					"original public close preserves the application projection"
				);
				milestones.push({ site: stage, closed, native: await census(identity, b.objectId), ...(snapshotObserver ? { pool: await pool() } : {}) });
				if (durableIntent) {
					const afterRetirement = await retirementImages();
					// Observe actual durable rows only AFTER the original public operation.
					// Neither labels nor this readonly test census mint a retirement plan.
					durableRetirement = { before: beforeRetirement, after: afterRetirement, delivered: closed,
						metadataCheckpointDrainUnobserved: true, preexistingSnapshotTurnoverDistinct: true };
					milestones.push({ site: "durable-retirement-native-readback", durableRetirement });
					const record = (value: unknown): Record<string, unknown> => {
						check(value !== null && typeof value === "object" && !Array.isArray(value), "actual native record");
						return value as Record<string, unknown>;
					};
					const tables = (images: unknown[], name: string): { table: string; keys: unknown[]; values: unknown[] }[] => {
						const image = images.map(record).find(row => row.name === name);
						check(image !== undefined && Array.isArray(image.canonicalImage), "actual native image retained");
						return decodeCanonical(Uint8Array.from(image.canonicalImage as number[])) as { table: string; keys: unknown[]; values: unknown[] }[];
					};
					const table = (images: unknown[], name: string, selected: string): { keys: unknown[]; values: unknown[] } => {
						const found = tables(images, name).find(row => row.table === selected);
						check(found !== undefined, "actual original native table retained");
						return found;
					};
					const encodedControl = (value: unknown): Record<string, unknown> => {
						const bytes = value instanceof Uint8Array ? value : record(value).record;
						check(bytes instanceof Uint8Array, "actual canonical native control bytes");
						return record(decodeCanonical(bytes));
					};
					const addressedValue = (images: unknown[], name: string, store: string, key: string): unknown => {
						const native = table(images, name, store), index = native.keys.findIndex(value => value === key);
						check(index >= 0 && native.keys.filter(value => value === key).length === 1, "exact addressed native control key retained");
						return native.values[index];
					};
					const ahe = table(afterRetirement, identity + "--ahe", "storageMeta").values.map(record)
						.find(row => row.key === "ahe-retirement:" + b.objectId);
					check(ahe !== undefined, "PUBLIC_RETIREMENT_COORDINATOR_INTENT_MISSING");
					check(ahe.record instanceof Uint8Array, "actual AHE coordinator canonical carrier");
					const decodedCoordinator = decodeAheRetirementControl(ahe.record);
					check(decodedCoordinator.ok, "actual original coordinator codec accepts persisted control");
					const coordinator = decodedCoordinator.value;
					check(coordinator.objectId === b.objectId && coordinator.active === null && coordinator.completed !== null,
						"actual original coordinator completes one addressed durable intent");
					const completed = coordinator.completed;
					check(completed !== null && typeof completed.sourceProofDigest === "string", "actual coordinator source proof binding retained");
					const snapshot = encodedControl(addressedValue(afterRetirement, identity + "--drp-snapshot-quarantine-v1", "retirementControls", b.objectId));
					const journal = encodedControl(addressedValue(afterRetirement, identity + "--drp-live-journal-v1", "retirementControls", b.objectId));
					const issuance = encodedControl(addressedValue(afterRetirement, identity + "--drp-issuance-v1", "retirementControls", b.objectId));
					const floor = encodedControl(addressedValue(afterRetirement, identity + "--startup-floor", "floor", "record"));
					const signing = table(afterRetirement, identity, "storageMeta").values.map(record)
						.find(row => row.key === "signing-retirement:" + b.objectId);
					check(signing !== undefined, "both physical vote and evidence domains have actual native control");
					const controls = [
						{ participant: "snapshot", control: snapshot }, { participant: "journal", control: journal },
						{ participant: "issuance", control: issuance }, { participant: "floor", control: record(floor.control) },
						{ participant: "vote-and-evidence-same-native-owner", control: record(signing.value) },
					];
					for (const { control } of controls) {
						check(typeof control.incarnation === "string" && control.incarnation.length > 0 &&
							Number.isSafeInteger(control.revision) && (control.revision as number) > 0,
							"actual native participant incarnation and revision retained");
						check(control.active === null && control.completed !== null, "every actual native participant is committed");
						const local = record(control.completed);
						check(local.decisionDigest === completed.decisionDigest && local.sourceProofDigest === completed.sourceProofDigest,
							"every actual native participant binds SAME coordinator decision and authenticated source proof");
					}
					const before = beforeRetirement;
					check(before !== undefined, "original native preimage retained");
					check(snapshot.objectId === b.objectId && journal.objectId === b.objectId && issuance.objectId === b.objectId &&
						record(signing.value).objectId === b.objectId && record(floor.scope).objectId === b.objectId,
						"all actual native controls belong to the genuine addressed object");
					const beforeFloor = encodedControl(addressedValue(before, identity + "--startup-floor", "floor", "record"));
					const previousState = record(beforeFloor.state), currentState = record(floor.state);
					check(JSON.stringify(Array.from(encodeCanonical(previousState.stable))) === JSON.stringify(Array.from(encodeCanonical(currentState.stable))),
						"successful close preserves original whole stable safety floor before adoption");
					const protectedScopes = record(snapshot.completed).protectedScopes;
					check(Array.isArray(protectedScopes) && protectedScopes.length > 0, "actual protected snapshot holes retained");
					const beforeChunks = table(before, identity + "--drp-snapshot-quarantine-v1", "chunks").values.map(record);
					const afterChunks = table(afterRetirement, identity + "--drp-snapshot-quarantine-v1", "chunks").values.map(record);
					for (const hole of protectedScopes) {
						const scope = record(record(hole).scope);
						const selected = (row: Record<string, unknown>): boolean => ["objectId", "epoch", "anchor", "manifestDigest"].every(key => row[key] === scope[key]);
						const prior = beforeChunks.filter(selected), next = afterChunks.filter(selected);
						check(prior.length > 0 && JSON.stringify(Array.from(encodeCanonical(prior))) === JSON.stringify(Array.from(encodeCanonical(next))),
							"every actual protected snapshot chunk remains byte-identical");
					}
					durableRetirement.coordinator = coordinator;
					durableRetirement.controls = controls;
					durableRetirement.protectedBytesPreserved = true;
					durableRetirement.stableFloorPreserved = true;
					check(closed.ok && closed.epoch === 4 && closed.successorEpoch === 5 && closed.lifecycle === "successor-pending-adoption",
						"original public close truthfully delivers pending successor without fabricating activation");
					stage = "retirement-adopt5";
					await room.adoptCreatorSuccessor();
					check(room.authority()?.epoch === 5, "genuine successor activated after committed intent");
					await room.issue(message("retirement-next"));
					const nextProjection = room.projection(), nextRows = nextProjection.accepted.filter(row => row.clientOperationId === "retirement-next");
					check(nextRows.length === 1,
						"ordinary future work remains admitted exactly once");
					const nextRow = nextRows[0];
					check(nextRow !== undefined, "actual ordinary continuation row");
					const afterNext = await retirementImages();
					const nativeIssue = table(afterNext, identity + "--drp-issuance-v1", "issuedRecords").values.map(record)
						.find(row => row.author === nextRow.author && row.authorSequence === nextRow.authorSequence);
					const nativePublication = table(afterNext, identity + "--drp-issuance-v1", "issuanceOutbox").values.map(record)
						.find(row => row.author === nextRow.author && row.authorSequence === nextRow.authorSequence);
					check(nativeIssue !== undefined && nativePublication?.publishState === "published" &&
						nativeIssue.canonicalPreimageBytes instanceof Uint8Array && nativeIssue.digest instanceof Uint8Array &&
						nativePublication.digest instanceof Uint8Array, "ordinary continuation has exact native issued/published pair");
					check(record(decodeCanonical(nativeIssue.canonicalPreimageBytes)).epoch === 5 &&
						JSON.stringify(Array.from(nativeIssue.digest)) === JSON.stringify(Array.from(nativePublication.digest)),
						"ordinary native continuation remains in lawful future epoch with SAME paired digest");
					for (let epoch = 0; epoch <= targetEpoch; epoch++)
						check(nextProjection.accepted.filter(row => row.clientOperationId === "facade-issue" + epoch).length === 1,
							"all original projected operations survive ordinary continuation");
					durableRetirement.continuation = { authority: room.authority(), projection: nextProjection, nativeIssue, nativePublication };
					milestones.push({ site: "durable-retirement-ordinary-continuation", continuation: durableRetirement.continuation });
				}
			}
		} catch (cause) {
			failed = true;
			primary = {
				stage,
				message: String(cause),
				...(cause instanceof Error ? { stack: cause.stack, cause: String(cause.cause) } : {}),
			};
		}
		const roomOwner = room;
		const roomCompletion = roomOwner ? Promise.resolve().then(() => roomOwner.close()) : Promise.resolve();
		const owners = [...(roomOwner ? [{ owner: "room", completion: roomCompletion }] : []),
			...(snapshotObserver ? [{ owner: "snapshot-observer", completion: Promise.resolve().then(() => snapshotObserver?.close()) }] : []),
			...(nativeFloor ? [{ owner: "native-floor", completion: roomCompletion.then(() => nativeFloor?.close(), () => nativeFloor?.close()) }] : []),
			...(issuanceObserver ? [{ owner: "issuance-observer", completion: Promise.resolve().then(() => issuanceObserver?.close()) }] : [])];
		const joined = await Promise.allSettled(owners.map(owner => owner.completion));
		const cleanup = joined.map((outcome, i) => {
			const owner = owners[i];
			check(owner, "joined cleanup has its original owner");
			return { owner: owner.owner, status: outcome.status,
				...(outcome.status === "rejected" ? { reason: String(outcome.reason) } : {}) };
		});
		return {
			passed: !failed && joined.every(outcome => outcome.status === "fulfilled"),
			failed,
			...(failed ? { primary } : {}),
			identity,
			objectId: b.objectId,
			profile: b.profile,
			transportAndHostFloorFixturePremises: true,
			...(nativeFloor ? { nativeFloorOriginCustody: true, independentAntiRollback: false } : {}),
			...(historicalSignatureNegative ? { historicalSignatureNegative } : {}),
			...(unmatchedPlanNegative ? { unmatchedPlanNegative } : {}),
			...(nativeCensusPositive ? { nativeCensusPositive } : {}),
			...(durableRetirement ? { durableRetirement } : {}),
			milestones,
			cleanup,
		};
	},
	boundedAheCompletedFloorRoom: async (identity: string, withheldStageReadback = false): Promise<unknown> => {
		const b = await bootstrap(identity),
			room = await openRoom(b, "create");
		const { createBrowserAheDurableStore } = await import("../../../packages/storage-browser/dist/src/index.js");
		let preopened: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined,
			fresh: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined;
		const milestones: Record<string, unknown>[] = [];
		let failed = false,
			primary: unknown;
		let restoreReadbackFault: (() => void) | undefined;
		let resumedGenerationId: string | undefined;
		const must = <T>(result: StoreResult<T>): T => {
			if (!result.ok) throw new TypeError("COMPLETED_FLOOR_ROOM:" + result.reason);
			return result.value;
		};
		try {
			await room.issue(message("completed-floor-before"));
			const beforeProjection = room.projection().accepted;
			check(
				beforeProjection.filter((v) => v.clientOperationId === "completed-floor-before").length === 1,
				"original public issue projected once"
			);
			preopened = await createBrowserAheDurableStore({
				databaseName: identity + "--ahe",
			});
			const objectId = must(parseStorageObjectId(b.objectId)),
				head = must(await preopened.readHead(objectId)),
				page = must(await preopened.readGenerationPage({ objectId, limit: 7 }));
			check(head.kind === "present" && page.nextCursor === null, "genuine full current native head and bounded census");
			const acquire = preopened.acquireRetirementControl;
			check(acquire, "genuine native retirement participant available");
			const recordDigests = page.generations.map((g) => must(digestBlob(encodeGenerationRecordV1(g)))),
				identities = page.generations.map((g) => ({
					generationId: g.generationId,
					identityDigest: aheRetirementGenerationIdentity(g),
				}));
			check(recordDigests.length > 0, "genuine current native partition nonempty");
			// Mechanical native checkpoint only: every existing generation protected.
			// Signed invite supplies genesis scope; these labels grant no all-owner eligibility.
			const preparation: AheRetirementPreparation = {
				head,
				floorEpoch: 0,
				floorAnchor: b.invite.pinnedGenesisAnchorDigest,
				decisionDigest: "d".repeat(64),
				sourceProofDigest: "e".repeat(64),
				generationRecordDigests: [],
				snapshotScopes: [],
				protectedIndices: [],
				retireIndices: [],
				domains: Array.from(
					{ length: 8 },
					(_, i) =>
						[2 ** i, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const
				),
			};
			must(
				await must(await acquire.call(preopened, objectId)).prepareBound({
					preparation,
					generations: {
						recordDigests,
						identities,
						protectedIndices: recordDigests.map((_, i) => i),
						retireIndices: [],
					},
				})
			);
			const completed = must(
				await must(await acquire.call(preopened, objectId)).commitPrepared({
					decisionDigest: preparation.decisionDigest,
					sourceProofDigest: preparation.sourceProofDigest,
				})
			);
			check(completed.completed?.throughEpoch === 0, "actual completed native floor zero");
			fresh = await createBrowserAheDurableStore({
				databaseName: identity + "--ahe",
			});
			const ordinaryInput = {
				objectId,
				generationId: must(parseGenerationId("f".repeat(64))),
				baseExpectedHead: head,
				closure: [],
			};
			const oldRefusal = await preopened.beginGeneration(ordinaryInput),
				freshRefusal = await fresh.beginGeneration(ordinaryInput);
			check(!oldRefusal.ok && oldRefusal.reason === "RETIREMENT_FENCED", "preopened ordinary mutation remains fenced");
			check(!freshRefusal.ok && freshRefusal.reason === "RETIREMENT_FENCED", "fresh ordinary mutation remains fenced");
			milestones.push({
				site: "completed-before-public-close",
				head,
				records: page.generations,
				completed,
				oldRefusal,
				freshRefusal,
				beforeProjection,
			});
			const closed = await room.sealEpoch();
			milestones.push({ site: "public-close-returned", closed });
			if (withheldStageReadback) {
				// Reuse the genuine native owner; withhold one verification read only.
				// This is neither native write failure nor process death.
				type NativeStore = NonNullable<typeof preopened>;
				const prototype = Object.getPrototypeOf(preopened) as object;
				const acquireDescriptor = Object.getOwnPropertyDescriptor(prototype, "acquireRetirementControl");
				const blobDescriptor = Object.getOwnPropertyDescriptor(prototype, "getBlob");
				check(acquireDescriptor && blobDescriptor, "original native instrumentation boundaries present");
				const originalAcquire = acquireDescriptor.value as NonNullable<NativeStore["acquireRetirementControl"]>;
				const originalGetBlob = blobDescriptor.value as NativeStore["getBlob"];
				let withholdNextBlob = false;
				let withheldReads = 0;
				const stages: Record<string, unknown>[] = [];
				const nativeObserver = environment(identity + "--ahe");
				restoreReadbackFault = (): void => {
					Object.defineProperty(prototype, "acquireRetirementControl", acquireDescriptor);
					Object.defineProperty(prototype, "getBlob", blobDescriptor);
				};
				Object.defineProperty(prototype, "getBlob", {
					...blobDescriptor,
					value: function (
						this: NativeStore,
						digest: Parameters<NativeStore["getBlob"]>[0]
					): ReturnType<NativeStore["getBlob"]> {
						if (withholdNextBlob) {
							withholdNextBlob = false;
							withheldReads++;
							return Promise.resolve({ ok: true as const, value: null });
						}
						return originalGetBlob.call(this, digest);
					},
				});
				Object.defineProperty(prototype, "acquireRetirementControl", {
					...acquireDescriptor,
					value: async function (
						this: NativeStore,
						id: Parameters<typeof originalAcquire>[0]
					): ReturnType<typeof originalAcquire> {
						const acquired = await originalAcquire.call(this, id);
						if (!acquired.ok) return acquired;
						const view = acquired.value;
						return {
							ok: true as const,
							value: {
								...view,
								prepare: view.prepare.bind(view),
								prepareBound: view.prepareBound.bind(view),
								commitPrepared: view.commitPrepared.bind(view),
								abortPrepared: view.abortPrepared.bind(view),
								publishNominatedFutureGeneration: view.publishNominatedFutureGeneration.bind(view),
								stageNominatedFutureGeneration: async (
									capability: unknown
								): ReturnType<typeof view.stageNominatedFutureGeneration> => {
									const observed = await nativeObserver.observe(() => view.stageNominatedFutureGeneration(capability));
									const result = observed.value;
									check(result.ok && result.value.nominee, "actual native stage has its durable nominee");
									stages.push({ nominee: result.value.nominee, evidence: observed.evidence });
									if (stages.length === 1) withholdNextBlob = true;
									return result;
								},
							},
						};
					},
				});
				let refused = false;
				let refusal: unknown;
				try {
					await room.adoptCreatorSuccessor();
				} catch (cause) {
					refused = true;
					refusal = cause;
				}
				check(
					refused && refusal instanceof Error && refusal.message.startsWith("v3 room successor stage failed:"),
					"withheld verification refuses application stage delivery"
				);
				check(withheldReads === 1 && stages.length === 1, "one read withheld after exactly one actual native stage");
				const staged = must(await acquire.call(preopened, objectId));
				const nominee = staged.control.nominee;
				check(
					nominee && staged.head.kind === "present",
					"failed delivery retains the exact durable nominee and predecessor head"
				);
				resumedGenerationId = nominee.generationId;
				check(staged.head.generationId !== resumedGenerationId, "nominee remains unpublished after failed readback");
				await staged.release();
				const beforeRetryFloor = await state(identity);
				check(
					beforeRetryFloor?.stable.epoch === 0 && beforeRetryFloor.pending === null,
					"failed stage did not advance host floor"
				);
				milestones.push({
					site: "first-stage-readback-withheld",
					refusal: { name: refusal.name, message: refusal.message },
					nominee,
					head: staged.head,
					stages,
					withheldReads,
				});
				await room.adoptCreatorSuccessor();
				check((stages.length as number) === 2, "fresh public verification resumes the native stage exactly once");
				const firstStage = stages[0];
				const resumedStage = stages[1];
				check(firstStage && resumedStage, "both exact native stage observations present");
				check(
					JSON.stringify(firstStage.nominee) === JSON.stringify(resumedStage.nominee),
					"retry preserves byte-identical nominee tuple"
				);
				const resumeEvidence = resumedStage.evidence as { writes: number; terminalKinds: string[] };
				check(
					resumeEvidence.writes === 1 && resumeEvidence.terminalKinds.every((kind) => kind === "complete"),
					"resume writes only native metadata and joins actual completion"
				);
				milestones.push({ site: "exact-nominee-resumed", stages, resumedGenerationId });
			} else {
				await room.adoptCreatorSuccessor();
			}
			const successorAuthority = room.authority();
			check(successorAuthority?.epoch === 1, "actual public successor activated at epoch one");
			check(
				room.projection().accepted.filter((v) => v.clientOperationId === "completed-floor-before").length === 1,
				"predecessor projection retained once after activation"
			);
			milestones.push({
				site: "public-adopt-activated",
				authority: successorAuthority,
				projection: room.projection(),
			});
			await room.issue(message("completed-floor-after"));
			const projection = room.projection();
			check(
				projection.accepted.filter((v) => v.clientOperationId === "completed-floor-before").length === 1,
				"predecessor projection preserved by next issue"
			);
			check(
				projection.accepted.filter((v) => v.clientOperationId === "completed-floor-after").length === 1,
				"genuine next ordinary issue projected once"
			);
			const hostFloor = await state(identity);
			check(
				hostFloor?.stable.epoch === 1 && hostFloor.pending === null,
				"original native host floor committed at successor epoch one"
			);
			const final = must(await acquire.call(preopened, objectId));
			try {
				if (resumedGenerationId !== undefined)
					check(
						final.head.kind === "present" && final.head.generationId === resumedGenerationId,
						"exact original nominee was published by retry"
					);
				check(
					JSON.stringify(final.control.completed) === JSON.stringify(completed.completed),
					"native completed floor and protected identities unchanged"
				);
				check(
					final.control.incarnation === completed.incarnation &&
						final.control.active === null &&
						final.control.nominee === null,
					"native incarnation unchanged and no unresolved nomination"
				);
				const finalPage = must(await preopened.readGenerationPage({ objectId, limit: 7 }));
				check(finalPage.nextCursor === null, "final native census remains bounded");
				check(
					identities.every((original) =>
						finalPage.generations.some(
							(g) =>
								g.generationId === original.generationId &&
								aheRetirementGenerationIdentity(g) === original.identityDigest
						)
					),
					"every protected native identity remains present"
				);
				milestones.push({
					site: "next-public-issue",
					authority: room.authority(),
					hostFloor,
					projection,
					control: final.control,
					head: final.head,
					records: finalPage.generations,
				});
			} finally {
				await final.release();
			}
		} catch (cause) {
			failed = true;
			primary =
				cause instanceof Error
					? {
							name: cause.name,
							message: cause.message,
							stack: cause.stack,
							cause:
								cause.cause instanceof Error
									? { name: cause.cause.name, message: cause.cause.message, stack: cause.cause.stack }
									: cause.cause,
						}
					: cause;
		} finally {
			restoreReadbackFault?.();
		}
		const owners = [
			{ owner: "room", completion: room.close() },
			...(preopened === undefined ? [] : [{ owner: "preopened-ahe", completion: preopened.close() }]),
			...(fresh === undefined ? [] : [{ owner: "fresh-ahe", completion: fresh.close() }]),
		];
		const cleanup = (await Promise.allSettled(owners.map((o) => o.completion))).map((outcome, i) => {
			const owner = owners[i];
			check(owner, "joined completion has its original owner");
			return {
				owner: owner.owner,
				status: outcome.status,
				...(outcome.status === "rejected" ? { reason: String(outcome.reason) } : {}),
			};
		});
		return {
			passed: !failed && cleanup.every((o) => o.status === "fulfilled"),
			mechanicalCheckpointNotAllOwnerAuthority: true,
			transportAndHostFloorFixturePremises: true,
			withheldStageReadback,
			identity,
			objectId: b.objectId,
			failed,
			...(failed ? { primary } : {}),
			milestones,
			cleanup,
		};
	},
	boundedAheProducer: async (identity: string, settlement: boolean): Promise<unknown> => {
		const b = await bootstrap(identity, settlement ? "creator-trusted-settlement-v1" : "creator-trusted-v1"),
			room = await openRoom(b, "create");
		const checkpoints: Record<string, unknown>[] = [];
		try {
			// The shipped bootstrap room has no successor authority yet. This is the actual
			// producer checkpoint zero, not a claim that a non-null authority authenticates genesis.
			checkpoints.push({ epoch: 0, ...(await census(identity, b.objectId)) });
			await room.issue(message("producer-zero"));
			for (let epoch = 1; epoch <= 3; epoch++) {
				await room.sealEpoch();
				await room.adoptCreatorSuccessor();
				const authority = room.authority();
				check(authority, "genuine successor authority present");
				checkpoints.push({ epoch: authority.epoch, ...(await census(identity, b.objectId)) });
				check(authority.epoch === epoch, "genuine room accepted successor epoch");
				await room.issue(message("producer-" + epoch));
			}
		} finally {
			await room.close();
		}
		const counts = checkpoints.map((c) => c.count);
		const last = checkpoints[3],
			epochTwo = checkpoints[2],
			initial = checkpoints[0];
		check(last && epochTwo && initial, "four genuine checkpoints observed");
		const records = last.records as {
			generationId: string;
			baseExpectedHead: { kind: string; generationId?: string };
			state: string;
		}[];
		const active = records.find((r) => r.state === "Adopted");
		check(active, "genuine selected active L metadata");
		const parent = records.find((r) => r.generationId === active.baseExpectedHead.generationId);
		check(parent, "genuine selected parent Q metadata");
		const older = records.find((r) => r.generationId === parent.baseExpectedHead.generationId);
		check(older, "genuine selected older L metadata");
		if (settlement) {
			check(
				older.baseExpectedHead.kind === "none" && records.length === 3,
				"genuine reclamation normalized oldest L, erased earlier prefix"
			);
			check(
				older.generationId === (epochTwo.head as { generationId: string }).generationId,
				"oldest is genuinely accepted epoch-two L, not genesis"
			);
			check(
				!(initial.records as { generationId: string }[]).some((initial) =>
					records.some((retained) => retained.generationId === initial.generationId)
				),
				"genuine older genesis prefix actually reclaimed"
			);
		}
		return {
			dataObservationOnly: true,
			identity,
			objectId: b.objectId,
			settlement,
			counts,
			checkpoints,
			selectedIds: [active.generationId, parent.generationId, older.generationId],
			normalizedOldest: older.baseExpectedHead.kind === "none",
		};
	},
	boundedAheGenuineRead: async (
		identity: string,
		objectId: string,
		selectedIds: string[],
		settlement: boolean
	): Promise<unknown> => {
		const before = await census(identity, objectId);
		const { createBrowserAheDurableStore } = await import("../../../packages/storage-browser/dist/src/index.js");
		const store = await createBrowserAheDurableStore({ databaseName: identity + "--ahe" });
		try {
			const method: unknown = Reflect.get(store, "acquireBoundedActiveRead");
			if (typeof method !== "function")
				return {
					passed: false,
					failure: "WIRING_RED:acquireBoundedActiveRead absent; genuine producer assertions masked",
					before,
				};
			const observed = await environment(identity + "--ahe").observe(
				() =>
					Reflect.apply(method, store, [{ objectId, ancestorCount: 2, limits: LIMITS }]) as Promise<{
						ok: boolean;
						reason?: string;
						value: {
							reader: {
								head: PresentHead;
								generations: GenerationRecord[];
								blobs: { ref: GenerationRef; bytes: Uint8Array }[];
								release(): Promise<void>;
							};
						};
					}>
			);
			check(
				observed.evidence.writes === 0 &&
					observed.evidence.modes.length === 1 &&
					observed.evidence.modes[0] === "readonly" &&
					observed.evidence.terminals === 1,
				"genuine single readonly terminal native snapshot"
			);
			const result = observed.value;
			if (!settlement) {
				check(!result.ok && result.reason === "READ_BUDGET_EXCEEDED", "fixed G7 whole valid shipped eight-row refusal");
				check(
					!observed.evidence.reads.some((r) => r.table === "generations" && r.operation === "get"),
					"genuine G+1 keys before generation values"
				);
				check((await store.readHead(objectId as never)).ok, "genuine valid G+1 nonpoisoning");
			} else {
				check(result.ok, "genuine successful native selection");
				const expectedRecords = selectedIds.map((generationId) => {
					const record = (before.records as GenerationRecord[]).find((r) => r.generationId === generationId);
					check(record, "genuine exact selected native metadata record present");
					return record;
				});
				assertNativeSelectedRead(
					result.value.reader,
					before.head as PresentHead,
					expectedRecords,
					await environment(identity + "--ahe").image(),
					observed.evidence
				);
				const oldest = expectedRecords[2];
				check(
					oldest && oldest.baseExpectedHead.kind === "none",
					"genuine normalized oldest requires no erased prefix walk"
				);
				await result.value.reader.release();
			}
			check(
				JSON.stringify(await census(identity, objectId)) === JSON.stringify(before),
				"genuine object unchanged by read/refusal"
			);
			return {
				passed: true,
				before,
				observation: observed.evidence,
				budgetRefusalNotRollbackAvailability: !settlement,
			};
		} finally {
			await store.close();
		}
	},
});
