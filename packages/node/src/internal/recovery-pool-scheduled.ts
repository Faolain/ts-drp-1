import type { CreatorRecoveryPoolResult } from "./creator-recovery-pool.js";

/**
 * Track Z: the recovery-pool lull a session schedules itself once per epoch (opt-in
 * `recoveryPoolScheduledLull`; the browser binding turns it on for new rooms on the room
 * database with retention). It requests the SAME explicit `maintainRecoveryPool()` right
 * after an adoption or install, so the lull joins the lifecycle FIFO behind the transition
 * that produced the epoch and runs before any later one, with no idle trigger.
 *
 * One lull per epoch: an epoch whose lull settled (`maintained`, `not-needed` or
 * `deferred:unsupported`, the idle scheduler's rule) answers every later call with that
 * result, without a second boundary. A `deferred:busy` result settles nothing. Local
 * scheduling policy only; it grants and decides nothing.
 */
export type ScheduledRecoveryPoolLull = Readonly<{
	/** After an adoption or install: requests one lull for the current epoch, once per epoch. */
	schedule(): void;
	/** Read synchronously at the entry of `maintainRecoveryPool()`: whether this call is the scheduled one. */
	claim(): boolean;
	/** Inside the FIFO: the settled epoch's result, or one lull, observed and recorded. */
	run(scheduled: boolean, lull: () => Promise<CreatorRecoveryPoolResult>): Promise<CreatorRecoveryPoolResult>;
	/** Whether a lull settled `epoch` (the idle scheduler skips it). */
	settled(epoch: number): boolean;
}>;

export type ScheduledRecoveryPoolLullInput = Readonly<{
	/** The session's current epoch, or undefined while it has no live plane. */
	epoch(): number | undefined;
	/** The session's own `maintainRecoveryPool()`. */
	request(): Promise<unknown>;
	now(): number;
}>;

const kindOf = (result: CreatorRecoveryPoolResult): string =>
	result.kind === "deferred" ? `deferred:${result.reason}` : result.kind;

function observe(event: Readonly<Record<string, unknown>>): void {
	try {
		const observer = Reflect.get(globalThis, "__warmProofEvent");
		if (typeof observer === "function") observer(event);
	} catch {
		/* Observation cannot alter scheduling. */
	}
}

/**
 * Creates one session's scheduled-lull bookkeeping.
 * @param input - The session's epoch, its own lull call and a clock.
 * @returns The bookkeeping.
 */
export function createScheduledRecoveryPoolLull(input: ScheduledRecoveryPoolLullInput): ScheduledRecoveryPoolLull {
	let requested: number | undefined;
	let claimable = false;
	let settledLull: Readonly<{ epoch: number; result: CreatorRecoveryPoolResult }> | undefined;
	return Object.freeze({
		schedule(): void {
			const epoch = input.epoch();
			if (epoch === undefined || epoch === requested || settledLull?.epoch === epoch) return;
			requested = epoch;
			claimable = true;
			let pending: Promise<unknown>;
			try {
				pending = input.request();
			} catch {
				// A refused admission is the room's own lifecycle answer; nothing to schedule.
				return;
			} finally {
				claimable = false;
			}
			// The lull's own failure is observed in `run` and handled by the room's rules.
			pending.catch(() => undefined);
		},
		claim(): boolean {
			const claimed = claimable;
			claimable = false;
			return claimed;
		},
		async run(scheduled, lull): Promise<CreatorRecoveryPoolResult> {
			const epoch = input.epoch();
			if (epoch !== undefined && settledLull?.epoch === epoch) return settledLull.result;
			const trigger = scheduled ? "scheduled" : "explicit";
			const started = input.now();
			let result: CreatorRecoveryPoolResult;
			try {
				result = await lull();
			} catch (error) {
				observe({
					kind: "recovery-pool-lull",
					trigger,
					epoch,
					result: "failed",
					cause: error instanceof Error ? error.message : String(error),
					ms: input.now() - started,
				});
				throw error;
			}
			observe({ kind: "recovery-pool-lull", trigger, epoch, result: kindOf(result), ms: input.now() - started });
			if (epoch !== undefined && !(result.kind === "deferred" && result.reason === "busy"))
				settledLull = Object.freeze({ epoch, result });
			return result;
		},
		settled(epoch: number): boolean {
			return settledLull?.epoch === epoch;
		},
	});
}
