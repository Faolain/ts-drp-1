import type { ShadowCloseObservation, ShadowDiagnostic } from "./shadow-contract.js";

export const SHADOW_RUN_SCHEMA_VERSION = 1;
export const SHADOW_CLOSES_PER_SHARD = 100;
export const SHADOW_REFERENCE_SAMPLES_PER_SHARD = 10;
export const SHADOW_SHARD_STEP = 0x9e37_79b9;
export const SHADOW_PROFILES = Object.freeze({
	nightly: Object.freeze({ epochs: 10_000, referenceSamples: 1_000, shards: 100 }),
	pr: Object.freeze({ epochs: 100, referenceSamples: 10, shards: 1 }),
} as const);

export const SHADOW_SEED_VECTOR = Object.freeze({
	date: "2026-08-25",
	seed: 612_622_333,
	sha: "43dadc1e00000000000000000000000000000000",
});

export type ShadowTier = keyof typeof SHADOW_PROFILES;

export interface ShadowShardInput {
	readonly closes: typeof SHADOW_CLOSES_PER_SHARD;
	readonly seed: number;
}

export interface ShadowRunReport {
	readonly appliedVertices: number;
	readonly browsers: readonly string[];
	readonly completedEpochs: number;
	readonly completedShards: number;
	readonly date: string;
	readonly epochs: number;
	readonly mismatches: readonly ShadowDiagnostic[];
	readonly nonemptyStates: number;
	readonly referenceSamples: number;
	readonly runtimes: readonly string[];
	readonly schemaVersion: typeof SHADOW_RUN_SCHEMA_VERSION;
	readonly seed: number;
	readonly sha: string;
	readonly shards: number;
	readonly tier: ShadowTier;
}

export interface ShadowRunnerModule {
	appendShadowLedger(
		input: Readonly<{
			candidate: ShadowRunReport;
			ledger: readonly ShadowRunReport[];
		}>
	): readonly ShadowRunReport[];
	deriveShadowSeed(input: Readonly<{ date: string; sha: string }>): number;
	runShadowTier(
		input: Readonly<{
			browsers: readonly string[];
			date: string;
			produceShard(input: ShadowShardInput): Promise<readonly ShadowCloseObservation[]>;
			runtimes: readonly string[];
			sha: string;
			tier: ShadowTier;
		}>
	): Promise<ShadowRunReport>;
}
