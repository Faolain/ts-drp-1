export interface SuccessorContract {
	readonly schemaVersion: "phase-3a1b-freeze-successor-red-v2";
	readonly correctionPaths: readonly string[];
	readonly expectedPolicySchemaVersion: string;
	readonly expectedProfileSchemaVersion: string;
	readonly externalBase: Readonly<{
		readonly commit: string;
		readonly parents: readonly [string, string];
		readonly tree: string;
	}>;
	readonly fixedAnchor: Readonly<{ readonly commit: string; readonly tree: string }>;
	readonly redBase: string;
	readonly redBaseParent: string;
	readonly redBaseTree: string;
	readonly predecessorOracleTransition: Readonly<{
		readonly changedPaths: readonly string[];
		readonly governed: readonly Readonly<{
			readonly currentBlob: string;
			readonly currentSha256: string;
			readonly id: string;
			readonly oldBlob: string;
			readonly oldSha256: string;
			readonly path: string;
		}>[];
		readonly parent: string;
		readonly parentTree: string;
	}>;
	readonly gossipOracleTransition: Readonly<{
		readonly commit: string;
		readonly currentBlob: string;
		readonly currentSha256: string;
		readonly oldBlob: string;
		readonly oldSha256: string;
		readonly parent: string;
		readonly path: string;
		readonly tree: string;
	}>;
	readonly ownerDirectory: string;
	readonly ownerFiles: readonly string[];
	readonly originalInstallPaths: readonly string[];
	readonly predecessors: readonly {
		readonly baseline: string;
		readonly baselineTree: string;
		readonly checker: string;
		readonly checkerBase: string;
		readonly directParent: string;
		readonly directParentTree: string;
		readonly environment: string;
		readonly id: string;
		readonly policy: string;
	}[];
	readonly workflowIdentities: readonly {
		readonly jobKey: string;
		readonly jobName: string | null;
		readonly path: string;
		readonly workflowName: string;
	}[];
	readonly historicalTransitions: readonly {
		readonly commits: readonly (readonly [string, string])[];
		readonly path: string;
	}[];
	readonly latentGossipBinding: Readonly<{
		readonly currentAuthorHash: string;
		readonly path: string;
		readonly sha256: string;
		readonly staleAuthorHash: string;
	}>;
	readonly gossipChain: readonly Readonly<{ readonly commit: string; readonly tree: string }>[];
	readonly gossipFdbSha256: Readonly<Record<string, string>>;
	readonly provisionalInstall: Readonly<{
		readonly commit: string;
		readonly parent: string;
		readonly tree: string;
	}>;
	readonly rootFreezeEvidence: readonly Readonly<{
		readonly baseline: string;
		readonly baselineTree: string;
		readonly checker: string;
		readonly checkerBase: string;
		readonly checkerBaseTree: string;
		readonly checkerBlob: string;
		readonly checkerSha256: string;
		readonly currentStdout: string;
		readonly directParent: string;
		readonly environment: string;
		readonly historicalStdout: string;
		readonly id: string;
	}>[];
}

export interface CompletedRepositoryCandidateEvidence {
	readonly available: true;
	readonly immutable: readonly string[];
	readonly inventory: readonly string[];
	readonly negatives: readonly {
		readonly name: string;
		readonly result: Readonly<{
			readonly output: string;
			readonly signal: NodeJS.Signals | null;
			readonly status: number | null;
		}>;
	}[];
	readonly positives: readonly {
		readonly name: string;
		readonly result: Readonly<{
			readonly output: string;
			readonly signal: NodeJS.Signals | null;
			readonly status: number | null;
		}>;
	}[];
}
