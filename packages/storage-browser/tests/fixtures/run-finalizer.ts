import type { FailureArtifact, ParentFailureCode, RunStage, SettledChildEvidence } from "./artifacts.js";
import type { ProcessIdentity } from "./process-forest.js";
import type { KillHit } from "../../src/killpoints.js";

export interface PartialFailureEvidence {
	readonly cleanup: {
		readonly unresolvedOwnedGroups: readonly number[];
		readonly validatedGroups: readonly number[];
	};
	readonly observedHits?: readonly KillHit[];
	readonly recordedForest?: readonly ProcessIdentity[];
	readonly recoveryClassification?: {
		readonly digest: string;
		readonly state: "old" | "new" | "mixed";
	};
	readonly settledChildren?: readonly SettledChildEvidence[];
}

export type RunFailureArtifact = FailureArtifact & {
	readonly partialEvidence: PartialFailureEvidence;
};

export interface FinalizeFailedRunInput {
	readonly base: Omit<FailureArtifact, "code" | "detail" | "stage" | "verdict">;
	readonly code: ParentFailureCode;
	readonly detail: string;
	readonly ownedGroups: readonly number[];
	readonly partialEvidence: Omit<PartialFailureEvidence, "cleanup">;
	readonly stage: RunStage;
	readonly validatedGroups: readonly number[];
}

export interface FailureFinalizerDependencies {
	killValidatedGroup(pgid: number): void;
	writeArtifact(artifact: RunFailureArtifact): void;
}

export interface RunFinalizationObservation {
	readonly artifact: RunFailureArtifact;
	readonly cleanupKilledGroups: readonly number[];
	readonly unresolvedOwnedGroups: readonly number[];
}

/**
 * Emits the single shared failure artifact and owns bounded cleanup callbacks.
 * @param failure - Truthful reached stage, closed code, partial evidence, and ownership state.
 * @param dependencies - Injected artifact writer and validated-group cleanup effects.
 * @returns The exact emitted artifact and cleanup accounting.
 */
export function finalizeFailedRun(
	failure: FinalizeFailedRunInput,
	dependencies: FailureFinalizerDependencies
): RunFinalizationObservation {
	const validatedOwnedGroups = Object.freeze(
		failure.validatedGroups.filter((pgid) => failure.ownedGroups.includes(pgid))
	);
	const unresolvedOwnedGroups = Object.freeze(
		failure.ownedGroups.filter((pgid) => !validatedOwnedGroups.includes(pgid))
	);
	const artifact: RunFailureArtifact = Object.freeze({
		...failure.base,
		verdict: "fail",
		stage: failure.stage,
		code: failure.code,
		detail: failure.detail,
		partialEvidence: Object.freeze({
			...failure.partialEvidence,
			cleanup: Object.freeze({
				validatedGroups: validatedOwnedGroups,
				unresolvedOwnedGroups,
			}),
		}),
	});
	dependencies.writeArtifact(artifact);
	for (const pgid of validatedOwnedGroups) dependencies.killValidatedGroup(pgid);
	return Object.freeze({
		artifact,
		cleanupKilledGroups: validatedOwnedGroups,
		unresolvedOwnedGroups,
	});
}
