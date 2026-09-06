import path from "node:path";

import { phase2jGitSha, preparePhase2jPublication } from "./fixtures/phase-2j-webcrypto-evidence.js";

/**
 * Creates one Phase 2j run and returns the only authoritative aggregate finalizer.
 * @returns Finalizer bound to the fresh run identity.
 */
export default function globalSetup(): () => void {
	const repositoryRoot = path.resolve(import.meta.dirname, "../..");
	const publication = preparePhase2jPublication({
		gitSha: phase2jGitSha(repositoryRoot),
		outputBase: path.join(repositoryRoot, "test-results/phase-2j"),
		uuid: process.env.PHASE_2J_RUN_UUID,
	});
	process.env.PHASE_2J_GIT_SHA = publication.layout.gitSha;
	process.env.PHASE_2J_RUN_ID = publication.layout.runId;
	process.env.PHASE_2J_RUN_ROOT = publication.layout.runRoot;
	return () => {
		try {
			publication.finalize();
		} finally {
			delete process.env.PHASE_2J_GIT_SHA;
			delete process.env.PHASE_2J_RUN_ID;
			delete process.env.PHASE_2J_RUN_ROOT;
		}
	};
}
