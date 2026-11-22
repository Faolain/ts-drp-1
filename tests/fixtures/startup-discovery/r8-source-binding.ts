import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { AHE_BOUNDED_READ_LIMITS, aheRetirementGenerationIdentity, digestBlob, encodeGenerationRecordV1, parseGenerationId,parseStorageObjectId } from "@ts-drp/storage";
import { Message, V3Envelope } from "@ts-drp/types";
import { createTransientPayloadApplication } from "../phase-6b-d110c-0c1f5b/transient-payload-application.js";
import { createV3RoomCreatorInviteMaterial, createV3RoomSession, type V3RoomSession, waitForV3RoomStartupForDiagnostics } from "../../../examples/v3-room/src/index.js";
import { reopenCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-activate.js";
import { recoverPendingCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-recover.js";
import { control as startupControl, trace as startupTrace } from "./observation.js";
import { AUTHOR_FENCE_ACTION } from "../../../packages/protocol-v3/src/index.js";
import { snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import { captureCreatorSnapshotRecoveryRoles } from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import { LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES, LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, encodeJournalRetirementControl } from "@ts-drp/live-journal";
import { readV3RuntimeOwnerCensus, routeV3RetainedIngress, type V3AdmittedVertexSink, type V3PlaneHandle, type V3RebaseSource } from "../../../packages/node/src/v3-live.js";
import { createBrowserAheDurableStore,createBrowserRoomHeadAuthority } from "../../../packages/storage-browser/src/index.js";
import { createBrowserDurableIssuanceStore } from "../../../packages/storage-browser/src/issuance.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/src/live-journal.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/src/snapshot-transfer.js";
import { createBrowserSnapshotQuarantineStore as createLegacySnapshotStore } from "../../../packages/storage-browser/tests/fixtures/legacy-snapshot-transfer.mjs";
import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import type { SnapshotQuarantineDeclaration, SnapshotQuarantineStore, SnapshotVerificationReceipt } from "@ts-drp/storage/snapshot-transfer";
import { bindCreatorLiveClose } from "../../../packages/node/src/creator-close.js";
import { openBrowserSealVoteStore } from "../../../packages/storage-browser/src/seal-vote.js";
import { openBrowserSealEvidenceStore } from "../../../packages/storage-browser/src/seal-evidence.js";
import { stable } from "../snapshot-recovery-owner/contract.js";
import { bootstrap, hex, message, parameters, roomInput, seed, transport } from "./room.js";
import type { Bootstrap } from "./types.js";
import { readCreatorSuccessorExport } from "../../../packages/node/src/creator-adoption.js";
import { createCreatorSuccessorMaterialServer } from "../../../packages/node/src/internal/creator-successor-transport.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { runCrossObjectActivationScenario } from "../phase-3g/rebase-outbox-fixture.js";
import { runHealthyGrid } from "./healthy-grid.ts";

function requireValue<T>(value:T|undefined, detail:string):T { if(value===undefined)throw new Error(detail);return value; }

async function copyInheritedSnapshot(
	sourceStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>,
	legacyStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>,
	declaration: SnapshotQuarantineDeclaration
): Promise<void> {
	const source = await sourceStore.openScope(declaration);
	const port = source.verificationQuarantine.open(new AbortController().signal);
	const old = await legacyStore.openScope(declaration);
	try {
		const stream = verifySnapshotStreamWithReceipt({exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: declaration.scope.manifestDigest, expectedScope: declaration.scope,
			profile: {maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072},
			quarantine: old.verificationQuarantine,
			source: {read: async descriptor => requireValue(await port.read(descriptor), "genuine snapshot chunk absent")}});
		await stream.completion;
		await old.complete(await stream.receipt);
	} finally {
		const joined = await Promise.allSettled([Promise.resolve().then(() => port.discard()),
			Promise.resolve().then(() => source.release()), Promise.resolve().then(() => old.release())]);
		const faults = joined.flatMap(value => value.status === "rejected" ? [value.reason] : []);
		if (faults.length) throw new AggregateError(faults, "original migration byte ports failed to join");
	}
}

/** An authentic unrelated room snapshot is unknown to the first room's protected planner. */
async function appendUnknownInheritedSnapshot(
	identity: string,
	legacyStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>,
	joins: Record<string, unknown>[]
): Promise<SnapshotQuarantineDeclaration> {
	const boot = await bootstrap(identity, "creator-trusted-settlement-v1"), input = await roomInput(boot, "create");
	const floor = await createBrowserRoomHeadAuthority({databaseName: identity + "--startup-floor", initialization: {kind: "create"}});
	let room: Awaited<ReturnType<typeof createV3RoomSession>> | undefined;
	let ahe: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined;
	let snapshot: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined;
	try {
		room = await createV3RoomSession({...input, roomHeadAuthority: floor});
		await waitForV3RoomStartupForDiagnostics(room);
		await room.issue(message("unrelated-inherited-source"));
		const sealed = await room.sealEpoch();
		if (!sealed.ok) throw new Error("genuine unrelated source close:" + JSON.stringify(sealed));
		await room.adoptCreatorSuccessor();
		await room.close(); room = undefined; joins.push({owner: "unknown-genuine-room", ok: true});
		ahe = await createBrowserAheDurableStore({databaseName: identity + "--ahe"});
		snapshot = await createBrowserSnapshotQuarantineStore({primaryDatabaseName: identity});
		const blob = await ahe.getBlob(sealed.cutValueRef.digest);
		if (!blob.ok || blob.value === null) throw new Error("genuine unrelated Cut absent");
		const cut = decodeCanonical(blob.value) as Record<string, unknown>;
		const selected = await snapshot.lookupRecoveryDeclaration({objectId: boot.objectId, epoch: sealed.epoch,
			anchor: String(cut.previousAnchor), manifestDigest: String(cut.snapshotManifestDigest)});
		if (selected.kind !== "present" || selected.state !== "verified" || selected.retention !== "recovery")
			throw new Error("genuine unrelated protected snapshot absent");
		await copyInheritedSnapshot(snapshot, legacyStore, selected.declaration);
		return selected.declaration;
	} finally {
		const owners = [{owner: "unknown-room", close: () => room?.close()}, {owner: "unknown-ahe", close: () => ahe?.close()},
			{owner: "unknown-snapshot", close: () => snapshot?.close()}, {owner: "unknown-floor", close: () => floor.close()}];
		const joined = await Promise.allSettled(owners.map(async value => {await value.close(); joins.push({owner: value.owner, ok: true});}));
		const faults = joined.flatMap(value => value.status === "rejected" ? [value.reason] : []);
		if (faults.length) throw new AggregateError(faults, "unknown authentic source owners failed to join");
	}
}

/** Fault only the exact authenticated v1 chunk payload; metadata/authority stay unchanged. */
async function corruptInheritedChunk(identity: string, declaration: SnapshotQuarantineDeclaration): Promise<Record<string, unknown>> {
	const request = indexedDB.open(identity + "--drp-snapshot-quarantine-v1");
	const database = await new Promise<IDBDatabase>((resolve, reject) => {request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
	try {
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			const transaction = database.transaction("chunks", "readwrite"), chunks = transaction.objectStore("chunks");
			let evidence: Record<string, unknown> | undefined;
			transaction.oncomplete = () => evidence === undefined ? reject(new Error("corruption fault did not reach exact row")) : resolve(evidence);
			transaction.onabort = () => reject(transaction.error ?? new Error("corruption fault transaction aborted"));
			const descriptor = declaration.chunks[0], scope = declaration.scope;
			if (descriptor === undefined) {transaction.abort(); return;}
			const selected = chunks.get([scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest, descriptor.index]);
			selected.onsuccess = () => {
				try {
					const row = selected.result as Record<string, unknown>, bytes = new Uint8Array(row.exactBytes as Uint8Array);
					const beforeDigest = snapshotChunkDigest(descriptor.index, bytes);
					if (bytes.length === 0 || beforeDigest !== descriptor.digest) throw new Error("corruption fault source was not the genuine verified chunk");
					bytes[0] = bytes[0]! ^ 1;
					const afterDigest = snapshotChunkDigest(descriptor.index, bytes);
					chunks.put({...row, exactBytes: bytes});
					evidence = {index: descriptor.index, expectedDigest: descriptor.digest, beforeDigest, afterDigest,
						byteLength: bytes.length, scope, metadataUnchanged: true};
				} catch (error) {transaction.abort(); reject(error);}
			};
		});
	} finally {database.close();}
}

// One affected original inherited-migration case. The v1 owner receives exact
// room-produced bytes through its original receipt path; no database image is
// copied and no legacy metadata or authority is forged.
async function runInheritedMigration(identity: string, fault?: "after-apply" | "unknown" | "corrupt" | "quota" | "mature" | "pending"): Promise<Record<string, unknown>> {
	const mature = fault === "mature" || fault === "pending";
	const boot = await bootstrap(identity, "creator-trusted-settlement-v1");
	const input = await roomInput(boot, "create");
	const legacyIdentity = identity + "-inherited";
	let floor = await createBrowserRoomHeadAuthority({databaseName: identity + "--startup-floor", initialization: {kind: "create"}});
	let room: V3RoomSession<ReturnType<typeof input.application.projectAcceptedOperations>> | undefined;
	let ahe: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined;
	let original: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined;
	let legacy: Awaited<ReturnType<typeof createLegacySnapshotStore>> | undefined;
	let inherited: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined;
	let issuance: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>> | undefined;
	let journal: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>> | undefined;
	let vote: Awaited<ReturnType<typeof openBrowserSealVoteStore>> | undefined;
	let evidence: Awaited<ReturnType<typeof openBrowserSealEvidenceStore>> | undefined;
	let plane: V3PlaneHandle | undefined;
	let close: Awaited<ReturnType<typeof bindCreatorLiveClose>> | undefined;
	const joins: Record<string, unknown>[] = [];
	let phase = "genuine-room-create", result: Record<string, unknown> | undefined;
	// Read-only boundary observations for this three-transition native case.
	// They supply no custody/authority and leave all original operations intact.
	const observeMaturePhase = (stage: string): void => {
		if (fault === "mature") console.info(JSON.stringify({lane: "inherited-migration-mature-phase", stage, atMs: Date.now()}));
	};
	try {
		observeMaturePhase("genuine-room-create");
		room = await createV3RoomSession({...input, roomHeadAuthority: floor});
		await waitForV3RoomStartupForDiagnostics(room);
		observeMaturePhase("genuine-initial-issue");
		await room.issue(message("inherited-source"));
		observeMaturePhase("genuine-initial-seal");
		const sealed = await room.sealEpoch();
		if (!sealed.ok) throw new Error("genuine inherited source close:" + JSON.stringify(sealed));
		const matureCutBytes: Uint8Array[] = [];
		let maturePinnedTrustBytes: Uint8Array | undefined;
		const captureMatureCut = async (transition: typeof sealed): Promise<void> => {
			const owner = requireValue(ahe, "mature original AHE absent");
			const blob = await owner.getBlob(transition.cutValueRef.digest);
			if (!blob.ok || blob.value === null) throw new Error("genuine mature current native Cut unavailable");
			const addressed = digestBlob(blob.value);
			if (!addressed.ok || addressed.value !== transition.cutValueRef.digest || blob.value.length !== transition.cutValueRef.byteLength)
				throw new Error("genuine mature current native Cut address differs");
			matureCutBytes.push(Uint8Array.from(blob.value));
		};
		if (mature) {
			ahe = await createBrowserAheDurableStore({databaseName: identity + "--ahe"});
			await captureMatureCut(sealed);
			const pinned = await ahe.getBlob(sealed.currentTrustRef.digest);
			if (!pinned.ok || pinned.value === null) throw new Error("genuine mature initial trust unavailable");
			maturePinnedTrustBytes = Uint8Array.from(pinned.value);
		}
		observeMaturePhase("genuine-initial-adopt");
		await room.adoptCreatorSuccessor();
		const transitions = [sealed];
		if (mature) {
			// Three genuine public closes/adoptions: no forced epoch, copied native
			// database image or synthetic pending floor. Pending coverage is separate.
			for (let step = 0; step < 2; step++) {
				phase = "genuine-mature-close-adopt-" + (step + 1);
				observeMaturePhase(phase + ":issue");
				await room.issue(message("inherited-mature-source-" + step));
				observeMaturePhase(phase + ":seal");
				const next = await room.sealEpoch();
				if (!next.ok || next.epoch !== transitions[transitions.length - 1]!.successorEpoch)
					throw new Error("genuine mature transition differs:" + JSON.stringify(next));
				transitions.push(next);
				await captureMatureCut(next);
				observeMaturePhase(phase + ":adopt");
				await room.adoptCreatorSuccessor();
			}
		}
		const authority = requireValue(room.authority() ?? undefined, "genuine adopted authority absent");
		if (authority.epoch !== transitions[transitions.length - 1]!.successorEpoch) throw new Error("genuine current successor absent");
		let pendingPublication: Record<string, unknown> | undefined;
		if (fault === "pending") {
			phase = "genuine-pending-close-stage-before-publication";
			await room.issue(message("inherited-pending-source"));
			const applicationProjection = room.projection().accepted.map(row => ({clientOperationId: row.clientOperationId, text: row.text}));
			const next = await room.sealEpoch();
			if (!next.ok || next.epoch !== authority.epoch || next.successorEpoch !== authority.epoch + 1)
				throw new Error("genuine pending transition differs:" + JSON.stringify(next));
			transitions.push(next); await captureMatureCut(next);
			const beforeFaults = startupTrace.filter(row => row.site === "publication-fault").length;
			startupControl.publicationFault = true;
			let publicationError: string | undefined;
			try {await room.adoptCreatorSuccessor();} catch (error) {publicationError = String(error);}
			const faultConsumed = !startupControl.publicationFault && startupTrace.filter(row => row.site === "publication-fault").length === beforeFaults + 1;
			const pendingState = await floor.read({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}});
			if (!faultConsumed || publicationError === undefined || !pendingState.ok || pendingState.state === null || pendingState.state.pending === null ||
				pendingState.state.stable.epoch !== authority.epoch || pendingState.state.pending.previous.epoch !== authority.epoch ||
				pendingState.state.pending.next.epoch !== next.successorEpoch || pendingState.state.pending.next.currentAnchorDigest !== next.successorAnchorDigest)
				throw new Error("original publication fault did not leave genuine pending floor:" + JSON.stringify({faultConsumed, publicationError, pendingState}));
			pendingPublication = {faultConsumed, publicationError, state: pendingState.state, sealed: next, applicationProjection};
		}
		await room.close(); room = undefined; joins.push({owner: "genuine-room", ok: true});
		phase = "exact-authenticated-snapshot-source";
		observeMaturePhase(phase);
		ahe ??= await createBrowserAheDurableStore({databaseName: identity + "--ahe"});
		original = await createBrowserSnapshotQuarantineStore({primaryDatabaseName: identity});
		const cutBlob = mature ? {ok: true as const, value: requireValue(matureCutBytes[0], "genuine mature first Cut absent")} : await ahe.getBlob(sealed.cutValueRef.digest);
		if (!cutBlob.ok || cutBlob.value === null) throw new Error("genuine native Cut unavailable");
		const pinnedTrustBlob = mature ? {ok: true as const, value: requireValue(maturePinnedTrustBytes, "genuine mature pinned trust absent")} : await ahe.getBlob(sealed.currentTrustRef.digest);
		if (!pinnedTrustBlob.ok || pinnedTrustBlob.value === null) throw new Error("genuine native genesis trust unavailable");
		const cut = decodeCanonical(cutBlob.value) as Record<string, unknown>;
		const scope = {objectId: boot.objectId, epoch: sealed.epoch, anchor: String(cut.previousAnchor), manifestDigest: String(cut.snapshotManifestDigest)};
		const selected = await original.lookupRecoveryDeclaration(scope);
		if (selected.kind !== "present" || selected.state !== "verified" || selected.retention !== "recovery") throw new Error("genuine source snapshot is not protected");
		const declarations = [selected.declaration], signedRoleCuts: Record<string, unknown>[] = [];
		if (mature) {
			for (const [index, transition] of transitions.entries()) {
				const bytes = requireValue(matureCutBytes[index], "genuine mature captured Cut absent");
				const body = decodeCanonical(bytes) as Record<string, unknown>, roles = captureCreatorSnapshotRecoveryRoles(body.recoveryRoles);
				const cutScope = {objectId: boot.objectId, epoch: transition.epoch, anchor: String(body.previousAnchor), manifestDigest: String(body.snapshotManifestDigest)};
				// Original early Cuts need not carry the later signed role transfer.
				// Their exact Cut scope is retained; the genuine epoch-two transfer
				// below must positively name all three, not merely match their count.
				if (body.epoch !== transition.epoch || body.objectId !== boot.objectId ||
					(roles !== undefined && (roles.genesisAnchorDigest !== boot.invite.pinnedGenesisAnchorDigest ||
						stable(roles.currentClose) !== stable(cutScope))) ||
					(body.recoveryRoles !== undefined && roles === undefined))
					throw new Error("genuine mature signed role references differ");
				const lookup = await original.lookupRecoveryDeclaration(cutScope);
				if (lookup.kind !== "present" || lookup.state !== "verified" || lookup.retention !== "recovery")
					throw new Error("genuine mature protected role bytes unavailable");
				if (!declarations.some(row => stable(row.scope) === stable(lookup.declaration.scope))) declarations.push(lookup.declaration);
				signedRoleCuts.push({cutRef: transition.cutValueRef, commitQcRef: transition.commitQcRef,
					currentTrustRef: transition.currentTrustRef, successorTrustRef: transition.successorTrustRef, cutScope, roles});
			}
			const latest = signedRoleCuts[2]!.roles as ReturnType<typeof captureCreatorSnapshotRecoveryRoles>;
			if (declarations.length !== (fault === "pending" ? 4 : 3) || latest === undefined || latest.previousClose === null ||
				stable(latest.currentClose) !== stable(signedRoleCuts[2]!.cutScope) ||
				stable(latest.previousClose) !== stable(signedRoleCuts[1]!.cutScope) ||
				!latest.classifiedScopes.some(scope => stable(scope) === stable(declarations[0]!.scope)))
				throw new Error("genuine mature current/two-rollback role chain differs");
		}
		phase = "original-v1-receipt-storage";
		observeMaturePhase(phase);
		legacy = await createLegacySnapshotStore({primaryDatabaseName: legacyIdentity});
		for (const declaration of declarations) await copyInheritedSnapshot(original, legacy, declaration);
		const unknownDeclaration = fault === "unknown" ? await appendUnknownInheritedSnapshot(identity + "-unknown", legacy, joins) : undefined;
		await legacy.close(); legacy = undefined; joins.push({owner: "original-v1-owner", ok: true});
		const corruption = fault === "corrupt" ? await corruptInheritedChunk(legacyIdentity, selected.declaration) : undefined;
		phase = "same-owner-native-upgrade";
		observeMaturePhase(phase);
		// A named legal custom native-owner quota negative; all default/positive
		// budgets and the independent cumulative proof entitlement stay unchanged.
		const configuredRecoveryLimits = fault === "quota" ? {maxRecoveryScopes: 4,
			maxRecoveryContentBytes: selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.length - 1} : undefined;
		inherited = await createBrowserSnapshotQuarantineStore({primaryDatabaseName: legacyIdentity,
			...(configuredRecoveryLimits === undefined ? {} : {recoveryLimits: configuredRecoveryLimits})});
		const beforeStatus = await inherited.recoveryStatus();
		const inspection = await inherited.inspectRecovery(selected.declaration);
		const beforeImage = await inheritedSnapshotImage(legacyIdentity);
		const beforeContent = await inheritedSnapshotImage(legacyIdentity, true);
		const beforeFloor = await floor.readRetirementImage({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}});
		const parsed = parseStorageObjectId(boot.objectId);
		if (!parsed.ok) throw new Error("original room object invalid");
		const beforeHead = await ahe.readHead(parsed.value);
		let sharedDependencies: {digest: string; byteLength: number; generations: string[]}[] | undefined;
		if (mature) {
			const acquired = await ahe.acquireBoundedRecoveryRoleRead({objectId: parsed.value, limits: AHE_BOUNDED_READ_LIMITS});
			if (!acquired.ok) throw new Error("genuine mature native census unavailable:" + JSON.stringify(acquired));
			try {
				// Positive identical digest/width references held by distinct native
				// roots, not an inference from scope count or snapshot absence.
				const byDigest = new Map<string, {byteLength: number; generations: string[]}>();
				for (const generation of acquired.value.generations) for (const ref of generation.closure) {
					const prior = byDigest.get(ref.digest);
					if (prior !== undefined && prior.byteLength !== ref.byteLength) throw new Error("shared native reference width differs");
					if (prior === undefined) byDigest.set(ref.digest, {byteLength: ref.byteLength, generations: [generation.generationId]});
					else prior.generations.push(generation.generationId);
				}
				sharedDependencies = [...byDigest].filter(([, value]) => value.generations.length > 1).map(([digest, value]) => ({digest, ...value}));
				if (!(await acquired.value.checkCurrency()).ok) throw new Error("genuine mature native census became stale");
			} finally {await acquired.value.release(); joins.push({owner: "mature-native-census", ok: true});}
		}
		issuance = await createBrowserDurableIssuanceStore({primaryDatabaseName: identity});
		journal = await createBrowserDurableLiveJournalStore({primaryDatabaseName: identity});
		const pendingApplicationState = async () => {
			const issueScope = {objectId: boot.objectId, author: input.author}, lineage = await issuance!.readLineage(issueScope);
			if (lineage.next > 16) throw new Error("pending migration native row bound exceeded");
			const issued = await Promise.all(Array.from({length: lineage.next}, (_, sequence) => issuance!.readIssued(issueScope, sequence)));
			const image = await journal!.readRetirementImage!({objectId: boot.objectId});
			if (!image.ok) throw new Error("pending migration native journal image unavailable");
			return {lineage, issued, outbox: await issuance!.readOutboxPage({scope: issueScope, limit: 64}), journal: image.value.canonicalRows};
		};
		const pendingApplicationImage = async (): Promise<string> => stable(await pendingApplicationState());
		if (fault === "pending") {
			phase = "authenticated-inherited-pending-recovery";
			const pending = beforeFloor.state.pending;
			if (pending === null || pendingPublication === undefined || beforeStatus.legacyUnclassifiedScopes !== 4)
				throw new Error("genuine inherited pending setup incomplete");
			const issuanceBefore = await inheritedSnapshotImage(identity, false, "--drp-issuance-v1");
			const journalBefore = await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1");
			const applicationBeforeState = await pendingApplicationState(), applicationBefore = stable(applicationBeforeState);
			const publicRecovery = await recoverPendingCreatorSuccessorAdoption({authenticationProfile: "creator-only",
				catalog: input.application.catalog, detachedSignature: boot.invite.detachedGenesisSignature,
				exactCanonicalAnchorPreimageBytes: boot.invite.exactCanonicalGenesisAnchorPreimageBytes,
				exactCanonicalParametersCarrierBytes: boot.invite.exactCanonicalParametersCarrierBytes,
				expectedNextRoomHead: pending.next, expectedPreviousRoomHead: pending.previous,
				issuanceStore: issuance, liveJournalStore: journal, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest,
				snapshotStore: inherited, store: ahe});
			const publicRefusal = {result: publicRecovery, afterStatus: await inherited.recoveryStatus(),
				afterHead: await ahe.readHead(parsed.value), afterFloor: await floor.readRetirementImage({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}}),
				snapshotUnchanged: beforeImage === await inheritedSnapshotImage(legacyIdentity),
				issuanceUnchanged: issuanceBefore === await inheritedSnapshotImage(identity, false, "--drp-issuance-v1"),
				journalUnchanged: journalBefore === await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1"),
				applicationUnchanged: applicationBefore === await pendingApplicationImage()};
			phase = "genuine-room-cold-pending-classification-publication";
			await floor.close(); joins.push({owner: "pending-create-floor", ok: true});
			floor = await createBrowserRoomHeadAuthority({databaseName: identity + "--startup-floor", initialization: {kind: "reopen"}});
			const coldInput = await roomInput(boot, "reopen"), delivered: Record<string, unknown>[] = [], signingReadiness: unknown[] = [];
			// Test substrate configuration only: the same original native snapshot
			// factory opens the namespace populated by genuine v1 receipt writes.
			// No product input, database copying or owner remapping is involved.
			Reflect.set(globalThis, "__r8InheritedSnapshotNamespace", {roomIdentity: identity, snapshotIdentity: legacyIdentity,
				readFloor: () => floor.readRetirementImage({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}}), readApplication: pendingApplicationImage});
			let recovered: Record<string, unknown>, continuation: Record<string, unknown> = {ok: false};
			try {
				room = await createV3RoomSession({...coldInput, roomHeadAuthority: floor, initialLogicalTime: 100,
					signRegisteredVertexDigest: async value => {signingReadiness.push(await inherited!.recoveryStatus()); return coldInput.signRegisteredVertexDigest(value);},
					onAcceptedVertex: async vertex => {delivered.push({authorSequence: vertex.authorSequence, digest: hex(vertex.digest), operation: vertex.operation, epoch: vertex.epoch, anchor: vertex.anchor});}});
				await waitForV3RoomStartupForDiagnostics(room);
				const adopted = room.authority();
				recovered = {ok: true, authority: adopted};
				const startupApplication = await pendingApplicationState();
				const startupPlan = await issuance.readSettlementPlan({objectId: boot.objectId, author: input.author});
				const startupJournalRows = startupApplication.journal.map(frame => decodeCanonical(frame) as readonly unknown[])
					.filter(frame => frame[0] === "acceptedEntries").map(frame => frame[2] as Record<string, unknown>);
				const startupRows = startupApplication.outbox.filter(row => row.commit.authorSequence >= applicationBeforeState.lineage.next).map(row => {
					const body = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;
					return {sequence: row.commit.authorSequence, body, planEffect: row.commit.planEffect,
						digest: hex(row.commit.envelope.digest), signatureValid: ed25519.verify(row.commit.envelope.signature, row.commit.envelope.digest, ed25519.getPublicKey(seed(identity))),
						digestValid: hex(hashDomain("ts-drp/vertex/v3", row.commit.envelope.canonicalPreimageBytes)) === hex(row.commit.envelope.digest),
						issuedExact: stable(startupApplication.issued[row.commit.authorSequence]?.envelope) === stable(row.commit.envelope),
						journalExact: startupJournalRows.some(entry => entry.sourceKind === "local-issued" && entry.localAuthor === input.author && entry.localAuthorSequence === row.commit.authorSequence && entry.vertexDigest === hex(row.commit.envelope.digest) && entry.objectId === body.objectId && entry.epoch === body.epoch && entry.anchorDigest === body.anchor),
						deliveries: delivered.filter(entry => entry.authorSequence === row.commit.authorSequence)};
				});
				const startupProjection = room.projection().accepted.map(row => ({clientOperationId: row.clientOperationId, text: row.text}));
				const startupOldRowsRetained = applicationBeforeState.issued.every((row, index) => stable(row) === stable(startupApplication.issued[index])) &&
					applicationBeforeState.outbox.every(row => startupApplication.outbox.some(actual => actual.commit.authorSequence === row.commit.authorSequence && stable(actual.commit) === stable(row.commit))) &&
					applicationBeforeState.journal.filter(frame => (decodeCanonical(frame) as readonly unknown[])[0] === "acceptedEntries")
						.every(row => startupApplication.journal.some(actual => stable(row) === stable(actual)));
				const publication = startupTrace.find(row => row.site === "pending-publication-readiness")?.value as {applicationImage?: string} | undefined;
				const applicationBeforeContinuation = publication?.applicationImage === applicationBefore && startupOldRowsRetained &&
					stable(startupProjection) === stable(pendingPublication.applicationProjection);
				const lineage = await issuance.readLineage({objectId: boot.objectId, author: input.author});
				const deliveryStart = delivered.length;
				await room.issue(message("inherited-pending-continuation"));
				const issued = await issuance.readIssued({objectId: boot.objectId, author: input.author}, lineage.next);
				if (issued === null || adopted === null) throw new Error("pending continuation native issued row absent");
				const {canonicalPreimageBytes: bytes, digest: digestBytes, signature} = issued.envelope;
				const body = decodeCanonical(bytes) as Record<string, unknown>;
				const outbox = (await issuance.readOutboxPage({scope: {objectId: boot.objectId, author: input.author}, limit: 64})).find(row => row.commit.authorSequence === lineage.next);
				const scope = {objectId: boot.objectId, epoch: adopted.epoch, anchorDigest: adopted.anchorDigest}, ready = await journal.readiness({scope});
				if (!ready.ok || !ready.ready) throw new Error("pending continuation journal unavailable");
				const page = await journal.readPage({scope, snapshot: ready.snapshot, afterSequence: null, limit: 64});
				if (!page.ok) throw new Error("pending continuation journal page unavailable");
				continuation = {ok: true, sequence: lineage.next, applicationBeforeContinuation, startupOldRowsRetained, startupRows, startupPlan,
					startupProjection, originalProjection: pendingPublication.applicationProjection, applicationBeforeState, startupApplication,
					candidateExact: hex(encodeCanonical(body.operation)) === hex(encodeCanonical(message("inherited-pending-continuation"))),
					scopeExact: body.epoch === adopted.epoch && body.anchor === adopted.anchorDigest && body.author === input.author && body.objectId === boot.objectId,
					digestExact: hex(hashDomain("ts-drp/vertex/v3", bytes)) === hex(digestBytes),
					signatureValid: ed25519.verify(signature, digestBytes, ed25519.getPublicKey(seed(identity))),
					outboxExact: outbox !== undefined && hex(outbox.commit.envelope.canonicalPreimageBytes) === hex(bytes) && hex(outbox.commit.envelope.signature) === hex(signature),
					journalExact: page.rows.some(row => row.sourceKind === "local-issued" && row.author === input.author && row.authorSequence === lineage.next && row.vertexDigest === hex(digestBytes)),
					deliveryExact: delivered.slice(deliveryStart).some(row => row.authorSequence === lineage.next && row.digest === hex(digestBytes) && stable(row.operation) === stable(body.operation) && row.epoch === adopted.epoch && row.anchor === adopted.anchorDigest)};
			} catch (error) {recovered = {ok: false, error: String(error)};}
			finally {Reflect.deleteProperty(globalThis, "__r8InheritedSnapshotNamespace");}
			result = {phase, recovered, publicRefusal, continuation, signingReadiness, pendingPublication, transitions, authority, beforeStatus,
				afterStatus: await inherited.recoveryStatus(), inheritedScopes: declarations.map(row => row.scope), signedRoleCuts,
				beforeHead, afterHead: await ahe.readHead(parsed.value), beforeFloor,
				publicationObservations: startupTrace.filter(row => row.site === "pending-publication-readiness"),
				recoveryObservations: startupTrace.filter(row => row.site === "pending-recovery-result"),
				issuanceNativeUnchanged: issuanceBefore === await inheritedSnapshotImage(identity, false, "--drp-issuance-v1"),
				journalNativeUnchanged: journalBefore === await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1"),
				sharedDependencies, sharedDependenciesAfter: await Promise.all((sharedDependencies ?? []).map(async row => {
					const blob = await ahe!.getBlob(row.digest), addressed = blob.ok && blob.value !== null ? digestBlob(blob.value) : undefined;
					return {...row, unchanged: addressed?.ok === true && addressed.value === row.digest && blob.ok && blob.value?.length === row.byteLength};
				})),
				afterFloor: await floor.readRetirementImage({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}}),
				exactInheritedContentUnchanged: beforeContent === await inheritedSnapshotImage(legacyIdentity, true),
				exactInheritedImageUnchanged: beforeImage === await inheritedSnapshotImage(legacyIdentity)};
			return {...result, joins};
		}
		const applicationImage = async (): Promise<string> => {
			const issueScope = {objectId: boot.objectId, author: input.author}, lineage = await issuance!.readLineage(issueScope);
			if (lineage.next > 8) throw new Error("migration refusal fixture native row bound exceeded");
			const issued = await Promise.all(Array.from({length: lineage.next}, (_, sequence) => issuance!.readIssued(issueScope, sequence)));
			const image = await journal!.readRetirementImage!({objectId: boot.objectId});
			if (!image.ok) throw new Error("migration refusal native journal image unavailable");
			return stable({lineage, issued, outbox: await issuance!.readOutboxPage({scope: issueScope, limit: 64}), journal: image.value.canonicalRows});
		};
		const beforeApplication = fault === "corrupt" || fault === "quota" ? await applicationImage() : undefined;
		phase = "authenticated-inherited-current-reopen";
		observeMaturePhase(phase);
		let signCalls = 0;
		const delivered: Record<string, unknown>[] = [];
		const signer = async (value: Uint8Array) => {signCalls++; return ed25519.sign(value, seed(identity));};
		const reopenCurrent = (snapshotStore = requireValue(inherited, "inherited owner absent")) => reopenCreatorSuccessorAdoption({
			settlementFloor: floor, authenticationProfile: "creator-only", author: input.author, catalog: input.application.catalog,
			detachedSignature: boot.invite.detachedGenesisSignature, exactCanonicalAnchorPreimageBytes: boot.invite.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: boot.invite.exactCanonicalParametersCarrierBytes,
			exactCanonicalPinnedGenesisBootstrapOperationBytes: encodeCanonical(input.application.bootstrapOperation),
			expectedRoomHead: {objectId: boot.objectId, epoch: authority.epoch, currentAnchorDigest: authority.anchorDigest},
			issuanceStore: requireValue(issuance, "original issuance absent"), liveJournalStore: requireValue(journal, "original journal absent"), messageQueueManager: new MessageQueueManager<Message>({logConfig: {level: "silent"}}),
			networkNode: transport(input.author)(boot.objectId).networkNode, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest,
			onAdmittedVertex: (delivery: Parameters<V3AdmittedVertexSink>[0]) => {delivered.push({authorSequence: delivery.vertex.authorSequence,
				canonicalPreimage: hex(delivery.exactReceivedCanonicalPreimageBytes), signature: hex(delivery.signature)});},
			signRegisteredVertexDigest: signer, snapshotStore, store: requireValue(ahe, "original AHE absent"),
		});
		let reopened = await reopenCurrent();
		observeMaturePhase(phase + ":returned");
		// The original cold owner uses this signer for a key-possession challenge
		// (creator-adoption.ts), not a vertex. Keep it separate from application issue.
		let reopenSignCalls = signCalls;
		let interruption: Record<string, unknown> | undefined;
		let refusal: Record<string, unknown> | undefined;
		let continuation: unknown = {ok: false, kind: "current-reopen-unavailable"};
		let expectedContinuationSequence: number | undefined;
		if (reopened.ok) {
			plane = reopened.handle as V3PlaneHandle;
			phase = "original-creator-maintenance-bind";
			observeMaturePhase(phase);
			vote = await openBrowserSealVoteStore({databaseName: identity});
			evidence = await openBrowserSealEvidenceStore({databaseName: identity});
			if (vote.observation.incarnation !== evidence.observation.incarnation) throw new Error("original signing incarnation disagreement");
			const bindCurrent = (snapshotStore: NonNullable<typeof inherited>) => bindCreatorLiveClose({plane: requireValue(plane, "current plane absent"), signer: requireValue(input.creatorFinalitySigner, "original finality signer absent"), snapshotStore,
				promotionContext: {catalog: input.application.catalog, roomHeadAuthority: floor,
					pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest,
					exactCanonicalPinnedGenesisTrustStateRecordBytes: pinnedTrustBlob.value},
				storageIncarnation: requireValue(vote, "native vote absent").observation.incarnation, voteStore: requireValue(vote, "native vote absent").store, evidenceStore: requireValue(evidence, "native evidence absent").store,
				// Original room mergedSettlementPlan([], priorPlan), restricted to the
				// genuine empty displaced-source preview; this is sizing, not authority.
				prospectiveSettlementPreview: preview => {
					if (preview.scope.objectId !== boot.objectId || preview.scope.author !== input.author ||
						preview.successorEpoch !== authority.epoch + 1) throw new Error("original fixture settlement preview scope differs");
					const prior = preview.priorPlan;
					if ((prior?.entries.length ?? 0) !== 0) throw new Error("original fixture empty-source preview has displaced settlement debt");
					const fenceSequence = preview.priorFenceEpoch !== preview.successorEpoch ? null : prior?.fenceSequence ?? null;
					const plan = prior !== null && prior.fenceSequence === fenceSequence ? prior : Object.freeze({
						entries: Object.freeze([...(prior?.entries ?? [])]), fenceSequence,
						revision: prior === null ? 0 : prior.revision + 1, scope: preview.scope});
					return Object.freeze({plan, fenceLogicalTime: Math.max(20, preview.minimumLogicalTime)});
				},
				exactCanonicalAvailabilityPolicyBytes: encodeCanonical({minLocalCopies: 1, minMirrorReceipts: 0, minRollbackGenerations: 2, mode: "local-only"}),
				onObservation: () => undefined});
			if (fault === "after-apply") {
				phase = "original-classification-after-apply-interruption";
				Reflect.set(globalThis, "__r8MigrationFault", "after-apply");
				Reflect.set(globalThis, "__r8MigrationFaultCount", 0);
				close = await bindCurrent(inherited);
				const injected = Reflect.get(globalThis, "__r8MigrationFaultCount") === 1;
				if (close.ok || !injected) throw new Error("original post-apply interruption was not reached:" + JSON.stringify({close, injected}));
				const pendingStatus = await inherited.recoveryStatus();
				const pendingCoordinator = await requireValue(ahe.readRetirementControl, "original coordinator reader absent").call(ahe, parsed.value);
				const pendingPhysicalUnchanged = beforeContent === await inheritedSnapshotImage(legacyIdentity, true);
				const interruptedBind = close;
				plane.deactivate(); plane = undefined; close = undefined;
				const nativeOwners = [{owner: "interrupted-inherited", close: () => inherited!.close()},
					{owner: "interrupted-ahe", close: () => ahe!.close()}, {owner: "interrupted-issuance", close: () => issuance!.close()},
					{owner: "interrupted-journal", close: () => journal!.close()}, {owner: "interrupted-vote", close: () => vote!.close()},
					{owner: "interrupted-evidence", close: () => evidence!.close()}, {owner: "interrupted-floor", close: () => floor.close()}];
				const stopped = await Promise.allSettled(nativeOwners.map(async owner => {await owner.close(); joins.push({owner: owner.owner, ok: true});}));
				const faults = stopped.flatMap(value => value.status === "rejected" ? [value.reason] : []);
				if (faults.length) throw new AggregateError(faults, "interrupted original native owners failed to join");
				phase = "fresh-same-intent-cold-owner-reopen";
				floor = await createBrowserRoomHeadAuthority({databaseName: identity + "--startup-floor", initialization: {kind: "reopen"}});
				ahe = await createBrowserAheDurableStore({databaseName: identity + "--ahe"});
				inherited = await createBrowserSnapshotQuarantineStore({primaryDatabaseName: legacyIdentity});
				issuance = await createBrowserDurableIssuanceStore({primaryDatabaseName: identity});
				journal = await createBrowserDurableLiveJournalStore({primaryDatabaseName: identity});
				vote = await openBrowserSealVoteStore({databaseName: identity});
				evidence = await openBrowserSealEvidenceStore({databaseName: identity});
				const coldPendingStatus = await inherited.recoveryStatus();
				const coldCoordinator = await requireValue(ahe.readRetirementControl, "cold original coordinator reader absent").call(ahe, parsed.value);
				reopened = await reopenCurrent();
				if (!reopened.ok) throw new Error("genuine SAME-intent cold current unavailable:" + JSON.stringify(reopened));
				plane = reopened.handle as V3PlaneHandle;
				const beforeRefusedSignCalls = signCalls;
				const issueScope = {objectId: boot.objectId, author: input.author};
				const coldLineageBefore = await issuance.readLineage(issueScope);
				const snapshotBeforeRefusal = await inheritedSnapshotImage(legacyIdentity);
				const issuanceBeforeRefusal = await inheritedSnapshotImage(identity, false, "--drp-issuance-v1");
				const journalBeforeRefusal = await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1");
				const deliveriesBeforeRefusal = delivered.length;
				const coldRefusal = await plane.issueLocal({operations: [{logicalTime: 19, operation: message("inherited-pending-refusal")}], signRegisteredVertexDigest: signer});
				interruption = {injected, interruptedBind, pendingStatus, coldPendingStatus, pendingCoordinator, coldCoordinator, pendingPhysicalUnchanged,
					coldRefusal, coldRefusalSignCalls: signCalls - beforeRefusedSignCalls,
					coldLineageBefore, coldLineageAfter: await issuance.readLineage(issueScope), snapshotBeforeRefusal,
					snapshotAfterRefusal: await inheritedSnapshotImage(legacyIdentity), issuanceBeforeRefusal,
					issuanceAfterRefusal: await inheritedSnapshotImage(identity, false, "--drp-issuance-v1")};
				interruption.journalBeforeRefusal = journalBeforeRefusal;
				interruption.journalAfterRefusal = await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1");
				interruption.refusalDeliveries = delivered.length - deliveriesBeforeRefusal;
				reopenSignCalls = signCalls;
			}
			phase = "original-creator-maintenance-bind";
			observeMaturePhase(phase);
			close = await bindCurrent(inherited);
			if (interruption !== undefined) {
				interruption.confirmBinding = close.ok ? {ok: true} : close;
				interruption.snapshotAfterConfirm = await inheritedSnapshotImage(legacyIdentity);
			}
			if (close.ok && interruption !== undefined) {
				// A failed native issuance correctly halts its runtime. Only the
				// original cold recovery owner may establish its durable outcome.
				phase = "original-post-confirm-issuance-cold-recovery";
				const beforeRecoverySigns = signCalls;
				await close.handle.stop(); plane.deactivate(); close = undefined; plane = undefined;
				joins.push({owner: "post-confirm-runtime", ok: true});
				reopened = await reopenCurrent();
				interruption.issuanceColdRecovery = reopened.ok ? {ok: true} : reopened;
				if (!reopened.ok) throw new Error("original post-confirm issuance recovery unavailable:" + JSON.stringify(reopened));
				plane = reopened.handle as V3PlaneHandle;
				interruption.issuanceRecoverySignCalls = signCalls - beforeRecoverySigns;
				interruption.recoveredLineage = await issuance.readLineage({objectId: boot.objectId, author: input.author});
				close = await bindCurrent(inherited);
				reopenSignCalls = signCalls;
			}
			if (close.ok || fault === "unknown" || fault === "corrupt" || fault === "quota") {
				phase = "original-current-continuation";
				observeMaturePhase(phase);
				const before = fault === "unknown" || fault === "corrupt" || fault === "quota" ? {signCalls, deliveries: delivered.length,
					lineage: await issuance.readLineage({objectId: boot.objectId, author: input.author}),
					issuance: await inheritedSnapshotImage(identity, false, "--drp-issuance-v1"),
					journal: await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1"),
					snapshot: await inheritedSnapshotImage(legacyIdentity)} : undefined;
				const lineage = await issuance.readLineage({objectId: boot.objectId, author: input.author});
				expectedContinuationSequence = lineage.next;
				let continuationLogicalTime = 20;
				if (fault === "mature" && lineage.next > 0) {
					const prior = await issuance.readIssued({objectId: boot.objectId, author: input.author}, lineage.next - 1);
					if (prior === null) throw new Error("genuine mature predecessor issued row absent");
					const body = decodeCanonical(prior.envelope.canonicalPreimageBytes) as Record<string, unknown>;
					if (!Number.isSafeInteger(body.logicalTime)) throw new Error("genuine mature predecessor logical time invalid");
					continuationLogicalTime = Math.max(20, Number(body.logicalTime) + 2);
				}
				continuation = await plane.issueLocal({operations: [{logicalTime: continuationLogicalTime, operation: message("inherited-continuation")}], signRegisteredVertexDigest: signer});
				observeMaturePhase(phase + ":returned");
				if (before !== undefined) refusal = {signCalls: signCalls - before.signCalls, deliveries: delivered.length - before.deliveries,
					lineageUnchanged: stable(await issuance.readLineage({objectId: boot.objectId, author: input.author})) === stable(before.lineage),
					issuanceUnchanged: before.issuance === await inheritedSnapshotImage(identity, false, "--drp-issuance-v1"),
					journalUnchanged: before.journal === await inheritedSnapshotImage(identity, false, "--drp-live-journal-v1"),
					snapshotUnchanged: before.snapshot === await inheritedSnapshotImage(legacyIdentity)};
			} else continuation = {ok: false, kind: close.reason};
		}
		let protectedInventory: unknown;
		if (inherited.captureRecoveryRoleInventory === undefined) throw new Error("original inherited role inventory owner absent");
		try {
			const inventory = await inherited.captureRecoveryRoleInventory({objectId: boot.objectId});
			protectedInventory = {ok: true, owner: inventory.owner, scopes: inventory.scopes, legacyScopes: inventory.legacyScopes};
		} catch (error) {
			protectedInventory = {ok: false, code: error instanceof Error ? Reflect.get(error, "code") : undefined, detail: String(error)};
		}
		const afterStatus = await inherited.recoveryStatus().catch(error => ({ok: false, error: String(error)}));
		if (interruption !== undefined) interruption.afterCoordinator = await requireValue(ahe.readRetirementControl, "original coordinator reader absent").call(ahe, parsed.value);
		let canonicalCorrespondence: Record<string, unknown> = {ok: false};
		if (typeof continuation === "object" && continuation !== null && Reflect.get(continuation, "ok") === true) {
			const accepted = continuation as {authorSequence: number; digest: string};
			const issueScope = {objectId: boot.objectId, author: input.author};
			const issued = await issuance.readIssued(issueScope, accepted.authorSequence);
			if (issued === null) throw new Error("genuine continuation native issued row absent");
			const {canonicalPreimageBytes: bytes, digest: digestBytes, signature} = issued.envelope;
			const canonical = decodeCanonical(bytes) as Record<string, unknown>;
			const outbox = (await issuance.readOutboxPage({scope: issueScope, limit: 64})).find(row => row.commit.authorSequence === accepted.authorSequence);
			const currentScope = {objectId: boot.objectId, epoch: authority.epoch, anchorDigest: authority.anchorDigest};
			const ready = await journal.readiness({scope: currentScope});
			if (!ready.ok || !ready.ready) throw new Error("genuine continuation native journal unavailable");
			const page = await journal.readPage({scope: currentScope, snapshot: ready.snapshot, afterSequence: null, limit: 64});
			if (!page.ok) throw new Error("genuine continuation native journal page absent");
			canonicalCorrespondence = {ok: true,
				candidateExact: hex(encodeCanonical(canonical.operation)) === hex(encodeCanonical(message("inherited-continuation"))),
				scopeExact: canonical.epoch === authority.epoch && canonical.anchor === authority.anchorDigest && canonical.author === input.author && canonical.objectId === boot.objectId,
				digestExact: hex(hashDomain("ts-drp/vertex/v3", bytes)) === hex(digestBytes) && hex(digestBytes) === accepted.digest,
				signatureValid: ed25519.verify(signature, digestBytes, ed25519.getPublicKey(seed(identity))),
				outboxExact: outbox !== undefined && hex(outbox.commit.envelope.canonicalPreimageBytes) === hex(bytes) && hex(outbox.commit.envelope.digest) === hex(digestBytes) && hex(outbox.commit.envelope.signature) === hex(signature),
				journalExact: page.rows.some(row => row.sourceKind === "local-issued" && row.author === input.author && row.authorSequence === accepted.authorSequence && row.vertexDigest === accepted.digest),
				deliveryExact: delivered.some(row => row.authorSequence === accepted.authorSequence && row.canonicalPreimage === hex(bytes) && row.signature === hex(signature))};
		}
		const coldAuthority = plane?.currentEphemeralAuthority();
		const sharedDependenciesAfter = sharedDependencies === undefined ? undefined : await Promise.all(sharedDependencies.map(async row => {
			const blob = await ahe!.getBlob(row.digest);
			if (!blob.ok || blob.value === null) return {...row, unchanged: false};
			const addressed = digestBlob(blob.value);
			return {...row, unchanged: addressed.ok && addressed.value === row.digest && blob.value.length === row.byteLength};
		}));
		result = {phase, sealed, transitions, authority, scope, beforeStatus, inspection, refusal, corruption, configuredRecoveryLimits,
			mature: fault === "mature" ? {signedRoleCuts, inheritedScopes: declarations.map(row => row.scope), sharedDependencies, sharedDependenciesAfter,
				expectedContinuationSequence, pendingCoverage: "not-reached-no-synthetic-floor"} : undefined,
			deliveredCount: delivered.length,
			applicationNativeUnchanged: beforeApplication === undefined ? undefined : beforeApplication === await applicationImage(),
			unknown: unknownDeclaration === undefined ? undefined : {scope: unknownDeclaration.scope,
				inspection: await inherited.inspectRecovery(unknownDeclaration)},
			cold: reopened.ok ? {ok: true, epoch: plane?.epoch, anchorDigest: coldAuthority?.anchorDigest,
				aclDigest: coldAuthority?.aclDigest, currentWriter: coldAuthority?.isCurrentWriter(input.author)} : reopened,
			binding: close === undefined ? null : close.ok ? {ok: true} : close, continuation, protectedInventory, canonicalCorrespondence, interruption,
			signCalls, reopenSignCalls, continuationSignCalls: signCalls - reopenSignCalls,
			afterStatus, exactInheritedImageUnchanged: beforeImage === await inheritedSnapshotImage(legacyIdentity),
			exactInheritedContentUnchanged: beforeContent === await inheritedSnapshotImage(legacyIdentity, true),
			beforeHead, afterHead: await ahe.readHead(parsed.value), beforeFloor,
			afterFloor: await floor.readRetirementImage({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}})};
	} catch (error) {throw new Error(phase + ": " + String(error), {cause: error});} finally {
		observeMaturePhase("original-native-cleanup");
		const stopped = await Promise.allSettled([Promise.resolve().then(() => close?.ok ? close.handle.stop() : undefined)]);
		plane?.deactivate();
		const owners = [{name: "room", close: () => room?.close()}, {name: "legacy", close: () => legacy?.close()},
			{name: "inherited", close: () => inherited?.close()}, {name: "source-snapshot", close: () => original?.close()},
			{name: "ahe", close: () => ahe?.close()}, {name: "issuance", close: () => issuance?.close()},
			{name: "journal", close: () => journal?.close()}, {name: "votes", close: () => vote?.close()},
			{name: "evidence", close: () => evidence?.close()}, {name: "floor", close: () => floor.close()}];
		const joined = await Promise.allSettled(owners.map(async owner => {await owner.close(); joins.push({owner: owner.name, ok: true});}));
		const faults = [...stopped, ...joined].flatMap(value => value.status === "rejected" ? [value.reason] : []);
		if (faults.length) throw new AggregateError(faults, "original inherited migration native owners failed to join");
		observeMaturePhase("original-native-cleanup:joined");
	}
	return {...result, joins};
}

async function runHealthyTerminalMigration(identity:string, inheritedSnapshot = false, persistedReopen = false):Promise<Record<string,unknown>> {
	const traceStart=startupTrace.length;
	const phase = (value:string):void => {startupTrace.push({site:"terminal-migration-phase",value});};
	Reflect.set(globalThis,"r8HealthyTerminalTrace",()=>startupTrace.slice(traceStart));
	Reflect.set(globalThis,"__r8TerminalContinuationDiagnostic",true);
	const boot=await bootstrap(identity),input=await roomInput(boot,"create"),nonce=seed(identity+"--migration-nonce");
	const targetObjectId="creator:"+hex(hashDomain("ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({rehearsalNonce:nonce,sourceObjectId:boot.objectId})).subarray(0,16));
	const acl=decodeCanonical(boot.invite.exactCanonicalLatchedAclBytes) as Record<string,unknown>;
	const targetCreatorInvite=await createV3RoomCreatorInviteMaterial({
		blueprintDigest:requireValue(input.application.catalog.blueprintDigests[0],"genuine target blueprint"),
		exactCanonicalApplicationStateBytes:encodeCanonical([]),
		exactCanonicalLatchedAclBytes:encodeCanonical({...acl,objectId:targetObjectId}),
		exactCanonicalParametersCarrierBytes:boot.invite.exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes:boot.invite.exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes:boot.invite.exactCanonicalSignerSetBytes,
		objectId:targetObjectId,signGenesisAnchorDigest:async value=>ed25519.sign(value,seed(identity))});
	let floor=await createBrowserRoomHeadAuthority({databaseName:identity+"--startup-floor",initialization:{kind:"create"}});
	let room:V3RoomSession|undefined;
	let migrationTarget:V3RoomSession|undefined;
	const joins:{owner:string;ok:boolean}[]=[];
	let result:Record<string,unknown>|undefined;
	try {
		phase("source-create");
		room=await createV3RoomSession({...input,roomHeadAuthority:floor,onMigrationTarget:target=>{migrationTarget=target;}});
		await waitForV3RoomStartupForDiagnostics(room);
		await room.issue({action:"message",clientOperationId:"before-terminal",text:"native durable source"});
		if (inheritedSnapshot) {
			phase("source-seal");
			const sealed = await room.sealEpoch();
			if (!sealed.ok) throw new Error("inherited source healthy seal refused");
			phase("source-adoption");
			await room.adoptCreatorSuccessor();
			phase("source-current-issue");
			await room.issue({action:"message",clientOperationId:"after-rollover",text:"native current epoch source"});
		}
		const before=room.projection();
		const canonicalState = requireValue(input.application.migration,"genuine migration semantics").canonicalStateBytes;
		const beforeCanonicalStateBytes=hex(canonicalState(before));
		phase("rehearsal");
		const rehearsal=await room.rehearseMigration({rehearsalNonce:nonce,targetCreatorInvite});
		phase("activation");
		const activation=await room.activateMigration({exactCanonicalRecordBytes:rehearsal.exactCanonicalRecordBytes,
			recordVertexDigest:rehearsal.recordVertexDigest,targetCreatorInvite});
		const after=room.projection(),targetRoomId=room.roomId;
		const afterCanonicalStateBytes=hex(canonicalState(after));
		let sourceRefusal:string|undefined;
		try{await room.issue({action:"message",clientOperationId:"forbidden-source",text:"forbidden"});}
		catch(error){sourceRefusal=String(error);}
		let target=requireValue(migrationTarget,"genuine migration target callback absent");
		phase("target-continuation");
		await target.issue({action:"message",clientOperationId:"after-terminal",text:"native target continuation"});
		let continuation=target.projection();
		let reopened:Record<string,unknown>|undefined;
		if (persistedReopen) {
			phase("terminal-source-close");
			await room.close();room=undefined;joins.push({owner:"pre-reopen-redirected-room",ok:true});
			await floor.close();joins.push({owner:"pre-reopen-native-floor",ok:true});
			migrationTarget=undefined;
			phase("terminal-source-reopen");
			floor=await createBrowserRoomHeadAuthority({databaseName:identity+"--startup-floor",initialization:{kind:"reopen"}});
			room=await createV3RoomSession({...await roomInput(boot,"reopen"),roomHeadAuthority:floor,
				onMigrationTarget:value=>{migrationTarget=value;}});
			await waitForV3RoomStartupForDiagnostics(room);
			target=requireValue(migrationTarget,"persisted terminal migration target callback absent");
			const recoveredCanonicalStateBytes=hex(canonicalState(target.projection()));
			const expectedCanonicalStateBytes=hex(canonicalState(continuation));
			phase("reopened-target-continuation");
			await target.issue({action:"message",clientOperationId:"after-terminal-reopen",text:"native reopened target continuation"});
			continuation=target.projection();
			reopened={objectId:target.objectId,roomId:room.roomId,recoveredCanonicalStateBytes,expectedCanonicalStateBytes};
		}
		const sourceFloorScope={objectId:boot.objectId,pinnedGenesisAnchorDigest:boot.invite.pinnedGenesisAnchorDigest};
		const sourceFloor=await floor.read({scope:sourceFloorScope});
		if(!sourceFloor.ok)throw new Error("genuine source floor absent");
		const advanced=await floor.begin({scope:sourceFloorScope,expected:sourceFloor.state,
			next:{objectId:boot.objectId,epoch:sourceFloor.state.stable.epoch+1,currentAnchorDigest:hex(seed(identity+"--foreign-floor"))}});
		if(!advanced.ok)throw new Error("genuine source floor advance refused");
		const committed=await floor.commit({scope:sourceFloorScope,expected:advanced.state});
		if(!committed.ok)throw new Error("genuine source floor commit refused");
		const refusalTraceStart=startupTrace.length;
		let staleSourceRefusal:string|undefined;
		try{await target.issue({action:"message",clientOperationId:"stale-source",text:"must not sign"});}
		catch(error){staleSourceRefusal=String(error);}
		const staleSourceNative=startupTrace.slice(refusalTraceStart).filter(row=>row.site==="terminal-native-issue-error");
		result={rehearsal:{activated:rehearsal.activated,importedOperationCount:rehearsal.importedOperationCount},
			activation,before,after,beforeCanonicalStateBytes,afterCanonicalStateBytes,
			continuation,afterStaleRefusal:target.projection(),staleSourceRefusal,staleSourceNative,
			resourceCharges:startupTrace.slice(traceStart).filter(row=>row.site==="migration-proof-capture"||row.site==="migration-proof-enforced-forecast"),
			objectId:target.objectId,targetRoomId,targetObjectId,sourceRefusal,reopened};
	}catch(error) {
		phase("failure-cleanup");
		throw new Error(JSON.stringify({error:String(error),cause:error instanceof Error?error.cause instanceof Error?
			{error:String(error.cause),cause:error.cause.cause,stack:error.cause.stack}:error.cause:undefined,
			stack:error instanceof Error?error.stack:undefined,
			native:startupTrace.slice(traceStart).filter(row=>row.site==="terminal-native-issue-error")}),{cause:error});
	}finally {
		Reflect.deleteProperty(globalThis,"__r8TerminalContinuationDiagnostic");
		const joined=await Promise.allSettled([{owner:"redirected-room",close:()=>room?.close()},
			{owner:"native-floor",close:()=>floor.close()}].map(async value=>{await value.close();joins.push({owner:value.owner,ok:true});}));
		const faults=joined.flatMap(value=>value.status==="rejected"?[value.reason]:[]);
		if(faults.length)throw new AggregateError(faults,"original terminal migration native owners failed to join");
	}
	return {...result,joins};
}

async function inheritedSnapshotImage(identity: string, physicalOnly = false, suffix = "--drp-snapshot-quarantine-v1"): Promise<string> {
	const opened = indexedDB.open(identity + suffix);
	const database = await new Promise<IDBDatabase>((resolve, reject) => {opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);});
	try {
		const names = Array.from(database.objectStoreNames);
		const transaction = database.transaction(names, "readonly");
		const joined = new Promise<void>((resolve, reject) => {transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);});
		const rows = await Promise.all(names.map(name => new Promise<unknown>((resolve, reject) => {const request = transaction.objectStore(name).getAll(); request.onsuccess = () => resolve([name, request.result]); request.onerror = () => reject(request.error);}))); 
		await joined;
		return stable({version: database.version, rows: physicalOnly ? rows.flatMap(value => {
			const [name, entries] = value as [string, Record<string, unknown>[]];
			if (name === "chunks") return [[name, entries]];
			if (name !== "scopes") return [];
			return [[name, entries.map(({retention: _role, descriptors: _descriptors, ...content}) => content)]];
		}) : rows});
	} finally {database.close();}
}
export async function runSourceBinding(identity:string, mode?:"floor"|"journal"|"bootstrap"|"custody"|"release"|"ahe"|"ahe-stale"|"stalled"|"stalled-bytes"|"stalled-control"|"stalled-terminal-publish"|"stalled-terminal-bytes"|"stalled-retained-publication"|"stalled-distinct-publication"|"stalled-pending-publication"|"stalled-ingress-barrier"|"replay-read-budget", sourcePayloadBytes=0) {
	if(!Number.isSafeInteger(sourcePayloadBytes)||sourcePayloadBytes<0||sourcePayloadBytes>8192||
		(sourcePayloadBytes!==0&&mode!==undefined&&mode!=="stalled"))throw new Error("source resource workload invalid");
	const sourceText=(label:string)=>sourcePayloadBytes===0?"source-"+label:label.repeat(sourcePayloadBytes);
	const sourceTexts=[sourceText("a"),sourceText("b")];
	const phaseDurations:{phase:string;milliseconds:number}[]=[];
	const timed=async<T>(phase:string,action:()=>Promise<T>):Promise<T>=>{
		const started=performance.now();
		try{return await action();}finally{phaseDurations.push({phase,milliseconds:performance.now()-started});}
	};
	const resourceTraceStart=startupTrace.length;
	const creatorIdentity=identity+"-creator",recipientIdentity=identity+"-recipient";
	const creatorAuthor=hex(ed25519.getPublicKey(seed(creatorIdentity))),recipientAuthor=hex(ed25519.getPublicKey(seed(recipientIdentity)));
	const objectId="creator:"+hex(hashDomain("ts-drp/r8-local-source-fixture/v1",new TextEncoder().encode(identity))).slice(0,32);
	const application=createTransientPayloadApplication(),signers=[{publicKey:creatorAuthor,signerId:"creator"}];
	const invite=await createV3RoomCreatorInviteMaterial({blueprintDigest:requireValue(application.catalog.blueprintDigests[0],"blueprint"),exactCanonicalApplicationStateBytes:encodeCanonical([]),exactCanonicalLatchedAclBytes:encodeCanonical({epoch:0,kind:"drp-v3-latched-acl",members:[{author:creatorAuthor,finalityKey:creatorAuthor,groups:["admin","finality","writer"]},{author:recipientAuthor,finalityKey:null,groups:["writer"]}].sort((a,b)=>a.author<b.author?-1:1),objectId,permissionless:false,version:3}),exactCanonicalParametersCarrierBytes:encodeCanonical(parameters),exactCanonicalProfileBytes:encodeCanonical({cryptoSuiteId:"ed25519-sha256-v3",profileId:"creator-trusted-settlement-v1",quorum:1,signers}),exactCanonicalSignerSetBytes:encodeCanonical(signers),objectId,signGenesisAnchorDigest:async value=>ed25519.sign(value,seed(creatorIdentity))});
	const creatorBoot:Bootstrap={identity:creatorIdentity,invite,objectId,profile:"creator-trusted-settlement-v1"};
	const recipientBoot:Bootstrap={...creatorBoot,identity:recipientIdentity};
	let creator:Awaited<ReturnType<typeof createV3RoomSession>>|undefined,recipient:Awaited<ReturnType<typeof createV3RoomSession>>|undefined,current:V3PlaneHandle|undefined;
	let issuance:Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>|undefined,journal:Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>|undefined,ahe:Awaited<ReturnType<typeof createBrowserAheDurableStore>>|undefined,snapshot:Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>>|undefined;
	let creatorFloor:Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>|undefined,recipientFloor:Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>|undefined;
	let result:Record<string,unknown>|undefined,failed=false,primary:unknown,phase="creator-room-open";
	const joins:Record<string,unknown>[]=[];
	try {
		creatorFloor=await createBrowserRoomHeadAuthority({databaseName:creatorIdentity+"--startup-floor",initialization:{kind:"create"}});
		recipientFloor=await createBrowserRoomHeadAuthority({databaseName:recipientIdentity+"--startup-floor",initialization:{kind:"create"}});
		creator=await createV3RoomSession({...await roomInput(creatorBoot,"create"),application,roomHeadAuthority:creatorFloor});
		await waitForV3RoomStartupForDiagnostics(creator);
		phase="recipient-room-open";
		recipient=await createV3RoomSession({...await roomInput(recipientBoot,"create",false),application,roomHeadAuthority:recipientFloor});
		await Promise.all([waitForV3RoomStartupForDiagnostics(creator),waitForV3RoomStartupForDiagnostics(recipient)]);
		phase="creator-acl-stage";
		await creator.issue({action:"acl",kind:"grant",group:"referee",target:recipientAuthor});
		await creator.issue({action:"acl",kind:"revoke",group:"writer",target:recipientAuthor});
		const closed=await timed("creator-sealing",()=>creator!.sealEpoch());
		if(!closed.ok)throw new Error("genuine creator close:"+JSON.stringify(closed));
		phase="old-recipient-after-remote-close";
		// Remote close cannot change this independent old Writer's native replica.
		await timed("old-writer-issue-publication",()=>Promise.all([
			recipient!.issue({action:"message",clientOperationId:"owned-a",text:sourceTexts[0]}),
			recipient!.issue({action:"message",clientOperationId:"owned-b",text:sourceTexts[1]}),
		]));
		// Genuine old Writer application join at a nonzero ordinal is not the
		// exact pinned bootstrap and cannot disappear from the protected census.
		if(mode==="bootstrap")await recipient.issue(application.bootstrapOperation);
		await recipient.close();recipient=undefined;joins.push({owner:"old-recipient-room",ok:true});
		phase="creator-adoption";
		await timed("creator-adoption",()=>creator!.adoptCreatorSuccessor());
		const authority=creator.authority();
		if(authority.epoch!==1)throw new Error("genuine adopted creator head missing");
		await creator.close();creator=undefined;joins.push({owner:"adopted-creator-room",ok:true});
		phase="cold-referee-reopen";
		issuance=await createBrowserDurableIssuanceStore({primaryDatabaseName:recipientIdentity});
		journal=await createBrowserDurableLiveJournalStore({primaryDatabaseName:recipientIdentity});
		ahe=await createBrowserAheDurableStore({databaseName:creatorIdentity+"--ahe"});
		snapshot=await createBrowserSnapshotQuarantineStore({primaryDatabaseName:creatorIdentity});
		const scope={author:recipientAuthor,objectId};
		const signer=async(value:Uint8Array)=>ed25519.sign(value,seed(recipientIdentity));
		const transformed=[{action:"message",clientOperationId:"owned-a",text:"transformed-"+sourceTexts[0]},{action:"message",clientOperationId:"owned-b",text:"transformed-"+sourceTexts[1]}];
		const delivered:Record<string,unknown>[]=[];
		let foreignFloorCommitted=false,foreignAheCommitted=false;
		let failFloorRelease=false,floorReleaseAttempts=0;
		const faultJoins:Promise<void>[]=[];
		const settlementFloor=mode==="release"?{
			readRetirementImage:(value:Parameters<typeof creatorFloor.readRetirementImage>[0])=>creatorFloor!.readRetirementImage(value),
			acquireNativeReadReservation:async(value:Parameters<typeof creatorFloor.acquireNativeReadReservation>[0])=>{
				const held=await creatorFloor!.acquireNativeReadReservation(value);
				return {check:()=>held.check(),release:()=>{
					floorReleaseAttempts+=1;
					const joined=held.release();
					if(failFloorRelease){failFloorRelease=false;faultJoins.push(joined);throw new Error("focused synchronous native floor release fault");}
					return joined;
				}};
			},
		}:creatorFloor;
		let pauseRetainedPublication:(()=>Promise<void>)|undefined;
		const nativeNetwork=transport(recipientAuthor)(objectId).networkNode;
		const networkNode={...nativeNetwork,publishMessage:async(...args:Parameters<typeof nativeNetwork.publishMessage>)=>{await pauseRetainedPublication?.();return nativeNetwork.publishMessage(...args);}};
		const ingressAppends:Record<string,unknown>[]=[];
		let replayReadinessCalls=0,replayPageCalls=0;
		const ingressJournal=mode==="replay-read-budget"?{...journal,
			readiness:async(input:Parameters<typeof journal.readiness>[0])=>{replayReadinessCalls++;return journal!.readiness(input);},
			readPage:async(input:Parameters<typeof journal.readPage>[0])=>{replayPageCalls++;return journal!.readPage(input);},
		}:mode!=="stalled-ingress-barrier"?journal:{...journal,
			appendAccepted:async(input:Parameters<typeof journal.appendAccepted>[0])=>{
				const value=await journal!.appendAccepted(input);
				if(input.sourceKind==="received")ingressAppends.push({vertexDigest:input.vertexDigest,
					canonicalPreimage:hex(input.exactCanonicalPreimageBytes!),signature:hex(input.detachedSignature!),result:value});
				return value;
			}};
		const reopened=await reopenCreatorSuccessorAdoption({settlementFloor,authenticationProfile:"creator-only",author:recipientAuthor,catalog:application.catalog,detachedSignature:invite.detachedGenesisSignature,exactCanonicalAnchorPreimageBytes:invite.exactCanonicalGenesisAnchorPreimageBytes,exactCanonicalParametersCarrierBytes:invite.exactCanonicalParametersCarrierBytes,exactCanonicalPinnedGenesisBootstrapOperationBytes:encodeCanonical(application.bootstrapOperation),expectedRoomHead:{objectId,epoch:authority.epoch,currentAnchorDigest:authority.anchorDigest},issuanceStore:issuance,liveJournalStore:ingressJournal,messageQueueManager:new MessageQueueManager<Message>({logConfig:{level:"silent"}}),networkNode,onAdmittedVertex:delivery=>{delivered.push({authorSequence:delivery.vertex.authorSequence,canonicalPreimage:hex(delivery.exactReceivedCanonicalPreimageBytes),signature:hex(delivery.signature),foreignFloorCommitted,foreignAheCommitted});},pinnedGenesisAnchorDigest:invite.pinnedGenesisAnchorDigest,signRegisteredVertexDigest:signer,snapshotStore:snapshot,store:ahe,settlementPolicy:{blueprintDigest:requireValue(application.catalog.blueprintDigests[0],"blueprint"),derive:(operations:readonly Readonly<Record<string,unknown>>[])=>({disposition:"transform" as const,operations:operations.map(operation=>({ ...operation,text:"transformed-"+String(operation.text)}))})}});
		if(reopened.ok!==true)throw new Error("genuine Referee cold reopen:"+JSON.stringify(reopened));
		current=reopened.handle as V3PlaneHandle;
		let source:V3RebaseSource|undefined;
		for(let index=0;index<8;index++) {
			const page=await current.readRebaseOutbox();
			if(!page.ok)throw new Error("original source read:"+JSON.stringify(page));
			if(page.kind==="empty")break;
			if(page.source.intents.some(intent=>intent.operation.clientOperationId==="owned-a")){source=page.source;break;}
		}
		source=requireValue(source,"actual historical source missing");
		if(source.intents.length!==2)throw new Error("original complete two-intent source missing");
		let signCalls=0;
		let queueForeignWriter:(()=>void)|undefined;
		const countedSigner=async(value:Uint8Array)=>{signCalls++;if(mode==="release")failFloorRelease=true;queueForeignWriter?.();return signer(value);};
		const beforeNew=await issuance.readLineage(scope);
		const ordinaryNew=await current.issueLocal({operations:[{logicalTime:20,operation:{action:"message",clientOperationId:"unrelated-new",text:"unrelated"}}],signRegisteredVertexDigest:countedSigner});
		const afterNew=await issuance.readLineage(scope),newSignCalls=signCalls;
		phase="current-referee-plan-fence";
		const originalPlan=await issuance.readSettlementPlan(scope);
		await issuance.transactWriteSettlementPlan({expectedRevision:originalPlan?.revision??null,scope,plan:{scope,revision:originalPlan===null?0:originalPlan.revision+1,fenceSequence:null,entries:originalPlan?.entries??[]}});
		const next=(await issuance.readLineage(scope)).next;
		const fence=await current.issueLocal({operations:[{logicalTime:21,operation:{action:AUTHOR_FENCE_ACTION,fenceSequence:next,version:1}}],signRegisteredVertexDigest:signer});
		if(!fence.ok)throw new Error("original Referee fence:"+JSON.stringify(fence));
		const prior=requireValue(await issuance.readSettlementPlan(scope)??undefined,"fenced plan");
		const intentDigest=hashDomain("ts-drp/settlement-replacement-intents/v1",encodeCanonical(transformed));
		const digest=Uint8Array.from(source.vertexDigest.match(/../g)!.map(value=>Number.parseInt(value,16)));
		const entry={disposition:"transform" as const,sourceSequence:source.authorSequence,sourceDigest:digest,replacementSequence:null,replacementProgress:{version:1 as const,intentCount:2,intentDigest,chunks:[]}};
		phase="current-referee-original-source-plan";
		await issuance.transactWriteSettlementPlan({expectedRevision:prior.revision,scope,plan:{...prior,revision:prior.revision+1,entries:[...prior.entries,entry]}});
		const effect={kind:"replacement" as const,sourceSequence:source.authorSequence,fromIntent:0,throughIntent:1,intentDigest};
		const localInput={operations:[{logicalTime:22,operation:transformed[0]!}],planEffect:effect,signRegisteredVertexDigest:countedSigner};
		const wrongCandidate=await source.issueReplacement({...localInput,operations:[{logicalTime:22,operation:{...transformed[0]!,text:"unrelated"}}]});
		const wrongScope=await source.issueReplacement.call({} as V3RebaseSource,localInput);
		const wrongSource=await source.issueReplacement({...localInput,planEffect:{...effect,sourceSequence:source.authorSequence+100}});
		const beforePositive=await issuance.readLineage(scope),negativeSignCalls=signCalls;
		if(mode==="replay-read-budget") {
			phase="native-replay-read-budget";
			const beforeCalls={readiness:replayReadinessCalls,pages:replayPageCalls};
			let censusBytes=0,proofByteCharge=0;
			await source.withDependencies(async(read,charge)=>{censusBytes=read.readExactCanonicalCensus().byteLength;proofByteCharge=charge;});
			const dependencyCalls={readiness:replayReadinessCalls-beforeCalls.readiness,pages:replayPageCalls-beforeCalls.pages};
			const prefix=await source.issueReplacement(localInput);
			const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
			result={mode,dependencyCalls,censusBytes,proofByteCharge,prefix,suffix,signCalls,plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope)};
		} else if(mode==="stalled-pending-publication") {
			phase="stalled-native-pending-publication-admission";
			let unblock!:()=>void,entered!:()=>void;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pending:Promise<unknown>[]=[],settled:{index:number;value:unknown}[]=[];
			try {
				pauseRetainedPublication=async()=>{entered();await gate;};
				const held=current.republishRetained();pending.push(held);await began;
				const beforeLineage=await issuance.readLineage(scope);
				for(let index=0;index<40;index++)pending.push(current.publishPending().then(value=>{settled.push({index,value});return value;}));
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeRelease={settled:structuredClone(settled),owners:readV3RuntimeOwnerCensus(current),signCalls};
				unblock();await Promise.all(pending);pauseRetainedPublication=undefined;
				const afterJoin=readV3RuntimeOwnerCensus(current);
				const admitted=settled.filter(row=>(row.value as {ok:boolean}).ok).map(row=>row.value);
				const retry=await current.publishPending();
				const afterLineage=await issuance.readLineage(scope);
				const prefix=await source.issueReplacement(localInput);
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				result={mode,beforeRelease,afterJoin,settled,admittedResultsDistinct:new Set(admitted).size===admitted.length,retry,
					beforeLineage,afterLineage,prefix,suffix,signCalls};
			}finally{unblock();await Promise.allSettled(pending);pauseRetainedPublication=undefined;}
		} else if(mode==="stalled-distinct-publication") {
			phase="stalled-native-distinct-publication-admission";
			let unblock!:()=>void,entered!:()=>void;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pending:Promise<unknown>[]=[],settled:{index:number;value:unknown}[]=[];
			try {
				pauseRetainedPublication=async()=>{entered();await gate;};
				const held=current.republishRetained();pending.push(held);await began;
				const beforeLineage=await issuance.readLineage(scope);
				for(let index=0;index<40;index++) {
					// Every intervening fresh publication turn makes a different FIFO cut.
					pending.push(current.publishPending());
					pending.push(current.republishRetained().then(value=>{settled.push({index,value});return value;}));
				}
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeRelease={settled:structuredClone(settled),owners:readV3RuntimeOwnerCensus(current),signCalls};
				unblock();await Promise.all(pending);pauseRetainedPublication=undefined;
				const afterJoin=readV3RuntimeOwnerCensus(current),retry=await current.republishRetained();
				const afterLineage=await issuance.readLineage(scope);
				const prefix=await source.issueReplacement(localInput);
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				result={mode,beforeRelease,afterJoin,settled,retry,beforeLineage,afterLineage,prefix,suffix,signCalls};
			}finally{unblock();await Promise.allSettled(pending);pauseRetainedPublication=undefined;}
		} else if(mode==="stalled-retained-publication") {
			phase="stalled-native-retained-publication";
			let unblock!:()=>void,entered!:()=>void,enteredJobs=0;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pending:Promise<unknown>[]=[];
			const observations:{signCalls:number;enteredJob:number}[]=[];
			try {
				pauseRetainedPublication=async()=>{
					enteredJobs++;observations.push({signCalls,enteredJob:enteredJobs});
					if(enteredJobs===1){entered();await gate;throw new Error("focused entered native publisher failure");}
				};
				const first=current.republishRetained();pending.push(first);
				await Promise.race([began,first.then(()=>{throw new Error("native retained publisher did not enter");})]);
				const beforeIssue=Array.from({length:40},()=>current.republishRetained());pending.push(...beforeIssue);
				// A later request cannot join work queued before this native issue.
				const prefix=source.issueReplacement(localInput);pending.push(prefix);
				const afterIssue=Array.from({length:40},()=>current.republishRetained());pending.push(...afterIssue);
				const beforeRelease={enteredJobs,signCalls,beforeIssueFlights:new Set(beforeIssue).size,afterIssueFlights:new Set(afterIssue).size,
					distinctQueueCuts:beforeIssue[0]!==afterIssue[0]};
				unblock();await Promise.all(pending);pauseRetainedPublication=undefined;
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				const publishedSuffix=await current.publishPending();
				result={mode,beforeRelease,first:await first,beforeIssue:await Promise.all(beforeIssue),afterIssue:await Promise.all(afterIssue),
					prefix:await prefix,suffix,publishedSuffix,signCalls,observations,enteredJobs,plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope)};
			}finally{unblock();await Promise.allSettled(pending);pauseRetainedPublication=undefined;}
		} else if(mode==="stalled-ingress-barrier") {
			phase="stalled-native-ingress-barrier";
			const transition=await current.beginTerminalTransition();
			if(!transition.ok)throw new Error("original terminal entry refused:"+JSON.stringify(transition));
			const issued=requireValue(await issuance.readIssued(scope,fence.authorSequence)??undefined,"native fence carrier absent");
			const wire=V3Envelope.encode({canonicalPreimage:issued.envelope.canonicalPreimageBytes,signature:issued.envelope.signature}).finish();
			const retained=(data:Uint8Array)=>Message.create({type:11,objectId:current!.topic,sender:recipientAuthor,data});
			let unblock!:()=>void,entered!:()=>void;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pending:Promise<unknown>[]=[];
			try {
				pauseRetainedPublication=async()=>{entered();await gate;};
				const publication=current.republishRetained();pending.push(publication);
				await Promise.race([began,publication.then(()=>{throw new Error("native retained publication did not enter");})]);
				const floorScope={scope:{objectId,pinnedGenesisAnchorDigest:invite.pinnedGenesisAnchorDigest}};
				const floorBefore=await Promise.all([creatorFloor.readRetirementImage(floorScope),recipientFloor.readRetirementImage(floorScope)]);
				const beforeLineage=await issuance.readLineage(scope),caller=retained(new Uint8Array(wire));
				const routed=routeV3RetainedIngress(current,caller);
				const afterValid=readV3RuntimeOwnerCensus(current);
				caller.data.fill(0);caller.sender="mutated-caller";
				const oversizedRouted=routeV3RetainedIngress(current,retained(new Uint8Array(parameters.maxPendingBytes+1)));
				const afterOversized=readV3RuntimeOwnerCensus(current);
				const fillerBytes=parameters.maxPendingBytes-wire.byteLength;
				const fillerRouted=routeV3RetainedIngress(current,retained(new Uint8Array(fillerBytes)));
				const afterFill=readV3RuntimeOwnerCensus(current);
				const overflowRouted=routeV3RetainedIngress(current,retained(Uint8Array.of(0xff)));
				const afterOverflow=readV3RuntimeOwnerCensus(current);
				unblock();await publication;pauseRetainedPublication=undefined;
				const beforeResume=readV3RuntimeOwnerCensus(current),resumed=transition.capability.resume();
				// Barrier callbacks enqueue before this original native read; joining
				// it joins the admitted ingress without inventing a test-only drain.
				await Promise.resolve();const joinedRead=await current.readRebaseOutbox();
				const afterJoin=readV3RuntimeOwnerCensus(current),afterLineage=await issuance.readLineage(scope);
				const floorAfter=await Promise.all([creatorFloor.readRetirementImage(floorScope),recipientFloor.readRetirementImage(floorScope)]);
				const prefix=await source.issueReplacement(localInput);
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				result={mode,wireBytes:wire.byteLength,fillerBytes,maxPendingBytes:parameters.maxPendingBytes,
					routed,oversizedRouted,fillerRouted,overflowRouted,afterValid,afterOversized,afterFill,afterOverflow,beforeResume,
					resumed,joinedRead,afterJoin,beforeLineage,afterLineage,floorBefore,floorAfter,ingressAppends,
					expected:{vertexDigest:fence.digest,canonicalPreimage:hex(issued.envelope.canonicalPreimageBytes),signature:hex(issued.envelope.signature)},
					prefix,suffix,signCalls,publication:await publication,plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope)};
			}finally{unblock();await Promise.allSettled(pending);pauseRetainedPublication=undefined;transition.capability.resume();}
		} else if(mode==="stalled-terminal-publish"||mode==="stalled-terminal-bytes") {
			phase="stalled-native-terminal-publication";
			const transition=await current.beginTerminalTransition();
			if(!transition.ok)throw new Error("original terminal entry refused:"+JSON.stringify(transition));
			let unblock!:()=>void,entered!:()=>void,captureEntries=0,enteredJobs=0;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pending:Promise<unknown>[]=[],settled:{index:number;value:unknown}[]=[];
			const queuedOperation={...transformed[0]!},queuedOperations=[{logicalTime:22,operation:queuedOperation}];
			const queuedInputBytes=encodeCanonical(queuedOperation).byteLength;
			try {
				pauseRetainedPublication=async()=>{enteredJobs++;entered();await gate;};
				const publication=current.republishRetained();pending.push(publication);
				await Promise.race([began,publication.then(()=>{throw new Error("native retained publication did not enter");})]);
				// A legal ordinary input is not a terminal migration activation. It
				// must retain its original absent/malformed result, with no signing.
				for(let index=0;index<40;index++) {
					const caller=new Proxy({operations:mode==="stalled-terminal-bytes"?queuedOperations:localInput.operations,signRegisteredVertexDigest:countedSigner},
						{ownKeys(target){captureEntries++;return Reflect.ownKeys(target);}});
					pending.push(transition.capability.publishTerminal(caller).then(value=>{settled.push({index,value});return value;}));
				}
				if(mode==="stalled-terminal-bytes")queuedOperation.text="x".repeat(parameters.maxEpochBytes+1);
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeRelease={settled:structuredClone(settled),captureEntries,signCalls,enteredJobs,owners:readV3RuntimeOwnerCensus(current)};
				const prematureResume=transition.capability.resume();
				unblock();await Promise.all(pending);pauseRetainedPublication=undefined;
				// Keep the RED's old premature-resume outcome observable while
				// joining its original native owners rather than hanging teardown.
				const retryTransition=prematureResume.ok?await current.beginTerminalTransition():transition;
				if(!retryTransition.ok)throw new Error("joined terminal retry unavailable:"+JSON.stringify(retryTransition));
				const overflow=mode==="stalled-terminal-bytes"?await retryTransition.capability.publishTerminal({operations:queuedOperations,signRegisteredVertexDigest:countedSigner}):undefined;
				const afterOverflowOwners=readV3RuntimeOwnerCensus(current);
				const retry=await retryTransition.capability.publishTerminal({operations:localInput.operations,signRegisteredVertexDigest:countedSigner});
				const resumed=retryTransition.capability.resume();
				const afterJoinOwners=readV3RuntimeOwnerCensus(current);
				const prefix=await source.issueReplacement(localInput);
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				result={mode,beforeRelease,prematureResume,settled,captureEntries,retry,resumed,prefix,suffix,signCalls,publication:await publication,queuedInputBytes,afterJoinOwners,overflow,afterOverflowOwners,
					plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope)};
			}finally{unblock();await Promise.allSettled(pending);}
		} else if(mode==="stalled-control") {
			phase="stalled-native-read-control-admission";
			let unblock!:()=>void,entered!:()=>void,enteredJobs=0;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pending:Promise<unknown>[]=[],settled:{index:number;ok:boolean;reason?:string}[]=[],reads:unknown[]=[],transitions:unknown[]=[],proofCharges:number[]=[];
			try {
				const consume=async(read:Parameters<Parameters<typeof source.withDependencies>[0]>[0],charge:number)=>{
					enteredJobs++;proofCharges.push(charge);
					if(read.readExactCanonicalCensus().byteLength===0)throw new Error("native protected census absent");
					if(enteredJobs===1){entered();await gate;}
				};
				const first=source.withDependencies(consume);pending.push(first);await began;
				for(let index=0;index<40;index++)pending.push(source.withDependencies(consume).then(()=>{
					settled.push({index,ok:true});},error=>{settled.push({index,ok:false,reason:String(error)});}));
				for(let index=0;index<40;index++)pending.push(current.readRebaseOutbox().then(value=>{reads.push(value);}));
				// Required terminal control does not borrow the full read-work pool.
				// Repeated entry must not retain another unbounded capability queue.
				const firstTransition=current.beginTerminalTransition();pending.push(firstTransition);
				for(let index=0;index<39;index++)pending.push(current.beginTerminalTransition().then(value=>{transitions.push(value);}));
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeRelease={settled:structuredClone(settled),reads:structuredClone(reads),transitions:structuredClone(transitions),enteredJobs,signCalls};
				unblock();await Promise.all(pending);
				const transition=await firstTransition;if(!transition.ok)throw new Error("required terminal control refused:"+JSON.stringify(transition));
				const resumed=transition.capability.resume();
				let afterJoin=false;await source.withDependencies(async()=>{afterJoin=true;});
				const prefix=await source.issueReplacement(localInput);
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				result={mode,beforeRelease,settled,reads,transitions,resumed,prefix,suffix,afterJoin,enteredJobs,proofCharges,signCalls,
					plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope)};
			}finally{unblock();await Promise.allSettled(pending);}
		} else if(mode==="stalled-bytes") {
			phase="stalled-native-runtime-input-bytes";
			let unblock!:()=>void,entered!:()=>void,enteredJobs=0;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pausedSigner=async(value:Uint8Array)=>{enteredJobs++;entered();await gate;return countedSigner(value);};
			const pending:Promise<unknown>[]=[],settled:{index:number;value:unknown}[]=[];
			try {
				const prefix=source.issueReplacement({...localInput,signRegisteredVertexDigest:pausedSigner});
				pending.push(prefix);await began;
				// Legal individually encoded message operations; deliberately not the
				// authenticated two-intent source candidate. Original authorization
				// must still reject them after bounded private capture joins.
				const operations=Array.from({length:16},(_,index)=>({logicalTime:22+2*index,
					operation:{action:"message",clientOperationId:"byte-probe-"+index,text:"x".repeat(60_000)}}));
				const batchBytes=operations.reduce((sum,row)=>sum+encodeCanonical(row.operation).byteLength,0);
				const firstBytes=localInput.operations.reduce((sum,row)=>sum+encodeCanonical(row.operation).byteLength,0);
				let expectedHeldBytes=firstBytes,expectedHeldCount=1;
				const expectedRefused:number[]=[];
				for(let index=0;index<40;index++) {
					if(expectedHeldCount>=32||expectedHeldBytes+batchBytes>parameters.maxPendingBytes)expectedRefused.push(index);
					else{expectedHeldCount++;expectedHeldBytes+=batchBytes;}
					const candidate={...localInput,operations,planEffect:{...effect,fromIntent:0,throughIntent:16}};
					pending.push(source.issueReplacement(candidate).then(value=>{settled.push({index,value});return value;}));
				}
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeRelease={settled:structuredClone(settled),enteredJobs,signCalls};
				unblock();const completedPrefix=await prefix;await Promise.all(pending);
				const suffix=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
				result={mode,beforeRelease,expectedRefused,expectedHeldBytes,expectedHeldCount,firstBytes,batchBytes,
					limitBytes:parameters.maxPendingBytes,completedPrefix,suffix,settled,signCalls,
					plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope),
					qualification:"Encoded private runtime operation custody, not proof charges or heap. Invalid source candidates retain original authentication refusal; genuine prefix/suffix and all native owners must join."};
			}finally{unblock();await Promise.allSettled(pending);}
		} else if(mode==="stalled") {
			phase="stalled-native-settlement-admission";
			let unblock!:()=>void,entered!:()=>void,enteredJobs=0,captureEntries=0;
			const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
			const pausedSigner=async(value:Uint8Array)=>{enteredJobs++;entered();await gate;return countedSigner(value);};
			const pending:Promise<unknown>[]=[],settled:{index:number;value:unknown}[]=[];
			try {
				const prefix=timed("held-replacement-prefix-inclusive",()=>source!.issueReplacement({...localInput,signRegisteredVertexDigest:pausedSigner}));
				pending.push(prefix);
				await began;
				for(let index=0;index<40;index++) {
					const caller=new Proxy(localInput,{ownKeys(target){captureEntries++;return Reflect.ownKeys(target);}});
					pending.push(source.issueReplacement(caller).then(value=>{settled.push({index,value});return value;}));
				}
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeRelease={settled:structuredClone(settled),enteredJobs,captureEntries,signCalls,
					deliveryCount:delivered.length,owners:readV3RuntimeOwnerCensus(current)};
				const checkpoint=Reflect.get(globalThis,"__r8ActiveResourceCheckpoint");
				if(typeof checkpoint==="function")await checkpoint("nonempty-replacement-held-before-release");
				unblock();
				const completedPrefix=await prefix;
				await Promise.all(pending);
				const afterPrefixOwners=readV3RuntimeOwnerCensus(current);
				if(typeof checkpoint==="function")await checkpoint("nonempty-replacement-prefix-joined");
				// Admission must also precede the separate terminal barrier wait.
				// Its original control capability must remain able to release a full
				// input pool; putting that control behind the same pool deadlocks.
				const transition=await current.beginTerminalTransition();
				if(!transition.ok)throw new Error("original terminal barrier unavailable:"+JSON.stringify(transition));
				const waiting:Promise<unknown>[]=[],barrierSettled:unknown[]=[];
				let barrierCaptures=0;
				for(let index=0;index<40;index++) {
					const caller=new Proxy({operations:localInput.operations,signRegisteredVertexDigest:countedSigner},
						{ownKeys(target){barrierCaptures++;return Reflect.ownKeys(target);}});
					waiting.push(current.issueLocal(caller).then(value=>{barrierSettled.push(value);return value;}));
				}
				pending.push(...waiting);
				await new Promise(resolve=>setTimeout(resolve,0));
				const beforeResume={settled:structuredClone(barrierSettled),barrierCaptures,signCalls};
				const resumed=transition.capability.resume();
				await Promise.all(waiting);
				const suffix=await timed("replacement-suffix",()=>source!.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}}));
				const afterSuffixOwners=readV3RuntimeOwnerCensus(current);
				if(typeof checkpoint==="function")await checkpoint("nonempty-replacement-suffix-joined");
				result={mode,beforeRelease,afterPrefixOwners,afterSuffixOwners,beforeResume,resumed,barrierSettled,completedPrefix,suffix,settled,enteredJobs,signCalls,
					plan:await issuance.readSettlementPlan(scope),lineage:await issuance.readLineage(scope),delivered};
			}finally{unblock();await Promise.allSettled(pending);}
		} else if(mode==="release") {
			phase="synchronous-native-release-fault";
			const refused=await source.issueReplacement(localInput);
			await Promise.all(faultJoins);
			const aheRead=await ahe.acquireNativeReadReservation({objectId});
			try{await aheRead.check();}finally{await aheRead.release();}
			const journalRead=await journal.acquireNativeReadReservation({objectId});
			try{await journalRead.check();}finally{await journalRead.release();}
			const afterFault=await issuance.readLineage(scope);
			const halted=await source.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}});
			result={mode,refused,halted,beforePositive,afterFault,lineage:await issuance.readLineage(scope),signCalls,floorReleaseAttempts,otherOwnersReacquired:true,plan:await issuance.readSettlementPlan(scope),committed:await issuance.readIssued(scope,beforePositive.next)};
		} else if(mode==="bootstrap") {
			phase="nonzero-bootstrap-near-miss";
			const beforePlan=await issuance.readSettlementPlan(scope);
			const refused=await source.issueReplacement(localInput);
			result={mode,refused,beforePositive,lineage:await issuance.readLineage(scope),beforePlan,plan:await issuance.readSettlementPlan(scope),signCalls};
		} else if(mode==="ahe-stale") {
			phase="native-authentic-same-closure-head-currency";
			const foreign=await createBrowserAheDurableStore({databaseName:creatorIdentity+"--ahe"});
			const parsedObject=parseStorageObjectId(objectId),parsedGeneration=parseGenerationId(hex(hashDomain("ts-drp/r8-native-ahe-stale/v1",encodeCanonical(identity))));
			if(!parsedObject.ok||!parsedGeneration.ok)throw new Error("original native AHE identifiers invalid");
			try {
				const original=await foreign.recoverActiveGeneration(parsedObject.value);
				if(!original.ok||original.value.kind!=="active")throw new Error("authentic adopted AHE source unavailable:"+JSON.stringify(original));
				const beforeHead=original.value.head;
				const begun=await foreign.beginGeneration({objectId:parsedObject.value,generationId:parsedGeneration.value,baseExpectedHead:beforeHead,closure:original.value.adoptedGeneration.closure});
				if(!begun.ok)throw new Error("original AHE begin refused:"+JSON.stringify(begun));
				for(const reference of original.value.adoptedGeneration.closure) {
					const blob=await foreign.getBlob(reference.digest);
					if(!blob.ok||blob.value===null||blob.value.byteLength!==reference.byteLength)throw new Error("exact original AHE blob unavailable");
					const cached=await foreign.putCachedBlob({objectId:parsedObject.value,generationId:parsedGeneration.value,digest:reference.digest,bytes:blob.value});
					const promoted=await foreign.promoteReference({objectId:parsedObject.value,generationId:parsedGeneration.value,digest:reference.digest});
					if(!cached.ok||!promoted.ok)throw new Error("original AHE exact blob promote refused");
				}
				const completed=await foreign.completeGeneration({objectId:parsedObject.value,generationId:parsedGeneration.value});
				if(!completed.ok)throw new Error("original AHE complete refused:"+JSON.stringify(completed));
				const swapped=await foreign.swapHead({objectId:parsedObject.value,generationId:parsedGeneration.value,expectedHead:beforeHead});
				if(!swapped.ok)throw new Error("original native same-closure head CAS refused:"+JSON.stringify(swapped));
				const beforePlan=await issuance.readSettlementPlan(scope),beforeDelivery=delivered.length;
				const staleHead=await source.issueReplacement(localInput);
				result={mode,beforeHead,afterHead:swapped.value.head,exactClosureUnchanged:completed.value.closureDigest===original.value.adoptedGeneration.closureDigest,staleHead,beforePositive,lineage:await issuance.readLineage(scope),beforePlan,plan:await issuance.readSettlementPlan(scope),deliveryDelta:delivered.length-beforeDelivery,signCalls};
			}finally{await foreign.close();joins.push({owner:"foreign-ahe-head-currency",ok:true});}
		} else if(mode==="ahe") {
			phase="native-whole-job-ahe-custody";
			const foreign=await createBrowserAheDurableStore({databaseName:creatorIdentity+"--ahe"});
			const parsedObject=parseStorageObjectId(objectId),parsedGeneration=parseGenerationId(hex(hashDomain("ts-drp/r8-native-ahe-custody/v1",encodeCanonical(identity))));
			if(!parsedObject.ok||!parsedGeneration.ok)throw new Error("original native AHE identifiers invalid");
			try {
				const original=await foreign.recoverActiveGeneration(parsedObject.value);
				if(!original.ok||original.value.kind!=="active")throw new Error("genuine adopted AHE source unavailable:"+JSON.stringify(original));
				const beforeImage=await foreign.readRetirementAdmissionImage!(parsedObject.value);
				if(!beforeImage.ok)throw new Error("native AHE preimage unavailable");
				let foreignWrite:ReturnType<typeof foreign.beginGeneration>|undefined;
				queueForeignWriter=()=>{queueForeignWriter=undefined;foreignWrite=foreign.beginGeneration({objectId:parsedObject.value,generationId:parsedGeneration.value,baseExpectedHead:original.value.head,closure:original.value.adoptedGeneration.closure}).then(value=>{if(value.ok)foreignAheCommitted=true;return value;});void foreignWrite.catch(()=>undefined);};
				const prefix=await source.issueReplacement(localInput);
				if(foreignWrite===undefined)throw new Error("native signer did not queue original foreign AHE writer");
				const committed=await foreignWrite;
				const afterImage=await foreign.readRetirementAdmissionImage!(parsedObject.value);
				if(!afterImage.ok)throw new Error("native AHE postimage unavailable");
				const atDelivery=prefix.ok?delivered.filter(row=>row.authorSequence===prefix.authorSequence):[];
				const issued=prefix.ok?await issuance.readIssued(scope,prefix.authorSequence):null;
				const currentScope={objectId,epoch:authority.epoch,anchorDigest:authority.anchorDigest};
				const readiness=await journal.readiness({scope:currentScope});
				if(!readiness.ok||!readiness.ready)throw new Error("native journal custody readback unavailable");
				const rows=await journal.readPage({scope:currentScope,snapshot:readiness.snapshot,afterSequence:null,limit:64});
				if(!rows.ok)throw new Error("native journal custody rows unavailable");
				result={mode,prefix,beforePositive,lineage:await issuance.readLineage(scope),signCalls,foreignAheCommitted,atDelivery,committed,beforeImage:beforeImage.value,afterImage:afterImage.value,issuedExact:prefix.ok&&issued!==null&&hex(issued.envelope.digest)===prefix.digest,journalExact:prefix.ok&&rows.rows.some(row=>row.sourceKind==="local-issued"&&row.author===recipientAuthor&&row.authorSequence===prefix.authorSequence&&row.vertexDigest===prefix.digest),plan:await issuance.readSettlementPlan(scope)};
			}finally{await foreign.close();joins.push({owner:"foreign-ahe-custody",ok:true});}
		} else if(mode==="custody") {
			phase="native-whole-job-floor-custody";
			const foreign=await createBrowserRoomHeadAuthority({databaseName:creatorIdentity+"--startup-floor",initialization:{kind:"reopen"}});
			const floorScope={objectId,pinnedGenesisAnchorDigest:invite.pinnedGenesisAnchorDigest};
			const observation=await foreign.acquireRetirementControl({scope:floorScope});
			const commitment={decisionDigest:hex(hashDomain("ts-drp/r8-native-floor-custody/v1",encodeCanonical(identity))),sourceProofDigest:source.vertexDigest,throughEpoch:0};
			let foreignWrite:Promise<unknown>|undefined;
			try {
				queueForeignWriter=()=>{queueForeignWriter=undefined;foreignWrite=observation.prepareFence(commitment).then(value=>{foreignFloorCommitted=true;return value;});void foreignWrite.catch(()=>undefined);};
				const prefix=await source.issueReplacement(localInput);
				if(foreignWrite===undefined)throw new Error("native signer did not queue the foreign floor writer");
				await foreignWrite;
				const atDelivery=prefix.ok?delivered.filter(row=>row.authorSequence===prefix.authorSequence):[];
				result={mode,prefix,beforePositive,lineage:await issuance.readLineage(scope),signCalls,foreignFloorCommitted,atDelivery,plan:await issuance.readSettlementPlan(scope)};
				const abort=await foreign.acquireRetirementControl({scope:floorScope});
				try{await abort.abortPrepared(commitment);}finally{await abort.release();}
			}finally{await observation.release();await foreign.close();joins.push({owner:"foreign-floor-custody",ok:true});}
		} else if(mode==="floor") {
			phase="whole-floor-control-currency";
			const floorScope={objectId,pinnedGenesisAnchorDigest:invite.pinnedGenesisAnchorDigest};
			const beforeFloor=await creatorFloor.readRetirementImage({scope:floorScope});
			// Mechanical native prepare/abort changes complete control currency, not
			// the stable safety floor; this is not protocol retirement authority.
			const commitment={decisionDigest:hex(hashDomain("ts-drp/r8-native-floor-currency/v1",encodeCanonical(identity))),sourceProofDigest:source.vertexDigest,throughEpoch:0};
			const prepared=await creatorFloor.acquireRetirementControl({scope:floorScope});
			try{await prepared.prepareFence(commitment);}finally{await prepared.release();}
			const aborted=await creatorFloor.acquireRetirementControl({scope:floorScope});
			try{await aborted.abortPrepared(commitment);}finally{await aborted.release();}
			const afterFloor=await creatorFloor.readRetirementImage({scope:floorScope});
			const beforePlan=await issuance.readSettlementPlan(scope);
			const staleFloor=await source.issueReplacement(localInput);
			result={mode,beforeFloor,afterFloor,staleFloor,beforePositive,lineage:await issuance.readLineage(scope),beforePlan,plan:await issuance.readSettlementPlan(scope),signCalls};
		} else if(mode==="journal") {
			phase="original-journal-native-currency-controls";
			const native=await createBrowserDurableLiveJournalStore({primaryDatabaseName:identity+"-journal-controls"});
			try {
				const oldScope={objectId,epoch:0,anchorDigest:invite.pinnedGenesisAnchorDigest};
				const currentScope={objectId,epoch:authority.epoch,anchorDigest:authority.anchorDigest};
				const currentAnchor=await journal.readSignedAnchorEnvelope({scope:currentScope,maxBytes:LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES});
				if(!currentAnchor.ok||currentAnchor.kind!=="present")throw new Error("genuine current journal anchor unavailable");
				const genesis=await native.installGenesis({objectId,exactCanonicalAnchorPreimageBytes:invite.exactCanonicalGenesisAnchorPreimageBytes,detachedAnchorSignature:invite.detachedGenesisSignature,exactCanonicalParametersCarrierBytes:invite.exactCanonicalParametersCarrierBytes});
				const installed=await native.installEpochAnchor(currentAnchor.envelope);
				if(!genesis.ok||!installed.ok)throw new Error("genuine journal control anchors unavailable");
				const currentRow={scope:currentScope,sourceKind:"local-issued" as const,vertexDigest:fence.digest,author:recipientAuthor,authorSequence:fence.authorSequence};
				const currentAppend=await native.appendAccepted(currentRow);
				const checkpoint=async()=>{
					const image=await native.readRetirementImage!({objectId});if(!image.ok)throw new Error("journal checkpoint unavailable");
					return {imageDigest:image.value.image.imageDigest,controlBytes:image.value.control===null?null:encodeJournalRetirementControl(image.value.control)};
				};
				const initial=await checkpoint();
				const oldRow={scope:oldScope,sourceKind:"local-issued" as const,vertexDigest:source.vertexDigest,author:recipientAuthor,authorSequence:source.authorSequence};
				const earlierScopeAppend=await native.appendAccepted({...oldRow,expectedNativeImage:initial});
				const point=await checkpoint();
				const duplicate=await native.appendAccepted({...oldRow,expectedNativeImage:point});
				const afterDuplicate=await checkpoint();
				const stale=await native.appendAccepted({...currentRow,expectedNativeImage:initial});
				const oversized=await native.appendAccepted({...oldRow,expectedNativeImage:{...point,controlBytes:new Uint8Array(LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES+1)}});
				result={mode,currentAppend,earlierScopeAppend,point,duplicate,afterDuplicate,stale,oversized,finalPoint:await checkpoint()};
			}finally{await native.close();joins.push({owner:"native-journal-controls",ok:true});}
		} else {
		phase="owned-source-transform-intervals";
		const prefix=await timed("replacement-prefix",()=>source!.issueReplacement(localInput));
		const afterPrefix=await issuance.readSettlementPlan(scope);
		const stalePlan=await source.issueReplacement(localInput),afterStaleSignCalls=signCalls;
		const suffix=await timed("replacement-suffix",()=>source!.issueReplacement({...localInput,operations:[{logicalTime:23,operation:transformed[1]!}],planEffect:{...effect,fromIntent:1,throughIntent:2}}));
		const plan=await issuance.readSettlementPlan(scope),lineage=await issuance.readLineage(scope);
		const currentScope={objectId,epoch:authority.epoch,anchorDigest:authority.anchorDigest};
		const ready=await journal.readiness({scope:currentScope});
		if(!ready.ok||!ready.ready)throw new Error("actual replacement journal readiness unavailable");
		const journalPage=await journal.readPage({scope:currentScope,snapshot:ready.snapshot,afterSequence:null,limit:64});
		if(!journalPage.ok)throw new Error("actual replacement journal rows unavailable");
		const nativeOutbox=await issuance.readOutboxPage({scope,limit:64});
		const canonicalCorrespondence=await Promise.all([prefix,suffix].map(async(accepted,index)=>{
			if(!accepted.ok)return {ok:false};
			const issued=await issuance!.readIssued(scope,accepted.authorSequence);
			if(issued===null)return {ok:false};
			const bytes=issued.envelope.canonicalPreimageBytes,digestBytes=issued.envelope.digest,signature=issued.envelope.signature;
			const canonical=decodeCanonical(bytes) as Record<string,unknown>;
			const outbox=nativeOutbox.find(row=>row.commit.authorSequence===accepted.authorSequence);
			const local=journalPage.rows.find(row=>row.sourceKind==="local-issued"&&row.author===recipientAuthor&&row.authorSequence===accepted.authorSequence);
			return {ok:true,authorSequence:accepted.authorSequence,operation:canonical.operation,expectedOperation:transformed[index],candidateExact:hex(encodeCanonical(canonical.operation))===hex(encodeCanonical(transformed[index])),scopeExact:canonical.epoch===1&&canonical.anchor===authority.anchorDigest&&canonical.author===recipientAuthor&&canonical.objectId===objectId,digestExact:hex(hashDomain("ts-drp/vertex/v3",bytes))===hex(digestBytes)&&hex(digestBytes)===accepted.digest,signatureValid:ed25519.verify(signature,digestBytes,ed25519.getPublicKey(seed(recipientIdentity))),outboxExact:outbox!==undefined&&hex(outbox.commit.envelope.canonicalPreimageBytes)===hex(bytes)&&hex(outbox.commit.envelope.digest)===hex(digestBytes)&&hex(outbox.commit.envelope.signature)===hex(signature),journalExact:local?.vertexDigest===accepted.digest,deliveryExact:delivered.some(row=>row.authorSequence===accepted.authorSequence&&row.canonicalPreimage===hex(bytes)&&row.signature===hex(signature))};
		}));
		current.deactivate();current=undefined;joins.push({owner:"current-referee-registration",ok:true});
		const revokedSource=await source.issueReplacement(localInput);
		result={identity,originalRole:"Writer",currentRole:"Referee-only",originalEpoch:0,currentEpoch:1,source:{author:source.author,authorSequence:source.authorSequence,vertexDigest:source.vertexDigest,intents:source.intents},ordinaryNew,beforeNew,afterNew,newSignCalls,wrongCandidate,wrongScope,wrongSource,stalePlan,afterStaleSignCalls,negativeSignCalls,beforePositive,prefix,afterPrefix,suffix,plan,lineage,signCalls,revokedSource,canonicalCorrespondence};
		}
	} catch(error) {failed=true;primary=error;throw new Error(phase+": "+String(error),{cause:error});} finally {
		current?.deactivate();
		const owners=[{name:"creator-room",close:()=>creator?.close()},{name:"recipient-room",close:()=>recipient?.close()},{name:"issuance",close:()=>issuance?.close()},{name:"journal",close:()=>journal?.close()},{name:"ahe",close:()=>ahe?.close()},{name:"snapshot",close:()=>snapshot?.close()},{name:"creator-floor",close:()=>creatorFloor?.close()},{name:"recipient-floor",close:()=>recipientFloor?.close()}];
		const completed=await Promise.allSettled(owners.map(async owner=>{await owner.close();joins.push({owner:owner.name,ok:true});}));
		const faults=completed.flatMap(outcome=>outcome.status==="rejected"?[outcome.reason]:[]);
		if(faults.length)throw new AggregateError(failed?[primary,...faults]:faults,"source-binding original owner joins");
	}
	return {...result,joins,resourceWorkload:{sourcePayloadBytes,sourceTextBytes:sourceTexts.map(text=>new TextEncoder().encode(text).byteLength),phaseDurations},resourceObservations:startupTrace.slice(resourceTraceStart).filter(row=>
		["active-rebase-proof-charge","replacement-native-census"].includes(String(row.site))),
		resourceQualification:"Original nonempty Referee dependency-read proof charges and native census logical bytes; different joined lifetimes, not additive or heap/physical-storage peaks. This source-bound replacement has no creator NEW-operation forecast. Full source authentication, native sign custody, currentness, progress and joined release remain required."};
}
/** Genuine received custody plus an original native metadata checkpoint. The
 * checkpoint is an all-protected storage premise, NOT seven-domain migration
 * authorization: the private inherited classifier correctly requires held debt. */
async function runReceivedPending(identity: string): Promise<Record<string, unknown>> {
	const boot = await bootstrap(identity + "-sender", "creator-trusted-settlement-v1"), input = await roomInput(boot, "create");
	const receiverIdentity = identity + "-receiver", object = parseStorageObjectId(boot.objectId);
	if (!object.ok) throw new Error("received object invalid");
	const senderFloor = await createBrowserRoomHeadAuthority({databaseName: boot.identity + "--startup-floor", initialization: {kind: "create"}});
	let receiverFloor = await createBrowserRoomHeadAuthority({databaseName: receiverIdentity + "--startup-floor", initialization: {kind: "create"}});
	let sender: Awaited<ReturnType<typeof createV3RoomSession>> | undefined, receiver: Awaited<ReturnType<typeof createV3RoomSession>> | undefined;
	let senderStore: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined,
		senderSnapshots: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined,
		store: Awaited<ReturnType<typeof createBrowserAheDurableStore>> | undefined,
		snapshots: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined,
		issuance: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>> | undefined,
		journal: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>> | undefined;
	let recipientPort: SnapshotChunkProtocolPort | undefined;
	const joins: Record<string, unknown>[] = [], deliveries: Record<string, unknown>[] = [];
	let phase = "sender-create", result: Record<string, unknown> | undefined;
	try {
		sender = await createV3RoomSession({...input, roomHeadAuthority: senderFloor});
		await waitForV3RoomStartupForDiagnostics(sender);
		phase = "genuine-sender-issue";
		await sender.issue(message("received-source"));
		phase = "genuine-sender-seal";
		const sealed = await sender.sealEpoch();
		if (!sealed.ok) throw new Error("genuine sender close:" + JSON.stringify(sealed));
		phase = "genuine-sender-adopt";
		await sender.adoptCreatorSuccessor();
		senderStore = await createBrowserAheDurableStore({databaseName: boot.identity + "--ahe"});
		senderSnapshots = await createBrowserSnapshotQuarantineStore({primaryDatabaseName: boot.identity});
		const exported = await readCreatorSuccessorExport({store: senderStore, snapshotStore: senderSnapshots,
			catalog: input.application.catalog, objectId: object.value, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: boot.invite.exactCanonicalGenesisAnchorPreimageBytes, detachedGenesisSignature: boot.invite.detachedGenesisSignature});
		const sourceScope = await senderSnapshots.openScope(exported.declaration), source = sourceScope.verificationQuarantine.open(new AbortController().signal);
		let chunks: Uint8Array[];
		try {chunks = await Promise.all(exported.declaration.chunks.map(async descriptor => requireValue(await source.read(descriptor), "genuine received chunk absent")));}
		finally {await source.discard(); await sourceScope.release(); joins.push({owner: "received-source-read", ok: true});}
		// Reuse the original honest scripted chunk transport. The sole auxiliary
		// handshake is answered by the ORIGINAL signed material server using real
		// room-produced bytes; transport routing is a fixture premise, not auth.
		const scripted = new ScriptedSnapshotChunkPort({declaration: exported.declaration, chunks} as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
			new Map([["sender", "honest" as const]]), "receiver");
		const materialServer = createCreatorSuccessorMaterialServer({identity: {author: input.author, sign: input.signRegisteredVertexDigest,
			isAuthorizedAuthor: author => author === input.author}, localPeerId: "sender", manifestDigest: exported.declaration.scope.manifestDigest,
			material: exported.material, connectedPeers: () => ["receiver"]});
		recipientPort = {localPeerId: "receiver", connectedPeers: () => ["sender"], close: () => scripted.close(), serve: handler => scripted.serve(handler),
			open: async peer => {
				const chunkStream = await scripted.open(peer), frames: Uint8Array[] = [];
				let auxiliary = false;
				return {peerId: peer, abort: reason => chunkStream.abort(reason), close: () => chunkStream.close(),
					read: async (maximum, options) => auxiliary ? requireValue(frames.shift(), "signed material frame missing") : chunkStream.read(maximum, options),
					write: async (bytes, options) => {
						if (Reflect.get(decodeCanonical(bytes) as object, "kind") !== "creator-successor-material-request") return chunkStream.write(bytes, options);
						auxiliary = true;
						const inbound: SnapshotChunkProtocolStream = {peerId: "receiver", abort: () => undefined, close: async () => undefined,
							read: async () => {throw new Error("material control reread");}, write: async frame => {frames.push(Uint8Array.from(frame));}};
						if (!(await materialServer.control(inbound, bytes))) throw new Error("original signed material server refused");
					}};
			}};
		const {creatorFinalitySigner: _sourceFinality, ...nonFinalityInput} = input;
		const receiverInput = {...nonFinalityInput, databaseName: receiverIdentity, issuanceDatabaseName: receiverIdentity,
			migrationDatabaseNamespace: receiverIdentity, roomHeadAuthority: receiverFloor,
			onAcceptedVertex: async (vertex: Parameters<NonNullable<typeof input.onAcceptedVertex>>[0]) => {
				deliveries.push({sequence: vertex.authorSequence, digest: hex(vertex.digest), operation: vertex.operation});},
			openTransport: (id: string) => {const port = requireValue(recipientPort, "received transport absent"), base = transport(input.author)(id);
				Reflect.set(base.networkNode, "createSnapshotChunkProtocolHost", () => port); return base;}};
		phase = "genuine-recipient-install-interruption";
		receiver = await createV3RoomSession(receiverInput);
		await waitForV3RoomStartupForDiagnostics(receiver);
		startupControl.publicationFault = true;
		let interrupted: string | undefined;
		try {await receiver.installCreatorSuccessor({offer: exported.offer, peers: ["sender"]});} catch (error) {interrupted = String(error);}
		if (startupControl.publicationFault || interrupted === undefined) throw new Error("original received publication fault not consumed");
		await receiver.close(); receiver = undefined; joins.push({owner: "received-interrupted-room", ok: true});
		store = await createBrowserAheDurableStore({databaseName: receiverIdentity + "--ahe"});
		snapshots = await createBrowserSnapshotQuarantineStore({primaryDatabaseName: receiverIdentity});
		issuance = await createBrowserDurableIssuanceStore({primaryDatabaseName: receiverIdentity});
		journal = await createBrowserDurableLiveJournalStore({primaryDatabaseName: receiverIdentity});
		const beforeFloor = await receiverFloor.read({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}});
		if (!beforeFloor.ok || beforeFloor.state === null || beforeFloor.state.pending === null) throw new Error("received pending floor absent");
		phase = "genuine-received-certificate-readback";
		const selector = {objectId: exported.declaration.scope.objectId, epoch: exported.declaration.scope.epoch, anchor: exported.declaration.scope.anchor};
		const pending = beforeFloor.state.pending, custody = await snapshots.lookupReceivedRecoveryCertificate(selector);
		if (custody === null) throw new Error("genuine received native certificate absent");
		const certificate = decodeCanonical(custody.exactReceivedCertificateBytes) as {candidateGenerationId: string; candidateClosureDigest: string};
		phase = "original-all-protected-native-checkpoint";
		const census = await requireValue(store.acquireBoundedRecoveryRoleRead, "received census owner absent").call(store, {objectId: object.value, limits: AHE_BOUNDED_READ_LIMITS});
		if (!census.ok) throw new Error("received census refused");
		let head: typeof census.value.head, rows: typeof census.value.generations;
		try {head = census.value.head; rows = census.value.generations; if (!(await census.value.checkCurrency()).ok) throw new Error("received native source stale");}
		finally {await census.value.release(); joins.push({owner: "received-checkpoint-census", ok: true});}
		if (head.kind !== "present" || !rows.some(row => row.state === "Complete" && row.generationId === certificate.candidateGenerationId && row.closureDigest === certificate.candidateClosureDigest))
			throw new Error("received exact complete candidate absent");
		const recordDigests = rows.map(row => {const digest = digestBlob(encodeGenerationRecordV1(row));
			if (!digest.ok) throw new Error("received native record digest refused"); return digest.value;});
		const sourceProofDigest = hex(hashDomain("ts-drp/received-pending-native-checkpoint/v1", encodeCanonical({head, rows, certificate: custody.exactReceivedCertificateBytes}))),
			decisionDigest = hex(hashDomain("ts-drp/received-pending-native-decision/v1", encodeCanonical({sourceProofDigest, retain: recordDigests})));
		const acquire = requireValue(store.acquireRetirementControl, "received native control absent");
		const prepared = await acquire.call(store, object.value);
		if (!prepared.ok) throw new Error("received checkpoint observation refused");
		try {
			const frame = Uint8Array.from(prepared.value.imageDigest.match(/../gu) ?? [], byte => Number.parseInt(byte, 16));
			const incarnation = hashDomain("ts-drp/received-pending-native-incarnation/v1", new TextEncoder().encode(prepared.value.control.incarnation));
			const applied = await prepared.value.prepareBound({preparation: {head, floorEpoch: 0, floorAnchor: boot.invite.pinnedGenesisAnchorDigest,
				decisionDigest, sourceProofDigest, generationRecordDigests: recordDigests, snapshotScopes: [], protectedIndices: [], retireIndices: [],
				domains: [[255, incarnation, frame, prepared.value.control.revision, incarnation, frame, prepared.value.control.revision]]},
				generations: {recordDigests, identities: rows.map(row => ({generationId: row.generationId, identityDigest: aheRetirementGenerationIdentity(row)})),
					protectedIndices: rows.map((_, index) => index), retireIndices: []}});
			if (!applied.ok) throw new Error("received native prepare refused:" + applied.reason);
		} finally {await prepared.value.release(); joins.push({owner: "received-native-prepare", ok: true});}
		const commit = await acquire.call(store, object.value);
		if (!commit.ok) throw new Error("received checkpoint commit observation refused");
		try {const applied = await commit.value.commitPrepared({decisionDigest, sourceProofDigest}); if (!applied.ok) throw new Error("received native commit refused:" + applied.reason);}
		finally {await commit.value.release(); joins.push({owner: "received-native-commit", ok: true});}
		const before = await store.readRetirementImage?.(object.value), snapshotBefore = await inheritedSnapshotImage(receiverIdentity), applicationBefore = stable({lineage: await issuance.readLineage({objectId: boot.objectId, author: input.author}), outbox: await issuance.readOutboxPage({scope: {objectId: boot.objectId, author: input.author}, limit: 64})});
		phase = "received-public-pending-recovery";
		const recovered = await recoverPendingCreatorSuccessorAdoption({authenticationProfile: "creator-only", catalog: input.application.catalog,
			detachedSignature: boot.invite.detachedGenesisSignature, exactCanonicalAnchorPreimageBytes: boot.invite.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: boot.invite.exactCanonicalParametersCarrierBytes, expectedNextRoomHead: pending.next, expectedPreviousRoomHead: pending.previous,
			pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest, snapshotStore: snapshots, store, issuanceStore: issuance, liveJournalStore: journal});
		const afterHead = await store.readHead(object.value), after = await store.readRetirementImage?.(object.value), custodyAfter = await snapshots.lookupReceivedRecoveryCertificate(selector);
		let continuation: Record<string, unknown> = {ok: false};
		if (recovered.ok) {
			phase = "genuine-same-db-received-cold-continuation";
			// The receiver uses the same authenticated author, so end the source
			// runtime before activating its successor in the independent namespace.
			await sender.close(); sender = undefined; joins.push({owner: "received-sender-before-recipient-activation", ok: true});
			await receiverFloor.close(); joins.push({owner: "received-floor-before-cold-reopen", ok: true});
			receiverFloor = await createBrowserRoomHeadAuthority({databaseName: receiverIdentity + "--startup-floor", initialization: {kind: "reopen"}});
			receiver = await createV3RoomSession({...receiverInput, roomHeadAuthority: receiverFloor, initialLogicalTime: 100});
			await waitForV3RoomStartupForDiagnostics(receiver);
			const scope = {objectId: boot.objectId, author: input.author}, lineage = await issuance.readLineage(scope), acceptedBefore = deliveries.length;
			await receiver.issue(message("received-pending-continuation"));
			const issued = await issuance.readIssued(scope, lineage.next), authority = receiver.authority();
			if (issued === null || authority === null) throw new Error("received continuation row absent");
			const body = decodeCanonical(issued.envelope.canonicalPreimageBytes) as Record<string, unknown>, current = {objectId: boot.objectId, epoch: authority.epoch, anchorDigest: authority.anchorDigest};
			const ready = await journal.readiness({scope: current});
			if (!ready.ok || !ready.ready) throw new Error("received continuation journal absent");
			const page = await journal.readPage({scope: current, snapshot: ready.snapshot, afterSequence: null, limit: 64});
			if (!page.ok) throw new Error("received continuation journal read refused");
			const outbox = (await issuance.readOutboxPage({scope, limit: 64})).find(row => row.commit.authorSequence === lineage.next);
			continuation = {ok: true, authority, sequence: lineage.next, signatureValid: ed25519.verify(issued.envelope.signature, issued.envelope.digest, ed25519.getPublicKey(seed(boot.identity))),
				digestExact: hex(hashDomain("ts-drp/vertex/v3", issued.envelope.canonicalPreimageBytes)) === hex(issued.envelope.digest),
				candidateExact: stable(body.operation) === stable(message("received-pending-continuation")), scopeExact: body.epoch === pending.next.epoch && body.anchor === pending.next.currentAnchorDigest,
				outboxExact: outbox !== undefined && stable(outbox.commit.envelope) === stable(issued.envelope),
				journalExact: page.rows.some(row => row.author === input.author && row.authorSequence === lineage.next && row.vertexDigest === hex(issued.envelope.digest)),
				deliveryExact: deliveries.slice(acceptedBefore).some(row => row.sequence === lineage.next && row.digest === hex(issued.envelope.digest))};
		}
		result = {phase, interrupted, checkpointPremise: "original-native-all-protected-metadata-only-not-seven-domain-migration", certificate, head, before, after,
			recovered, afterHead, continuation, snapshotUnchanged: snapshotBefore === await inheritedSnapshotImage(receiverIdentity),
			certificateUnchanged: stable(custodyAfter) === stable(custody), applicationBefore,
			beforeFloor, afterFloor: await receiverFloor.read({scope: {objectId: boot.objectId, pinnedGenesisAnchorDigest: boot.invite.pinnedGenesisAnchorDigest}})};
		return {...result, joins};
	} catch (error) {throw new Error(phase + ": " + String(error), {cause: error});}
	finally {
		const owners = [{owner: "received-sender", close: () => sender?.close()}, {owner: "received-recipient", close: () => receiver?.close()},
			{owner: "received-sender-ahe", close: () => senderStore?.close()}, {owner: "received-sender-snapshots", close: () => senderSnapshots?.close()},
			{owner: "received-ahe", close: () => store?.close()}, {owner: "received-snapshots", close: () => snapshots?.close()},
			{owner: "received-issuance", close: () => issuance?.close()}, {owner: "received-journal", close: () => journal?.close()},
			{owner: "received-floor", close: () => receiverFloor.close()}, {owner: "received-sender-floor", close: () => senderFloor.close()},
			{owner: "received-protocol", close: () => recipientPort?.close()}];
		const joined = await Promise.allSettled(owners.map(async owner => {await owner.close(); joins.push({owner: owner.owner, ok: true});}));
		const failures = joined.flatMap(row => row.status === "rejected" ? [row.reason] : []);
		if (failures.length) throw new AggregateError(failures, "received pending owners failed to join");
	}
}
/** Existing public room buffer, actual native signing and unchanged signed pending limits. */
async function runRoomPendingBytes(identity:string):Promise<Record<string,unknown>> {
	const boot=await bootstrap(identity,"creator-trusted-settlement-v1");
	const input=await roomInput(boot,"create");
	let unblock!:()=>void,entered!:()=>void,paused=false,signCalls=0;
	const gate=new Promise<void>(resolve=>{unblock=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
	const signer=async(value:Uint8Array)=>{
		if(paused){signCalls++;entered();await gate;}
		return input.signRegisteredVertexDigest(value);
	};
	let room:Awaited<ReturnType<typeof createV3RoomSession>>|undefined;
	let native:Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>|undefined;
	let floor:Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>|undefined;
	const pending:Promise<unknown>[]=[],settled:{index:number;ok:boolean;reason?:string}[]=[];
	try {
		floor=await createBrowserRoomHeadAuthority({databaseName:identity+"--startup-floor",initialization:{kind:"create"}});
		room=await createV3RoomSession({...input,roomHeadAuthority:floor,signRegisteredVertexDigest:signer});
		await waitForV3RoomStartupForDiagnostics(room);
		native=await createBrowserDurableIssuanceStore({primaryDatabaseName:identity});
		const scope={author:input.author,objectId:boot.objectId},before=await native.readLineage(scope);
		paused=true;
		const enteredOperation={action:"message",clientOperationId:"entered",text:"entered"};
		const firstBytes=encodeCanonical(enteredOperation).byteLength;
		const first=room.issue(enteredOperation);
		pending.push(first);
		await Promise.race([began,first.then(()=>{throw new Error("native sign gate not reached");})]);
		const offeredBytes:number[]=[];
		let expectedHeldBytes=firstBytes,expectedHeldCount=1;
		const expectedRefused:number[]=[];
		for(let index=0;index<300;index++) {
			const offered={action:"message",clientOperationId:"queued-"+index,text:"x".repeat(60_000)};
			const size=encodeCanonical(offered).byteLength;offeredBytes.push(size);
			if(expectedHeldCount>=parameters.maxPendingEntries||expectedHeldBytes+size>parameters.maxPendingBytes)
				expectedRefused.push(index);
			else{expectedHeldBytes+=size;expectedHeldCount++;}
			pending.push(room.issue(offered).then(()=>{settled.push({index,ok:true});},error=>{
				settled.push({index,ok:false,reason:String(error)});
			}));
			// Public issue takes private custody before its waits, not later in drain.
			offered.text="caller-mutated";
		}
		enteredOperation.text="caller-mutated";
		await new Promise(resolve=>setTimeout(resolve,0));
		const beforeRelease={settled:structuredClone(settled),signCalls};
		unblock();
		await Promise.all(pending);
		const after=await native.readLineage(scope),issued=await native.readIssued(scope,before.next);
		const firstOperation=issued===null?undefined:Reflect.get(decodeCanonical(issued.envelope.canonicalPreimageBytes) as object,"operation");
		const signaturesAtJoin=signCalls;
		// This legal encoded input exceeds the residual headroom during the
		// stall. Reaching native admission proves retained buffer credit returned.
		const refillOperation={action:"message",clientOperationId:"after-join-refill",text:"y".repeat(60_000)};
		const refillBytes=encodeCanonical(refillOperation).byteLength;
		let refill:{ok:boolean;reason?:string};
		try{await room.issue(refillOperation);refill={ok:true};}
		catch(error){refill={ok:false,reason:String(error)};}
		let continuation:{ok:boolean;reason?:string};
		try{await room.issue({action:"message",clientOperationId:"after-join",text:"small-after-join"});continuation={ok:true};}
		catch(error){continuation={ok:false,reason:String(error)};}
		return {beforeRelease,expectedRefused,expectedHeldBytes,expectedHeldCount,firstBytes,
			offeredBytes,limitBytes:parameters.maxPendingBytes,limitEntries:parameters.maxPendingEntries,
			settled,before,after,firstOperation,signaturesAtJoin,refillBytes,refill,continuation,
			qualification:"Encoded public input buffer only; later native proof/epoch backpressure is a separate limiter, not a byte/heap equivalence. Actual first native signature/issuance and all submitted jobs join."};
	} finally {
		unblock();await Promise.allSettled(pending);
		const joined=await Promise.allSettled([Promise.resolve().then(()=>room?.close()),
			Promise.resolve().then(()=>native?.close()),Promise.resolve().then(()=>floor?.close())]);
		const faults=joined.flatMap(row=>row.status==="rejected"?[row.reason]:[]);
		if(faults.length)throw new AggregateError(faults,"public pending original owners failed to join");
	}
}
Object.assign(globalThis,{r8HealthyGrid:runHealthyGrid,r8CrossObjectCompletion:()=>runCrossObjectActivationScenario(undefined,"stalled"),r8HealthyTerminalMigration:runHealthyTerminalMigration,r8RoomPendingBytes:runRoomPendingBytes,r8SourceBinding:runSourceBinding,r8InheritedMigration:runInheritedMigration,r8ReceivedPending:runReceivedPending});
