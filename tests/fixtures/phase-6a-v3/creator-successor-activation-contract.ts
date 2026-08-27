import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type Serializable, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { GenuineCreatorAdoptionFixture } from "./creator-adoption-contract.js";
import { workspacePackageImportHook } from "../shared/workspace-package-subprocess.mjs";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const D108D1_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts",
	"tests/phase-6a-creator-successor-activation-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-activation-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-activation-death-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
	"packages/storage-browser/playwright.phase-6a-creator-successor-activation.config.ts",
] as const);

export const D108D1_GREEN_PATHS = Object.freeze([
	"packages/node/src/creator-adoption-activate.ts",
	"packages/node/src/creator-adoption.ts",
	"packages/node/src/creator-adoption-commit.ts",
	"packages/node/src/creator-close.ts",
	"packages/node/src/internal/creator-adoption-intent.ts",
	"packages/node/src/internal/creator-successor-live.ts",
	"packages/node/src/v3-live.ts",
	"packages/node/package.json",
] as const);

export const CREATOR_SUCCESSOR_ACTIVATION_EXPORTS = Object.freeze([
	"activateCreatorSuccessorAdoption",
	"reopenCreatorSuccessorAdoption",
] as const);
export const CREATOR_SUCCESSOR_ACTIVATION_INPUT_KEYS = Object.freeze([
	"capability",
	"handle",
	"messageQueueManager",
	"networkNode",
	"onAdmittedVertex",
] as const);
export const CREATOR_SUCCESSOR_REOPEN_INPUT_KEYS = Object.freeze([
	"authenticationProfile",
	"catalog",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"issuanceStore",
	"liveJournalStore",
	"messageQueueManager",
	"networkNode",
	"onAdmittedVertex",
	"pinnedGenesisAnchorDigest",
	"snapshotDeclaration",
	"snapshotStore",
	"store",
] as const);
export const CREATOR_SUCCESSOR_LOCAL_AUTHOR_REOPEN_INPUT_KEYS = Object.freeze([
	"authenticationProfile",
	"author",
	"catalog",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"issuanceStore",
	"liveJournalStore",
	"messageQueueManager",
	"networkNode",
	"onAdmittedVertex",
	"pinnedGenesisAnchorDigest",
	"signRegisteredVertexDigest",
	"snapshotDeclaration",
	"snapshotStore",
	"store",
] as const);
export const CREATOR_SUCCESSOR_ACTIVATION_SUCCESS_KEYS = Object.freeze([
	"handle",
	"lifecycle",
	"ok",
	"recovery",
	"trust",
] as const);
export const CREATOR_SUCCESSOR_ACTIVATION_FAILURE_KINDS = Object.freeze([
	"malformed-input",
	"capability-unavailable",
	"source-unavailable",
	"snapshot-unavailable",
	"preparation-rejected",
	"recovery-rejected",
	"activation-rejected",
	"authority-unavailable",
	"chain-invalid",
	"storage-failed",
	"internal-invariant",
] as const);

export const D108D1_NODE_BEHAVIORS = Object.freeze([
	"genuine successor imports its verified snapshot before epoch-one activation",
	"private custody alone selects installEpochAnchor",
	"divergent genesis identity fails before every live effect",
	"pending epoch-zero outbox is classified and never published as epoch one",
	"old handle registration author and prepared capability are terminal",
	"hot duplicate returns the same handle before a second source claim",
	"conflicting hot duplicate bindings fail closed",
	"post-adoption activation failure cleans up and fresh reverify performs no second swapHead",
	"TTL expiry performs one bounded full reverify attempt",
] as const);

export const D108D1_CHILD_BEHAVIORS = Object.freeze([
	"fresh Node imports the built non-root successor activation subpath",
	"cold reopen reconstructs active-new custody with no adoption CAS or displaced-row publication",
] as const);

export const D108D1_BROWSER_BEHAVIORS = Object.freeze([
	"missing or hostile LockManager authority fails activation closed",
	"two tabs elect one lifetime-held writer then a freshly reverified loser wins after release",
] as const);

export const V3_RECOVERED_AUTHORITY_SHA256 = "20453bc3aefdb4c97dbfb77e311e4021621ea6413514cb3e049914d22f4e9cb1";

export interface D108d1CandidateModule {
	activateCreatorSuccessorAdoption?(input: unknown): Promise<Readonly<Record<string, unknown>>>;
	reopenCreatorSuccessorAdoption?(input: unknown): Promise<Readonly<Record<string, unknown>>>;
}

export interface D108d1Oracle {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: 1;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly snapshotPayloadDigest: string;
	readonly stableTopic: string;
	readonly stateDigest: string;
}

export type D108d1ChildMode =
	| "cold"
	| "declaration-loop-mutant"
	| "divergent-genesis"
	| "extra-epoch"
	| "probe"
	| "ttl-expired";

export interface D108d1ChildMessage {
	readonly kind: string;
	readonly message?: string;
	readonly proof?: Readonly<Record<string, unknown>>;
}

function packD108d1Value(value: unknown): unknown {
	if (value instanceof Uint8Array) return Object.freeze({ bytesBase64: Buffer.from(value).toString("base64") });
	if (Array.isArray(value)) return value.map(packD108d1Value);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, packD108d1Value(entry)]));
	}
	return value;
}

/**
 * Produces the exact untrusted durable carrier used by fresh-process and two-tab REDs.
 * @param fixture - Genuine D.108b close fixture.
 * @param directory - Optional native-store directory owned by the caller.
 * @returns Packed raw AHE, snapshot, journal, issuance, catalog and creator-genesis carriers.
 */
export async function createD108d1PackedDurableMaterial(
	fixture: GenuineCreatorAdoptionFixture,
	directory = ""
): Promise<unknown> {
	const verifier = (await import("../../../packages/node/src/creator-adoption.js")) as {
		verifyCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
	};
	const committer = (await import("../../../packages/node/src/creator-adoption-commit.js")) as {
		commitCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
	};
	const verified = await verifier.verifyCreatorSuccessorAdoption({ catalog: fixture.catalog, handle: fixture.handle });
	if (verified.ok !== true) throw new TypeError(`D.108d1 verification failed: ${String(verified.kind)}`);
	const committed = await committer.commitCreatorSuccessorAdoption({ handle: fixture.handle, intent: verified.intent });
	if (committed.ok !== true) throw new TypeError(`D.108d1 commit failed: ${String(committed.kind)}`);
	const committedInspection = await fixture.handle.inspectDurableHead();
	if (!Buffer.from(encodeCanonical(committedInspection.head)).equals(Buffer.from(encodeCanonical(committed.head)))) {
		throw new TypeError("D.108d1 committed head does not match durable inspection");
	}
	const projection = canonicalRecord(fixture.evidence.exactCanonicalProjectionBytes);
	const projectionDigest = lowerHex(
		hashDomain("ts-drp-storage/blob/v1", fixture.evidence.exactCanonicalProjectionBytes)
	);
	const projectionRef = Object.freeze({
		byteLength: fixture.evidence.exactCanonicalProjectionBytes.byteLength,
		digest: projectionDigest,
	});
	const predecessorAclRef = Object.freeze({
		byteLength: fixture.evidence.predecessorExactCanonicalLatchedAclBytes.byteLength,
		digest: lowerHex(hashDomain("ts-drp-storage/blob/v1", fixture.evidence.predecessorExactCanonicalLatchedAclBytes)),
	});
	const activeClosure = Object.freeze(
		committedInspection.references.map((ref) => Object.freeze({ byteLength: ref.byteLength, digest: ref.digest }))
	);
	if (
		!activeClosure.some((ref) => ref.digest === projectionRef.digest && ref.byteLength === projectionRef.byteLength)
	) {
		throw new TypeError("D.108d1 committed durable closure omits the successor projection");
	}
	const currentTrustCandidate = fixture.evidence.current.candidates.find(
		(candidate) => candidate.ref.digest === fixture.evidence.closeResult.currentTrustRef.digest
	);
	if (currentTrustCandidate === undefined) throw new TypeError("D.108d1 current trust candidate is unavailable");
	const currentTrustRecord = canonicalRecord(currentTrustCandidate.bytes);
	if (!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)) {
		throw new TypeError("D.108d1 current anchor carrier is unavailable");
	}
	const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
	const exactCanonicalParametersCarrierBytes = encodeCanonical({
		maxDependencies: 16,
		maxEpochBytes: 8_388_608,
		maxEpochVertices: 8192,
		maxPendingBytes: 16_777_216,
		maxPendingEntries: 4096,
		maxSnapshotBytes: 268_435_456,
		snapshotChunkBytes: 131_072,
	});
	const authenticatedCurrentAnchorDigest = lowerHex(
		hashDomain("ts-drp/epoch-anchor/v3", currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes)
	);
	const authenticatedParametersDigest = lowerHex(
		hashDomain("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes)
	);
	if (
		authenticatedCurrentAnchorDigest !== fixture.evidence.currentTrust.currentAnchorDigest ||
		authenticatedCurrentAnchorDigest !== fixture.evidence.currentTrust.genesisAnchorDigest ||
		currentAnchor.parametersDigest !== authenticatedParametersDigest
	) {
		throw new TypeError("D.108d1 creator-genesis carriers are not bound to the authenticated anchor");
	}
	const resolved = fixture.catalog.resolve(String(projection.blueprintDigest));
	const outbox = await fixture.evidence.issuanceStore.readOutboxPage({ scope: fixture.evidence.issuanceScope });
	return packD108d1Value({
		active: {
			closure: activeClosure,
			generationId: (committed.head as Readonly<Record<string, unknown>>).generationId,
			head: committed.head,
			projection: { bytes: fixture.evidence.exactCanonicalProjectionBytes, ref: projectionRef },
		},
		blobs: [
			...fixture.evidence.current.candidates,
			...fixture.evidence.proposed.candidates,
			{ bytes: fixture.evidence.predecessorExactCanonicalLatchedAclBytes, ref: predecessorAclRef },
		],
		catalog: {
			blueprintDigests: fixture.catalog.blueprintDigests,
			catalogDigest: fixture.catalog.catalogDigest,
			resolved,
		},
		creatorGenesis: {
			authenticationProfile: "creator-only",
			detachedSignature: currentTrustRecord.detachedCurrentAnchorSignature,
			exactCanonicalAnchorPreimageBytes: currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes,
			pinnedGenesisAnchorDigest: fixture.evidence.currentTrust.genesisAnchorDigest,
		},
		current: fixture.evidence.current,
		directory,
		...(fixture.evidence.establishedPeer === undefined ? {} : { establishedPeer: fixture.evidence.establishedPeer }),
		issuance: { outbox, scope: fixture.evidence.issuanceScope },
		journalRows: fixture.evidence.journalRows,
		oracle: deriveD108d1Oracle(fixture),
		proposed: fixture.evidence.proposed,
		snapshot: { chunks: fixture.evidence.chunks, declaration: fixture.evidence.declaration },
	});
}

/**
 * Launches the genuine built-package child and transfers its carrier over IPC.
 * @param mode - One bounded cold-reopen proof mode.
 * @param input - Packed durable material, unused by the import probe.
 * @returns The child's single terminal proof message.
 */
export function runD108d1ActivationChild(mode: D108d1ChildMode, input: unknown): Promise<D108d1ChildMessage> {
	return new Promise((resolvePromise, reject) => {
		const childPath = resolve(
			REPOSITORY_ROOT,
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-activation-child.mjs"
		);
		const importHook = workspacePackageImportHook({
			expectedImports: {
				"@ts-drp/message-queue": resolve(REPOSITORY_ROOT, "packages/message-queue/dist/src/index.js"),
				"@ts-drp/node/creator-adoption-activate": resolve(
					REPOSITORY_ROOT,
					"packages/node/dist/src/creator-adoption-activate.js"
				),
				"@ts-drp/node/v3-live": resolve(REPOSITORY_ROOT, "packages/node/dist/src/v3-live.js"),
				"@ts-drp/storage-node": resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/index.js"),
				"@ts-drp/storage-node/issuance": resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/issuance.js"),
				"@ts-drp/storage-node/live-journal": resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/live-journal.js"),
				"@ts-drp/storage-node/snapshot-transfer": resolve(
					REPOSITORY_ROOT,
					"packages/storage-node/dist/src/snapshot-transfer.js"
				),
			},
		});
		const child = spawn(process.execPath, [importHook, childPath, mode], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let observed: D108d1ChildMessage | undefined;
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`D.108d1 child timeout: ${stderr}`));
		}, 60_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: D108d1ChildMessage) => (observed = message));
		child.once("error", reject);
		child.once("spawn", () => {
			if (mode !== "probe") child.send(input as Serializable);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0 || observed === undefined || observed.kind === "child-error") {
				reject(new Error(observed?.message ?? `D.108d1 child failed (${String(code)}): ${stderr}`));
			} else resolvePromise(observed);
		});
	});
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (
		decoded === null ||
		typeof decoded !== "object" ||
		Array.isArray(decoded) ||
		!Buffer.from(encodeCanonical(decoded)).equals(bytes)
	) {
		throw new TypeError("D.108d1 oracle carrier is not exact canonical bytes");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function candidateBytes(
	fixture: GenuineCreatorAdoptionFixture,
	ref: Readonly<{ readonly byteLength: number; readonly digest: string }>
): Uint8Array {
	const candidates = fixture.evidence.proposed.candidates.filter(
		(candidate) => candidate.ref.digest === ref.digest && candidate.ref.byteLength === ref.byteLength
	);
	if (candidates.length !== 1) throw new TypeError("D.108d1 oracle candidate is unavailable");
	return Uint8Array.from(candidates[0]?.bytes as Uint8Array);
}

/**
 * Derives successor identity without trusting an activation result or caller DTO.
 * @param fixture - Genuine certified close evidence.
 * @returns Exact successor identity and stable topic.
 */
export function deriveD108d1Oracle(fixture: GenuineCreatorAdoptionFixture): D108d1Oracle {
	const successorTrust = canonicalRecord(candidateBytes(fixture, fixture.evidence.closeResult.successorTrustRef));
	if (!(successorTrust.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)) {
		throw new TypeError("D.108d1 successor anchor bytes are unavailable");
	}
	const anchorBytes = Uint8Array.from(successorTrust.exactCanonicalCurrentAnchorPreimageBytes);
	const anchor = canonicalRecord(anchorBytes);
	const projection = canonicalRecord(fixture.evidence.exactCanonicalProjectionBytes);
	const manifest = canonicalRecord(fixture.evidence.declaration.exactCanonicalManifestBytes);
	const payload = canonicalRecord(fixture.evidence.exactCanonicalPayloadBytes);
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const payloadDigest = lowerHex(hashDomain("ts-drp/snapshot-payload/v3", fixture.evidence.exactCanonicalPayloadBytes));
	const objectId = String(anchor.objectId);
	const predecessorGenesisAnchorDigest = fixture.evidence.currentTrust.genesisAnchorDigest;
	const successorGenesisAnchorDigest = successorTrust.genesisAnchorDigest;
	if (
		typeof successorGenesisAnchorDigest !== "string" ||
		successorGenesisAnchorDigest !== predecessorGenesisAnchorDigest
	) {
		throw new TypeError("D.108d1 successor genesis identity diverged");
	}
	const genesisAnchorDigest = successorGenesisAnchorDigest;
	const stableTopicDigest = lowerHex(
		hashDomain(
			"ts-drp/live-topic/v3",
			new TextEncoder().encode(objectId),
			new TextEncoder().encode(genesisAnchorDigest)
		)
	);
	if (
		anchor.epoch !== 1 ||
		projection.kind !== "v3-live-generation-2" ||
		projection.version !== 2 ||
		projection.epoch !== 1 ||
		projection.anchorDigest !== anchorDigest ||
		projection.objectId !== objectId ||
		projection.parametersDigest !== anchor.parametersDigest ||
		projection.snapshotPayloadDigest !== payloadDigest ||
		manifest.payloadDigest !== payloadDigest ||
		payload.objectId !== objectId ||
		payload.epoch !== 0 ||
		payload.anchor !== fixture.evidence.currentTrust.currentAnchorDigest
	) {
		throw new TypeError("D.108d1 successor cross-carrier identity failed");
	}
	return Object.freeze({
		aclDigest: String(anchor.aclDigest),
		anchorDigest,
		epoch: 1 as const,
		genesisAnchorDigest,
		objectId,
		parametersDigest: String(anchor.parametersDigest),
		snapshotPayloadDigest: payloadDigest,
		stableTopic: `drp/v3/1/${stableTopicDigest}`,
		stateDigest: String(anchor.stateDigest),
	});
}

/**
 * Returns source-level authority and scope governance for the frozen GREEN.
 * @returns Frozen governance assertions over the exact owner roster.
 */
export function d108d1SourceGovernance(): Readonly<Record<string, boolean>> {
	const read = (path: string): string => {
		const absolute = resolve(REPOSITORY_ROOT, path);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
	};
	const owner = read(D108D1_GREEN_PATHS[0]);
	const internal = read(D108D1_GREEN_PATHS[5]);
	const live = read(D108D1_GREEN_PATHS[6]);
	const root = read("packages/node/src/index.ts");
	const room = read("examples/v3-room/src/index.ts");
	const chat = read("examples/v3-chat/src/index.ts");
	const productExists = /adoptCreatorSuccessor\s*\(/u.test(room);
	const roomConsumesActivation =
		/@ts-drp\/node\/creator-adoption-activate/u.test(room) &&
		/activateCreatorSuccessorAdoption/u.test(room) &&
		/reopenCreatorSuccessorAdoption/u.test(room);
	const recoveredAuthority = read("packages/node/src/v3-live-recovered-authority.ts");
	return Object.freeze({
		internalCustody: /installCreatorSuccessorLive|consumeCreatorSuccessorLive/u.test(internal),
		noDirectChatActivationConsumer:
			!/activateCreatorSuccessorAdoption|reopenCreatorSuccessorAdoption|creator-adoption-activate/u.test(chat),
		noRootExport: !/activateCreatorSuccessorAdoption|creator-adoption-activate/u.test(root),
		privateEpochAnchor: /installEpochAnchor/u.test(live) && /CreatorSuccessor|creatorSuccessor/u.test(live),
		recoveredAuthorityUnchanged:
			createHash("sha256").update(recoveredAuthority).digest("hex") === V3_RECOVERED_AUTHORITY_SHA256,
		roomOwnsActivationWhenProductExists: !productExists || roomConsumesActivation,
		webLockAuthority:
			/navigator/u.test(owner) && /locks/u.test(owner) && /request/u.test(owner) && /exclusive/u.test(owner),
	});
}
