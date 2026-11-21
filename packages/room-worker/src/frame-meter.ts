/**
 * The bridge's per-frame main-thread cost (measurement only), split between the library and the app:
 * each page frame's worker-message handling and posts, less the app rendering they ran, is the
 * library's cost; the app's rendering (what it wraps in `render` or `renderFrame`) is the app's.
 * Totals are exact; a cost lands in the frame its handler ran. Pass the meter to openRoomWorker's
 * `meter`. Apps expose `control` to their harness.
 */
import type { RoomWorkerMeter } from "./page.js";

const FRAME_LIMIT = 100_000;
/** A frame whose library cost is above this is "heavy" (Profile M's per-frame share of the bridge). */
const HEAVY_FRAME_MS = 0.5;

/** One message kind's share of the library cost, and what it spent in heavy frames. */
export interface RoomWorkerFrameMeterKind {
	readonly count: number;
	readonly totalMs: number;
	readonly maxMs: number;
	readonly heavyFrames: number;
	readonly heavyMs: number;
}

export interface RoomWorkerFrameMeterReading {
	/** The library's main-thread ms per page frame. */
	readonly library: readonly number[];
	/** The app's rendering ms per page frame. */
	readonly render: readonly number[];
	readonly dropped: number;
	readonly kinds: Readonly<Record<string, RoomWorkerFrameMeterKind>>;
	/** The latency stages the app named (ms samples). */
	readonly latency: Readonly<Record<string, readonly number[]>>;
}

export interface RoomWorkerFrameMeterControl {
	read(): RoomWorkerFrameMeterReading;
	reset(): void;
}

export interface RoomWorkerFrameMeterOptions {
	/** Command name -> stage name: the page posting that command to the worker handling it. */
	readonly commands?: Readonly<Record<string, string>>;
	/**
	 * Stream name -> [pacing, hop, frameWait] stage names: the worker holding an emitted value for
	 * the page's credit, sending it to the page handling it, and the page handling it to the next frame
	 * the app renders it in (the app's `renderFrame` callbacks).
	 */
	readonly streams?: Readonly<Record<string, readonly [string, string, string]>>;
}

export interface RoomWorkerFrameMeter extends RoomWorkerMeter {
	readonly control: RoomWorkerFrameMeterControl;
	/** Runs app rendering inside a worker message's handling (counted as the app's, not the library's). */
	render(draw: () => void): void;
	/** Wraps a frame callback whose work is app rendering. */
	renderFrame(callback: FrameRequestCallback): FrameRequestCallback;
}

/**
 * Creates the meter; it counts frames from now (requestAnimationFrame).
 * @param options - The latency stages to sample.
 * @returns The meter.
 */
export function createRoomWorkerFrameMeter(options: RoomWorkerFrameMeterOptions = {}): RoomWorkerFrameMeter {
	let library = 0;
	let render = 0;
	// App rendering run by the worker message being handled (its listeners render synchronously).
	let renderInMessage = 0;
	let dropped = 0;
	const libraryFrames: number[] = [];
	const renderFrames: number[] = [];
	type Kind = { count: number; totalMs: number; maxMs: number; heavyFrames: number; heavyMs: number };
	const kinds = new Map<string, Kind>();
	const frameKinds = new Map<string, number>();
	const latency = new Map<string, number[]>();
	for (const stage of Object.values(options.commands ?? {})) latency.set(stage, []);
	for (const stages of Object.values(options.streams ?? {})) for (const stage of stages) latency.set(stage, []);
	const sample = (stage: string, ms: number): void => {
		const values = latency.get(stage);
		if (values !== undefined && values.length < FRAME_LIMIT) values.push(Math.max(0, ms));
	};
	// Per stream: when the newest value not yet rendered was handled (timeOrigin + now).
	const receivedAt = new Map<string, number>();
	const charge = (kind: string, ms: number): void => {
		library += ms;
		let entry = kinds.get(kind);
		if (entry === undefined) {
			entry = { count: 0, totalMs: 0, maxMs: 0, heavyFrames: 0, heavyMs: 0 };
			kinds.set(kind, entry);
		}
		entry.count++;
		entry.totalMs += ms;
		entry.maxMs = Math.max(entry.maxMs, ms);
		frameKinds.set(kind, (frameKinds.get(kind) ?? 0) + ms);
	};
	const tick = (): void => {
		if (libraryFrames.length < FRAME_LIMIT) {
			libraryFrames.push(library);
			renderFrames.push(render);
		} else dropped++;
		if (library > HEAVY_FRAME_MS)
			for (const [kind, ms] of frameKinds) {
				const entry = kinds.get(kind);
				if (entry === undefined) continue;
				entry.heavyFrames++;
				entry.heavyMs += ms;
			}
		frameKinds.clear();
		library = 0;
		render = 0;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	const timed = (draw: () => void): number => {
		const started = performance.now();
		let spent = 0;
		try {
			draw();
		} finally {
			spent = performance.now() - started;
			render += spent;
		}
		return spent;
	};
	return {
		message(kind, ms): void {
			charge(kind, Math.max(0, ms - renderInMessage));
			renderInMessage = 0;
		},
		post(kind, ms): void {
			charge(`post:${kind}`, ms);
		},
		render(draw): void {
			renderInMessage += timed(draw);
		},
		renderFrame:
			(callback) =>
			(time): void => {
				const now = performance.timeOrigin + performance.now();
				for (const [stream, at] of receivedAt) {
					const stages = options.streams?.[stream];
					if (stages !== undefined) sample(stages[2], now - at);
				}
				receivedAt.clear();
				timed(() => callback(time));
			},
		stream(name, emittedAt, sentAt, handledAt): void {
			const stages = options.streams?.[name];
			if (stages === undefined) return;
			sample(stages[0], sentAt - emittedAt);
			sample(stages[1], handledAt - sentAt);
			receivedAt.set(name, handledAt);
		},
		command(name, postedAt, handledAt): void {
			const stage = options.commands?.[name];
			if (stage !== undefined) sample(stage, handledAt - postedAt);
		},
		control: {
			read: (): RoomWorkerFrameMeterReading => ({
				library: [...libraryFrames],
				render: [...renderFrames],
				dropped,
				kinds: Object.fromEntries([...kinds].map(([kind, entry]) => [kind, { ...entry }])),
				latency: Object.fromEntries([...latency].map(([stage, values]) => [stage, [...values]])),
			}),
			reset: (): void => {
				libraryFrames.length = 0;
				renderFrames.length = 0;
				kinds.clear();
				frameKinds.clear();
				for (const values of latency.values()) values.length = 0;
				receivedAt.clear();
				dropped = 0;
			},
		},
	};
}
