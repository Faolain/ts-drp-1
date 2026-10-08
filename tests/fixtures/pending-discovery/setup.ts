import { prepareCandidates } from "./candidates.js";
import { closeAll } from "./cleanup.js";
import type { CandidateFault, NativeOwners, RecoveryCase, SetupReport } from "./types.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import { CompactMerkleAccumulator } from "../../../packages/compaction/dist/src/index.js";
import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
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
import {
	decodeSnapshotManifest,
	encodeSnapshotTransfer,
} from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";
import {
	digestBlob,
	digestClosure,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "../../../packages/storage/dist/src/index.js";
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

/**
 * Genuine public producer lifecycle, shared without Node or browser-only fixture imports.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @param epochs - Explicit fixture-owned input for this isolated control.
 * @param owners - Explicit fixture-owned input for this isolated control.
 * @param publishFinal - Explicit fixture-owned input for this isolated control.
 * @param mode - Concrete case control installed before the setup realm closes.
 * @param candidateFault - Native physical setup-only fault operation.
 * @returns Original production values or isolated fixture evidence.
 */
export async function setup(
	identity: string,
	epochs: 1 | 2,
	owners: NativeOwners,
	publishFinal: boolean,
	mode: RecoveryCase = "verified",
	candidateFault?: CandidateFault
): Promise<SetupReport> {
	const objectIdText = `creator:${digest("ts-drp/pending-fixture-object", new TextEncoder().encode(identity)).slice(0, 32)}`;
	const parsed = parseStorageObjectId(objectIdText);
	if (!parsed.ok) throw new Error("SETUP_OBJECT_INVALID");
	const objectId = parsed.value;
	let plane: V3PlaneHandle | undefined;
	let publishPending: (() => Promise<void>) | undefined;
	const closers: Array<() => Promise<void>> = [];
	const handles: CreatorLiveCloseHandle[] = [];
	let primary: { error: unknown } | undefined;
	try {
		const app = application();
		const initialState = encodeCanonical(0);
		const exactCanonicalParametersCarrierBytes = encodeCanonical(parameters);
		const acl = encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: 3,
		});
		const signers = [{ publicKey: author, signerId: "creator" }];
		const signerBytes = encodeCanonical(signers);
		const profileBytes = encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-settlement-v1",
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
		plane = activated.handle;
		const bound = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialState, plane });
		if (!bound.ok) throw new Error("SETUP_BLUEPRINT_BIND");
		const finality = await createRecoverableFinalitySigner({ seed: Uint8Array.from(seed) });
		if (hex(finality.publicKey) !== author) throw new Error("SETUP_FINALITY_IDENTITY");
		const closeEpochs: number[] = [];
		const states: number[] = [];
		let expectedState = 0;
		let expectedPreviousRoomHead: SetupReport["bootstrap"]["expectedPreviousRoomHead"] | undefined;
		let expectedNextRoomHead: SetupReport["bootstrap"]["expectedNextRoomHead"] | undefined;
		let pendingGenerationId = "";
		let proposedHead: unknown;
		let pendingHead: unknown;
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
			const authorityBeforeClose = plane.currentEphemeralAuthority();
			if (authorityBeforeClose === undefined) throw new Error("SETUP_PREVIOUS_HEAD");
			const closed = await close.handle.close();
			if (!closed.ok) throw new Error("SETUP_CLOSE_FAILED");
			if (epoch === epochs - 1) {
				expectedPreviousRoomHead = { objectId, epoch, currentAnchorDigest: authorityBeforeClose.anchorDigest };
				expectedNextRoomHead = {
					objectId,
					epoch: closed.successorEpoch,
					currentAnchorDigest: closed.successorAnchorDigest,
				};
				const old = await owners.ahe.readHead(objectId);
				if (!old.ok || old.value.kind !== "present") throw new Error("SETUP_PROPOSED_HEAD");
				proposedHead = old.value;
			}
			const verified = await verifyCreatorSuccessorAdoption({ catalog: app.catalog, handle: close.handle });
			if (verified.ok !== true)
				throw new Error(`SETUP_VERIFY:${epoch}:${String(verified.kind)}:${String(verified.detail)}`);
			if (epoch === epochs - 1) {
				const staged = await stageCreatorSuccessorAdoption({ handle: close.handle, intent: verified.intent });
				if (staged.ok !== true) throw new Error("SETUP_STAGE_FAILED");
				const page = await owners.ahe.readGenerationPage({ objectId, limit: 128 });
				if (!page.ok) throw new Error("SETUP_STAGED_LINEAGE");
				const candidates = page.value.generations.filter(
					(generation) =>
						generation.state === "Complete" &&
						generation.baseExpectedHead.kind === "present" &&
						generation.baseExpectedHead.generationId === (proposedHead as { generationId: string }).generationId
				);
				if (candidates.length !== 1) throw new Error("SETUP_STAGED_CANDIDATE_NOT_UNIQUE");
				const candidate = candidates[0];
				if (candidate === undefined) throw new Error("SETUP_CANDIDATE_MISSING");
				pendingGenerationId = candidate.generationId;
				publishPending = async (): Promise<void> => {
					const result = await publishStagedCreatorSuccessorAdoption({
						handle: close.handle,
						capability: staged.capability,
					});
					if (result.ok !== true) throw new Error("SETUP_STAGED_PUBLISH_FAILED");
				};
				const after = await owners.ahe.readHead(objectId);
				if (!after.ok || after.value.kind !== "present") throw new Error("SETUP_PENDING_HEAD");
				pendingHead = after.value;
				if (after.value.generationId !== (proposedHead as { generationId: string }).generationId)
					throw new Error("SETUP_FINAL_PUBLICATION_BRANCH");
				expectedState += (epoch + 1) * 11;
				states.push(expectedState);
				closeEpochs.push(epoch);
				continue;
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
		if (expectedPreviousRoomHead === undefined || expectedNextRoomHead === undefined)
			throw new Error("SETUP_FINAL_HEAD");
		const active = await owners.ahe.recoverActiveGeneration(objectId);
		if (!active.ok || active.value.kind !== "active") throw new Error("SETUP_ACTIVE_CLOSURE");
		let cut: Record<string, unknown> | undefined;
		for (const ref of active.value.references) {
			const blob = await owners.ahe.getBlob(ref.digest);
			if (!blob.ok || blob.value === null) throw new Error("SETUP_BLOB");
			const record = decodeCanonical(blob.value) as Record<string, unknown>;
			if (record.kind === "drp-hard-epoch-cut" && record.epoch === epochs - 1) cut = record;
		}
		if (cut === undefined) throw new Error("SETUP_FINAL_CUT");
		// A genuinely verified neighboring scope, with deliberately different state.
		// Its declaration and bodies stay wholly inside the dying setup process/page.
		const competingObject = objectId;
		const competingEpoch = epochs + 3;
		const profile = {
			maxManifestBytes: 212387,
			maxSnapshotBytes: parameters.maxSnapshotBytes,
			snapshotChunkBytes: parameters.snapshotChunkBytes,
		} as const;
		const competingPayload = encodeCanonical({
			application: 999,
			objectId: competingObject,
			epoch: competingEpoch,
			anchor: String(cut.previousAnchor),
		});
		const encoded = encodeSnapshotTransfer({
			objectId: competingObject,
			epoch: competingEpoch,
			anchor: String(cut.previousAnchor),
			aclDigest: String(cut.aclDigest),
			stateDigest: digest("ts-drp/state/v3", encodeCanonical(999)),
			schemaVersion: 1,
			exactCanonicalPayloadBytes: competingPayload,
			profile,
		});
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
			expectedManifestDigest: encoded.manifestDigest,
			profile,
		});
		const competingScope = {
			objectId: competingObject,
			epoch: competingEpoch,
			anchor: String(cut.previousAnchor),
			manifestDigest: encoded.manifestDigest,
		};
		const competing = await owners.snapshot.openScope({
			scope: competingScope,
			chunks: decoded.chunks,
			exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
			totalBytes: competingPayload.byteLength,
		});
		try {
			const verified = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
				expectedManifestDigest: encoded.manifestDigest,
				expectedScope: competingScope,
				profile,
				quarantine: competing.verificationQuarantine,
				source: { read: (descriptor) => Promise.resolve(encoded.chunks[descriptor.index]) },
			});
			await verified.completion;
			await competing.complete(await verified.receipt);
			if ((await competing.status()).kind !== "verified") throw new Error("SETUP_COMPETING_NOT_VERIFIED");
		} finally {
			await competing.release();
		}
		const report: SetupReport = {
			bootstrap: {
				identity,
				catalogDigest: app.catalog.catalogDigest,
				detachedSignature: hex(signature),
				exactCanonicalAnchorPreimageBytes: hex(anchorBytes),
				exactCanonicalParametersCarrierBytes: hex(exactCanonicalParametersCarrierBytes),
				pinnedGenesisAnchorDigest: pin,
				expectedPreviousRoomHead,
				expectedNextRoomHead,
			},
			oracle: {
				expectedState,
				states,
				competingScope,
				pendingGenerationId,
				proposedHead,
				pendingHead,
				intendedPublicationHead: null,
				intendedUnrelatedHead: null,
				preparedCandidates: [],
				snapshotChunks: { count: 0, indices: [], allPreloaded: true },
				closeEpochs,
				lookupScope: {
					objectId,
					epoch: Number(cut.epoch),
					anchor: String(cut.previousAnchor),
					manifestDigest: String(cut.snapshotManifestDigest),
				},
			},
		};
		const preparedIds = await prepareCandidates(owners.ahe, report.bootstrap, mode);
		const nativeDeclaration = await owners.snapshot.lookupRecoveryDeclaration(report.oracle.lookupScope);
		if (nativeDeclaration.kind !== "present" || nativeDeclaration.state !== "verified")
			throw new Error("SETUP_ORACLE_SNAPSHOT_NOT_VERIFIED");
		const indices = nativeDeclaration.declaration.chunks.map((descriptor) => descriptor.index);
		if (indices.length === 0 || indices.some((index, position) => index !== position))
			throw new Error("SETUP_ORACLE_DESCRIPTOR_ORDER");
		report.oracle.snapshotChunks = { count: indices.length, indices, allPreloaded: true };
		if (mode === "unmatched") {
			if (candidateFault === undefined) throw new Error("UNMATCHED_NATIVE_FAULT_MISSING");
			await candidateFault(report.bootstrap, mode);
		}
		const preparedPage = await owners.ahe.readGenerationPage({ objectId, limit: 128 });
		if (!preparedPage.ok || preparedPage.value.nextCursor !== null) throw new Error("SETUP_ORACLE_LINEAGE");
		report.oracle.preparedCandidates = preparedIds
			.map((id) => {
				const found = preparedPage.value.generations.filter((entry) => entry.generationId === id);
				const candidate = found[0];
				if (found.length !== 1 || candidate === undefined) throw new Error("SETUP_ORACLE_PREPARED_CANDIDATE");
				const role: SetupReport["oracle"]["preparedCandidates"][number]["role"] =
					mode === "incomplete" || mode === "unmatched"
						? id === pendingGenerationId
							? "discarded"
							: mode === "incomplete"
								? "incomplete"
								: "unmatched-base"
						: "intended";
				if (
					role === "discarded"
						? candidate.state !== "Discarded"
						: role === "incomplete"
							? candidate.state !== "Staged"
							: candidate.state !== "Complete" && candidate.state !== "Adopted"
				)
					throw new Error("SETUP_ORACLE_PREPARED_STATE");
				return { generationId: id, closureDigest: candidate.closureDigest, role, state: candidate.state };
			})
			.sort((left, right) => left.generationId.localeCompare(right.generationId));
		if (
			mode === "divergent-mixed-unavailable" &&
			new Set(report.oracle.preparedCandidates.map((entry) => entry.closureDigest)).size !== 2
		)
			throw new Error("SETUP_DIVERGENT_CLOSURES_NOT_DISTINCT");
		// Controller-only publication oracle from the actual prepared native record.
		// Retry's equivalent lower ID wins only when no new head is already active.
		if (mode !== "incomplete" && mode !== "unmatched") {
			const selectedId = mode === "retry" && !publishFinal ? "0".repeat(63) + "1" : pendingGenerationId;
			const selected = preparedPage.value.generations.filter((record) => record.generationId === selectedId);
			const record = selected[0];
			if (
				selected.length !== 1 ||
				record === undefined ||
				(record.state !== "Complete" && record.state !== "Adopted") ||
				record.baseExpectedHead.kind !== "present"
			)
				throw new Error("SETUP_ORACLE_CANDIDATE");
			const revision = parseHeadRevision(record.baseExpectedHead.revision + 1);
			const closureDigest = digestClosure(record.closure);
			if (!revision.ok || !closureDigest.ok) throw new Error("SETUP_ORACLE_PUBLICATION");
			report.oracle.intendedPublicationHead = {
				kind: "present",
				objectId,
				generationId: record.generationId,
				closureDigest: closureDigest.value,
				revision: revision.value,
			};
			if (mode === "reread-unrelated") {
				const bytes = encodeCanonical({ kind: "pending-unrelated-head-control" });
				const blob = digestBlob(bytes),
					generation = parseGenerationId("0".repeat(63) + "2");
				const raceRevision = parseHeadRevision(revision.value + 1);
				if (!blob.ok || !generation.ok || !raceRevision.ok) throw new Error("SETUP_ORACLE_UNRELATED");
				const raceClosure = digestClosure([{ digest: blob.value, byteLength: bytes.byteLength }]);
				if (!raceClosure.ok) throw new Error("SETUP_ORACLE_UNRELATED_CLOSURE");
				report.oracle.intendedUnrelatedHead = {
					kind: "present",
					objectId,
					generationId: generation.value,
					closureDigest: raceClosure.value,
					revision: raceRevision.value,
				};
			}
		}
		if (publishFinal) {
			if (publishPending === undefined) throw new Error("SETUP_PUBLICATION_MISSING");
			await publishPending();
			const after = await owners.ahe.readHead(objectId);
			if (!after.ok || after.value.kind !== "present" || after.value.generationId !== pendingGenerationId)
				throw new Error("SETUP_FINAL_PUBLICATION_BRANCH");
			report.oracle.pendingHead = after.value;
			if (hex(encodeCanonical(after.value)) !== hex(encodeCanonical(report.oracle.intendedPublicationHead)))
				throw new Error("SETUP_ORACLE_ACTIVE_HEAD_MISMATCH");
		}
		return report;
	} catch (error) {
		primary = { error };
		throw error;
	} finally {
		await closeAll(
			[
				async (): Promise<void> => {
					await Promise.resolve();
					plane?.deactivate();
				},
				...handles.reverse().map((handle) => (): Promise<void> => handle.stop()),
				...closers.reverse(),
			],
			primary
		);
	}
}
