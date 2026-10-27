// Gate thresholds of the browser FPS gate (tests/browser-app-fps.pw.ts), per engine, applied to both
// pages (creator and member) of every shipped app.
//
// Derived from the first baseline (2026-10-27, heads 528db598 / 0499cd82, 30 adopted epochs per
// app; Grid measured up to its member-wedge failure). Rule: each limit is 1.5 x the worst value any
// page of any app showed on that engine, rounded up (ms to 10, rates to 0.5), with a floor of 1.0
// per 1,000 for the >100 ms in-window rate, whose baseline is a single frame or two. The baseline
// ran both pages, the dev servers and the relay on one 10-core host (load 7-15 during runs), so it
// already includes the gate's own contention. The injected-block control (300 ms every 20th frame)
// measures p99 ~310 ms and ~50 frames >100 ms per 1,000 on every engine, far above every limit.
// Headless rAF runs at ~120 Hz on Chromium and Firefox and ~60 Hz on WebKit, so limits are per
// engine. Long tasks are reported only by Chromium.
// Baseline worst values (page, app) behind each limit, from
// .logs/realtime-resume-2026-10-23/browser-fps/{gate-30,gate-30-grid-partial,step1-grid-chromium-100}:
//   Chromium: p99 in 33 (chat creator), p99 out 40 (canvas creator), >100/1000 in 0.2 (grid creator),
//             >50/1000 in 2.6 (chat and grid creator), >100/1000 out 3.8 (chat creator),
//             long task in 402 (grid creator), stall in 398 (grid creator).
//   Firefox:  p99 in 34 (grid creator), p99 out 70 (grid creator), >100/1000 in 0.4 (grid creator),
//             >50/1000 in 6.3 (grid creator), >100/1000 out 1.9 (chat creator), stall in 371 (chat creator).
//   WebKit:   p99 in 55 (chat creator), p99 out 59 (chat creator), >100/1000 in 0.1,
//             >50/1000 in 14.0 (chat creator), >100/1000 out 6.3 (chat creator), stall in 458 (grid creator).
// The Chat creator's ~400 ms main-thread blocks (about two per epoch, mostly outside rollover
// windows) are inside these limits; they are recorded as a finding, not as acceptable by design.

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

const BY_ENGINE: Readonly<Record<string, FpsThresholds>> = {
	chromium: {
		frameP99InWindowMs: 50,
		framesOver100InWindowPer1000: 1,
		framesOver50InWindowPer1000: 4,
		frameP99OutsideMs: 60,
		framesOver100OutsidePer1000: 6,
		longestLongTaskInWindowMs: 610,
		longestStallInWindowMs: 600,
	},
	firefox: {
		frameP99InWindowMs: 60,
		framesOver100InWindowPer1000: 1,
		framesOver50InWindowPer1000: 9.5,
		frameP99OutsideMs: 110,
		framesOver100OutsidePer1000: 3,
		longestLongTaskInWindowMs: 610,
		longestStallInWindowMs: 560,
	},
	webkit: {
		frameP99InWindowMs: 90,
		framesOver100InWindowPer1000: 1,
		framesOver50InWindowPer1000: 21,
		frameP99OutsideMs: 90,
		framesOver100OutsidePer1000: 9.5,
		longestLongTaskInWindowMs: 610,
		longestStallInWindowMs: 690,
	},
};

/**
 * The limits for one engine; every app shares them (the baseline worst case per engine).
 * @param engine - Playwright browser name.
 * @param _app - Shipped app (kept for per-app limits should a later baseline need them).
 */
export function fpsThresholds(engine: string, _app: string): FpsThresholds {
	const thresholds = BY_ENGINE[engine];
	if (thresholds === undefined) throw new Error(`BROWSER_FPS_THRESHOLDS_ENGINE ${engine}`);
	return thresholds;
}

export const FPS_THRESHOLDS_STATUS = "baseline 2026-10-27 (1.5 x worst page per engine)";
