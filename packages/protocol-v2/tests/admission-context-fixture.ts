import {
	type ActiveCryptoSuiteId,
	type AdmissionContext,
	type AdmissionParameters,
	digestRegistryPreimage,
	prepareAdmissionContext,
	type PreparedAdmissionContext,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const registry = protocolRegistry();

export const DEFAULT_ADMISSION_PARAMETERS: AdmissionParameters = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
});

/**
 * Prepares raw admission evidence for package tests.
 * @param raw - Raw epoch evidence.
 * @returns The package-owned prepared context.
 */
export function prepareTestAdmissionContext(raw: AdmissionContext): PreparedAdmissionContext {
	const prepared = prepareAdmissionContext(raw);
	if (!prepared.ok) throw new Error(prepared.code);
	return prepared.context;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds verified current-anchor evidence and its digest-bound admission parameters for tests.
 * @param input - Fixture overrides.
 * @param input.cryptoSuiteId - Negotiated suite recorded by the test context.
 * @param input.currentEpoch - Current epoch number.
 * @param input.isAncestor - Exact ancestry relation used by the test.
 * @param input.objectId - Object identity bound into the anchor.
 * @param input.parameters - Anchor-bound protocol parameters.
 * @param input.protocolMajor - Protocol namespace major.
 * @returns A package-prepared admission context with real registered anchor evidence.
 */
export function makeAdmissionContext(input: {
	readonly cryptoSuiteId?: ActiveCryptoSuiteId;
	readonly currentEpoch?: number;
	readonly isAncestor?: AdmissionContext["isAncestor"];
	readonly objectId: string;
	readonly parameters?: AdmissionParameters;
	readonly protocolMajor?: number;
}): PreparedAdmissionContext {
	const parameters = input.parameters ?? DEFAULT_ADMISSION_PARAMETERS;
	const protocolMajor = input.protocolMajor ?? 2;
	const currentEpoch = input.currentEpoch ?? 4;
	const parametersDigest = hex(
		digestRegistryPreimage(registry, "parameters", parameters as unknown as Readonly<Record<string, unknown>>)
	);
	const anchorPreimage = {
		kind: "drp-epoch-anchor",
		protocolMajor,
		objectId: input.objectId,
		epoch: currentEpoch,
		previousAnchor: ZERO_DIGEST,
		cutDigest: ONE_DIGEST,
		stateDigest: ZERO_DIGEST,
		aclDigest: ONE_DIGEST,
		historyRoot: ZERO_DIGEST,
		historySize: 0,
		archiveIndexRoot: ONE_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		signerSetDigest: ONE_DIGEST,
		parametersDigest,
		profileDigest: ONE_DIGEST,
		cryptoSuiteId: input.cryptoSuiteId ?? "ed25519-sha256-v1",
	};
	const currentEpochAnchor = Object.freeze({
		...anchorPreimage,
		hash: hex(digestRegistryPreimage(registry, "epochAnchor", anchorPreimage)),
	});
	const raw: AdmissionContext = {
		cryptoSuiteId: input.cryptoSuiteId ?? "ed25519-sha256-v1",
		currentAnchor: currentEpochAnchor.hash,
		currentEpoch,
		currentEpochAnchor,
		isAncestor: input.isAncestor ?? ((): boolean => false),
		objectId: input.objectId,
		parameters,
		protocolMajor,
	};
	return prepareTestAdmissionContext(raw);
}
