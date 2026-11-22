import type { FinalizeFailedRunInput } from "./run-finalizer.js";

/**
 * Returns neutral base metadata for process-cleanup failure controls.
 * @returns One immutable failure-artifact base.
 */
export function processFailureBase(): FinalizeFailedRunInput["base"] {
	return Object.freeze({
		schemaVersion: 1,
		browser: Object.freeze({ executablePath: "/opt/chromium", name: "chromium", version: "149.0" }),
		databaseName: "process-cleanup-control",
		gitSha: "a".repeat(40),
		platform: "darwin",
		profilePath: "/tmp/process-cleanup-control",
		runId: "process-cleanup-control",
	});
}
