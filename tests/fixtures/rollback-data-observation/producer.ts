import type { ProducerReport } from "./types.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import { CompactMerkleAccumulator } from "../../../packages/compaction/dist/src/index.js";
import { createCurrentAnchorTrustStore } from "../../../packages/control-plane/dist/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/dist/src/finality.js";
import { activateCreatorSuccessorAdoption } from "../../../packages/node/dist/src/creator-adoption-activate.js";
import { commitCreatorSuccessorAdoption } from "../../../packages/node/dist/src/creator-adoption-commit.js";
import {
	publishStagedCreatorSuccessorAdoption,
	stageCreatorSuccessorAdoption,
} from "../../../packages/node/dist/src/creator-adoption-stage.js";
import { verifyCreatorSuccessorAdoption } from "../../../packages/node/dist/src/creator-adoption.js";
import { bindCreatorLiveClose, type CreatorLiveCloseHandle } from "../../../packages/node/dist/src/creator-close.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	type V3PlaneHandle,
} from "../../../packages/node/dist/src/v3-live.js";
import {
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
} from "../../../packages/protocol-v3/dist/src/public.js";
import { parseStorageObjectId } from "../../../packages/storage/dist/src/index.js";
import { openBrowserSealEvidenceStore } from "../../../packages/storage-browser/dist/src/seal-evidence.js";
import { openBrowserSealVoteStore } from "../../../packages/storage-browser/dist/src/seal-vote.js";
import {
	application,
	author,
	bootstrapOperation,
	digest,
	hex,
	parameters,
	seed,
	sign,
	unhex,
} from "../cold-discovery/application.js";
import { runtime } from "../cold-discovery/runtime.js";
import type { NativeOwners } from "../cold-discovery/types.js";

/**
 * Genuine public producer lifecycle, shared without Node or browser-only fixture imports.
 * @param identity
 * @param epochs
 * @param owners
 * @param profileId
 * @param roleStop
 */
export async function setup(
	identity: string,
	epochs: 0 | 1 | 2 | 3,
	owners: NativeOwners,
	profileId: "creator-trusted-v1" | "creator-trusted-settlement-v1",
	roleStop?: "before-publication" | "already-published"
): Promise<ProducerReport> {
	const objectIdText = `creator:${digest("ts-drp/cold-fixture-object", new TextEncoder().encode(identity)).slice(0, 32)}`;
	const parsed = parseStorageObjectId(objectIdText);
	if (!parsed.ok) throw new Error("SETUP_OBJECT_INVALID");
	const objectId = parsed.value;
	const app = application();
	const initialState = encodeCanonical(0);
	const exactCanonicalParametersCarrierBytes = encodeCanonical(parameters);
	const acl = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
		objectId,
		permissionless: false,
		version: profileId === "creator-trusted-v1" ? 1 : 3,
	});
	const signers = [{ publicKey: author, signerId: "creator" }];
	const signerBytes = encodeCanonical(signers);
	const profileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId,
		quorum: 1,
		signers,
	});
	const empty = hex(new CompactMerkleAccumulator().root());
	const anchorBytes = encodeCanonical({
		aclDigest: digest("ts-drp/latched-acl/v3", acl),
		archiveIndexRoot: empty,
		blueprintDigest: app.blueprintDigest,
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "0".repeat(64),
		epoch: 0,
		historyRoot: empty,
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest: digest("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes),
		previousAnchor: "0".repeat(64),
		profileDigest: digest("ts-drp/profile/v3", profileBytes),
		protocolMajor: 3,
		signerSetDigest: digest("ts-drp/signer-set/v3", signerBytes),
		stateDigest: digest("ts-drp/state/v3", initialState),
	});
	const pin = digest("ts-drp/epoch-anchor/v3", anchorBytes);
	const signature = await sign(unhex(pin));
	const installed = await createCurrentAnchorTrustStore({
		objectId,
		pinnedGenesisAnchorDigest: pin,
		store: owners.ahe,
	}).install({
		detachedGenesisSignature: signature,
		exactCanonicalGenesisAnchorPreimageBytes: anchorBytes,
		exactCanonicalProfileBytes: profileBytes,
		exactCanonicalSignerSetBytes: signerBytes,
		pinnedGenesisAnchorDigest: pin,
	});
	if (!installed.ok) throw new Error(`SETUP_INSTALL:${installed.reason}`);
	const genesisActive = await owners.ahe.recoverActiveGeneration(objectId);
	if (!genesisActive.ok || genesisActive.value.kind !== "active") throw new Error("GENESIS_TRUST_CLOSURE");
	const pinRef = genesisActive.value.references[0];
	if (!pinRef) throw new Error("PIN_REF");
	const pinBlob = await owners.ahe.getBlob(pinRef.digest);
	if (!pinBlob.ok || !pinBlob.value) throw new Error("PIN_BYTES");
	const pinTrustBytes = Uint8Array.from(pinBlob.value);
	const prepared = await prepareV3LiveGeneration({
		authenticationProfile: "creator-only",
		catalog: app.catalog,
		detachedSignature: signature,
		exactCanonicalAnchorPreimageBytes: anchorBytes,
		exactCanonicalParametersCarrierBytes,
		objectId,
		pinnedGenesisAnchorDigest: pin,
		store: owners.ahe,
	});
	if (!prepared.ok) throw new Error(`SETUP_PREPARE:${prepared.kind}:${prepared.detail}`);
	const issuer = createAdmissionBoundTransactionalVertexIssuer({
		author,
		preparedBlueprintAdmission: prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes: app.canonicalBlueprintPackageBytes,
			expectedBlueprintDigest: app.blueprintDigest,
		}),
		publicKey: { bytes: unhex(author), format: "raw" },
		signRegisteredVertexDigest: sign,
		transactIssue: (scope, build) => owners.issuance.transactIssue(scope, build),
	});
	await issuer.issue({
		anchor: pin,
		dependencies: [pin],
		epoch: 0,
		logicalTime: 1,
		objectId,
		operation: bootstrapOperation,
	});
	const recovered = await recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalLatchedAclBytes: acl,
		exactCanonicalPinnedGenesisBootstrapOperationBytes: encodeCanonical(bootstrapOperation),
		issuanceScope: { author, objectId },
		issuanceStore: owners.issuance,
		liveJournalStore: owners.journal,
	});
	if (!recovered.ok) throw new Error(`SETUP_RECOVER:${recovered.kind}`);
	const bindings = runtime(`setup-${identity}`);
	const activated = activateV3LivePlane({ capability: recovered.capability, ...bindings });
	if (!activated.ok) throw new Error(`SETUP_ACTIVATE:${activated.kind}`);
	let plane: V3PlaneHandle = activated.handle;
	const bound = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialState, plane });
	if (!bound.ok) throw new Error("SETUP_BLUEPRINT_BIND");
	const finality = await createRecoverableFinalitySigner({ seed: Uint8Array.from(seed) });
	if (hex(finality.publicKey) !== author) throw new Error("SETUP_FINALITY_IDENTITY");
	const closers: Array<() => Promise<void>> = [];
	const handles: CreatorLiveCloseHandle[] = [];
	const closeEpochs: number[] = [];
	const states: number[] = [];
	let expectedState = 0;
	let pendingFloor: ProducerReport["floor"] | undefined;
	try {
		for (let epoch = 0; epoch < epochs; epoch += 1) {
			const issued = await plane.issueLocal({
				operations: [{ logicalTime: 11 + epoch * 10, operation: { action: "add", value: (epoch + 1) * 11 } }],
				signRegisteredVertexDigest: sign,
			});
			if (!issued.ok) throw new Error(`SETUP_ISSUE:${epoch}:${issued.kind}`);
			const published = await plane.publishPending();
			if (!published.ok) throw new Error(`SETUP_PUBLISH:${epoch}:${published.kind}`);
			const sealName = `${identity}--seal-${epoch}`;
			const vote = await openBrowserSealVoteStore({ databaseName: sealName });
			closers.push(vote.close);
			const evidence = await openBrowserSealEvidenceStore({ databaseName: sealName });
			closers.push(evidence.close);
			if (vote.observation.incarnation !== evidence.observation.incarnation) throw new Error("SETUP_SEAL_INCARNATION");
			const close = await bindCreatorLiveClose({
				plane,
				signer: finality.signer,
				snapshotStore: owners.snapshot,
				voteStore: vote.store,
				evidenceStore: evidence.store,
				storageIncarnation: vote.observation.incarnation,
				onObservation: () => undefined,
				exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
					minLocalCopies: 1,
					minMirrorReceipts: 0,
					minRollbackGenerations: 2,
					mode: "local-only",
				}),
			});
			if (!close.ok) throw new Error(`SETUP_CLOSE_BIND:${epoch}:${close.reason}`);
			handles.push(close.handle);
			const previous = plane.currentEphemeralAuthority();
			const closed = await close.handle.close();
			const verified = await verifyCreatorSuccessorAdoption({ catalog: app.catalog, handle: close.handle });
			if (verified.ok !== true)
				throw new Error(`SETUP_VERIFY:${epoch}:${String(verified.kind)}:${String(verified.detail)}`);
			if (roleStop && epoch === epochs - 1) {
				if (!previous || !closed.ok) throw new Error("ROLE_STOP_GENUINE_CLOSE");
				const staged = await stageCreatorSuccessorAdoption({ handle: close.handle, intent: verified.intent });
				if (!staged.ok) throw new Error("ROLE_STOP_STAGE");
				pendingFloor = {
					stable: { objectId, epoch: previous.epoch, currentAnchorDigest: previous.anchorDigest },
					pending: {
						previous: { objectId, epoch: previous.epoch, currentAnchorDigest: previous.anchorDigest },
						next: { objectId, epoch: closed.successorEpoch, currentAnchorDigest: closed.successorAnchorDigest },
					},
				};
				if (roleStop === "already-published") {
					const published = await publishStagedCreatorSuccessorAdoption({
						handle: close.handle,
						capability: staged.capability,
					});
					if (!published.ok) throw new Error("ROLE_STOP_PUBLISH");
				}
				expectedState += (epoch + 1) * 11;
				states.push(expectedState);
				break;
			}
			const committed = await commitCreatorSuccessorAdoption({ handle: close.handle, intent: verified.intent });
			if (committed.ok !== true) throw new Error(`SETUP_COMMIT:${epoch}:${String(committed.kind)}`);
			const descriptor = committed.descriptor as Record<string, unknown>;
			const expectedRoomHead = {
				currentAnchorDigest: String(descriptor.anchorDigest),
				epoch: Number(descriptor.epoch),
				objectId,
			};
			const successor = await activateCreatorSuccessorAdoption({
				capability: committed.capability,
				expectedRoomHead,
				handle: close.handle,
				...bindings,
			});
			if (successor.ok !== true)
				throw new Error(`SETUP_SUCCESSOR:${epoch}:${String(successor.kind)}:${String(successor.detail)}`);
			plane = successor.handle as V3PlaneHandle;
			const projection = bindV3BlueprintLivePlane({ plane, purpose: "projection-base" });
			if (!projection.ok) throw new Error(`SETUP_PROJECTION:${epoch}`);
			expectedState += (epoch + 1) * 11;
			const state = decodeCanonical(projection.exactCanonicalApplicationStateBytes);
			if (state !== expectedState) throw new Error(`SETUP_STATE:${state}:${expectedState}`);
			states.push(expectedState);
			closeEpochs.push(epoch);
		}
		const authority = plane.currentEphemeralAuthority();
		if (authority === undefined || (!pendingFloor && authority.epoch !== epochs)) throw new Error("SETUP_FINAL_HEAD");
		const active = await owners.ahe.recoverActiveGeneration(objectId);
		if (!active.ok || active.value.kind !== "active") throw new Error("SETUP_ACTIVE_CLOSURE");
		let cut: Record<string, unknown> | undefined;
		for (const ref of active.value.references) {
			const blob = await owners.ahe.getBlob(ref.digest);
			if (!blob.ok || blob.value === null) throw new Error("SETUP_BLOB");
			const record = decodeCanonical(blob.value) as Record<string, unknown>;
			if (record.kind === "drp-hard-epoch-cut" && record.epoch === epochs - 1) cut = record;
		}
		if (epochs > 0 && cut === undefined) throw new Error("SETUP_FINAL_CUT");
		return {
			bootstrap: {
				identity,
				objectId,
				pinnedGenesisAnchorDigest: pin,
				exactCanonicalPinnedGenesisTrustStateRecordBytes: hex(pinTrustBytes),
				profileId,
			},
			floor: pendingFloor ?? {
				stable: { objectId, epoch: authority.epoch, currentAnchorDigest: authority.anchorDigest },
				pending: null,
			},
			expectedStates: states,
		};
	} finally {
		plane.deactivate();
		for (const handle of handles.reverse()) await handle.stop();
		for (const close of closers.reverse()) await close();
	}
}
