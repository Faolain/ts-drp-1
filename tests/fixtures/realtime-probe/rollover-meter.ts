import type { Page } from "@playwright/test";

import {
	drainProbe,
	FixedHistogram,
	type HistogramSummary,
	type ProbeDrain,
	type ProbeTotals,
	TaskCounter,
} from "./page-probe.js";
import { fabricAgeOfInformation } from "../../../examples/grid/src/age-of-information.js";

// Harness side of the browser FPS gate. It drains both pages' probe rings on a short period, keeps
// every rollover stage bracket of both pages (absolute times), and folds each frame interval, long
// task and heartbeat stall into fixed-size histograms/counters, split by whether it overlaps a
// rollover window: the union of every stage bracket (creator seal, adopt, export, publish; member
// install) of EITHER page, an open bracket counting from its start. A sample is classified only once
// both pages have been drained past it, so a bracket the other page opened meanwhile is known.
// Memory: histograms are fixed-size; stage brackets, per-rollover windows, placements and movement
// deliveries grow with the run (a few numbers per epoch or per move), never with frames.

export type Role = "creator" | "member";

export interface StageInterval {
	readonly role: Role;
	readonly name: string;
	readonly start: number;
	readonly end: number;
	readonly ok: boolean;
	readonly epochAfter: number;
	readonly successorEpoch: number;
}

interface PageAccumulator {
	readonly framesAll: FixedHistogram;
	readonly framesIn: FixedHistogram;
	readonly framesOut: FixedHistogram;
	readonly tasksIn: TaskCounter;
	readonly tasksOut: TaskCounter;
	readonly stallsIn: TaskCounter;
	readonly stallsOut: TaskCounter;
	pendingFrames: number[];
	pendingTasks: number[];
	pendingStalls: number[];
	timeOrigin: number;
	drainedAt: number;
	totals: ProbeTotals | undefined;
	epoch: number | null;
	delivery: Readonly<Record<string, unknown>> | null;
	role: string | null;
	longTaskSupported: boolean;
	hiddenObserved: boolean;
	dropped: Record<string, number>;
	visibility: string;
}

const accumulator = (): PageAccumulator => ({
	framesAll: new FixedHistogram(),
	framesIn: new FixedHistogram(),
	framesOut: new FixedHistogram(),
	tasksIn: new TaskCounter(),
	tasksOut: new TaskCounter(),
	stallsIn: new TaskCounter(),
	stallsOut: new TaskCounter(),
	pendingFrames: [],
	pendingTasks: [],
	pendingStalls: [],
	timeOrigin: 0,
	drainedAt: 0,
	totals: undefined,
	epoch: null,
	delivery: null,
	role: null,
	longTaskSupported: false,
	hiddenObserved: false,
	dropped: {},
	visibility: "unknown",
});

export interface PageReport {
	readonly frames: Readonly<{
		all: HistogramSummary;
		inRolloverWindow: HistogramSummary;
		outsideRolloverWindow: HistogramSummary;
	}>;
	readonly longTasks: Readonly<{
		supported: boolean;
		inRolloverWindow: ReturnType<TaskCounter["summary"]>;
		outsideRolloverWindow: ReturnType<TaskCounter["summary"]>;
	}>;
	readonly heartbeatStalls: Readonly<{
		inRolloverWindow: ReturnType<TaskCounter["summary"]>;
		outsideRolloverWindow: ReturnType<TaskCounter["summary"]>;
		qualification: string;
	}>;
	readonly totals: ProbeTotals | undefined;
	readonly epoch: number | null;
	readonly delivery: Readonly<Record<string, unknown>> | null;
	readonly deliveryRole: string | null;
	readonly droppedRingEntries: Readonly<Record<string, number>>;
	readonly hiddenObserved: boolean;
	readonly visibility: string;
}

/** Drains and classifies both pages. */
export class RolloverMeter {
	readonly stages: StageInterval[] = [];
	private readonly open = new Map<Role, (readonly [string, number])[]>([
		["creator", []],
		["member", []],
	]);
	private readonly pages = new Map<Role, PageAccumulator>([
		["creator", accumulator()],
		["member", accumulator()],
	]);
	/** Raw rows the app drivers consume (keydowns and DOM observations, absolute times). */
	readonly keydowns = new Map<Role, [number, string][]>([
		["creator", []],
		["member", []],
	]);
	readonly observations = new Map<Role, [number, string, string][]>([
		["creator", []],
		["member", []],
	]);

	/**
	 * Each page's clock (performance.timeOrigin + now) differs from the harness clock by an offset
	 * that differs per renderer process and drifts slowly, so every page time is mapped onto the
	 * harness clock with the offset of the tightest of a few round trips, recalibrated periodically.
	 */
	private readonly offsets = new Map<Role, Readonly<{ offset: number; rtt: number; at: number }>>();
	private readonly calibrations: Readonly<{ role: Role; offset: number; rtt: number; at: number }>[] = [];
	private drains = 0;

	/**
	 *
	 * @param roles
	 */
	constructor(private readonly roles: ReadonlyMap<Role, Page>) {}

	/**
	 * Measures each page's clock offset against the harness clock.
	 * @param samples
	 */
	async calibrate(samples = 7): Promise<void> {
		for (const [role, page] of this.roles) {
			let best: { offset: number; rtt: number; at: number } | undefined;
			for (let sample = 0; sample < samples; sample++) {
				const before = performance.timeOrigin + performance.now();
				const pageNow = await page.evaluate(() => performance.timeOrigin + performance.now());
				const after = performance.timeOrigin + performance.now();
				const rtt = after - before;
				if (best === undefined || rtt < best.rtt) best = { offset: pageNow - (before + after) / 2, rtt, at: after };
			}
			if (best !== undefined) {
				this.offsets.set(role, best);
				if (this.calibrations.length < 4_096) this.calibrations.push({ role, ...best });
			}
		}
	}

	/**
	 * Maps an absolute page time (performance.timeOrigin + now) of one role onto the harness clock.
	 * @param role
	 * @param pageTime
	 */
	toHarness(role: Role, pageTime: number): number {
		return pageTime - (this.offsets.get(role)?.offset ?? 0);
	}

	/** Calibration history (bounded): offsets and round trips. */
	clockCalibration(): Readonly<Record<string, unknown>> {
		const summary = (role: Role) => {
			const rows = this.calibrations.filter((row) => row.role === role);
			if (rows.length === 0) return null;
			const offsets = rows.map((row) => row.offset);
			return {
				samples: rows.length,
				firstOffsetMs: offsets[0],
				lastOffsetMs: offsets.at(-1),
				offsetRangeMs: Math.max(...offsets) - Math.min(...offsets),
				worstRttMs: Math.max(...rows.map((row) => row.rtt)),
			};
		};
		return {
			rule: "page time - offset = harness time; offset from the minimum-round-trip of 7 evaluations, recalibrated every 10 s",
			creator: summary("creator"),
			member: summary("member"),
		};
	}

	/** Drains both pages and classifies every sample both drains have passed. */
	async drain(): Promise<void> {
		if (this.offsets.size === 0 || this.drains % 20 === 0) await this.calibrate();
		this.drains++;
		const entries = [...this.roles.entries()];
		const drained = await Promise.all(entries.map(([, page]) => drainProbe(page)));
		entries.forEach(([role], index) => this.ingest(role, drained[index] as ProbeDrain));
		this.classify();
	}

	private ingest(role: Role, drain: ProbeDrain): void {
		const page = this.pages.get(role) as PageAccumulator;
		const origin = drain.timeOrigin - (this.offsets.get(role)?.offset ?? 0);
		page.timeOrigin = origin;
		page.drainedAt = origin + drain.drainedAt;
		page.totals = drain.totals;
		page.epoch = drain.epoch;
		page.delivery = drain.delivery;
		page.role = drain.role;
		page.longTaskSupported = drain.longTaskSupported;
		page.hiddenObserved ||= drain.hiddenObserved;
		page.dropped = { ...drain.dropped };
		page.visibility = drain.visibility;
		for (let index = 0; index + 1 < drain.frames.length; index += 2)
			page.pendingFrames.push(origin + (drain.frames[index] as number), drain.frames[index + 1] as number);
		for (let index = 0; index + 1 < drain.longTasks.length; index += 2)
			page.pendingTasks.push(origin + (drain.longTasks[index] as number), drain.longTasks[index + 1] as number);
		for (let index = 0; index + 1 < drain.stalls.length; index += 2)
			page.pendingStalls.push(origin + (drain.stalls[index] as number), drain.stalls[index + 1] as number);
		for (const [name, start, end, ok, epochAfter, successorEpoch] of drain.stages)
			this.stages.push({
				role,
				name,
				start: origin + start,
				end: origin + end,
				ok: ok === 1,
				epochAfter,
				successorEpoch,
			});
		this.open.set(
			role,
			drain.openStages.map(([name, start]) => [name, origin + start] as const)
		);
		const keys = this.keydowns.get(role) as [number, string][];
		for (const [at, key] of drain.keydowns) keys.push([origin + at, key]);
		const seen = this.observations.get(role) as [number, string, string][];
		for (const [at, key, value] of drain.observations) seen.push([origin + at, key, value]);
	}

	/**
	 * Whether [from, to] overlaps a rollover window known now.
	 * @param from
	 * @param to
	 */
	overlapsWindow(from: number, to: number): boolean {
		for (const stage of this.stages) if (stage.start <= to && stage.end >= from) return true;
		for (const rows of this.open.values()) for (const [, start] of rows) if (start <= to) return true;
		return false;
	}

	private classify(final = false): void {
		const cutoff = final
			? Number.POSITIVE_INFINITY
			: Math.min(...[...this.pages.values()].map((page) => page.drainedAt));
		for (const page of this.pages.values()) {
			const frames = page.pendingFrames;
			const keepFrames: number[] = [];
			for (let index = 0; index + 1 < frames.length; index += 2) {
				const end = frames[index] as number;
				const interval = frames[index + 1] as number;
				if (end > cutoff) {
					keepFrames.push(end, interval);
					continue;
				}
				page.framesAll.add(interval);
				(this.overlapsWindow(end - interval, end) ? page.framesIn : page.framesOut).add(interval);
			}
			page.pendingFrames = keepFrames;
			const fold = (values: number[], inside: TaskCounter, outside: TaskCounter, stall: boolean): number[] => {
				const keep: number[] = [];
				for (let index = 0; index + 1 < values.length; index += 2) {
					const at = values[index] as number;
					const duration = values[index + 1] as number;
					// A task is [start, start + duration]; a heartbeat stall ends where it was observed.
					const from = stall ? at - duration : at;
					const to = stall ? at : at + duration;
					if (to > cutoff) {
						keep.push(at, duration);
						continue;
					}
					(this.overlapsWindow(from, to) ? inside : outside).add(duration);
				}
				return keep;
			};
			page.pendingTasks = fold(page.pendingTasks, page.tasksIn, page.tasksOut, false);
			page.pendingStalls = fold(page.pendingStalls, page.stallsIn, page.stallsOut, true);
		}
	}

	/** Classifies everything left (call once both pages are stopped and drained). */
	finish(): void {
		this.classify(true);
	}

	/**
	 *
	 * @param role
	 */
	epoch(role: Role): number | null {
		return (this.pages.get(role) as PageAccumulator).epoch;
	}

	/**
	 *
	 * @param role
	 */
	totals(role: Role): ProbeTotals | undefined {
		return (this.pages.get(role) as PageAccumulator).totals;
	}

	/**
	 *
	 * @param role
	 */
	report(role: Role): PageReport {
		const page = this.pages.get(role) as PageAccumulator;
		return {
			frames: {
				all: page.framesAll.summary(),
				inRolloverWindow: page.framesIn.summary(),
				outsideRolloverWindow: page.framesOut.summary(),
			},
			longTasks: {
				supported: page.longTaskSupported,
				inRolloverWindow: page.tasksIn.summary(),
				outsideRolloverWindow: page.tasksOut.summary(),
			},
			heartbeatStalls: {
				inRolloverWindow: page.stallsIn.summary(),
				outsideRolloverWindow: page.stallsOut.summary(),
				qualification:
					"lateness above 50 ms of a 25 ms setInterval heartbeat: a main-thread stall proxy on engines without PerformanceObserver longtask",
			},
			totals: page.totals,
			epoch: page.epoch,
			delivery: page.delivery,
			deliveryRole: page.role,
			droppedRingEntries: page.dropped,
			hiddenObserved: page.hiddenObserved,
			visibility: page.visibility,
		};
	}

	/** Stage durations by name (ms), fixed-size histograms. */
	stageDurations(): Record<string, HistogramSummary & { failures: number }> {
		const byName = new Map<string, { histogram: FixedHistogram; failures: number }>();
		for (const stage of this.stages) {
			const key = `${stage.role}:${stage.name}`;
			const entry = byName.get(key) ?? { histogram: new FixedHistogram(), failures: 0 };
			entry.histogram.add(stage.end - stage.start);
			if (!stage.ok) entry.failures++;
			byName.set(key, entry);
		}
		return Object.fromEntries(
			[...byName].map(([key, value]) => [key, { ...value.histogram.summary(), failures: value.failures }])
		);
	}

	/**
	 * One window per creator rollover: from its seal's start to the later of its last creator stage
	 * and the first member install that reached its successor epoch.
	 */
	rolloverWindows(): readonly Readonly<{
		successorEpoch: number;
		start: number;
		creatorEnd: number;
		memberInstallEnd: number | null;
		end: number;
		sealMs: number;
		creatorMs: number;
	}>[] {
		const seals = this.stages.filter((stage) => stage.role === "creator" && stage.name === "creator-seal" && stage.ok);
		return seals.map((seal, index) => {
			const nextSeal = seals[index + 1]?.start ?? Number.POSITIVE_INFINITY;
			const creatorEnd = Math.max(
				seal.end,
				...this.stages
					.filter(
						(stage) =>
							stage.role === "creator" &&
							stage.name !== "creator-seal" &&
							stage.start >= seal.start &&
							stage.start < nextSeal
					)
					.map((stage) => stage.end)
			);
			const install = this.stages.find(
				(stage) =>
					stage.role === "member" &&
					stage.name === "member-install" &&
					stage.ok &&
					stage.start >= seal.start &&
					stage.epochAfter >= seal.successorEpoch
			);
			return {
				successorEpoch: seal.successorEpoch,
				start: seal.start,
				creatorEnd,
				memberInstallEnd: install?.end ?? null,
				end: Math.max(creatorEnd, install?.end ?? creatorEnd),
				sealMs: seal.end - seal.start,
				creatorMs: creatorEnd - seal.start,
			};
		});
	}
}

// ---------------------------------------------------------------------------------------------
// Movement over the ephemeral WebRTC channel (Grid).

/**
 * Parses one Grid dot coordinate as rendered: `calc(50% + Npx)` (left) or `calc(50% - Npx)` (top).
 * @param value
 */
export function parseGridOffset(value: string): number | undefined {
	const text = value.trim();
	if (text === "50%") return 0;
	const match = /^calc\(50%\s*([+-])\s*(-?[\d.]+)px\)$/u.exec(text);
	if (match === null) return undefined;
	const magnitude = Number(match[2]);
	return match[1] === "-" ? -magnitude : magnitude;
}

/**
 *
 * @param value
 */
export function parseGridPosition(value: string): Readonly<{ x: number; y: number }> | undefined {
	const [left, top] = value.split(";");
	const x = parseGridOffset(left ?? "");
	const yOffset = parseGridOffset(top ?? "");
	if (x === undefined || yOffset === undefined) return undefined;
	// left = 50% + 24x px; top = 50% - 24y px.
	return { x: Math.round(x / 24), y: Math.round(-yOffset / 24) };
}

interface PendingMove {
	readonly sentAt: number;
	readonly x: number;
	readonly y: number;
}

/**
 * One direction of movement: the sender's key presses (with the positions they produce) against
 * the receiver's rendered positions of the sender's dot. A rendered position matches the oldest
 * pending press that produced it; older pending presses were coalesced (a newer position was shown
 * first). Presses unmatched after `expiryMs` were never shown.
 */
export class MovementDirection {
	private readonly pending: PendingMove[] = [];
	readonly latencyAll = new FixedHistogram();
	readonly latencyIn = new FixedHistogram();
	readonly latencyOut = new FixedHistogram();
	readonly deliveries: { sentAtMs: number; receivedAtMs: number }[] = [];
	/** Gaps between successive presses: the source's own cadence, which age of information includes. */
	readonly sendGaps = new FixedHistogram();
	sent = 0;
	shown = 0;
	coalesced = 0;
	neverShown = 0;
	unmatchedRenders = 0;
	firstSentAt: number | undefined;
	lastSentAt: number | undefined;
	/** Diagnostics: the first few sends and unmatched renders (bounded). */
	private readonly firstSends: string[] = [];
	private readonly firstUnmatched: string[] = [];

	/**
	 *
	 * @param label
	 * @param expiryMs
	 */
	constructor(
		readonly label: string,
		private readonly expiryMs = 5_000
	) {}

	/**
	 *
	 * @param sentAt
	 * @param x
	 * @param y
	 */
	send(sentAt: number, x: number, y: number): void {
		this.sent++;
		if (this.lastSentAt !== undefined) this.sendGaps.add(sentAt - this.lastSentAt);
		this.firstSentAt ??= sentAt;
		this.lastSentAt = sentAt;
		this.pending.push({ sentAt, x, y });
		if (this.firstSends.length < 8) this.firstSends.push(`${x},${y}`);
	}

	/**
	 *
	 * @param at
	 * @param x
	 * @param y
	 * @param inWindow
	 */
	render(at: number, x: number, y: number, inWindow: (from: number, to: number) => boolean): void {
		while (this.pending.length > 0 && at - (this.pending[0] as PendingMove).sentAt > this.expiryMs) {
			this.pending.shift();
			this.neverShown++;
		}
		const index = this.pending.findIndex((move) => move.x === x && move.y === y && move.sentAt <= at);
		if (index < 0) {
			this.unmatchedRenders++;
			if (this.firstUnmatched.length < 8) this.firstUnmatched.push(`${x},${y}`);
			return;
		}
		const move = this.pending[index] as PendingMove;
		this.coalesced += index;
		this.pending.splice(0, index + 1);
		this.shown++;
		const latency = at - move.sentAt;
		this.latencyAll.add(latency);
		(inWindow(move.sentAt, at) ? this.latencyIn : this.latencyOut).add(latency);
		this.deliveries.push({ sentAtMs: move.sentAt, receivedAtMs: at });
	}

	/**
	 * Age of information at the receiver with the Grid page's own computation
	 * (examples/grid/src/age-of-information.ts), sampled every `intervalMs` over the sending period.
	 * @param intervalMs
	 * @param inWindow
	 */
	ageOfInformation(
		intervalMs: number,
		inWindow: (from: number, to: number) => boolean
	): Readonly<{
		all: HistogramSummary;
		inRolloverWindow: HistogramSummary;
		outsideRolloverWindow: HistogramSummary;
	}> | null {
		if (this.firstSentAt === undefined || this.lastSentAt === undefined) return null;
		const ages = fabricAgeOfInformation(this.deliveries, this.firstSentAt, this.lastSentAt, intervalMs);
		const all = new FixedHistogram();
		const inside = new FixedHistogram();
		const outside = new FixedHistogram();
		ages.forEach((age, index) => {
			const sampledAt = this.firstSentAt! + index * intervalMs;
			all.add(age);
			(inWindow(sampledAt, sampledAt) ? inside : outside).add(age);
		});
		return { all: all.summary(), inRolloverWindow: inside.summary(), outsideRolloverWindow: outside.summary() };
	}

	/**
	 *
	 */
	summary(): Readonly<Record<string, unknown>> {
		return {
			label: this.label,
			sent: this.sent,
			shown: this.shown,
			coalesced: this.coalesced,
			neverShown: this.neverShown + this.pending.length,
			unmatchedRenders: this.unmatchedRenders,
			sendGapMs: this.sendGaps.summary(),
			firstSends: this.firstSends,
			firstUnmatchedRenders: this.firstUnmatched,
			inputToRemoteRenderMs: {
				all: this.latencyAll.summary(),
				inRolloverWindow: this.latencyIn.summary(),
				outsideRolloverWindow: this.latencyOut.summary(),
			},
		};
	}
}
