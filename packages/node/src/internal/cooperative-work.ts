// Host-level scheduling for cooperative native work in one event loop, which
// several rooms (or a creator and a co-located peer) may share.
//
// Foreground work (an admitted issuance job, ordinary readiness, a room's issue
// drain) registers while it runs. Background walks (recovery-pool maintenance)
// run in the background lane. A background host turn defers while foreground
// work is registered, so each foreground yield admits timers and transport
// callbacks instead of one more background span.
//
// There is no async context here, so the lane is ambient and scoped to drains
// we own: a background walk enters through a background host turn of its own,
// and each resumed background turn restores the lane for its microtask drain
// only (cleared by the next process tick, which runs when that drain ends; a
// host without one does not restore it, so there only the entry turn defers).
// A checkpoint created in the lane keeps it. Everything else is unclassified
// and never deferred. A misclassified turn only waits, and every deferral is
// bounded: it resumes once the foreground cohort it found has released, after
// an idle window in which the host keeps turning without foreground progress,
// or at the hard bound. The scheduler holds and detaches no custody: callers
// keep their ownership and recheck currency and stopping after every host
// turn, deferral included.

/** A deferred background turn resumes after this many idle polls without foreground progress. */
export const BACKGROUND_IDLE_POLLS = 5;
/** Interval of one idle poll; a host that is not turning does not advance the count. */
export const BACKGROUND_IDLE_POLL_MS = 10;
/** Hard bound on one background deferral, whatever the foreground does. */
export const BACKGROUND_DEFERRAL_BOUND_MS = 1_000;

type Lane = "background" | undefined;
type Waiter = { readonly cohort: Set<object>; wake(reason: "released" | "idle" | "bound"): void };

const foreground = new Set<object>();
const waiters = new Set<Waiter>();
let running: Lane;
// Advanced by every resumed turn outside the background lane. Registered
// foreground runs through such turns, so an idle window observes none.
let progress = 0;
// Measurement only (never read by scheduling): background host turns, and how
// each deferred one resumed.
const laneCounts = { backgroundTurns: 0, deferred: 0, released: 0, idle: 0, bound: 0 };

/** Background-lane host turn counts since load; for tests and diagnostics only. */
export type BackgroundLaneCounts = Readonly<typeof laneCounts>;
/**
 * Reads the background-lane counters. Scheduling never reads them.
 * @returns A frozen copy: resumed background turns, how many deferred, and how each deferral ended.
 */
export function readBackgroundLaneCounts(): BackgroundLaneCounts {
	return Object.freeze({ ...laneCounts });
}

// Clears a restored lane once the resumed drain ends. Without a process tick
// there is no such boundary, so the lane is not restored at all there.
const endOfDrain: ((callback: () => void) => void) | undefined = ((): ((callback: () => void) => void) | undefined => {
	const tick = (globalThis as { process?: { nextTick?: unknown } }).process?.nextTick;
	return typeof tick === "function"
		? (callback: () => void): void => Reflect.apply(tick, undefined, [callback])
		: undefined;
})();
function restore(lane: Lane): void {
	if (lane === undefined || endOfDrain === undefined) {
		running = undefined;
		return;
	}
	running = lane;
	endOfDrain(() => {
		running = undefined;
	});
}

function deferBehindForeground(): Promise<void> | undefined {
	if (foreground.size === 0) return undefined;
	return new Promise<void>((resolve) => {
		const started = performance.now();
		let seen = progress;
		let idle = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		laneCounts.deferred++;
		const waiter: Waiter = {
			cohort: new Set(foreground),
			wake: (reason: "released" | "idle" | "bound"): void => {
				if (!waiters.delete(waiter)) return;
				laneCounts[reason]++;
				clearTimeout(timer);
				// Resume in a host task of its own, never inside the releasing turn.
				setTimeout(resolve, 0);
			},
		};
		const poll = (): void => {
			idle = progress === seen ? idle + 1 : 0;
			seen = progress;
			if (idle >= BACKGROUND_IDLE_POLLS || performance.now() - started >= BACKGROUND_DEFERRAL_BOUND_MS) {
				waiter.wake(idle >= BACKGROUND_IDLE_POLLS ? "idle" : "bound");
				return;
			}
			timer = setTimeout(poll, BACKGROUND_IDLE_POLL_MS);
		};
		waiters.add(waiter);
		timer = setTimeout(poll, BACKGROUND_IDLE_POLL_MS);
	});
}

function hostTurn(lane: Lane): Promise<void> {
	running = undefined;
	return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
		if (lane !== "background") {
			progress++;
			running = undefined;
			return undefined;
		}
		laneCounts.backgroundTurns++;
		const deferred = deferBehindForeground();
		if (deferred === undefined) {
			restore(lane);
			return undefined;
		}
		return deferred.then(() => {
			restore(lane);
		});
	});
}

/**
 * Registers running foreground work until the returned release runs. Register
 * only admitted work that runs, never work waiting for a background result
 * (such a wait still ends, but only at the idle window or the bound).
 * @returns Idempotent release of this registration.
 */
export function beginForegroundWork(): () => void {
	const ticket = {};
	foreground.add(ticket);
	running = undefined;
	let released = false;
	return (): void => {
		if (released) return;
		released = true;
		foreground.delete(ticket);
		for (const waiter of [...waiters]) {
			waiter.cohort.delete(ticket);
			if (waiter.cohort.size === 0) waiter.wake("released");
		}
	};
}

/**
 * Runs a background walk. It starts in a background host turn of its own (so it
 * defers while foreground work is registered, and its first drain holds only
 * this walk), and the lane holds in every drain the walk resumes in until it
 * settles. Like any host turn, the caller's walk must recheck currency first.
 * @param work - The background walk.
 * @returns What `work` resolves to.
 */
export function runInBackgroundLane<T>(work: () => Promise<T>): Promise<T> {
	return hostTurn("background")
		.then(work)
		.finally(() => {
			running = undefined;
		});
}

/**
 * Give timers and transport callbacks a host task. Awaiting an already resolved
 * native promise only advances the microtask queue and does not do this.
 * Callers keep their existing ownership and must recheck currency after yielding.
 * @returns Completion of the scheduling boundary.
 */
export function yieldToHost(): Promise<void> {
	return hostTurn(running);
}

/**
 * A scheduling budget for one sequential read/preparation walk, not an authority
 * or a bound on an individual native operation. No work or custody is detached.
 * @returns A checkpoint that yields once its local scheduling budget expires.
 */
export function createWorkCheckpoint(): () => Promise<void> | undefined {
	const created = running;
	let deadline = performance.now() + 8;
	return (): Promise<void> | undefined => {
		if (performance.now() < deadline) return undefined;
		return hostTurn(created ?? running).then(() => {
			deadline = performance.now() + 8;
		});
	};
}
