import type { OutcomeCommitAdmissionOperation } from "@ts-drp/outcome-commit";
import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";

/** Complete original source material, supplied by its owner. No field asserts
 * authentication, native currency, operation validity or completeness. */
export interface ZonePlacementGrowthMaterial {
	readonly exactCanonicalBaseStateBytes: readonly Uint8Array[];
	readonly currentOperations: readonly unknown[];
	readonly protectedOperations: readonly unknown[];
	readonly recoveryOperations: readonly unknown[];
	readonly candidateOperation: unknown;
}

export interface ZonePlacementGrowthBound extends CanonicalResourceFootprint {
	readonly blockCount: number;
}

/** Private numerical max-per-ID projection. No original carriers/operations
 * are retained. Candidate quotes never advance the accepted projection. */
export interface ZonePlacementGrowthProjection {
	advance(operations: readonly unknown[]): boolean;
	quote(candidateOperation: unknown): ZonePlacementGrowthBound | undefined;
	/** Numerical existing-material bound only, not an operation classifier. */
	quoteWithoutApplicationCandidate(): ZonePlacementGrowthBound | undefined;
	/** Uniform complete-material ceiling for any supported future operations in
	 * this aggregate canonical whole-operation byte / validated action window.
	 * Batch entries each spend one action; no candidate or reducer is executed. */
	quoteWindow(input: Readonly<{maxAdditionalActions: number; maxAdditionalOperationBytes: number}>):
		CanonicalResourceFootprint | undefined;
}

/** The resumable seed of a {@link ZonePlacementGrowthProjection}: step walks at most about
 * `byteBudget` more base bytes (true once every base is captured); finish returns exactly what
 * createPlacementGrowthProjection returns for the same material. */
export interface ZonePlacementGrowthSeed {
	step(byteBudget: number): boolean;
	finish(): ZonePlacementGrowthProjection | undefined;
}

export interface ZoneState {
	readonly version: 2;
	readonly creatorAuthor: string;
	readonly creatorPeerId: string;
	readonly blocks: readonly Readonly<{
		readonly id: string;
		readonly kind: string;
		readonly x: number;
		readonly y: number;
	}>[];
	readonly outcomes: readonly OutcomeCommitAdmissionOperation[];
	readonly roster: readonly Readonly<{ readonly author: string; readonly peerId: string; readonly order: number }>[];
}

export interface ZoneStateKernel {
	emptyState(): ZoneState;
	apply(
		state: ZoneState,
		operation: Readonly<Record<string, unknown>>,
		author?: string
	): Readonly<{ readonly state: ZoneState; readonly output: unknown }>;
	captureState(value: unknown): ZoneState;
	blockForOperation(operation: unknown): ZoneState["blocks"][number] | undefined;
	/** Pure placement/roster-declaration/causalJoin resource upper bound, not admission. */
	readPlacementGrowthBound(material: ZonePlacementGrowthMaterial): ZonePlacementGrowthBound | undefined;
	createPlacementGrowthProjection(material: Omit<ZonePlacementGrowthMaterial, "candidateOperation">):
		ZonePlacementGrowthProjection | undefined;
	/** The same projection, seeded in bounded byte steps; step throws on a refused base. */
	beginPlacementGrowthProjection(material: Omit<ZonePlacementGrowthMaterial, "candidateOperation">):
		ZonePlacementGrowthSeed | undefined;
	readonly reducers: Readonly<
		Record<
			string,
			(
				input: Readonly<{
					readonly state: ZoneState;
					readonly operation: Readonly<Record<string, unknown>>;
					readonly executionContext?: Readonly<{ readonly author: string }>;
				}>
			) => Readonly<{ readonly state: ZoneState; readonly output: unknown }>
		>
	>;
}

export function createZoneStateKernel(
	creatorAuthor: string,
	creatorPeerId: string,
	artifactVersion?: "current" | "predecessor"
): ZoneStateKernel;
export function emptyZoneState(creatorAuthor: string, creatorPeerId: string): ZoneState;
