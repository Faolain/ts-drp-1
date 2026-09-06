export const SHADOW_SEED = 0x4d_2026;
export const SHADOW_CLOSES = 100;
export const REFERENCE_SAMPLE_INTERVAL = 10;
export const EXPECTED_REFERENCE_SAMPLES = SHADOW_CLOSES / REFERENCE_SAMPLE_INTERVAL;
export const OBJECT_ID = "creator:44444444444444444444444444444444";
export const STATE_DOMAIN = "ts-drp/state/v3";
export const WRITER = "author:shadow-writer";
export const FOREIGN_AUTHOR = "author:shadow-foreign";

export const REFERENCE_HASHES = Object.freeze({
	"canonical.js": "daa0cda2893c4301b0271a47cb45ed2568f77bda0bce7502f0de756d0a678ca5",
	"fold.js": "369a84682a7003bfd90e25ca4b0bd203c3b0a38c80a9772e825bca23723f746c",
	"hash.js": "6cd4059d02ef09dfc80423ae6eec57917449ebd8be1b06141387ea23154ef637",
	"linearize.js": "ee5a41ce44700fa8329883fb63414ec81e0873335f6cbfebc47e6af0e2c69bf9",
} as const);

export interface ShadowIdentity {
	readonly anchor: string;
	readonly blueprintDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

export interface ShadowStateObservation extends ShadowIdentity {
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

export interface ShadowTypeScriptObservation extends ShadowStateObservation {
	readonly order: readonly string[];
	readonly payloadDigest: string;
}

export type ShadowReferenceObservation =
	| Readonly<{ readonly kind: "not-sampled" }>
	| Readonly<{ readonly kind: "observed"; readonly value: ShadowStateObservation }>;

export interface ShadowCloseObservation {
	readonly appliedVertices: number;
	readonly archival: ShadowStateObservation;
	readonly engineA: ShadowTypeScriptObservation;
	readonly engineB: ShadowTypeScriptObservation;
	readonly reference: ShadowReferenceObservation;
	readonly seed: number;
}

export type ShadowDiagnostic = Readonly<{
	readonly epoch: number;
	readonly kind:
		| "agreement"
		| "identity-mismatch"
		| "invalid-observation"
		| "order-mismatch"
		| "payload-mismatch"
		| "state-mismatch";
	readonly seed: number;
}>;

export type ShadowComparisonResult =
	| Readonly<{
			readonly appliedVertices: number;
			readonly closes: number;
			readonly diagnostics: readonly ShadowDiagnostic[];
			readonly kind: "agreement";
			readonly nonemptyStates: number;
			readonly ok: true;
			readonly referenceSamples: number;
	  }>
	| Readonly<{
			readonly diagnostic: ShadowDiagnostic;
			readonly kind: ShadowDiagnostic["kind"];
			readonly ok: false;
	  }>;

export interface ShadowComparisonModule {
	compareShadowRun(
		input: Readonly<{
			readonly expectedCloses: number;
			readonly expectedReferenceSamples: number;
			readonly observations: readonly ShadowCloseObservation[];
		}>
	): ShadowComparisonResult;
}
