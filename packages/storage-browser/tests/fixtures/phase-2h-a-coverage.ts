export interface Phase2hCoverageMeasurement {
	readonly command: string;
	readonly config: Readonly<{ lf: number; sf: string }> | null;
	readonly gitSha: string;
	readonly lh: number;
	readonly lf: number;
	readonly nodeVersion: string;
	readonly pnpmVersion: string;
	readonly providerVersion: string;
	readonly thresholdLines: 70;
	readonly vitestVersion: string;
	readonly worktree: string;
}

/**
 * Checks the bounded before/after denominator evidence required during RED.
 * @param before - Baseline collected without the package-root config.
 * @param after - Same-toolchain collection with the config present.
 * @returns Exact fail-closed measurement errors.
 */
export function phase2hCoverageErrors(
	before: Phase2hCoverageMeasurement,
	after: Phase2hCoverageMeasurement
): readonly string[] {
	const errors: string[] = [];
	if (
		before.command !== after.command ||
		before.nodeVersion !== after.nodeVersion ||
		before.pnpmVersion !== after.pnpmVersion ||
		before.vitestVersion !== after.vitestVersion ||
		before.providerVersion !== after.providerVersion
	)
		errors.push("coverage toolchain or command changed between samples");
	if (before.gitSha !== after.gitSha) errors.push("coverage samples are not bound to one Git candidate");
	if (before.thresholdLines !== 70 || after.thresholdLines !== 70) errors.push("coverage line threshold changed");
	if (before.config !== null) errors.push("before sample already contains the new config");
	if (
		after.config === null ||
		after.config.sf !== "packages/storage-browser/playwright.protocol-v2.config.ts" ||
		after.config.lf <= 0
	)
		errors.push("after sample lacks the exact package-root config SF/LF entry");
	if (after.config !== null && after.lf - before.lf !== after.config.lf)
		errors.push("coverage LF denominator delta does not equal the config LF entry");
	if (after.lh !== before.lh) errors.push("unexecuted config unexpectedly changed covered lines");
	if (before.worktree.length === 0 || after.worktree.length === 0) errors.push("coverage worktree identity is absent");
	return Object.freeze(errors);
}
