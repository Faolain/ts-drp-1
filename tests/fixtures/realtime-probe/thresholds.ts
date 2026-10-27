// Gate thresholds of the browser FPS gate (tests/browser-app-fps.pw.ts), per page (creator and
// member) of every shipped app, per engine. PROVISIONAL until the first quiet-host baseline: the
// values below only keep the instrument honest (the injected-block control must fail them) and are
// replaced, with their justification, from the measured baseline.

export interface FpsThresholds {
	/** p99 of rAF intervals that overlap a rollover window (ms, histogram bucket upper bound). */
	readonly frameP99InWindowMs: number;
	/** Frames longer than 100 ms per 1,000 frames that overlap a rollover window. */
	readonly framesOver100InWindowPer1000: number;
	/** Frames longer than 50 ms per 1,000 frames that overlap a rollover window. */
	readonly framesOver50InWindowPer1000: number;
	/** p99 of rAF intervals outside rollover windows (ms). */
	readonly frameP99OutsideMs: number;
	/** Frames longer than 100 ms per 1,000 frames outside rollover windows. */
	readonly framesOver100OutsidePer1000: number;
	/** Longest long task inside a rollover window (ms), where the engine reports long tasks. */
	readonly longestLongTaskInWindowMs: number;
	/** Longest heartbeat stall inside a rollover window (ms), every engine. */
	readonly longestStallInWindowMs: number;
}

const PROVISIONAL: FpsThresholds = {
	frameP99InWindowMs: 250,
	framesOver100InWindowPer1000: 60,
	framesOver50InWindowPer1000: 150,
	frameP99OutsideMs: 150,
	framesOver100OutsidePer1000: 20,
	longestLongTaskInWindowMs: 1_000,
	longestStallInWindowMs: 1_000,
};

/**
 * Per engine and app; the provisional values apply everywhere until the baseline replaces them.
 * @param _engine
 * @param _app
 */
export function fpsThresholds(_engine: string, _app: string): FpsThresholds {
	return PROVISIONAL;
}

export const FPS_THRESHOLDS_STATUS = "provisional (before the first quiet-host baseline)";
