import type { FailureArtifact, PartialFailureEvidence, RunStage } from "./artifacts.js";

export type { PartialFailureEvidence } from "./artifacts.js";

export type RunFailureArtifact = FailureArtifact & {
	readonly partialEvidence: PartialFailureEvidence;
};

export interface FinalizeFailedRunInput {
	readonly base: Omit<FailureArtifact, "code" | "detail" | "partialEvidence" | "stage" | "verdict">;
	readonly code: FailureArtifact["code"];
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
		[...new Set(failure.validatedGroups)].filter((pgid) => failure.ownedGroups.includes(pgid))
	);
	const cleanupKilledGroups: number[] = [];
	for (const pgid of validatedOwnedGroups) {
		try {
			dependencies.killValidatedGroup(pgid);
			cleanupKilledGroups.push(pgid);
		} catch {
			// The emitted artifact reports every owned group whose cleanup did not complete.
		}
	}
	const unresolvedOwnedGroups = Object.freeze(
		[...new Set(failure.ownedGroups)].filter((pgid) => !cleanupKilledGroups.includes(pgid))
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
				validatedGroups: Object.freeze([...cleanupKilledGroups]),
				unresolvedOwnedGroups,
			}),
		}),
	});
	dependencies.writeArtifact(artifact);
	return Object.freeze({
		artifact,
		cleanupKilledGroups: Object.freeze(cleanupKilledGroups),
		unresolvedOwnedGroups,
	});
}
