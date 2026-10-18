export const PHASE_2E5_ROOT_COMMAND =
	"pnpm exec playwright test --config packages/storage-browser/playwright.phase-2e5-browser-inventory.config.ts --fail-on-flaky-tests && pnpm exec playwright test --config packages/storage-browser/playwright.phase-2e6-real-process-death.config.ts --fail-on-flaky-tests && pnpm exec playwright test --config packages/storage-browser/playwright.phase-2e7-publication-component.config.ts --fail-on-flaky-tests && pnpm exec playwright test --config packages/storage-browser/playwright.phase-2l-d-parity.config.ts --fail-on-flaky-tests";
export const PHASE_2E5_MATRIX = "phase-2e5-browser-request-inventory-red.pw.ts";

export interface Phase2e5AuthorityInput {
	readonly ciCommands: readonly string[];
	readonly configMatch: unknown;
	readonly matrixExists: boolean;
	readonly matrixSource: string;
	readonly rootCommand: unknown;
}

/**
 * Runs narrow fail-closed governance for the one root/CI inventory authority.
 * @param input - Current or controlled authority surfaces.
 * @returns Every authority mismatch.
 */
export function phase2e5AuthorityErrors(input: Phase2e5AuthorityInput): readonly string[] {
	const errors: string[] = [];
	if (input.rootCommand !== PHASE_2E5_ROOT_COMMAND) errors.push("root command bypasses Phase 2e5 inventory config");
	if (input.ciCommands.filter((command) => command.trim() === "pnpm e2e-test:storage-browser").length !== 1)
		errors.push("CI does not invoke the root inventory authority exactly once");
	if (input.ciCommands.some((command) => command.includes("missing-storage-browser.config.ts")))
		errors.push("CI invokes an ungoverned browser config");
	if (input.configMatch !== PHASE_2E5_MATRIX) errors.push("dedicated config matcher is not exact");
	if (!input.matrixExists) errors.push("dedicated inventory matrix is absent");
	if (input.matrixSource.trim().length === 0) errors.push("dedicated inventory matrix is empty");
	const testCalls = input.matrixSource.match(/\btest\s*\(/gu)?.length ?? 0;
	if (testCalls < 4) errors.push("dedicated inventory matrix has fewer than four executable controls");
	if (/\btest(?:\.describe)?\.(?:skip|fixme)\s*\(/u.test(input.matrixSource))
		errors.push("dedicated inventory matrix contains a skipped control");
	return Object.freeze(errors);
}
