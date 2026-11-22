import type { CreatorRecoveryPoolResult } from "./creator-recovery-pool.js";

/** Opt-in automatic early recovery-pool turnover at observed idle lulls. */
export type RecoveryPoolAutoMaintenanceOptions = Readonly<{
	/** Quiet period with no local issue, projection change or lifetime transition. Default 1000 ms. */
	idleMilliseconds?: number;
	/** Upper bound for the back-off after a busy attempt. Default 30000 ms. */
	maxBackoffMilliseconds?: number;
	/** Observation only; a throwing observer cannot alter scheduling. */
	onResult?(outcome: RecoveryPoolAutoMaintenanceOutcome): void;
}>;

export type RecoveryPoolAutoMaintenanceOutcome = Readonly<
	| { kind: "result"; epoch: number; milliseconds: number; result: CreatorRecoveryPoolResult }
	| { kind: "failed"; epoch: number; milliseconds: number; error: unknown }
>;

export type RecoveryPoolAutoSchedulerInput = Readonly<{
	options: RecoveryPoolAutoMaintenanceOptions;
	/** Identity snapshot of room activity; any element change counts as activity. */
	activity(): readonly unknown[];
	/** True while local work is queued or a lifetime transition is admitted. */
	busy(): boolean;
	/** Current epoch, or undefined while the room has no live plane. */
	epoch(): number | undefined;
	/** False once the session is closed or failed; stops the scheduler. */
	open(): boolean;
	/** Optional: whether another lull source (the scheduled lull) already settled `epoch`. */
	settled?(epoch: number): boolean;
	maintain(): Promise<CreatorRecoveryPoolResult>;
	now(): number;
	setTimer(callback: () => void, milliseconds: number): unknown;
	clearTimer(handle: unknown): void;
}>;

const DEFAULT_IDLE_MILLISECONDS = 1_000;
const DEFAULT_MAX_BACKOFF_MILLISECONDS = 30_000;

/**
 * Validates the opt-in options. Bounds are local scheduling policy only.
 * @param options - Caller options.
 * @returns Resolved idle and back-off bounds.
 */
export function resolveRecoveryPoolAutoMaintenanceOptions(options: RecoveryPoolAutoMaintenanceOptions): Readonly<{
	idleMilliseconds: number;
	maxBackoffMilliseconds: number;
}> {
	const idle = options.idleMilliseconds ?? DEFAULT_IDLE_MILLISECONDS;
	const maxBackoff = options.maxBackoffMilliseconds ?? Math.max(DEFAULT_MAX_BACKOFF_MILLISECONDS, idle);
	if (!Number.isSafeInteger(idle) || idle < 1 || !Number.isSafeInteger(maxBackoff) || maxBackoff < idle)
		throw new TypeError("v3 room recovery-pool auto maintenance bounds are invalid");
	if (options.onResult !== undefined && typeof options.onResult !== "function")
		throw new TypeError("v3 room recovery-pool auto maintenance observer is invalid");
	return Object.freeze({ idleMilliseconds: idle, maxBackoffMilliseconds: maxBackoff });
}

/**
 * Polls for an idle lull and then requests the SAME explicit maintenance call.
 * It never forces work: activity resets the idle clock, `busy` results back off
 * exponentially, and an epoch whose result was `maintained`, `not-needed` or
 * `unsupported` is not retried until the epoch changes, and an epoch `settled` reports
 * (another lull source already settled it) is never attempted. A failure stops the
 * scheduler; the room's own halt/recovery rules apply unchanged.
 * @param input - Room observations and the explicit maintenance call.
 * @returns Stop handle; idempotent.
 */
export function startRecoveryPoolAutoScheduler(input: RecoveryPoolAutoSchedulerInput): Readonly<{ stop(): void }> {
	const { idleMilliseconds, maxBackoffMilliseconds } = resolveRecoveryPoolAutoMaintenanceOptions(input.options);
	const observe = input.options.onResult;
	let stopped = false, timer: unknown, delay = idleMilliseconds, settledEpoch: number | undefined;
	let seen = input.activity();
	const report = (outcome: RecoveryPoolAutoMaintenanceOutcome): void => {
		try { observe?.(outcome); } catch { /* Observation cannot alter scheduling. */ }
	};
	const arm = (milliseconds: number): void => {
		if (stopped || !input.open()) return;
		timer = input.setTimer(() => { timer = undefined; void tick(); }, milliseconds);
	};
	const changed = (): boolean => {
		const current = input.activity();
		const moved = current.length !== seen.length || current.some((value, index) => value !== seen[index]);
		seen = current;
		return moved;
	};
	const tick = async (): Promise<void> => {
		if (stopped || !input.open()) return;
		const epoch = input.epoch();
		if (changed() || input.busy() || epoch === undefined) {
			delay = idleMilliseconds;
			return arm(idleMilliseconds);
		}
		if (epoch === settledEpoch || input.settled?.(epoch) === true) return arm(idleMilliseconds);
		let result: CreatorRecoveryPoolResult;
		const started = input.now();
		try {
			result = await input.maintain();
		} catch (error) {
			report(Object.freeze({ kind: "failed", epoch, milliseconds: input.now() - started, error }));
			stopped = true;
			return;
		}
		report(Object.freeze({ kind: "result", epoch, milliseconds: input.now() - started, result }));
		// Work done by this call is not gameplay activity.
		seen = input.activity();
		if (result.kind === "deferred" && result.reason === "busy") {
			delay = Math.min(delay * 2, maxBackoffMilliseconds);
			return arm(delay);
		}
		settledEpoch = epoch;
		delay = idleMilliseconds;
		arm(idleMilliseconds);
	};
	arm(idleMilliseconds);
	return Object.freeze({
		stop(): void {
			stopped = true;
			if (timer !== undefined) input.clearTimer(timer);
			timer = undefined;
		},
	});
}
