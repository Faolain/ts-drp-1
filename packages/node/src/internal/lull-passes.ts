import { CreatorRecoveryHoldUnavailable } from "../v3-live.js";

/**
 * Lull "A": a session's maintenance passes run as bounded steps, each in its own lifecycle
 * admission. A step does a bounded amount of work and answers:
 * - "done": the pass is finished (it is dropped);
 * - "more": it made progress and has more to do (the next step is admitted at once, AFTER anything
 *   queued meanwhile, so an install or a local move waits for at most one step, never the pass);
 * - "deferred": its boundary was unavailable and nothing ran (it is kept for the next lull).
 * A step that throws CreatorRecoveryHoldUnavailable is "deferred"; any other failure is the step's
 * own (the pass is dropped and the failure reaches the lull's caller, as before).
 * Local scheduling only: it grants and decides nothing.
 */
export type LullStep = () => Promise<"done" | "more" | "deferred">;
export type LullPassScheduler = Readonly<{
	/** Registers one pass for `reason` (an already pending pass for it is kept, not replaced). */
	requestLullPass(reason: string, step: LullStep): void;
	/** Whether any pass is pending. */
	pending(): boolean;
	/** Runs the pending passes, one admitted step at a time. */
	runLull(): Promise<"maintained" | "deferred" | "not-needed">;
}>;

/**
 * @param input - `admit(step)` runs one step as ONE lifecycle admission (holding what a lull holds);
 * `stopped()` ends the lull before its next step once the session is closing.
 * @returns The session's pass scheduler.
 */
export function createLullPassScheduler(
	input: Readonly<{
		admit(step: LullStep): Promise<"done" | "more" | "deferred">;
		/** True once the session is closing: no further step is admitted. */
		stopped?(): boolean;
	}>
): LullPassScheduler {
	const passes = new Map<string, LullStep>();
	return Object.freeze({
		requestLullPass(reason: string, step: LullStep): void {
			if (!passes.has(reason)) passes.set(reason, step);
		},
		pending(): boolean {
			return passes.size !== 0;
		},
		async runLull(): Promise<"maintained" | "deferred" | "not-needed"> {
			if (passes.size === 0) return "not-needed";
			let ran = false;
			let deferred = false;
			for (const [reason, step] of [...passes]) {
				for (;;) {
					if (input.stopped?.() === true) {
						deferred = true;
						break;
					}
					let answer: "done" | "more" | "deferred";
					try {
						answer = await input.admit(step);
					} catch (error) {
						// Refused because the session began closing while the step was queued: the lull ends.
						if (input.stopped?.() === true && !ran) throw error;
						if (input.stopped?.() === true) {
							deferred = true;
							break;
						}
						if (error instanceof CreatorRecoveryHoldUnavailable) answer = "deferred";
						else {
							passes.delete(reason);
							throw error;
						}
					}
					if (answer === "deferred") {
						deferred = true;
						break;
					}
					ran = true;
					if (answer === "done") {
						if (passes.get(reason) === step) passes.delete(reason);
						break;
					}
				}
			}
			// A close that began between steps ends the lull with what its steps already did.
			if (ran && input.stopped?.() === true) return "maintained";
			return deferred ? "deferred" : ran ? "maintained" : "not-needed";
		},
	});
}
