import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const REQUIRED_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/successor-epoch-contract.ts",
	"tests/phase-6a-creator-successor-epoch-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-successor-epoch-entry.ts",
	"packages/storage-browser/tests/phase-6a-successor-epoch.pw.ts",
	"packages/storage-browser/playwright.phase-6a-successor-epoch.config.ts",
]);

export const REQUIRED_GREEN_PATHS = Object.freeze([
	"packages/live-journal/src/types.ts",
	"packages/live-journal/src/contract.ts",
	"packages/storage-node/src/live-journal.ts",
	"packages/storage-browser/src/live-journal.ts",
	"packages/node/src/v3-live.ts",
]);

export const SUCCESSOR_JOURNAL_METHODS = Object.freeze([
	"appendAccepted",
	"close",
	"installEpochAnchor",
	"installGenesis",
	"readiness",
	"readPage",
]);

export const SUCCESSOR_SCOPE_KEYS = Object.freeze(["anchorDigest", "epoch", "objectId"]);
export const SUCCESSOR_INSTALL_KEYS = Object.freeze([
	"detachedAnchorSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"objectId",
]);

export interface SuccessorScope {
	readonly anchorDigest: string;
	readonly epoch: 1;
	readonly objectId: string;
}

export interface GenesisEpochMaterial {
	readonly install: Readonly<Record<string, unknown>>;
	readonly received: Readonly<Record<string, unknown>>;
	readonly scope: Readonly<{ readonly anchorDigest: string; readonly epoch: 0; readonly objectId: string }>;
	readonly vertexDigest: string;
}

export interface SuccessorEpochMaterial {
	readonly anchorBytes: Uint8Array;
	readonly anchorDigest: string;
	readonly genesis: GenesisEpochMaterial;
	readonly install: Readonly<Record<string, unknown>>;
	readonly local: Readonly<Record<string, unknown>>;
	readonly objectId: string;
	readonly parametersBytes: Uint8Array;
	readonly parametersDigest: string;
	readonly received: Readonly<Record<string, unknown>>;
	readonly scope: SuccessorScope;
	readonly signature: Uint8Array;
	readonly vertexBytes: Uint8Array;
	readonly vertexDigest: string;
}

export interface SuccessorEpochReadiness {
	readonly missing: readonly string[];
	readonly ready: boolean;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds exact canonical epoch-one journal carriers without asking production
 * code to choose an epoch or confer authority.
 * @returns Detached successor anchor, vertex, scopes and store inputs.
 */
export function createSuccessorEpochMaterial(): SuccessorEpochMaterial {
	const objectId = `creator:${"1".repeat(32)}`;
	const parametersBytes = encodeCanonical({
		maxDependencies: 8,
		maxEpochBytes: 1_048_576,
		maxEpochVertices: 64,
		maxPendingBytes: 1_048_576,
		maxPendingEntries: 64,
		maxSnapshotBytes: 1_048_576,
		snapshotChunkBytes: 65_536,
	});
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parametersBytes));
	const anchorBytes = encodeCanonical({
		aclDigest: "8".repeat(64),
		archiveIndexRoot: "9".repeat(64),
		blueprintDigest: "2".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "6".repeat(64),
		epoch: 1,
		historyRoot: "7".repeat(64),
		historySize: 1,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest,
		previousAnchor: "5".repeat(64),
		profileDigest: "4".repeat(64),
		protocolMajor: 3,
		signerSetDigest: "3".repeat(64),
		stateDigest: "a".repeat(64),
	});
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const vertexBytes = encodeCanonical({
		anchor: anchorDigest,
		author: "creator",
		authorSequence: 12,
		dependencies: ["b".repeat(64)],
		epoch: 1,
		kind: "drp-vertex",
		logicalTime: 13,
		objectId,
		operation: { arguments: { value: "successor" }, type: "append" },
		protocolMajor: 3,
	});
	const vertexDigest = lowerHex(hashDomain("ts-drp/vertex/v3", vertexBytes));
	const signature = new Uint8Array(64).fill(7);
	const scope = Object.freeze({ anchorDigest, epoch: 1 as const, objectId });
	const zero = "0".repeat(64);
	const genesisAnchorBytes = encodeCanonical({
		aclDigest: zero,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: zero,
		epoch: 0,
		historyRoot: zero,
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest,
		previousAnchor: zero,
		profileDigest: "4".repeat(64),
		protocolMajor: 3,
		signerSetDigest: "3".repeat(64),
		stateDigest: zero,
	});
	const genesisAnchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", genesisAnchorBytes));
	const genesisScope = Object.freeze({ anchorDigest: genesisAnchorDigest, epoch: 0 as const, objectId });
	const genesisVertexBytes = encodeCanonical({
		anchor: genesisAnchorDigest,
		author: "creator",
		authorSequence: 0,
		dependencies: ["c".repeat(64)],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: 1,
		objectId,
		operation: { arguments: { value: "genesis" }, type: "append" },
		protocolMajor: 3,
	});
	const genesisVertexDigest = lowerHex(hashDomain("ts-drp/vertex/v3", genesisVertexBytes));
	return Object.freeze({
		anchorBytes,
		anchorDigest,
		genesis: Object.freeze({
			install: Object.freeze({
				detachedAnchorSignature: Uint8Array.from(signature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(genesisAnchorBytes),
				exactCanonicalParametersCarrierBytes: Uint8Array.from(parametersBytes),
				objectId,
			}),
			received: Object.freeze({
				detachedSignature: Uint8Array.from(signature),
				exactCanonicalPreimageBytes: Uint8Array.from(genesisVertexBytes),
				scope: genesisScope,
				sourceKind: "received",
				vertexDigest: genesisVertexDigest,
			}),
			scope: genesisScope,
			vertexDigest: genesisVertexDigest,
		}),
		install: Object.freeze({
			detachedAnchorSignature: Uint8Array.from(signature),
			exactCanonicalAnchorPreimageBytes: Uint8Array.from(anchorBytes),
			exactCanonicalParametersCarrierBytes: Uint8Array.from(parametersBytes),
			objectId,
		}),
		local: Object.freeze({
			author: "creator",
			authorSequence: 12,
			scope,
			sourceKind: "local-issued",
			vertexDigest,
		}),
		objectId,
		parametersBytes,
		parametersDigest,
		received: Object.freeze({
			detachedSignature: Uint8Array.from(signature),
			exactCanonicalPreimageBytes: Uint8Array.from(vertexBytes),
			scope,
			sourceKind: "received",
			vertexDigest,
		}),
		scope,
		signature,
		vertexBytes,
		vertexDigest,
	});
}

function source(path: string): string {
	return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

function sourceOwner(text: string, start: string, end: string): string | undefined {
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end, startIndex + start.length);
	return startIndex < 0 || endIndex < 0 ? undefined : text.slice(startIndex, endIndex);
}

function ownerMatches(text: string | undefined, patterns: readonly RegExp[]): boolean {
	return text !== undefined && patterns.every((pattern) => pattern.test(text));
}

/**
 * Collapses all five future owners into the one intentional RED readiness fact.
 * @returns Exact owner paths whose successor representation is still absent.
 */
export function successorEpochReadiness(): SuccessorEpochReadiness {
	const missing: string[] = [];
	for (const path of REQUIRED_GREEN_PATHS) {
		if (!existsSync(resolve(REPOSITORY_ROOT, path))) missing.push(path);
	}
	if (missing.length > 0) return Object.freeze({ missing: Object.freeze(missing), ready: false });

	const types = source("packages/live-journal/src/types.ts");
	const journalScope = sourceOwner(types, "export interface LiveJournalScope", "export interface Install");
	if (
		!types.includes("installEpochAnchor") ||
		!ownerMatches(journalScope, [/readonly\s+epoch:\s*number;/u, /readonly\s+anchorDigest:\s*string;/u]) ||
		journalScope?.includes("readonly epoch: 0;")
	) {
		missing.push("packages/live-journal/src/types.ts");
	}
	const contractPath = "packages/live-journal/src/contract.ts";
	const contract = source(contractPath);
	const copyScope = sourceOwner(contract, "function copyScope", "function cloneScope");
	const cloneScope = sourceOwner(contract, "function cloneScope", "function sameScope");
	if (
		!contract.includes("installEpochAnchor") ||
		!ownerMatches(copyScope, [/isSafeIntegerBetween\(epoch,\s*0\)/u, /epoch,\s*objectId/u]) ||
		!ownerMatches(cloneScope, [/epoch:\s*scope\.epoch/u])
	) {
		missing.push(contractPath);
	}
	for (const path of [
		"packages/storage-node/src/live-journal.ts",
		"packages/storage-browser/src/live-journal.ts",
	] as const) {
		const adapter = source(path);
		if (!adapter.includes("installEpochAnchor") || !adapter.includes("return Object.freeze")) missing.push(path);
	}
	const live = source("packages/node/src/v3-live.ts");
	const provenanceType = sourceOwner(live, "interface ProvenanceSnapshot", "interface OpenedTrustSnapshot");
	const authenticatedProvenance = sourceOwner(
		live,
		"function snapshotAuthenticatedProvenance",
		"interface CapturedIteratorStep"
	);
	const usablePayload = sourceOwner(live, "function payloadIsUsable", "type V3IngressFailureCategory");
	const journalScopeOwner = sourceOwner(live, "function liveJournalScope", "function sameLiveJournalScope");
	const issueOwner = sourceOwner(live, "async function issueOneVertex", "async function issueLocal");
	const blueprintHandle = sourceOwner(live, "function makeV3BlueprintLiveHandle", "function importLiveSnapshotMachine");
	const planeHandle = sourceOwner(live, "function makeV3PlaneHandle", "export function activateV3LivePlane");
	if (
		!ownerMatches(provenanceType, [/readonly\s+epoch:\s*number;/u]) ||
		!ownerMatches(authenticatedProvenance, [
			/NumberIsSafeInteger\(provenance\.epoch\)/u,
			/provenance\.epoch\s*>=\s*0/u,
			/epoch:\s*provenance\.epoch/u,
		]) ||
		!ownerMatches(usablePayload, [
			/NumberIsSafeInteger\(payload\.provenance\.epoch\)/u,
			/payload\.provenance\.epoch\s*>=\s*0/u,
		]) ||
		!ownerMatches(journalScopeOwner, [/epoch:\s*payload\.provenance\.epoch/u]) ||
		!ownerMatches(issueOwner, [/epoch:\s*registration\.payload\.provenance\.epoch/u]) ||
		!ownerMatches(blueprintHandle, [/epoch:\s*registration\.payload\.provenance\.epoch/u]) ||
		!ownerMatches(planeHandle, [/epoch:\s*registration\.payload\.provenance\.epoch/u])
	) {
		missing.push("packages/node/src/v3-live.ts");
	}
	return Object.freeze({ missing: Object.freeze([...new Set(missing)]), ready: missing.length === 0 });
}
