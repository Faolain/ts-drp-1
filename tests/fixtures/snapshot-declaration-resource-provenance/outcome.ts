export interface ChildOutcome {
	status: number | null;
	signal?: string | null;
	error?: string;
}

export interface ResourceReceipt {
	completed: true;
	run: string;
	status: 0 | 1 | 2;
	summarySha256: string;
}

const engines = ["node", "nodeBundled", "chromium", "firefox", "webkit"];

/**
 * Classify completed resource counters, requiring all expected engines and controls.
 * @param summary - Parsed resource summary.
 * @returns Zero all pass, one normative RED, two incomplete or failed controls.
 */
export function resourceStatus(summary: unknown): 0 | 1 | 2 {
	if (!summary || typeof summary !== "object" || Object.keys(summary).length !== engines.length) return 2;
	let red = false;
	for (const engine of engines) {
		const entry: unknown = Reflect.get(summary, engine);
		if (
			!entry ||
			typeof entry !== "object" ||
			Reflect.get(entry, "cases") !== 171 ||
			Reflect.get(entry, "encoderControl") !== true
		)
			return 2;
		const checks: unknown = Reflect.get(entry, "checks");
		if (!checks || typeof checks !== "object") return 2;
		for (const name of ["compatibility", "hookReached"]) {
			const control: unknown = Reflect.get(checks, name);
			if (
				!control ||
				typeof control !== "object" ||
				Reflect.get(control, "passed") !== 171 ||
				Reflect.get(control, "failed") !== 0
			)
				return 2;
		}
		for (const name of [
			"freshCapturedDecoder",
			"replacementMode",
			"noRetainedSharedDecoder",
			"boundedChunks",
			"boundedPieces",
			"reusedCapturedEncoder",
			"immediatePieceComparisonAndFinalOrdering",
			"nativeCarryBound",
			"rejectFirstMismatch",
		]) {
			const check: unknown = Reflect.get(checks, name);
			if (!check || typeof check !== "object") return 2;
			const passed: unknown = Reflect.get(check, "passed");
			const failed: unknown = Reflect.get(check, "failed");
			if (
				typeof passed !== "number" ||
				typeof failed !== "number" ||
				!Number.isInteger(passed) ||
				!Number.isInteger(failed) ||
				passed < 0 ||
				failed < 0 ||
				passed + failed !== (name === "rejectFirstMismatch" ? 1 : 171)
			)
				return 2;
			red ||= failed > 0;
		}
	}
	return red ? 1 : 0;
}

/**
 * Evaluate child terminals only when resource completion and its hashed summary agree.
 * @param prerequisites - Strict, lint, format and outcome diagnostic terminals.
 * @param resource - Resource child terminal.
 * @param receipt - Parsed completed resource receipt.
 * @param summary - Parsed completed resource counters.
 * @param run - Requested immutable run label.
 * @param summarySha256 - Hash of the actual summary file.
 * @returns Zero all pass, one legitimate RED, two infrastructure or controls failure.
 */
export function gateStatus(
	prerequisites: ChildOutcome[],
	resource: ChildOutcome,
	receipt: unknown,
	summary: unknown,
	run: string,
	summarySha256: string
): 0 | 1 | 2 {
	if (
		prerequisites.length !== 4 ||
		prerequisites.some((item) => item.status !== 0 || item.signal || item.error) ||
		resource.signal ||
		resource.error
	)
		return 2;
	if (
		!receipt ||
		typeof receipt !== "object" ||
		Reflect.get(receipt, "completed") !== true ||
		Reflect.get(receipt, "run") !== run ||
		Reflect.get(receipt, "summarySha256") !== summarySha256
	)
		return 2;
	const status = resourceStatus(summary);
	if (Reflect.get(receipt, "status") !== status || resource.status !== status) return 2;
	return status;
}
