import type { BrowserContext, Page } from "@playwright/test";

// Shared realtime page probe (measurement only), lifted from the inline observation of
// tests/phase-3a1b-d9346-v3-zone.pw.ts so that its single-rollover check and the multi-epoch
// browser FPS gate (tests/browser-app-fps.pw.ts) read the same instrument:
// - requestAnimationFrame callback intervals (frame opportunities on the page's main thread);
// - PerformanceObserver "longtask" entries where the engine supports them (Chromium);
// - an event-loop heartbeat (a 25 ms interval whose lateness is a main-thread stall on every engine);
// - entries into RTCDataChannel.send and "message" deliveries on the ephemeral WebRTC channel
//   (label "ts-drp-ephemeral/1"; the original native methods and listeners run unchanged), counted
//   while the probe is started;
// - browser-local stage brackets (creator seal/adopt/export/publish, member install) reported by the
//   served observation in tests/fixtures/realtime-probe/served-rollover-observation.ts;
// - keydown times and app DOM changes (Grid dots and blocks, Canvas pixels, Chat rows) for
//   input-to-render delivery matching in the harness.
// Memory is bounded: every stream is a fixed-capacity ring the harness drains, with an exact drop
// counter, plus exact totals since start. Nothing retains packets, keys, authorities or handles.
//
// Control: `injectBlockMs` > 0 busy-loops the main thread for that long inside every
// `injectEveryFrames`-th animation frame callback (a deliberate stall the gate must catch).

export const EPHEMERAL_LABEL = "ts-drp-ephemeral/1";

export interface RealtimeProbeOptions {
	/** Which shipped page's DOM changes to record ("none": only frames, tasks, RTC and stages). */
	readonly app: "grid" | "canvas" | "chat" | "none";
	readonly injectBlockMs: number;
	readonly injectEveryFrames: number;
	/** Start the frame loop and observers at once (the gate) or on start() (d9346 phases). */
	readonly autoStart: boolean;
	/** Heartbeat stall detector period (ms); 0 disables it (d9346 keeps its own 50 ms timer). */
	readonly heartbeatMs?: number;
}

/** One stage bracket: [name, start, end, ok (1/0), epochAfter or -1, successorEpoch or -1]. */
export type StageRow = readonly [string, number, number, number, number, number];

/** One drain of a page's rings. Times are performance.now() of that page; add `timeOrigin`. */
export interface ProbeDrain {
	readonly timeOrigin: number;
	readonly drainedAt: number;
	readonly visibility: string;
	/** Flattened [end, interval] pairs of complete rAF intervals. */
	readonly frames: readonly number[];
	/** Flattened [start, duration] pairs. */
	readonly longTasks: readonly number[];
	/** Flattened [observedAt, lateness] pairs of heartbeat ticks later than 50 ms. */
	readonly stalls: readonly number[];
	readonly stages: readonly StageRow[];
	/** [at, key] */
	readonly keydowns: readonly (readonly [number, string])[];
	/** [at, key, value] app DOM changes. */
	readonly observations: readonly (readonly [number, string, string])[];
	/** Stages still open at the drain: [name, start]. */
	readonly openStages: readonly (readonly [string, number])[];
	readonly dropped: Readonly<Record<string, number>>;
	readonly totals: ProbeTotals;
	readonly epoch: number | null;
	readonly delivery: Readonly<Record<string, unknown>> | null;
	readonly role: string | null;
	readonly longTaskSupported: boolean;
	readonly hiddenObserved: boolean;
}

export interface ProbeTotals {
	/** rAF callbacks (the first of a run has no interval). */
	readonly frameCallbacks: number;
	/** Complete rAF intervals. */
	readonly frames: number;
	readonly framesOver50: number;
	readonly framesOver100: number;
	readonly maxFrameIntervalMs: number;
	readonly lastFrameAt: number | null;
	readonly longTasks: number;
	readonly longTaskMs: number;
	readonly maxLongTaskMs: number;
	readonly stalls: number;
	readonly maxStallMs: number;
	readonly rtcSendEntries: number;
	readonly rtcMessageEntries: number;
	readonly lastRtcMessageEntryAt: number | null;
	readonly injectedBlocks: number;
	readonly stageCounts: Readonly<Record<string, number>>;
	readonly stageFailures: number;
}

/**
 * The page side. Self-contained: Playwright serializes it into an init script, so it must not
 * close over anything in this module.
 * @param options - See RealtimeProbeOptions.
 */
export function realtimeProbeInitScript(options: RealtimeProbeOptions): void {
	if (Reflect.get(globalThis, "__TS_DRP_REALTIME_PROBE__") !== undefined) throw Error("REALTIME_PROBE_ALREADY_OWNED");
	const now = (): number => performance.now();
	// Fixed-capacity rings with exact drop counts.
	const ring = (capacity: number) => {
		const values: unknown[] = [];
		let dropped = 0;
		return {
			push(value: unknown): void {
				if (values.length < capacity) values.push(value);
				else dropped++;
			},
			take(): unknown[] {
				return values.splice(0);
			},
			get dropped(): number {
				return dropped;
			},
		};
	};
	const frameRing = ring(16_384);
	const taskRing = ring(4_096);
	const stallRing = ring(4_096);
	const stageRing = ring(1_024);
	const keyRing = ring(4_096);
	const observationRing = ring(8_192);
	const listeners = new Set<(kind: string, detail?: string) => void>();
	const emit = (kind: string, detail?: string): void => {
		for (const listener of listeners)
			try {
				listener(kind, detail);
			} catch {
				// Observation never fails the page.
			}
	};
	const totals = {
		frameCallbacks: 0,
		frames: 0,
		framesOver50: 0,
		framesOver100: 0,
		maxFrameIntervalMs: 0,
		lastFrameAt: null as number | null,
		longTasks: 0,
		longTaskMs: 0,
		maxLongTaskMs: 0,
		stalls: 0,
		maxStallMs: 0,
		rtcSendEntries: 0,
		rtcMessageEntries: 0,
		lastRtcMessageEntryAt: null as number | null,
		injectedBlocks: 0,
		stageCounts: {} as Record<string, number>,
		stageFailures: 0,
	};
	let active = false;
	let hiddenObserved = false;
	let frameHandle = 0;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let longTaskObserver: PerformanceObserver | undefined;
	let lastFrame: number | undefined;
	let frameOrdinal = 0;
	const longTaskSupported =
		typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask");
	const onFrame = (): void => {
		if (!active) return;
		const at = now();
		frameOrdinal++;
		totals.frameCallbacks++;
		if (lastFrame !== undefined) {
			const interval = at - lastFrame;
			totals.frames++;
			if (interval > 50) totals.framesOver50++;
			if (interval > 100) totals.framesOver100++;
			if (interval > totals.maxFrameIntervalMs) totals.maxFrameIntervalMs = interval;
			frameRing.push(at);
			frameRing.push(interval);
		}
		totals.lastFrameAt = at;
		lastFrame = at;
		if (document.visibilityState !== "visible") hiddenObserved = true;
		emit("animation-frame-opportunity", document.visibilityState);
		if (options.injectBlockMs > 0 && options.injectEveryFrames > 0 && frameOrdinal % options.injectEveryFrames === 0) {
			// The control's deliberate main-thread block.
			const until = now() + options.injectBlockMs;
			while (now() < until) {
				/* busy */
			}
			totals.injectedBlocks++;
		}
		frameHandle = requestAnimationFrame(onFrame);
	};
	const HEARTBEAT_MS = options.heartbeatMs ?? 25;
	let due = 0;
	const start = (): void => {
		if (active) return;
		active = true;
		lastFrame = undefined;
		frameHandle = requestAnimationFrame(onFrame);
		due = now() + HEARTBEAT_MS;
		if (HEARTBEAT_MS > 0)
			heartbeat = setInterval(() => {
				const at = now();
				const lateness = at - due;
				due = at + HEARTBEAT_MS;
				if (lateness > 50) {
					totals.stalls++;
					if (lateness > totals.maxStallMs) totals.maxStallMs = lateness;
					stallRing.push(at);
					stallRing.push(lateness);
				}
				emit("timer-drift", String(Math.max(0, lateness)));
			}, HEARTBEAT_MS);
		if (longTaskSupported) {
			longTaskObserver = new PerformanceObserver((list) => {
				if (!active) return;
				for (const entry of list.getEntries()) {
					totals.longTasks++;
					totals.longTaskMs += entry.duration;
					if (entry.duration > totals.maxLongTaskMs) totals.maxLongTaskMs = entry.duration;
					taskRing.push(entry.startTime);
					taskRing.push(entry.duration);
					emit("long-task", JSON.stringify({ startTime: entry.startTime, duration: entry.duration }));
				}
			});
			longTaskObserver.observe({ type: "longtask", buffered: false });
		}
	};
	const stop = (): void => {
		active = false;
		cancelAnimationFrame(frameHandle);
		if (heartbeat !== undefined) clearInterval(heartbeat);
		heartbeat = undefined;
		longTaskObserver?.disconnect();
		longTaskObserver = undefined;
	};
	const reset = (): void => {
		for (const r of [frameRing, taskRing, stallRing, stageRing, keyRing, observationRing]) r.take();
		Object.assign(totals, {
			frameCallbacks: 0,
			frames: 0,
			framesOver50: 0,
			framesOver100: 0,
			maxFrameIntervalMs: 0,
			lastFrameAt: null,
			longTasks: 0,
			longTaskMs: 0,
			maxLongTaskMs: 0,
			stalls: 0,
			maxStallMs: 0,
			rtcSendEntries: 0,
			rtcMessageEntries: 0,
			lastRtcMessageEntryAt: null,
			injectedBlocks: 0,
			stageCounts: {},
			stageFailures: 0,
		});
		lastFrame = undefined;
	};

	// Ephemeral WebRTC entries. Original receivers, arguments, returns and listeners are preserved.
	const label = "ts-drp-ephemeral/1";
	const nativeSend = RTCDataChannel.prototype.send;
	const nativeListen = RTCDataChannel.prototype.addEventListener;
	const watched = new WeakSet<RTCDataChannel>();
	Object.defineProperty(RTCDataChannel.prototype, "send", {
		configurable: true,
		writable: true,
		value: function (this: RTCDataChannel, data: unknown) {
			if (active && this.label === label) {
				totals.rtcSendEntries++;
				emit("rtc-send-entry");
			}
			return Reflect.apply(nativeSend, this, [data]);
		},
	});
	Object.defineProperty(RTCDataChannel.prototype, "addEventListener", {
		configurable: true,
		writable: true,
		value: function (this: RTCDataChannel, type: string, listener: unknown, listenerOptions?: unknown) {
			if (type === "message" && this.label === label && !watched.has(this)) {
				watched.add(this);
				Reflect.apply(nativeListen, this, [
					"message",
					() => {
						if (!active) return;
						totals.rtcMessageEntries++;
						totals.lastRtcMessageEntryAt = now();
						emit("rtc-message-entry");
					},
				]);
			}
			return Reflect.apply(nativeListen, this, [type, listener, listenerOptions]);
		},
	});

	// Keydowns (capture phase, before the page's own listener).
	window.addEventListener(
		"keydown",
		(event) => {
			keyRing.push([now(), event.key]);
			emit("input-keydown", event.key);
		},
		{ capture: true }
	);
	// Clicks (Canvas paints): recorded with the clicked element's id.
	window.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			keyRing.push([now(), `click:${target instanceof HTMLElement ? target.id : ""}`]);
		},
		{ capture: true }
	);

	// Stages: the served rollover observation calls stage(name, run) around the policy's and the
	// delivery's own room calls. The page's own room is bound read-only for its epoch.
	let boundRoom: { authority(): { epoch: number } | null } | undefined;
	let boundRole: string | null = null;
	let deliveryStats: (() => Record<string, unknown>) | undefined;
	const openStages = new Map<number, [string, number]>();
	let nextStage = 0;
	const epochOf = (): number => {
		try {
			return boundRoom?.authority()?.epoch ?? -1;
		} catch {
			return -1;
		}
	};
	const observation = Object.freeze({
		stage<Value>(name: string, run: () => Promise<Value>): Promise<Value> {
			const id = nextStage++;
			const started = now();
			openStages.set(id, [name, started]);
			emit("lifecycle-stage-start", name);
			const finish = (ok: boolean, value?: unknown): void => {
				openStages.delete(id);
				totals.stageCounts[name] = (totals.stageCounts[name] ?? 0) + 1;
				if (!ok) totals.stageFailures++;
				const successor =
					value !== null && typeof value === "object" && typeof Reflect.get(value, "successorEpoch") === "number"
						? (Reflect.get(value, "successorEpoch") as number)
						: -1;
				stageRing.push([name, started, now(), ok ? 1 : 0, epochOf(), successor]);
				// A User Timing measure per stage, so a Chromium trace carries the brackets on its own clock.
				try {
					performance.measure(`ts-drp:${name}`, { start: started, end: now() });
				} catch {
					// Engines without measure options keep the ring row only.
				}
				emit("lifecycle-stage-complete", name);
			};
			let pending: Promise<Value>;
			try {
				pending = run();
			} catch (error) {
				finish(false);
				throw error;
			}
			return pending.then(
				(value) => {
					finish(true, value);
					return value;
				},
				(error: unknown) => {
					finish(false);
					throw error;
				}
			);
		},
		bindDelivery(role: string, room: unknown, stats: () => Record<string, unknown>): void {
			boundRole = role;
			boundRoom = room as typeof boundRoom;
			deliveryStats = stats;
		},
	});
	Reflect.set(globalThis, "__TS_DRP_ROLLOVER_OBSERVATION__", observation);

	// App DOM changes, deduplicated per key (only a changed value is recorded).
	const lastValue = new Map<string, string>();
	const seenRows = new Set<string>();
	const record = (key: string, value: string): void => {
		if (lastValue.get(key) === value) return;
		if (lastValue.size >= 4_096 && !lastValue.has(key)) lastValue.delete(lastValue.keys().next().value as string);
		lastValue.set(key, value);
		observationRing.push([now(), key, value]);
	};
	const inspect = (node: Node): void => {
		if (!(node instanceof HTMLElement)) return;
		if (options.app === "grid") {
			const peer = node.dataset.glowingPeerId;
			if (peer !== undefined) record(`p:${peer}`, `${node.style.left};${node.style.top}`);
			const block = node.dataset.blockId;
			if (block !== undefined && node.isConnected) record(`b:${block}`, node.textContent ?? "");
		} else if (options.app === "canvas") {
			if (node.parentElement?.id === "canvas" && node.id !== "") record(node.id, node.style.backgroundColor);
		} else if (options.app === "chat") {
			// The page rebuilds every row on each render and appends complete rows: one record per new row.
			if (!node.classList.contains("message")) return;
			const id = node.dataset.clientOperationId;
			if (id === undefined || seenRows.has(id)) return;
			if (seenRows.size >= 16_384) {
				observationRing.push([now(), "chat:seen-overflow", id]);
				return;
			}
			seenRows.add(id);
			observationRing.push([now(), `m:${id}`, node.querySelector(".message-content")?.textContent ?? ""]);
		}
	};
	const rootId =
		options.app === "grid" ? "grid" : options.app === "canvas" ? "canvas" : options.app === "chat" ? "chat" : "";
	if (rootId !== "") {
		const attach = (): void => {
			const root = document.getElementById(rootId);
			if (root === null) {
				requestAnimationFrame(attach);
				return;
			}
			new MutationObserver((records) => {
				for (const mutation of records) {
					if (mutation.type === "attributes") inspect(mutation.target);
					else {
						// Grid replaces a block's text in place (its target); every page appends new elements.
						if (options.app === "grid") inspect(mutation.target);
						for (const added of Array.from(mutation.addedNodes)) inspect(added);
					}
				}
			}).observe(root, {
				attributes: true,
				attributeFilter: ["style"],
				childList: true,
				subtree: true,
				characterData: false,
			});
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true });
		else attach();
	}

	const copyTotals = () => ({ ...totals, stageCounts: { ...totals.stageCounts } });
	Reflect.set(
		globalThis,
		"__TS_DRP_REALTIME_PROBE__",
		Object.freeze({
			start,
			stop,
			reset,
			subscribe(listener: (kind: string, detail?: string) => void): () => void {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			totals: copyTotals,
			epoch: (): number | null => (boundRoom === undefined ? null : epochOf()),
			drain() {
				const at = now();
				let delivery: Record<string, unknown> | null = null;
				try {
					delivery = deliveryStats === undefined ? null : { ...deliveryStats() };
				} catch {
					delivery = null;
				}
				return {
					timeOrigin: performance.timeOrigin,
					drainedAt: at,
					visibility: document.visibilityState,
					frames: frameRing.take(),
					longTasks: taskRing.take(),
					stalls: stallRing.take(),
					stages: stageRing.take(),
					keydowns: keyRing.take(),
					observations: observationRing.take(),
					openStages: [...openStages.values()].map(([name, started]) => [name, started]),
					dropped: {
						frames: frameRing.dropped,
						longTasks: taskRing.dropped,
						stalls: stallRing.dropped,
						stages: stageRing.dropped,
						keydowns: keyRing.dropped,
						observations: observationRing.dropped,
					},
					totals: copyTotals(),
					epoch: boundRoom === undefined ? null : epochOf(),
					delivery,
					role: boundRole,
					longTaskSupported,
					hiddenObserved,
				};
			},
		})
	);
	if (options.autoStart) start();
}

/**
 * Installs the probe in every page of a context (before any page script).
 * @param context - The browser context.
 * @param options - Probe options.
 */
export async function installRealtimeProbe(context: BrowserContext, options: RealtimeProbeOptions): Promise<void> {
	await context.addInitScript(realtimeProbeInitScript, options);
}

/**
 * Drains one page's probe rings.
 * @param page - The page.
 * @returns The drained rows and totals.
 */
export function drainProbe(page: Page): Promise<ProbeDrain> {
	return page.evaluate(() => {
		const probe = Reflect.get(globalThis, "__TS_DRP_REALTIME_PROBE__") as { drain(): unknown } | undefined;
		if (probe === undefined) throw new Error("REALTIME_PROBE_ABSENT");
		return probe.drain();
	}) as Promise<ProbeDrain>;
}

// ---------------------------------------------------------------------------------------------
// Harness side: fixed-bucket histograms with exact counters.

/** Bucket upper bounds (ms): 1 ms to 100 ms, 10 ms to 500 ms, 100 ms to 10 s; then overflow. */
const BOUNDS: readonly number[] = (() => {
	const bounds: number[] = [];
	for (let value = 1; value <= 100; value++) bounds.push(value);
	for (let value = 110; value <= 500; value += 10) bounds.push(value);
	for (let value = 600; value <= 10_000; value += 100) bounds.push(value);
	return bounds;
})();

export interface HistogramSummary {
	readonly count: number;
	readonly p50: number | null;
	readonly p95: number | null;
	readonly p99: number | null;
	readonly max: number | null;
	readonly over50: number;
	readonly over100: number;
	readonly meanMs: number | null;
	readonly resolution: string;
}

/** A fixed-size histogram (bounded memory) with exact count, max, sum and >50/>100 counters. */
export class FixedHistogram {
	private readonly buckets = new Float64Array(BOUNDS.length + 1);
	private count = 0;
	private sum = 0;
	private max = Number.NEGATIVE_INFINITY;
	private over50 = 0;
	private over100 = 0;

	/**
	 *
	 * @param value
	 */
	add(value: number): void {
		if (!Number.isFinite(value)) return;
		this.count++;
		this.sum += value;
		if (value > this.max) this.max = value;
		if (value > 50) this.over50++;
		if (value > 100) this.over100++;
		let low = 0;
		let high = BOUNDS.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (value <= (BOUNDS[middle] as number)) high = middle;
			else low = middle + 1;
		}
		this.buckets[low] = (this.buckets[low] ?? 0) + 1;
	}

	private quantile(p: number): number | null {
		if (this.count === 0) return null;
		const rank = Math.ceil(p * this.count);
		let seen = 0;
		for (let index = 0; index < this.buckets.length; index++) {
			seen += this.buckets[index] ?? 0;
			if (seen >= rank) return index < BOUNDS.length ? Math.min(BOUNDS[index] as number, this.max) : this.max;
		}
		return this.max;
	}

	/**
	 *
	 */
	summary(): HistogramSummary {
		return {
			count: this.count,
			p50: this.quantile(0.5),
			p95: this.quantile(0.95),
			p99: this.quantile(0.99),
			max: this.count === 0 ? null : this.max,
			over50: this.over50,
			over100: this.over100,
			meanMs: this.count === 0 ? null : this.sum / this.count,
			resolution: "bucket upper bound: 1 ms to 100 ms, 10 ms to 500 ms, 100 ms to 10 s; max exact",
		};
	}
}

/** Counter of long tasks (or stalls) with exact count, total and longest. */
export class TaskCounter {
	count = 0;
	totalMs = 0;
	longestMs = 0;
	/**
	 *
	 * @param duration
	 */
	add(duration: number): void {
		this.count++;
		this.totalMs += duration;
		if (duration > this.longestMs) this.longestMs = duration;
	}
	/**
	 *
	 */
	summary(): Readonly<{ count: number; totalMs: number; longestMs: number }> {
		return { count: this.count, totalMs: this.totalMs, longestMs: this.longestMs };
	}
}
