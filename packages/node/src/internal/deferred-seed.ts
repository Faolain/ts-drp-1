// Runs a resumable seed (begin → step(budget) → done) in short host turns, one live seed per owner.
// The live plane seeds its application state bound this way after a machine install, so neither the
// install turn nor any later turn pays the whole seed: each turn steps until it has run `turnMs`,
// then yields to the host. A newer seed for the same owner (the next install) abandons the older one,
// and a seed whose owner is no longer current when its turn runs is discarded: a result is only ever
// delivered for the seed that is still the owner's latest and still current. A caller that cannot wait
// for the turns (it needs the result now) finishes the pending seed in its own turn with finishNow and
// pays only the residual. Nothing here grants admission; the caller owns what a result means and keeps
// its own fallback when none is delivered.

/** The resumable seed the runner drives. step throws on refusal; the runner then delivers undefined. */
export type DeferredSeedStepper<Result> = Readonly<{
	step(byteBudget: number): boolean;
	finish(): Result | undefined;
}>;

/** One seed's cost: host turns taken, busy time across them, its longest turn, install-to-result wall time,
 * the time its creation took (inside the first turn), each turn's duration in order, whether a finishNow
 * caller finished it and the residual that caller paid in its own turn (0 when its own turns finished it). */
export type DeferredSeedStats = Readonly<{
	forced: boolean;
	forcedUs: number;
	turns: number;
	busyUs: number;
	maxTurnUs: number;
	wallUs: number;
	startUs: number;
	turnUs: readonly number[];
}>;

export type DeferredSeedRunnerOptions = Readonly<{
	/** Runs `turn` in a later host turn. */
	schedule(turn: () => void): void;
	/** Milliseconds, monotonic. */
	now(): number;
	/** A turn stops stepping once it has run this long. */
	turnMs: number;
	/** Byte budget of one step. */
	stepBytes: number;
}>;

export type DeferredSeedRequest<Result> = Readonly<{
	/** Creates the seed, in the first deferred turn (never in the caller's turn). Undefined: nothing to seed. */
	start(): DeferredSeedStepper<Result> | undefined;
	/** Whether the owner is still in the state the seed was begun for. */
	current(): boolean;
	/** The finished seed's result (undefined when the seed refused), delivered once, in a seed turn. */
	done(result: Result | undefined, stats: DeferredSeedStats): void;
	/** The seed was abandoned (a newer seed began, or the owner moved on) before it finished. */
	discarded?(stats: DeferredSeedStats): void;
}>;

export interface DeferredSeedRunner<Owner extends object, Result> {
	/** Begins a seed for the owner, abandoning any unfinished one. */
	begin(owner: Owner, request: DeferredSeedRequest<Result>): void;
	/** Abandons the owner's unfinished seed; true when there was one. */
	cancel(owner: Owner): boolean;
	pending(owner: Owner): boolean;
	/**
	 * Finishes the owner's pending seed in the caller's turn and delivers it (done) before returning.
	 * @returns The delivered seed's stats (forcedUs: the residual paid here), or undefined when nothing was
	 * pending or the seed was no longer current (then discarded).
	 */
	finishNow(owner: Owner): DeferredSeedStats | undefined;
}

type Entry<Result> = {
	readonly request: DeferredSeedRequest<Result>;
	readonly begunAt: number;
	seed?: DeferredSeedStepper<Result>;
	turns: number;
	busyMs: number;
	maxTurnMs: number;
	startMs: number;
	turnMs: number[];
	forced: boolean;
	forcedMs: number;
};

/**
 * Creates a runner of resumable seeds in short host turns.
 * @param options - Scheduler, clock, per-turn time budget and per-step byte budget.
 * @returns The runner.
 */
export function createDeferredSeedRunner<Owner extends object, Result>(
	options: DeferredSeedRunnerOptions
): DeferredSeedRunner<Owner, Result> {
	const { schedule, now, turnMs, stepBytes } = options;
	const entries = new WeakMap<Owner, Entry<Result>>();
	const stats = (entry: Entry<Result>): DeferredSeedStats =>
		Object.freeze({
			turns: entry.turns,
			busyUs: Math.round(entry.busyMs * 1000),
			maxTurnUs: Math.round(entry.maxTurnMs * 1000),
			wallUs: Math.round((now() - entry.begunAt) * 1000),
			startUs: Math.round(entry.startMs * 1000),
			turnUs: Object.freeze(entry.turnMs.map((ms) => Math.round(ms * 1000))),
			forced: entry.forced,
			forcedUs: Math.round(entry.forcedMs * 1000),
		});
	const abandon = (entry: Entry<Result>): void => {
		try {
			entry.request.discarded?.(stats(entry));
		} catch {
			/* A listener cannot alter the runner. */
		}
	};
	/** Whether the owner's live seed is this entry and still current; a seed no longer current is discarded. */
	const live = (owner: Owner, entry: Entry<Result>): boolean => {
		if (entries.get(owner) !== entry) return false;
		let current = false;
		try {
			current = entry.request.current();
		} catch {
			current = false;
		}
		if (!current) {
			entries.delete(owner);
			abandon(entry);
		}
		return current;
	};
	const deliver = (owner: Owner, entry: Entry<Result>, result: Result | undefined): DeferredSeedStats => {
		entries.delete(owner);
		const delivered = stats(entry);
		try {
			entry.request.done(result, delivered);
		} catch {
			/* The caller owns its result. */
		}
		return delivered;
	};
	const turn = (owner: Owner, entry: Entry<Result>): void => {
		if (!live(owner, entry)) return;
		const started = now();
		let finished = false;
		let result: Result | undefined;
		try {
			let fresh = false;
			if (entry.seed === undefined) {
				entry.seed = entry.request.start();
				entry.startMs = now() - started;
				fresh = true;
			}
			if (entry.seed === undefined) finished = true;
			// A creation that used half the turn steps from the next turn; any later turn steps at least once.
			else if (!fresh || now() - started < turnMs / 2) {
				do finished = entry.seed.step(stepBytes) === true;
				while (!finished && now() - started < turnMs);
				if (finished) result = entry.seed.finish();
			}
		} catch {
			finished = true;
			result = undefined;
		}
		const spent = now() - started;
		entry.turns++;
		entry.turnMs.push(spent);
		entry.busyMs += spent;
		if (spent > entry.maxTurnMs) entry.maxTurnMs = spent;
		if (!finished) {
			schedule(() => turn(owner, entry));
			return;
		}
		deliver(owner, entry, result);
	};
	return Object.freeze({
		begin(owner: Owner, request: DeferredSeedRequest<Result>): void {
			const prior = entries.get(owner);
			if (prior !== undefined) abandon(prior);
			const entry: Entry<Result> = { request, begunAt: now(), turns: 0, busyMs: 0, maxTurnMs: 0, startMs: 0, turnMs: [],
				forced: false, forcedMs: 0 };
			entries.set(owner, entry);
			schedule(() => turn(owner, entry));
		},
		cancel(owner: Owner): boolean {
			const prior = entries.get(owner);
			if (prior === undefined) return false;
			entries.delete(owner);
			abandon(prior);
			return true;
		},
		pending(owner: Owner): boolean {
			return entries.has(owner);
		},
		finishNow(owner: Owner): DeferredSeedStats | undefined {
			const entry = entries.get(owner);
			if (entry === undefined || !live(owner, entry)) return undefined;
			// The queued turn finds the entry gone and does nothing.
			const started = now();
			let result: Result | undefined;
			try {
				entry.seed ??= entry.request.start();
				if (entry.seed !== undefined) {
					while (entry.seed.step(Number.MAX_SAFE_INTEGER) !== true);
					result = entry.seed.finish();
				}
			} catch {
				result = undefined;
			}
			entry.forced = true;
			entry.forcedMs = now() - started;
			return deliver(owner, entry, result);
		},
	});
}
