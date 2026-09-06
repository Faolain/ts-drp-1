interface Phase5cSealVoteTestControl {
	runSchemaScenario(databaseName: string): Promise<unknown>;
	runScopedSnapshotScenario(databaseName: string): Promise<unknown>;
	runStrictVoteScenario(databaseName: string): Promise<unknown>;
	runDispatchScenario(databaseName: string, mode: string): Promise<unknown>;
	runDeathCheckpoint(databaseName: string, checkpoint: string): Promise<never>;
	runVersionChangeScenario(databaseName: string): Promise<unknown>;
}

declare global {
	interface Window {
		phase5cSealVote: Phase5cSealVoteTestControl;
	}
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the tests-only RED lands before the package-internal GREEN owner.
const candidate = (await import("../../src/internal/seal-vote-test-control.js")) as {
	createSealVoteBrowserTestControl(): Phase5cSealVoteTestControl;
};

window.phase5cSealVote = candidate.createSealVoteBrowserTestControl();

export {};
