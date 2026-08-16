export interface SuccessorContract {
	readonly fixedAnchor: Readonly<{ readonly commit: string; readonly tree: string }>;
	readonly redBase: string;
	readonly gossipOracleTransition: Readonly<{
		readonly currentBlob: string;
		readonly currentSha256: string;
		readonly oldBlob: string;
		readonly oldSha256: string;
		readonly parent: string;
		readonly path: string;
	}>;
	readonly ownerDirectory: string;
	readonly ownerFiles: readonly string[];
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
