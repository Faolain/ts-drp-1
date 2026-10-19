import { encodeAheRetirementControl, type AheRetirementControl } from "@ts-drp/storage";

/** Outcome of an explicit, opt-in recovery-pool maintenance boundary. */
export type CreatorRecoveryPoolResult = Readonly<
	| { kind: "maintained" }
	| { kind: "not-needed" }
	| { kind: "deferred"; reason: "busy" | "unsupported" }
>;

/**
 * Soft watermark: the bounded pool is full (the next close would have to turn it
 * over inline) or generation pressure would force the close's capacity drain.
 * Requesting maintenance grants nothing; the original planner still classifies,
 * authenticates and bounds every retirement.
 * @param input - Point observations of the native pool and generation page.
 * @returns Whether early turnover would remove close-time inline maintenance.
 */
export function creatorRecoveryPoolPressure(input: Readonly<{
	recoveryScopes: number;
	maxRecoveryScopes: number;
	generations: number;
	maxObjectGenerations: number;
}>): boolean {
	return input.recoveryScopes >= input.maxRecoveryScopes || input.generations > input.maxObjectGenerations - 2;
}

/** Exact durable control produced by THIS process's completed early turnover. */
export type CreatorEarlyTurnoverToken = Readonly<{ epoch: number; control: Uint8Array }>;

/**
 * Captures the exact completed control after an early turnover joined. Process
 * local: a crash loses it and the close keeps the original durable resume rule.
 * @param epoch - Current epoch of the boundary that ran the turnover.
 * @param control - Durable control read after every hold and release joined.
 * @returns Token, or undefined when the control is not a completed idle control.
 */
export function captureCreatorEarlyTurnoverToken(
	epoch: number, control: AheRetirementControl | null
): CreatorEarlyTurnoverToken | undefined {
	if (control === null || control.active !== null || control.completed?.domains === undefined ||
		control.completed.generationDrain?.phase === "pending") return undefined;
	return Object.freeze({ epoch, control: encodeAheRetirementControl(control) });
}

/**
 * Original close-time resume rule, except that a completed control byte-equal to
 * the one this process's early turnover consumed at the SAME epoch's boundary is
 * not unfinished work: that boundary already consumed its retirement completion.
 * Active intents, pending reconciliation and reconstruction receipts still resume.
 * @param input - Close-time durable and process-local observations.
 * @returns Whether the close must rerun original reconciliation.
 */
export function creatorCloseRetirementResumeRequired(input: Readonly<{
	reconciliationPending: boolean;
	reconstructionPresent: boolean;
	intent: AheRetirementControl | null;
	currentEpoch: number;
	earlyTurnover?: CreatorEarlyTurnoverToken;
}>): boolean {
	const { intent } = input;
	if (input.reconciliationPending || input.reconstructionPresent) return true;
	if (intent?.active !== null && intent?.active !== undefined) return true;
	const completedAtBoundary = intent?.completed?.domains !== undefined &&
		intent.completed.throughEpoch + 1 === input.currentEpoch;
	if (!completedAtBoundary) return false;
	const token = input.earlyTurnover;
	if (token === undefined || token.epoch !== input.currentEpoch) return true;
	let observed: Uint8Array;
	try {
		observed = encodeAheRetirementControl(intent);
	} catch {
		return true;
	}
	if (observed.byteLength !== token.control.byteLength) return true;
	for (let index = 0; index < observed.byteLength; index++) if (observed[index] !== token.control[index]) return true;
	return false;
}
