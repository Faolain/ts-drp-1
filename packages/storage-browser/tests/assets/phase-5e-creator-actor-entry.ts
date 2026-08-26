import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { installCreatorAnchorTrustRoot } from "@ts-drp/protocol-v3";
import { openSealAuthority, type SealAuthority, verifySealQC } from "@ts-drp/protocol-v3/seal";
import { encodeSnapshotTransfer } from "@ts-drp/protocol-v3/snapshot-transfer";

const CREATOR_SEED = new Uint8Array(32).fill(0x31);
const OBJECT_ID = `creator:${"6".repeat(32)}`;
const SIGNER_ID = "creator-finality";
const ZERO_DIGEST = "0".repeat(64);

type ActorResult = Readonly<
	| { ok: false; reason: string }
	| {
			exactCanonicalCommitQcBytes: Uint8Array;
			exactCanonicalPrepareQcBytes: Uint8Array;
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			valueDigest: string;
	  }
>;

export interface CreatorActorStatus {
	readonly evidenceRevision: number;
	readonly phase: string;
	readonly terminal: boolean;
}

export interface CreatorActor {
	close(input: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>): Promise<ActorResult>;
	status(): CreatorActorStatus;
	stop(): Promise<void>;
}

interface CandidateCreatorModule {
	createCreatorSealActor(
		input: Readonly<{
			currentTrust: unknown;
			evidenceStore: unknown;
			onObservation(event: Readonly<Record<string, unknown>>): void;
			signer: unknown;
			storageIncarnation: string;
			voteStore: unknown;
		}>
	): Promise<Readonly<{ actor: CreatorActor; ok: true } | { ok: false; reason: string }>>;
}

interface CandidateEvidenceModule {
	openBrowserSealEvidenceStore(input: Readonly<{ databaseName: string }>): Promise<
		Readonly<{
			close(): Promise<void>;
			observation: Readonly<{ evidenceCount: number; incarnation: string; version: 3 }>;
			store: unknown;
		}>
	>;
}

interface CandidateVoteModule {
	openBrowserSealVoteStore(input: Readonly<{ databaseName: string }>): Promise<
		Readonly<{
			close(): Promise<void>;
			observation: Readonly<{ incarnation: string; pendingCount: number; version: 3 }>;
			store: unknown;
		}>
	>;
}

interface CandidateFinalityModule {
	createRecoverableFinalitySigner(input: Readonly<{ seed: Uint8Array }>): Promise<
		Readonly<{
			publicKey: Uint8Array;
			signer: unknown;
		}>
	>;
}

export interface CreatorActorHarness {
	readonly actor: CreatorActor;
	readonly authority: SealAuthority;
	readonly closeInput: Readonly<Record<string, unknown>>;
	close(): Promise<void>;
	readonly events: Readonly<Record<string, unknown>>[];
	readonly evidenceObservation: Readonly<{ evidenceCount: number; incarnation: string; version: 3 }>;
}

/**
 * Runs the raw-digest signing mutant through the real package-scoped keychain export.
 * @returns Rejected signing promise; resolution would expose forbidden authority.
 */
export async function attemptRawDigestSign(): Promise<Uint8Array> {
	const finality = await import("@ts-drp/keychain/finality");
	const created = await finality.createRecoverableFinalitySigner({ seed: Uint8Array.from(CREATOR_SEED) });
	return finality.signSealRegisteredDigest({
		// @ts-expect-error -- deliberate raw carrier must not satisfy the opaque registered-request type.
		request: { digest: "f".repeat(64) },
		signer: created.signer,
	});
}

/**
 * Verifies one returned actor QC through the real seal verifier and harness authority.
 * @param harness - Genuine creator actor harness holding the opaque seal authority.
 * @param exactCanonicalQcBytes - Exact durable QC bytes returned or reopened by the actor.
 * @returns Real seal-verifier result.
 */
export function verifyCreatorActorQc(
	harness: CreatorActorHarness,
	exactCanonicalQcBytes: Uint8Array
): ReturnType<typeof verifySealQC> {
	return verifySealQC({ authority: harness.authority, exactCanonicalQcBytes });
}

function bytesHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digest(domain: string, bytes: Uint8Array): string {
	return bytesHex(hashDomain(domain, bytes));
}

function fixture(): Readonly<{
	authority: SealAuthority;
	closeInput: Readonly<Record<string, unknown>>;
	currentTrust: unknown;
}> {
	const publicKey = ed25519.getPublicKey(CREATOR_SEED);
	const signerSet = Object.freeze([Object.freeze({ publicKey: bytesHex(publicKey), signerId: SIGNER_ID })]);
	const profile = Object.freeze({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: "creator-trusted-v1",
		quorum: 1,
		signers: signerSet,
	});
	const parameters = Object.freeze({
		maxDependencies: 16,
		maxEpochBytes: 8_388_608,
		maxEpochVertices: 8_192,
		maxPendingBytes: 16_777_216,
		maxPendingEntries: 4_096,
		maxSnapshotBytes: 268_435_456,
		snapshotChunkBytes: 131_072,
	});
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalProfileBytes = encodeCanonical(profile);
	const exactCanonicalParametersBytes = encodeCanonical(parameters);
	const anchor = Object.freeze({
		aclDigest: "2".repeat(64),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: ZERO_DIGEST,
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
		parametersDigest: digest("ts-drp/parameters/v3", exactCanonicalParametersBytes),
		previousAnchor: ZERO_DIGEST,
		profileDigest: digest("ts-drp/profile/v3", exactCanonicalProfileBytes),
		protocolMajor: 3,
		signerSetDigest: digest("ts-drp/signer-set/v3", exactCanonicalSignerSetBytes),
		stateDigest: "6".repeat(64),
	});
	const exactCanonicalAnchorPreimageBytes = encodeCanonical(anchor);
	const anchorDigest = digest("ts-drp/epoch-anchor/v3", exactCanonicalAnchorPreimageBytes);
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: ed25519.sign(
			Uint8Array.from(anchorDigest.match(/../gu) ?? [], (part) => Number.parseInt(part, 16)),
			CREATOR_SEED
		),
		exactCanonicalGenesisAnchorPreimageBytes: exactCanonicalAnchorPreimageBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: anchorDigest,
	});
	if (!installed.ok) throw new Error(`creator trust fixture failed: ${installed.reason}`);

	const stateDigest = "7".repeat(64);
	const aclDigest = "8".repeat(64);
	const snapshotPayload = encodeCanonical({
		acl: { epoch: 0, members: [] },
		anchor: anchorDigest,
		application: { counter: 9 },
		archiveIndexRoot: anchor.archiveIndexRoot,
		blueprintDigest: anchor.blueprintDigest,
		epoch: 0,
		kind: "drp-snapshot-payload",
		objectId: OBJECT_ID,
		protocolMajor: 3,
		schemaVersion: 1,
	});
	const snapshot = encodeSnapshotTransfer({
		aclDigest,
		anchor: anchorDigest,
		epoch: 0,
		exactCanonicalPayloadBytes: snapshotPayload,
		objectId: OBJECT_ID,
		profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
		schemaVersion: 1,
		stateDigest,
	});
	const openedAuthority = openSealAuthority({ signerPublicKey: publicKey, trust: installed.trust });
	if (!openedAuthority.ok) throw new Error(`creator authority fixture failed: ${openedAuthority.reason}`);
	return Object.freeze({
		authority: openedAuthority.authority,
		closeInput: Object.freeze({
			aclDigest,
			archiveIndexRoot: anchor.archiveIndexRoot,
			blueprintDigest: anchor.blueprintDigest,
			closeReason: "creator-requested",
			closeSetCount: 2,
			closeSetRoot: "9".repeat(64),
			currentTrust: installed.trust,
			exactCanonicalAvailabilityPolicyBytes: encodeCanonical({
				minLocalCopies: 1,
				minMirrorReceipts: 0,
				minRollbackGenerations: 2,
				mode: "local-only",
			}),
			exactCanonicalNextSignerSetBytes: exactCanonicalSignerSetBytes,
			exactCanonicalParametersBytes,
			exactCanonicalSnapshotManifestBytes: snapshot.exactCanonicalManifestBytes,
			historyRoot: "a".repeat(64),
			historySize: 2,
			snapshotManifestDigest: snapshot.manifestDigest,
			stateDigest,
		}),
		currentTrust: installed.trust,
	});
}

/**
 * Opens the real future actor over the public browser vote/evidence ports.
 * @param databaseName - Exact primary browser database identity.
 * @returns Genuine actor harness and observation-only close seam.
 */
export async function openCreatorActorHarness(databaseName: string): Promise<CreatorActorHarness> {
	const [creator, evidenceCandidate, voteCandidate, finalityCandidate] = (await Promise.all([
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- this literal future import must remain valid across RED and GREEN.
		// @ts-ignore -- D.107b RED freezes this literal package subpath before its GREEN owner exists.
		import(/* @vite-ignore */ "@ts-drp/seal/creator"), // eslint-disable-line import/no-unresolved -- future exact package subpath.
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- this literal future import must remain valid across RED and GREEN.
		// @ts-ignore -- D.107b RED freezes this literal package subpath before its GREEN owner exists.
		import(/* @vite-ignore */ "@ts-drp/storage-browser/seal-evidence"), // eslint-disable-line import/no-unresolved -- future exact package subpath.
		import("@ts-drp/storage-browser/seal-vote"),
		import("@ts-drp/keychain/finality"),
	])) as unknown as readonly [
		CandidateCreatorModule,
		CandidateEvidenceModule,
		CandidateVoteModule,
		CandidateFinalityModule,
	];
	const prepared = fixture();
	const signer = await finalityCandidate.createRecoverableFinalitySigner({ seed: CREATOR_SEED });
	const vote = await voteCandidate.openBrowserSealVoteStore({ databaseName });
	const evidence = await evidenceCandidate.openBrowserSealEvidenceStore({ databaseName });
	if (vote.observation.incarnation !== evidence.observation.incarnation) {
		await Promise.all([vote.close(), evidence.close()]);
		throw new Error("vote/evidence incarnation mismatch");
	}
	const events: Readonly<Record<string, unknown>>[] = [];
	const opened = await creator.createCreatorSealActor({
		currentTrust: prepared.currentTrust,
		evidenceStore: evidence.store,
		onObservation: (event) => {
			events.push(structuredClone(event));
			if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
				globalThis.dispatchEvent(new CustomEvent("phase5e-creator-observation", { detail: { kind: event.kind } }));
			}
		},
		signer: signer.signer,
		storageIncarnation: vote.observation.incarnation,
		voteStore: vote.store,
	});
	if (!opened.ok) {
		await Promise.all([vote.close(), evidence.close()]);
		throw new Error(`creator actor open failed: ${opened.reason}`);
	}
	return Object.freeze({
		actor: opened.actor,
		authority: prepared.authority,
		close: async () => {
			await opened.actor.stop();
			await Promise.all([vote.close(), evidence.close()]);
		},
		closeInput: prepared.closeInput,
		events,
		evidenceObservation: evidence.observation,
	});
}

interface ActiveRun {
	harness: CreatorActorHarness;
	result?: unknown;
	settled: boolean;
	task?: Promise<void>;
}

const runs = new Map<string, ActiveRun>();

async function open(databaseName: string): Promise<ActiveRun> {
	const existing = runs.get(databaseName);
	if (existing !== undefined) return existing;
	const harness = await openCreatorActorHarness(databaseName);
	const active: ActiveRun = { harness, settled: false };
	runs.set(databaseName, active);
	return active;
}

declare global {
	interface Window {
		phase5eCreatorActor: Readonly<{
			awaitResult(databaseName: string): Promise<unknown>;
			close(databaseName: string): Promise<void>;
			observe(databaseName: string): Promise<unknown>;
			runConflict(databaseName: string): Promise<unknown>;
			runStop(databaseName: string): Promise<unknown>;
			start(databaseName: string): Promise<unknown>;
		}>;
	}
}

if (typeof window !== "undefined") {
	window.phase5eCreatorActor = Object.freeze({
		async awaitResult(databaseName: string): Promise<unknown> {
			const active = await open(databaseName);
			await active.task;
			return structuredClone(active.result);
		},
		async close(databaseName: string): Promise<void> {
			const active = runs.get(databaseName);
			if (active === undefined) return;
			await active.harness.close();
			runs.delete(databaseName);
		},
		async observe(databaseName: string): Promise<unknown> {
			const active = await open(databaseName);
			return structuredClone({
				events: active.harness.events,
				result: active.result,
				settled: active.settled,
				status: active.harness.actor.status(),
			});
		},
		async runConflict(databaseName: string): Promise<unknown> {
			const active = await open(databaseName);
			const first = await active.harness.actor.close({ closeInput: active.harness.closeInput });
			const duplicate = await active.harness.actor.close({ closeInput: active.harness.closeInput });
			const conflict = await active.harness.actor.close({
				closeInput: { ...active.harness.closeInput, closeSetRoot: "f".repeat(64) },
			});
			return structuredClone({ conflict, duplicate, first, status: active.harness.actor.status() });
		},
		async runStop(databaseName: string): Promise<unknown> {
			const active = await open(databaseName);
			const pending = active.harness.actor.close({ closeInput: active.harness.closeInput });
			await Promise.resolve();
			const openReadwriteTransactions = (
				(Reflect.get(window, "__phase5eTransactions") as
					| readonly Readonly<{ completed: boolean; mode: string }>[]
					| undefined) ?? []
			).filter(({ completed, mode }) => mode === "readwrite" && !completed).length;
			const atStop = structuredClone({
				events: active.harness.events,
				openReadwriteTransactions,
				status: active.harness.actor.status(),
			});
			const stop = active.harness.actor.stop();
			const [result] = await Promise.all([pending, stop]);
			const settled = structuredClone({ events: active.harness.events, status: active.harness.actor.status() });
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
			return structuredClone({
				afterTurn: { events: active.harness.events, status: active.harness.actor.status() },
				atStop,
				result,
				settled,
			});
		},
		async start(databaseName: string): Promise<unknown> {
			const active = await open(databaseName);
			if (active.task === undefined) {
				active.task = active.harness.actor
					.close({ closeInput: active.harness.closeInput })
					.then((result) => {
						active.result = result;
					})
					.finally(() => {
						active.settled = true;
					});
			}
			return structuredClone({ events: active.harness.events, status: active.harness.actor.status() });
		},
	});
}
