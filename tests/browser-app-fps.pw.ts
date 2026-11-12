import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";

import { APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS } from "./fixtures/active-endurance/driver.js";
import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority.js";
import { FixedHistogram, installRealtimeProbe } from "./fixtures/realtime-probe/page-probe.js";
import {
	MovementDirection,
	type PageReport,
	parseGridPosition,
	type Role,
	RolloverMeter,
} from "./fixtures/realtime-probe/rollover-meter.js";
import {
	installHarnessBridgeGuard,
	installServedRolloverObservation,
} from "./fixtures/realtime-probe/served-rollover-observation.js";
import { FPS_THRESHOLDS_STATUS, type FpsThresholds, fpsThresholds } from "./fixtures/realtime-probe/thresholds.js";

// Browser app FPS gate. In real browsers (Chromium, Firefox, WebKit; playwright.browser-app-fps.config.ts),
// the SHIPPED Grid, Canvas and Chat pages, served by their own dev servers with real browser networking,
// play while each page's own rollover policy (examples/v3-room/src/rollover.ts with the app's budget)
// rolls the room over and the page's own successor delivery carries each offer to the other page,
// for BROWSER_FPS_EPOCHS adopted epochs (default 30, read from the room's authenticated epoch). Storage
// is the engine's own IndexedDB; the room-head floor is the test-owned external account every shipped
// page test uses (tests/fixtures/phase-3a1b/grid-room-head-authority.ts).
//
// Input is the pages' own input path: Grid movement is real key presses (w/a/s/d) on both pages, sent
// over the browser's own WebRTC ephemeral channel; Grid has no block-placement control, so blocks are
// placed through the page's zone API (`__TS_DRP_V3_ZONE__.placeBlock`, the page's own issue path through
// its rollover policy); Canvas paints are real clicks on pixels; Chat messages are typed into each page's
// input and sent with a real Enter. Canvas joins its second page as the shipped receive-only observer;
// Chat's creator makes its joiner a Writer through the page's membership control.
//
// Harness offer passing is refused (served-rollover-observation.ts): the successor-publisher test hooks
// throw on assignment and the Grid window API's seal/export/adopt/install throw when called; any attempt
// fails the run.
//
// Measured per page with tests/fixtures/realtime-probe (bounded rings drained every DRAIN_MS, folded
// into fixed-size histograms): rAF intervals, long tasks (Chromium), heartbeat stalls (every engine), all
// split by rollover window (any seal/adopt/export/publish/install bracket of either page); ephemeral
// WebRTC send/message entries; Grid input-to-remote-render latency and age of information (the page's
// own computation, examples/grid/src/age-of-information.ts); the worst member (Grid Writer) issue
// overlapping each rollover window against APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS; conservation at the end.
//
// Control: BROWSER_FPS_INJECT_BLOCK="<ms>@<n>" busy-loops <ms> on every <n>-th frame in both pages.
// With BROWSER_FPS_CONTROL=1 the test passes only if the gate FAILS on frame and stall rules.

const EPOCHS = Number(process.env.BROWSER_FPS_EPOCHS ?? 30);
const APPS = (process.env.BROWSER_FPS_APPS ?? "grid,canvas,chat").split(",").filter((value) => value !== "");
const OUT = process.env.BROWSER_FPS_OUT ?? join(tmpdir(), `browser-fps-${Date.now()}`);
const CONTROL = process.env.BROWSER_FPS_CONTROL === "1";
const INJECT = process.env.BROWSER_FPS_INJECT_BLOCK ?? (CONTROL ? "300@20" : "");
const GATE = process.env.BROWSER_FPS_GATE !== "0";
const [INJECT_MS, INJECT_EVERY] = INJECT === "" ? [0, 0] : INJECT.split("@").map(Number);
const DRAIN_MS = 500;
const STALL_MS = Number(process.env.BROWSER_FPS_STALL_MS ?? 180_000);
const MOVE_MS = 100;
const PLACE_MS = 400;
const PAINT_MS = 350;
const CHAT_MS = 300;
const ROLLOVER_TAIL_MS = 1_000;
// Measurement only. BROWSER_FPS_CPU_THROTTLE=<rate>: Chromium DevTools CPU throttling (Emulation.setCPUThrottlingRate)
// on both pages; other engines have no equivalent and record "unsupported". BROWSER_FPS_TRACE_EPOCHS="<a>-<b>":
// a Chromium performance trace (both renderers, JS sampling) from creator epoch a to b, written to OUT.
const CPU_THROTTLE = Number(process.env.BROWSER_FPS_CPU_THROTTLE ?? 1);
// BROWSER_FPS_ROOM_WORKER=1: Grid opens with its zone in the opt-in room worker (`?roomWorker`) and the
// page's bridge meter (`roomWorkerMeter`): each frame's bridge cost (library) and Grid rendering (app),
// and the worker's data-channel counts and attach latency, are reported under summary.roomWorker.
const ROOM_WORKER = process.env.BROWSER_FPS_ROOM_WORKER === "1";
const TRACE_EPOCHS = (process.env.BROWSER_FPS_TRACE_EPOCHS ?? "").split("-").filter((value) => value !== "").map(Number);
const TRACE_CATEGORIES = [
	"devtools.timeline",
	"disabled-by-default-devtools.timeline",
	"disabled-by-default-devtools.timeline.frame",
	"v8.execute",
	"disabled-by-default-v8.cpu_profiler",
	"blink.user_timing",
	"toplevel",
];
if (!(Number.isFinite(CPU_THROTTLE) && CPU_THROTTLE >= 1)) throw new Error("BROWSER_FPS_CPU_THROTTLE");
for (const app of APPS) if (!["grid", "canvas", "chat"].includes(app)) throw new Error(`BROWSER_FPS_APP ${app}`);
if (!Number.isSafeInteger(EPOCHS) || EPOCHS < 1) throw new Error("BROWSER_FPS_EPOCHS");
if (INJECT !== "" && !(Number.isFinite(INJECT_MS) && (INJECT_MS as number) > 0 && Number.isSafeInteger(INJECT_EVERY)))
	throw new Error("BROWSER_FPS_INJECT_BLOCK must be <ms>@<frames>");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Play {
	stop(): Promise<void>;
	failure(): string | undefined;
}

interface AppDriver {
	readonly origin: string;
	installAuthority(contexts: readonly BrowserContext[]): Promise<void>;
	open(creator: Page, member: Page): Promise<void>;
	play(creator: Page, member: Page, meter: RolloverMeter): Play;
	/** Consumes the meter's new input and render rows. */
	consume(meter: RolloverMeter): void;
	conserve(creator: Page, member: Page, meter: RolloverMeter): Promise<Readonly<Record<string, unknown>>>;
	/** Issue latencies by role, absolute [start, end] (for the per-rollover member bound). */
	issues(): readonly Readonly<{ role: Role; start: number; end: number; ok: boolean }>[];
	report(meter: RolloverMeter): Readonly<Record<string, unknown>>;
}

function loop(period: number, step: (index: number) => Promise<void>): Play {
	let stopped = false;
	let failure: string | undefined;
	const task = (async (): Promise<void> => {
		for (let index = 0; !stopped; index++) {
			const started = Date.now();
			try {
				await step(index);
			} catch (error) {
				if (stopped) return;
				failure = String(error).slice(0, 2_000);
				return;
			}
			const remaining = period - (Date.now() - started);
			if (remaining > 0) await sleep(remaining);
		}
	})();
	return {
		stop: async () => {
			stopped = true;
			await task;
		},
		failure: () => failure,
	};
}

function together(plays: readonly Play[]): Play {
	return {
		stop: async () => {
			await Promise.all(plays.map((play) => play.stop()));
		},
		failure: () => plays.map((play) => play.failure()).find((value) => value !== undefined),
	};
}

// ---------------------------------------------------------------------------------------------
// Grid

interface ZoneView {
	readonly blocks: readonly Readonly<{ id: string; kind: string; x: number; y: number }>[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localPeerId: string;
	readonly ready: boolean;
	readonly rawTransport: Readonly<{ received: number; sent: number; links: readonly unknown[]; linkDrops: number }>;
	readonly transientPositions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>;
}

const zone = (page: Page): Promise<ZoneView> =>
	page.evaluate(async () => {
		const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as
			| { snapshot(): ZoneView; refresh?(): Promise<ZoneView> }
			| undefined;
		if (api === undefined) throw new Error("BROWSER_FPS_ZONE_API_ABSENT");
		// A room-worker zone's snapshot() is the zone it last published; refresh() reads the current one.
		const value = api.refresh === undefined ? api.snapshot() : await api.refresh();
		return {
			blocks: value.blocks.map(({ id, kind, x, y }) => ({ id, kind, x, y })),
			durableVertexCount: value.durableVertexCount,
			enrollment: value.enrollment,
			invite: value.invite,
			localPeerId: value.localPeerId,
			ready: value.ready,
			rawTransport: {
				received: value.rawTransport.received,
				sent: value.rawTransport.sent,
				links: [...value.rawTransport.links],
				linkDrops: value.rawTransport.linkDrops,
			},
			transientPositions: { ...value.transientPositions },
		};
	});

const SQUARE = 20;
/** A square loop: 80 distinct positions before one repeats. */
const MOVE_KEYS = [
	...Array<string>(SQUARE).fill("d"),
	...Array<string>(SQUARE).fill("w"),
	...Array<string>(SQUARE).fill("a"),
	...Array<string>(SQUARE).fill("s"),
];
const STEP: Readonly<Record<string, readonly [number, number]>> = { w: [0, 1], a: [-1, 0], s: [0, -1], d: [1, 0] };
const BLOCK_IDS = 32;
const KINDS = ["stone", "wood", "sand"] as const;

function gridDriver(): AppDriver {
	const origin = "http://127.0.0.1:4174";
	const peer = new Map<Role, string>();
	const position = new Map<Role, { x: number; y: number }>();
	const expectedKeys = new Map<Role, { key: string; x: number; y: number }[]>([
		["creator", []],
		["member", []],
	]);
	const directions = new Map<Role, MovementDirection>([
		["creator", new MovementDirection("creator to member")],
		["member", new MovementDirection("member to creator")],
	]);
	const placements: {
		role: Role;
		id: string;
		text: string;
		start: number;
		end: number;
		ok: boolean;
		error?: string;
		block: { id: string; kind: string; x: number; y: number };
	}[] = [];
	const pendingBlocks = new Map<string, { text: string; start: number; role: Role }>();
	const blockDelivery = new Map<Role, FixedHistogram>([
		["creator", new FixedHistogram()],
		["member", new FixedHistogram()],
	]);
	const finalRaw = new Map<Role, ZoneView["rawTransport"]>();
	const startRaw = new Map<Role, ZoneView["rawTransport"]>();
	let keyMismatch = 0;

	const open = async (page: Page): Promise<void> => {
		await page.goto(ROOM_WORKER ? `${origin}/?roomWorker&roomWorkerMeter` : `${origin}/`);
		await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_GRID_SESSION__") !== undefined, undefined, {
			timeout: 60_000,
		});
		await expect(page.locator("#loadingMessage")).toBeHidden({ timeout: 60_000 });
		await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_V3_ZONE__") !== undefined, undefined, {
			timeout: 20_000,
		});
	};
	const blur = (page: Page): Promise<void> =>
		page.evaluate(() => {
			const selected = document.activeElement;
			if (selected instanceof HTMLElement) selected.blur();
		});
	return {
		origin,
		installAuthority: async (contexts) => {
			await installGridRoomHeadAuthority([contexts[0] as BrowserContext]);
			await installGridRoomHeadAuthority(
				[contexts[1] as BrowserContext],
				"__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__",
				"create"
			);
		},
		open: async (creator, member) => {
			await Promise.all([open(creator), open(member)]);
			const [creatorView, memberView] = await Promise.all([zone(creator), zone(member)]);
			peer.set("creator", creatorView.localPeerId);
			peer.set("member", memberView.localPeerId);
			await creator.fill("#zoneMemberEnrollment", memberView.enrollment);
			await creator.click("#createGrid");
			await expect.poll(async () => (await zone(creator)).ready, { timeout: 60_000 }).toBe(true);
			const created = await zone(creator);
			await member.fill("#gridInput", created.invite);
			await member.click("#joinGrid");
			await expect.poll(async () => (await zone(member)).durableVertexCount, { timeout: 60_000 }).toBe(2);
			await expect.poll(async () => (await zone(creator)).durableVertexCount, { timeout: 60_000 }).toBe(2);
			// The ephemeral channel is the browser's own WebRTC data channel, both ways.
			await expect
				.poll(async () => (await zone(creator)).rawTransport.links.length, { timeout: 90_000 })
				.toBeGreaterThan(0);
			await expect
				.poll(async () => (await zone(member)).rawTransport.links.length, { timeout: 90_000 })
				.toBeGreaterThan(0);
			await Promise.all([blur(creator), blur(member)]);
			for (const [role, page] of [
				["creator", creator],
				["member", member],
			] as const) {
				const view = await zone(page);
				position.set(role, { ...(view.transientPositions[view.localPeerId] ?? { x: 0, y: 0 }) });
				startRaw.set(role, view.rawTransport);
			}
		},
		play: (creator, member, meter) => {
			const pages = new Map<Role, Page>([
				["creator", creator],
				["member", member],
			]);
			const plays: Play[] = [];
			for (const role of ["creator", "member"] as const) {
				const page = pages.get(role) as Page;
				plays.push(
					loop(MOVE_MS, async (index) => {
						const key = MOVE_KEYS[index % MOVE_KEYS.length] as string;
						const at = position.get(role) as { x: number; y: number };
						const [dx, dy] = STEP[key] as readonly [number, number];
						at.x += dx;
						at.y += dy;
						(expectedKeys.get(role) as { key: string; x: number; y: number }[]).push({ key, x: at.x, y: at.y });
						await page.keyboard.press(key);
					})
				);
				plays.push(
					loop(PLACE_MS, async (index) => {
						const prefix = role === "creator" ? "c" : "m";
						const block = {
							id: `${prefix}-${index % BLOCK_IDS}`,
							kind: KINDS[index % KINDS.length] as string,
							x: (index % 13) - 6 + (role === "creator" ? 0 : 20),
							y: (Math.floor(index / 13) % 9) - 4,
						};
						const text = `${block.kind} (${block.x}, ${block.y})`;
						const result = await page.evaluate(async (input) => {
							const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(value: unknown): Promise<void> };
							const start = performance.timeOrigin + performance.now();
							try {
								await api.placeBlock(input);
								return { ok: true, start, end: performance.timeOrigin + performance.now() };
							} catch (error) {
								return {
									ok: false,
									start,
									end: performance.timeOrigin + performance.now(),
									error: String(error).slice(0, 600),
								};
							}
						}, block);
						const start = meter.toHarness(role, result.start);
						const end = meter.toHarness(role, result.end);
						placements.push({ role, id: block.id, text, block, ...result, start, end });
						if (result.ok) pendingBlocks.set(`${role}:${block.id}`, { text, start, role });
						if (!result.ok) throw new Error(`BROWSER_FPS_GRID_PLACEMENT_REFUSED ${role} ${block.id} ${result.error}`);
					})
				);
			}
			return together(plays);
		},
		consume: (meter) => {
			for (const role of ["creator", "member"] as const) {
				const keys = (meter.keydowns.get(role) as [number, string][]).splice(0);
				const expected = expectedKeys.get(role) as { key: string; x: number; y: number }[];
				for (const [at, key] of keys) {
					if (key.startsWith("click:")) continue;
					const next = expected.shift();
					if (next === undefined || next.key !== key) {
						keyMismatch++;
						continue;
					}
					(directions.get(role) as MovementDirection).send(at, next.x, next.y);
				}
			}
			// Every press of both pages is known before any render is matched.
			for (const role of ["creator", "member"] as const) {
				const other: Role = role === "creator" ? "member" : "creator";
				// Renders on THIS page of the OTHER page's dot and blocks.
				const rows = (meter.observations.get(role) as [number, string, string][]).splice(0);
				for (const [at, key, value] of rows) {
					if (key === `p:${peer.get(other)}`) {
						const parsed = parseGridPosition(value);
						if (parsed !== undefined)
							(directions.get(other) as MovementDirection).render(at, parsed.x, parsed.y, (from, to) =>
								meter.overlapsWindow(from, to)
							);
					} else if (key.startsWith("b:")) {
						const id = key.slice(2);
						const owner: Role = id.startsWith("c-") ? "creator" : "member";
						if (owner === role) continue;
						const pending = pendingBlocks.get(`${owner}:${id}`);
						if (pending !== undefined && pending.text === value && at >= pending.start) {
							(blockDelivery.get(owner) as FixedHistogram).add(at - pending.start);
							pendingBlocks.delete(`${owner}:${id}`);
						}
					}
				}
			}
		},
		conserve: async (creator, member) => {
			const expected = new Map<string, { id: string; kind: string; x: number; y: number }>();
			for (const placement of placements) if (placement.ok) expected.set(placement.id, placement.block);
			const sorted = (blocks: ZoneView["blocks"]) => [...blocks].sort((a, b) => a.id.localeCompare(b.id));
			const want = sorted([...expected.values()]);
			let views: [ZoneView, ZoneView] | undefined;
			const deadline = Date.now() + 180_000;
			for (;;) {
				views = [await zone(creator), await zone(member)];
				const [c, m] = views;
				if (
					JSON.stringify(sorted(c.blocks)) === JSON.stringify(want) &&
					JSON.stringify(sorted(m.blocks)) === JSON.stringify(want)
				)
					break;
				if (Date.now() > deadline) break;
				await sleep(500);
			}
			const [c, m] = views;
			for (const [role, view] of [
				["creator", c],
				["member", m],
			] as const)
				finalRaw.set(role, view.rawTransport);
			const missing = (view: ZoneView) =>
				want
					.filter((block) => !view.blocks.some((value) => JSON.stringify(value) === JSON.stringify(block)))
					.map((block) => block.id);
			return {
				rule: "every block id's latest accepted placement (ids cycle through 32 per author) is present, identically, in both replicas; every placement call was accepted",
				placements: placements.length,
				placementsRefused: placements.filter((value) => !value.ok).length,
				expectedBlocks: want.length,
				creatorBlocks: c.blocks.length,
				memberBlocks: m.blocks.length,
				missingInCreator: missing(c),
				missingInMember: missing(m),
				identical: JSON.stringify(sorted(c.blocks)) === JSON.stringify(sorted(m.blocks)),
				passed:
					placements.every((value) => value.ok) &&
					missing(c).length === 0 &&
					missing(m).length === 0 &&
					c.blocks.length === want.length &&
					m.blocks.length === want.length,
			};
		},
		issues: () => placements.map(({ role, start, end, ok }) => ({ role, start, end, ok })),
		report: (meter) => {
			const inWindow = (from: number, to: number): boolean => meter.overlapsWindow(from, to);
			const latency = (role: Role) => {
				const histogram = new FixedHistogram();
				for (const placement of placements)
					if (placement.role === role && placement.ok) histogram.add(placement.end - placement.start);
				return histogram.summary();
			};
			return {
				input:
					"movement: real key presses w/a/s/d; blocks: the page's zone API placeBlock (Grid has no placement control)",
				movement: {
					qualification:
						"each key press moves the sender's dot one cell (an 80-cell square loop); the receiver's rendered dot position is matched to the oldest pending press that produced it (both page clocks are performance.timeOrigin + now on one host); a press whose position was never rendered (coalesced by a newer one, or lost on the unreliable channel) is counted, not timed",
					keyMismatch,
					creatorToMember: (directions.get("creator") as MovementDirection).summary(),
					memberToCreator: (directions.get("member") as MovementDirection).summary(),
					ageOfInformation: {
						computation:
							"examples/grid/src/age-of-information.ts fabricAgeOfInformation (the Grid page's own), sampled every 100 ms over the sending period",
						atMember: (directions.get("creator") as MovementDirection).ageOfInformation(MOVE_MS, inWindow),
						atCreator: (directions.get("member") as MovementDirection).ageOfInformation(MOVE_MS, inWindow),
					},
					webRtc: Object.fromEntries(
						(["creator", "member"] as const).map((role) => {
							const before = startRaw.get(role);
							const after = finalRaw.get(role);
							return [
								role,
								{
									pageCounters:
										before === undefined || after === undefined
											? null
											: {
													sent: after.sent - before.sent,
													received: after.received - before.received,
													linkDrops: after.linkDrops - before.linkDrops,
												},
									dataChannelEntries: {
										send: meter.totals(role)?.rtcSendEntries ?? null,
										message: meter.totals(role)?.rtcMessageEntries ?? null,
									},
								},
							];
						})
					),
				},
				placementIssueMs: { creator: latency("creator"), member: latency("member") },
				blockPlacementToRemoteRenderMs: {
					creatorBlocksAtMember: (blockDelivery.get("creator") as FixedHistogram).summary(),
					memberBlocksAtCreator: (blockDelivery.get("member") as FixedHistogram).summary(),
				},
			};
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The opt-in room worker (BROWSER_FPS_ROOM_WORKER=1, Grid only)

interface RoomWorkerMeterReading {
	readonly library: readonly number[];
	readonly render: readonly number[];
	readonly dropped: number;
}

interface RoomWorkerRtcReading {
	readonly peerConnections: number;
	readonly channelsCreated: number;
	readonly channelsReceived: number;
	readonly channelsAttached: number;
	readonly attachMs: readonly number[];
	readonly signallingCalls: number;
	readonly syntheticOpens: number;
}

function roomWorkerReading(
	page: Page,
	action: "reset" | "read"
): Promise<Readonly<{ meter: RoomWorkerMeterReading; rtc: RoomWorkerRtcReading }> | null> {
	return page.evaluate(async (selected) => {
		const meter = Reflect.get(window, "__TS_DRP_GRID_ROOM_WORKER_METER__") as
			| { read(): RoomWorkerMeterReading; reset(): void }
			| undefined;
		const control = Reflect.get(window, "__TS_DRP_GRID_ROOM_WORKER__") as
			| { rtcStats(): Promise<RoomWorkerRtcReading> }
			| undefined;
		if (meter === undefined || control === undefined) throw new Error("BROWSER_FPS_ROOM_WORKER_ABSENT");
		if (selected === "reset") {
			meter.reset();
			return null;
		}
		return { meter: meter.read(), rtc: await control.rtcStats() };
	}, action);
}

function distribution(values: readonly number[]): Readonly<{ count: number; p50: number; p99: number; max: number; mean: number }> {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const round = (value: number): number => Math.round(value * 1_000) / 1_000;
	return {
		count: sorted.length,
		p50: round(at(0.5)),
		p99: round(at(0.99)),
		max: round(sorted[sorted.length - 1] ?? 0),
		mean: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
	};
}

/** Library share (bridge, messages, posts) and app share (Grid's DOM rendering) per page frame. */
async function roomWorkerSummary(pages: ReadonlyMap<Role, Page>, playMs: number): Promise<Record<string, unknown>> {
	const roles: Record<string, unknown> = {};
	for (const [role, page] of pages) {
		const reading = await roomWorkerReading(page, "read");
		if (reading === null) continue;
		const { meter, rtc } = reading;
		const channels = rtc.channelsCreated + rtc.channelsReceived;
		roles[role] = {
			libraryMsPerFrame: distribution(meter.library),
			renderMsPerFrame: distribution(meter.render),
			libraryPlusRenderMsPerFrame: distribution(meter.library.map((value, index) => value + (meter.render[index] ?? 0))),
			framesDropped: meter.dropped,
			libraryP99WithinHalfMs: distribution(meter.library).p99 <= 0.5,
			dataChannels: {
				...rtc,
				attachMs: distribution(rtc.attachMs),
				opensPerSecondOverPlay: Math.round((channels / Math.max(1, playMs / 1_000)) * 1_000) / 1_000,
				qualification:
					"counts since the worker opened (join included); attachMs is createDataChannel in the worker to the page's transferred channel attaching (one page round trip per worker-created channel); received channels are transferred on arrival with no round trip",
			},
		};
	}
	return {
		qualification:
			"per page frame from play start: library = the room worker bridge's main-thread work (worker message handling, less the Grid rendering it ran, plus posts); render = Grid's DOM rendering (projection, network panel, the transient frame). The page probe's RTC entry counts see no data channels in this mode (they are transferred to the worker).",
		roles,
	};
}

// ---------------------------------------------------------------------------------------------
// Canvas

function canvasDriver(): AppDriver {
	const origin = "http://127.0.0.1:4180";
	const clicks: { id: string; at: number }[] = [];
	const paints: { id: string; color: string; clickAt: number; shownAt: number }[] = [];
	const pendingObserver = new Map<string, { color: string; clickAt: number }>();
	const creatorShown = new FixedHistogram();
	const observerShown = new FixedHistogram();
	let clicksIssued = 0;
	const waitForRelay = (page: Page): Promise<unknown> =>
		page.waitForFunction(
			() =>
				((
					Reflect.get(window, "__TS_DRP_CANVAS_SESSION__") as
						| { snapshot(): { relayReservations: readonly unknown[] } }
						| undefined
				)?.snapshot().relayReservations.length ?? 0) >= 1,
			undefined,
			{ timeout: 60_000 }
		);
	const colors = (page: Page): Promise<Record<string, string>> =>
		page.evaluate(() =>
			Object.fromEntries(
				Array.from(document.querySelectorAll<HTMLElement>("#canvas > div"), (pixel) => [
					pixel.id,
					getComputedStyle(pixel).backgroundColor,
				])
			)
		);
	const canvas: AppDriver = {
		origin,
		installAuthority: async (contexts) => {
			await installGridRoomHeadAuthority(
				[contexts[0] as BrowserContext],
				"__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__"
			);
			await installGridRoomHeadAuthority(
				[contexts[1] as BrowserContext],
				"__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__",
				"create"
			);
		},
		open: async (creator, member) => {
			await Promise.all([creator.goto(`${origin}/`), member.goto(`${origin}/`)]);
			await Promise.all([waitForRelay(creator), waitForRelay(member)]);
			await expect(creator.locator("#create")).toBeEnabled({ timeout: 60_000 });
			await creator.locator("#create").click();
			await expect(creator.locator("#canvas > div")).toHaveCount(100);
			await expect(creator.locator("#canvasInvite")).not.toHaveValue("", { timeout: 60_000 });
			const invite = await creator.locator("#canvasInvite").inputValue();
			await expect(member.locator("#connect")).toBeEnabled({ timeout: 60_000 });
			await member.locator("#canvasIdInput").fill(invite);
			await member.locator("#connect").click();
			await expect(member.locator("#canvasId")).not.toBeEmpty({ timeout: 60_000 });
			await expect(creator.locator("#object_peers")).not.toHaveText("[]", { timeout: 90_000 });
		},
		play: (creator) =>
			loop(PAINT_MS, async (index) => {
				// Pixel ids are "<x>-<y>"; each pixel is repainted once per 100 clicks.
				const id = `${index % 10}-${Math.floor(index / 10) % 10}`;
				clicksIssued++;
				await creator.locator(`[id="${id}"]`).click({ timeout: 30_000 });
			}),
		consume: (meter) => {
			for (const [at, key] of (meter.keydowns.get("creator") as [number, string][]).splice(0))
				if (/^click:\d+-\d+$/u.test(key)) clicks.push({ id: key.slice(6), at });
			meter.keydowns.get("member")?.splice(0);
			for (const [at, id, color] of (meter.observations.get("creator") as [number, string, string][]).splice(0)) {
				const index = clicks.findIndex((click) => click.id === id && click.at <= at);
				if (index < 0) continue;
				const click = clicks.splice(index, 1)[0] as { id: string; at: number };
				paints.push({ id, color, clickAt: click.at, shownAt: at });
				creatorShown.add(at - click.at);
				pendingObserver.set(id, { color, clickAt: click.at });
			}
			for (const [at, id, color] of (meter.observations.get("member") as [number, string, string][]).splice(0)) {
				const pending = pendingObserver.get(id);
				if (pending !== undefined && pending.color === color && at >= pending.clickAt) {
					observerShown.add(at - pending.clickAt);
					pendingObserver.delete(id);
				}
			}
		},
		conserve: async (creator, member, meter) => {
			const deadline = Date.now() + 180_000;
			let pair: [Record<string, string>, Record<string, string>];
			for (;;) {
				// A paint still waiting in the policy (a closing epoch) lands later; keep matching.
				await meter.drain();
				canvas.consume(meter);
				pair = [await colors(creator), await colors(member)];
				if ((JSON.stringify(pair[0]) === JSON.stringify(pair[1]) && clicks.length === 0) || Date.now() > deadline)
					break;
				await sleep(500);
			}
			const [c, m] = pair;
			const differing = Object.keys(c).filter((id) => c[id] !== m[id]);
			// Each click must have produced a creator paint (a matched color change).
			const unpainted = clicks.length;
			return {
				rule: "every click produced a creator paint and the observer's 100 pixels equal the creator's",
				clicks: clicksIssued,
				paintsShownOnCreator: paints.length,
				clicksWithoutPaint: unpainted,
				unpaintedClicks: clicks
					.slice(0, 20)
					.map((click) => ({ id: click.id, agoMs: Math.round(performance.timeOrigin + performance.now() - click.at) })),
				differingPixels: differing,
				passed: differing.length === 0 && unpainted === 0 && paints.length === clicksIssued,
			};
		},
		issues: () =>
			paints.map(({ clickAt, shownAt }) => ({ role: "creator" as const, start: clickAt, end: shownAt, ok: true })),
		report: () => ({
			input: "real clicks on the creator's pixels; the observer is the shipped receive-only page",
			memberMoves: "none: the shipped Canvas joins its second page as a receive-only observer",
			clickToCreatorRenderMs: creatorShown.summary(),
			clickToObserverRenderMs: observerShown.summary(),
			webRtcEphemeral: "not used by Canvas (no live cursors); its room transport is the node's own",
		}),
	};
	return canvas;
}

// ---------------------------------------------------------------------------------------------
// Chat

function chatDriver(): AppDriver {
	const origin = "http://127.0.0.1:4181";
	const prefix: Readonly<Record<Role, string>> = { creator: "fps creator ", member: "fps member " };
	interface Sent {
		text: string;
		enterAt?: number;
		ownAt?: number;
		otherAt?: number;
	}
	const sent = new Map<Role, Sent[]>([
		["creator", []],
		["member", []],
	]);
	const cursor = new Map<Role, number>([
		["creator", 0],
		["member", 0],
	]);
	// First render of each message text on each page (forgotten once both pages showed it).
	const shown = new Map<Role, Map<string, number>>([
		["creator", new Map()],
		["member", new Map()],
	]);
	const ownLatency = new Map<Role, FixedHistogram>([
		["creator", new FixedHistogram()],
		["member", new FixedHistogram()],
	]);
	const otherLatency = new Map<Role, FixedHistogram>([
		["creator", new FixedHistogram()],
		["member", new FixedHistogram()],
	]);
	const issues: { role: Role; start: number; end: number; ok: boolean }[] = [];
	let memberWriterAt: number | undefined;
	let memberWaitedForShareMs = 0;
	const waitForRelay = (page: Page): Promise<unknown> =>
		page.waitForFunction(
			() =>
				((
					Reflect.get(window, "__TS_DRP_CHAT_SESSION__") as
						| { snapshot(): { relayReservations: readonly unknown[] } }
						| undefined
				)?.snapshot().relayReservations.length ?? 0) >= 1,
			undefined,
			{ timeout: 60_000 }
		);
	const texts = (page: Page): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll(".message-content"), (element) => element.textContent ?? "")
		);
	const send = async (page: Page, role: Role, index: number): Promise<void> => {
		const text = `${prefix[role]}${String(index).padStart(4, "0")}`;
		(sent.get(role) as Sent[]).push({ text });
		await page.locator("#messageInput").fill(text);
		await page.locator("#messageInput").press("Enter");
		await expect(page.locator("#messageInput")).toHaveValue("", { timeout: 120_000 });
	};
	return {
		origin,
		installAuthority: async (contexts) => {
			await installGridRoomHeadAuthority(
				[contexts[0] as BrowserContext],
				"__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__"
			);
			await installGridRoomHeadAuthority(
				[contexts[1] as BrowserContext],
				"__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__",
				"create"
			);
		},
		open: async (creator, member) => {
			await Promise.all([creator.goto(`${origin}/`), member.goto(`${origin}/`)]);
			await Promise.all([waitForRelay(creator), waitForRelay(member)]);
			await expect(creator.locator("#createRoom")).toBeEnabled({ timeout: 60_000 });
			await creator.locator("#createRoom").click();
			await expect(creator.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u, { timeout: 60_000 });
			await expect(creator.locator("#chatInvite")).not.toHaveValue("", { timeout: 60_000 });
			const roomId = await creator.locator("#chatId").getAttribute("data-full-id");
			const invite = await creator.locator("#chatInvite").inputValue();
			await expect(member.locator("#joinRoom")).toBeEnabled({ timeout: 60_000 });
			await member.locator("#roomInput").fill(invite);
			await member.locator("#roomInput").press("Enter");
			await expect(member.locator("#chatId")).toHaveAttribute("data-full-id", roomId ?? "", { timeout: 60_000 });
			await expect(creator.locator("#messageInput")).toBeEnabled({ timeout: 60_000 });
			// The admin's page makes the joiner a Writer through its membership control. The grant latches at
			// the next checkpoint and the joiner's share is in force a checkpoint later; the creator's own
			// rollover policy produces those checkpoints while play runs, and the joiner's first Send reopens
			// its page as a Writer (the shipped path).
			const memberAuthor = (await member.locator("#authorId").getAttribute("data-author")) ?? "";
			expect(memberAuthor).toMatch(/^[0-9a-f]{64}$/u);
			await expect(creator.locator("#membershipPanel")).toBeVisible({ timeout: 60_000 });
			await creator.locator("#memberInput").fill(memberAuthor);
			await creator.locator("#grantWriter").click();
			await expect(creator.getByRole("status", { name: "Chat connection status" })).toContainText(/Writer granted/u, {
				timeout: 60_000,
			});
		},
		play: (creator, member) => {
			const started = Date.now();
			let memberSends = 0;
			return together([
				loop(CHAT_MS, (index) => send(creator, "creator", index)),
				loop(CHAT_MS, async () => {
					if (!(await member.locator("#messageInput").isEnabled())) {
						if (memberWriterAt === undefined) memberWaitedForShareMs = Date.now() - started;
						await sleep(250);
						return;
					}
					memberWriterAt ??= Date.now() - started;
					await send(member, "member", memberSends++);
				}),
			]);
		},
		consume: (meter) => {
			for (const role of ["creator", "member"] as const) {
				const queue = sent.get(role) as Sent[];
				for (const [at, key] of (meter.keydowns.get(role) as [number, string][]).splice(0)) {
					if (key !== "Enter") continue;
					const index = cursor.get(role) as number;
					const entry = queue[index];
					if (entry !== undefined) {
						entry.enterAt = at;
						cursor.set(role, index + 1);
					}
				}
				const seen = shown.get(role) as Map<string, number>;
				for (const [at, key, text] of (meter.observations.get(role) as [number, string, string][]).splice(0))
					if (key.startsWith("m:") && !seen.has(text)) seen.set(text, at);
			}
			for (const role of ["creator", "member"] as const) {
				const other: Role = role === "creator" ? "member" : "creator";
				const queue = sent.get(role) as Sent[];
				for (const entry of queue) {
					if (entry.enterAt === undefined) continue;
					const own = shown.get(role)?.get(entry.text);
					const remote = shown.get(other)?.get(entry.text);
					if (own !== undefined && entry.ownAt === undefined) {
						entry.ownAt = own;
						(ownLatency.get(role) as FixedHistogram).add(own - entry.enterAt);
						issues.push({ role, start: entry.enterAt, end: own, ok: true });
					}
					if (remote !== undefined && entry.otherAt === undefined) {
						entry.otherAt = remote;
						(otherLatency.get(role) as FixedHistogram).add(remote - entry.enterAt);
					}
				}
				// Bounded: forget messages both pages have shown.
				while (queue.length > 0 && queue[0]?.ownAt !== undefined && queue[0]?.otherAt !== undefined) {
					const done = queue.shift() as Sent;
					shown.get("creator")?.delete(done.text);
					shown.get("member")?.delete(done.text);
					cursor.set(role, (cursor.get(role) as number) - 1);
				}
			}
		},
		conserve: async (creator, member) => {
			const deadline = Date.now() + 180_000;
			const ours = (values: string[]): string[] => values.filter((text) => text.startsWith("fps ")).sort();
			let pair: [string[], string[]];
			for (;;) {
				pair = [ours(await texts(creator)), ours(await texts(member))];
				if (JSON.stringify(pair[0]) === JSON.stringify(pair[1]) || Date.now() > deadline) break;
				await sleep(500);
			}
			const [c, m] = pair;
			const union = [...new Set([...c, ...m])];
			const missing = (values: string[]): string[] => union.filter((text) => !values.includes(text));
			const duplicated = (values: string[]): string[] =>
				[...new Set(values)].filter((text) => values.filter((value) => value === text).length !== 1);
			const counts = (values: string[]) => ({
				creatorMessages: values.filter((text) => text.startsWith(prefix.creator)).length,
				memberMessages: values.filter((text) => text.startsWith(prefix.member)).length,
			});
			return {
				rule: "every message either page sent is shown exactly once on both pages",
				onCreatorPage: counts(c),
				onMemberPage: counts(m),
				missingOnCreator: missing(c).slice(0, 50),
				missingOnMember: missing(m).slice(0, 50),
				duplicated: [...duplicated(c), ...duplicated(m)].slice(0, 50),
				passed:
					missing(c).length === 0 &&
					missing(m).length === 0 &&
					duplicated(c).length === 0 &&
					duplicated(m).length === 0 &&
					counts(c).creatorMessages > 0 &&
					counts(c).memberMessages > 0,
			};
		},
		issues: () => issues,
		report: () => ({
			input:
				"messages typed into each page's input and sent with a real Enter; the creator's page makes the joiner a Writer through its membership control",
			memberWriter: {
				becameWriterAfterPlayMs: memberWriterAt ?? null,
				waitedForShareMs: memberWaitedForShareMs,
				qualification:
					"the grant latches at the next checkpoint and the share is in force at a later one; the member's first Send reopens its page as a Writer",
			},
			enterToOwnRenderMs: {
				creator: (ownLatency.get("creator") as FixedHistogram).summary(),
				member: (ownLatency.get("member") as FixedHistogram).summary(),
			},
			enterToOtherPageRenderMs: {
				creatorMessagesOnMember: (otherLatency.get("creator") as FixedHistogram).summary(),
				memberMessagesOnCreator: (otherLatency.get("member") as FixedHistogram).summary(),
			},
			webRtcEphemeral: "not used by Chat; its room transport is the node's own",
		}),
	};
}

const DRIVERS: Readonly<Record<string, () => AppDriver>> = { grid: gridDriver, canvas: canvasDriver, chat: chatDriver };

// ---------------------------------------------------------------------------------------------
// Gate

interface Verdict {
	readonly passed: boolean;
	readonly failures: readonly string[];
	readonly checks: readonly Readonly<{ rule: string; value: number | null; limit: number; passed: boolean }>[];
}

function evaluateGate(
	pages: Readonly<Record<Role, PageReport>>,
	thresholds: FpsThresholds,
	memberOverBound: number,
	instrument: readonly string[]
): Verdict {
	const checks: { rule: string; value: number | null; limit: number; passed: boolean }[] = [];
	const check = (rule: string, value: number | null, limit: number): void => {
		checks.push({ rule, value, limit, passed: value !== null && value <= limit });
	};
	for (const role of ["creator", "member"] as const) {
		const page = pages[role];
		const inside = page.frames.inRolloverWindow;
		const outside = page.frames.outsideRolloverWindow;
		const per1000 = (count: number, total: number): number | null => (total === 0 ? null : (count * 1000) / total);
		check(`${role} frame p99 in rollover windows (ms)`, inside.p99, thresholds.frameP99InWindowMs);
		check(
			`${role} frames >100 ms per 1000 in rollover windows`,
			per1000(inside.over100, inside.count),
			thresholds.framesOver100InWindowPer1000
		);
		check(
			`${role} frames >50 ms per 1000 in rollover windows`,
			per1000(inside.over50, inside.count),
			thresholds.framesOver50InWindowPer1000
		);
		check(`${role} frame p99 outside rollover windows (ms)`, outside.p99, thresholds.frameP99OutsideMs);
		check(
			`${role} frames >100 ms per 1000 outside rollover windows`,
			per1000(outside.over100, outside.count),
			thresholds.framesOver100OutsidePer1000
		);
		if (page.longTasks.supported)
			check(
				`${role} longest long task in rollover windows (ms)`,
				page.longTasks.inRolloverWindow.longestMs,
				thresholds.longestLongTaskInWindowMs
			);
		check(
			`${role} longest heartbeat stall in rollover windows (ms)`,
			page.heartbeatStalls.inRolloverWindow.longestMs,
			thresholds.longestStallInWindowMs
		);
	}
	check(`member issues above ${APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS} ms in a rollover window`, memberOverBound, 0);
	const failures = [
		...checks.filter((value) => !value.passed).map((value) => `${value.rule}: ${value.value} > ${value.limit}`),
		...instrument,
	];
	return { passed: failures.length === 0, failures, checks };
}

const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const REFUSAL_PATTERN = /refused|failed|invariant|unavailable|not-active|not authorized/u;

/**
 * Runs in the page: an error with its cause chain and AggregateError members, or JSON for other values.
 * @param value - One console argument.
 */
function describeConsoleValue(value: unknown): string {
	const walk = (item: unknown, depth: number): string => {
		if (item instanceof Error) {
			const parts = [`${item.name}: ${item.message}`];
			const members = (item as { errors?: unknown }).errors;
			if (Array.isArray(members) && depth < 4)
				parts.push(`errors: [${members.map((member) => walk(member, depth + 1)).join(" | ")}]`);
			if (item.cause !== undefined && depth < 4) parts.push(`cause: ${walk(item.cause, depth + 1)}`);
			if (item.stack !== undefined) parts.push(`stack: ${item.stack}`);
			return parts.join("; ");
		}
		if (typeof item === "object" && item !== null) {
			try {
				return JSON.stringify(item);
			} catch {
				return String(item);
			}
		}
		return String(item);
	};
	return walk(value, 0);
}

/** Per-rollover issue latency: the worst issue of each role overlapping each window plus its tail. */
function issueLatency(meter: RolloverMeter, driver: AppDriver) {
	const windows = meter.rolloverWindows();
	const issues = driver.issues();
	const perWindow = windows.map((window) => {
		const until = window.end + ROLLOVER_TAIL_MS;
		const worst = (role: Role): number | null => {
			const values = issues
				.filter((issue) => issue.role === role && issue.start <= until && issue.end >= window.start)
				.map((issue) => issue.end - issue.start);
			return values.length === 0 ? null : Math.max(...values);
		};
		return { ...window, worstCreatorIssueMs: worst("creator"), worstMemberIssueMs: worst("member") };
	});
	const distribution = (values: readonly (number | null)[]) => {
		const histogram = new FixedHistogram();
		for (const value of values) if (value !== null) histogram.add(value);
		return histogram.summary();
	};
	const memberWorst = perWindow.map((window) => window.worstMemberIssueMs);
	const memberOverBound = memberWorst.filter(
		(value) => value !== null && value > APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS
	).length;
	const rolloverIssueLatency = {
		windowRule: `seal start to the later of the creator's last stage and the member's install of that successor, plus ${ROLLOVER_TAIL_MS} ms`,
		member: {
			boundMs: APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS,
			windowsWithMemberIssues: memberWorst.filter((value) => value !== null).length,
			overBound: memberOverBound,
			worstPerWindowMs: distribution(memberWorst),
		},
		creator: { worstPerWindowMs: distribution(perWindow.map((window) => window.worstCreatorIssueMs)) },
		perWindow: perWindow.map((window) => ({
			successorEpoch: window.successorEpoch,
			creatorMs: Math.round(window.creatorMs),
			sealMs: Math.round(window.sealMs),
			installEndAfterSealMs:
				window.memberInstallEnd === null ? null : Math.round(window.memberInstallEnd - window.start),
			worstCreatorIssueMs: window.worstCreatorIssueMs === null ? null : Math.round(window.worstCreatorIssueMs),
			worstMemberIssueMs: window.worstMemberIssueMs === null ? null : Math.round(window.worstMemberIssueMs),
		})),
	};
	return { windows, memberOverBound, rolloverIssueLatency };
}

for (const app of APPS)
	test(`${app}: the shipped page keeps rendering through its own rollovers`, async ({ browser, browserName }) => {
		mkdirSync(OUT, { recursive: true });
		const driver = (DRIVERS[app] as () => AppDriver)();
		const base = `${browserName}-${app}${ROOM_WORKER ? "-worker" : ""}${CONTROL ? "-control" : ""}`;
		const epochLog = join(OUT, `${base}-epochs.jsonl`);
		writeFileSync(epochLog, "");
		const sourceDiff = execFileSync("git", ["diff", "--no-ext-diff", "HEAD"], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		const configuration = {
			app,
			engine: browserName,
			engineVersion: browser.version(),
			epochsTarget: EPOCHS,
			epochsCount:
				"adopted epochs: the creator room's authenticated epoch (room.authority().epoch through the page's own delivery binding)",
			sourceHead,
			dirtyTracked: sourceDiff.length !== 0,
			sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
			control: CONTROL,
			roomWorker: ROOM_WORKER && app === "grid",
			injectBlock: INJECT === "" ? null : { ms: INJECT_MS, everyFrames: INJECT_EVERY },
			cadenceMs: { drain: DRAIN_MS, move: MOVE_MS, place: PLACE_MS, paint: PAINT_MS, chat: CHAT_MS },
			memberRolloverIssueBoundMs: APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS,
			rolloverWindowTailMs: ROLLOVER_TAIL_MS,
			thresholdsStatus: FPS_THRESHOLDS_STATUS,
			cpuThrottle: CPU_THROTTLE === 1 ? null : { rate: CPU_THROTTLE, applied: browserName === "chromium" ? "chromium Emulation.setCPUThrottlingRate" : "unsupported on this engine" },
			traceEpochs: TRACE_EPOCHS.length === 2 ? TRACE_EPOCHS : null,
			hostLoadAverageAtStart: loadavg(),
			startedAt: new Date().toISOString(),
		};
		const contexts = [await browser.newContext(), await browser.newContext()] as const;
		await driver.installAuthority(contexts);
		const routeFailures: string[] = [];
		for (const context of contexts) {
			await installRealtimeProbe(context, {
				app: app as "grid" | "canvas" | "chat",
				injectBlockMs: INJECT_MS as number,
				injectEveryFrames: INJECT_EVERY as number,
				autoStart: false,
			});
			await installHarnessBridgeGuard(context);
			await installServedRolloverObservation(context, driver.origin, routeFailures);
		}
		const creator = await contexts[0].newPage();
		const member = await contexts[1].newPage();
		if (CPU_THROTTLE > 1 && browserName === "chromium")
			for (const [page, context] of [
				[creator, contexts[0]],
				[member, contexts[1]],
			] as const)
				await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
		let tracing: "idle" | "on" | "done" = "idle";
		const pageErrors: string[] = [];
		const consoleTail: string[] = [];
		const refusals: string[] = [];
		for (const [name, page] of [
			["creator", creator],
			["member", member],
		] as const) {
			page.on("pageerror", (error) => pageErrors.push(`${name}: ${String(error).slice(0, 600)}`));
			page.on("response", (response) => {
				if (response.status() >= 400)
					consoleTail.push(`${new Date().toISOString()} ${name} http ${response.status()} ${response.url().slice(0, 300)}`);
			});
			page.on("console", (message) => {
				if (message.type() !== "warning" && message.type() !== "error") return;
				const at = new Date().toISOString();
				const text = message.text();
				const record = (body: string): void => {
					consoleTail.push(`${at} ${name} ${message.type()} ${body.slice(0, 2_000)}`);
					if (consoleTail.length > 400) consoleTail.shift();
					if (REFUSAL_PATTERN.test(body) && refusals.length < 60)
						refusals.push(`${at} ${name} ${message.type()} ${body.slice(0, 20_000)}`);
				};
				// Firefox renders object arguments as "JSHandle@object", and no engine's text carries an
				// error's cause or AggregateError members: resolve the arguments in the page instead.
				if (!text.includes("JSHandle@") && !REFUSAL_PATTERN.test(text)) return record(text);
				void Promise.all(
					message.args().map((argument) => argument.evaluate(describeConsoleValue).catch(() => "<unreadable>"))
				).then(
					(parts) => record(parts.join(" ")),
					() => record(text)
				);
			});
		}
		const meter = new RolloverMeter(
			new Map<Role, Page>([
				["creator", creator],
				["member", member],
			])
		);
		let summary: Record<string, unknown> = { ...configuration };
		let play: Play | undefined;
		let failure: unknown;
		try {
			const openStarted = Date.now();
			await driver.open(creator, member);
			const openMs = Date.now() - openStarted;
			const roomWorker = ROOM_WORKER && app === "grid";
			if (roomWorker) await Promise.all([creator, member].map((page) => roomWorkerReading(page, "reset")));
			await Promise.all(
				[creator, member].map((page) =>
					page.evaluate(() => (Reflect.get(globalThis, "__TS_DRP_REALTIME_PROBE__") as { start(): void }).start())
				)
			);
			const playStarted = Date.now();
			await meter.calibrate();
			play = driver.play(creator, member, meter);
			let lastEpoch = -1;
			let lastProgressAt = Date.now();
			for (;;) {
				await sleep(DRAIN_MS);
				await meter.drain();
				driver.consume(meter);
				const creatorEpoch = Math.max(0, meter.epoch("creator") ?? 0);
				const memberEpoch = Math.max(0, meter.epoch("member") ?? 0);
				if (creatorEpoch > lastEpoch) {
					lastEpoch = creatorEpoch;
					lastProgressAt = Date.now();
					appendFileSync(
						epochLog,
						JSON.stringify({
							at: new Date().toISOString(),
							elapsedMs: Date.now() - playStarted,
							creatorEpoch,
							memberEpoch,
							creatorTotals: meter.totals("creator"),
							memberTotals: meter.totals("member"),
							loadAverage: loadavg(),
						}) + "\n"
					);
					if (creatorEpoch <= 3 || creatorEpoch % 10 === 0)
						console.log(
							`BROWSER_FPS ${browserName} ${app} creator epoch ${creatorEpoch}/${EPOCHS} member ${memberEpoch}`
						);
				}
				if (browserName === "chromium" && TRACE_EPOCHS.length === 2) {
					if (tracing === "idle" && creatorEpoch >= (TRACE_EPOCHS[0] as number)) {
						await browser.startTracing(undefined, {
							path: join(OUT, `${base}-trace-e${TRACE_EPOCHS[0]}-e${TRACE_EPOCHS[1]}.json`),
							categories: TRACE_CATEGORIES,
						});
						appendFileSync(epochLog, JSON.stringify({ traceStart: Date.now(), performanceOrigin: "wall" }) + "\n");
						tracing = "on";
					} else if (tracing === "on" && creatorEpoch >= (TRACE_EPOCHS[1] as number)) {
						await browser.stopTracing();
						appendFileSync(epochLog, JSON.stringify({ traceStop: Date.now() }) + "\n");
						tracing = "done";
					}
				}
				if (creatorEpoch >= EPOCHS && memberEpoch >= EPOCHS) break;
				const playFailure = play.failure();
				if (playFailure !== undefined) throw new Error(`BROWSER_FPS_PLAY_FAILED ${playFailure}`);
				if (routeFailures.length > 0) throw new Error(`BROWSER_FPS_OBSERVATION ${routeFailures.join("; ")}`);
				if (Date.now() - lastProgressAt > STALL_MS)
					throw new Error(`BROWSER_FPS_EPOCH_STALL creator ${creatorEpoch} member ${memberEpoch} for ${STALL_MS} ms`);
			}
			const playMs = Date.now() - playStarted;
			await play.stop();
			play = undefined;
			// Read before conservation, whose zone reads would count as bridge work.
			const roomWorkerReport = roomWorker
				? await roomWorkerSummary(
						new Map<Role, Page>([
							["creator", creator],
							["member", member],
						]),
						playMs
					)
				: null;
			await meter.drain();
			driver.consume(meter);
			const conservation = await driver.conserve(creator, member, meter);
			await meter.drain();
			driver.consume(meter);
			await Promise.all(
				[creator, member].map((page) =>
					page.evaluate(() => (Reflect.get(globalThis, "__TS_DRP_REALTIME_PROBE__") as { stop(): void }).stop())
				)
			);
			await meter.drain();
			driver.consume(meter);
			meter.finish();
			const violations = (
				await Promise.all(
					[creator, member].map((page) =>
						page.evaluate(() => [
							...((Reflect.get(globalThis, "__TS_DRP_HARNESS_BRIDGE_VIOLATIONS__") as string[] | undefined) ?? [
								"guard absent",
							]),
						])
					)
				)
			).flat();
			const pages = { creator: meter.report("creator"), member: meter.report("member") };
			const { windows, memberOverBound, rolloverIssueLatency } = issueLatency(meter, driver);
			const stageCounts = {
				creator: meter.totals("creator")?.stageCounts ?? {},
				member: meter.totals("member")?.stageCounts ?? {},
			};
			const instrument: string[] = [];
			if (violations.length > 0) instrument.push(`harness offer bridge attempted: ${violations.join(", ")}`);
			if (routeFailures.length > 0) instrument.push(`served observation failed: ${routeFailures.join(", ")}`);
			if ((stageCounts.creator["creator-seal"] ?? 0) < EPOCHS)
				instrument.push(`creator seals observed ${stageCounts.creator["creator-seal"] ?? 0} < ${EPOCHS}`);
			if ((stageCounts.member["member-install"] ?? 0) < 1) instrument.push("no member install observed");
			if (pages.creator.frames.inRolloverWindow.count === 0 || pages.member.frames.inRolloverWindow.count === 0)
				instrument.push("no frames classified inside a rollover window");
			for (const role of ["creator", "member"] as const)
				for (const [ring, dropped] of Object.entries(pages[role].droppedRingEntries))
					if (dropped > 0) instrument.push(`${role} probe ring ${ring} dropped ${dropped}`);
			if (pages.creator.hiddenObserved || pages.member.hiddenObserved)
				instrument.push("a page was hidden during play (rAF throttled)");
			if (!(conservation as { passed?: boolean }).passed) instrument.push("conservation failed");
			if (pageErrors.length > 0) instrument.push(`page errors: ${pageErrors.slice(0, 5).join(" | ")}`);
			const delivery = { creator: pages.creator.delivery, member: pages.member.delivery };
			if (Number((delivery.member as { installed?: number } | null)?.installed ?? 0) < 1)
				instrument.push("the member's own delivery installed no offer");
			const thresholds = fpsThresholds(browserName, app);
			const verdict = evaluateGate(pages, thresholds, memberOverBound, instrument);
			summary = {
				...configuration,
				playMs,
				openMs,
				roomWorker: roomWorkerReport,
				adoptedEpochs: { creator: meter.epoch("creator"), member: meter.epoch("member") },
				rolloversObserved: windows.length,
				stageCounts,
				stageDurationsMs: meter.stageDurations(),
				stageBrackets: meter.stages,
				pages,
				rolloverIssueLatency,
				app: { ...driver.report(meter), name: app },
				successorDelivery: delivery,
				harnessBridgeViolations: violations,
				conservation,
				clock: meter.clockCalibration(),
				pageErrors,
				thresholds,
				verdict,
				hostLoadAverageAtEnd: loadavg(),
			};
			if (CONTROL) {
				// The control passes only when the gate catches the injected block in its frame and stall rules.
				const caught = verdict.failures.filter((value) => /frame p99|frames >|long task|heartbeat stall/u.test(value));
				Object.assign(summary, { controlCaughtBy: caught });
				expect(caught.length, "the injected main-thread block must fail the gate's frame rules").toBeGreaterThan(0);
				expect(verdict.passed).toBe(false);
			} else if (GATE) {
				expect(verdict.failures, "browser FPS gate").toEqual([]);
			}
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			await play?.stop().catch(() => undefined);
			if (tracing === "on") await browser.stopTracing().catch(() => undefined);
			if (failure !== undefined)
				summary = {
					...summary,
					failure: String(failure).slice(0, 4_000),
					stageCounts: { creator: meter.totals("creator")?.stageCounts, member: meter.totals("member")?.stageCounts },
					adoptedEpochs: { creator: meter.epoch("creator"), member: meter.epoch("member") },
					hostLoadAverageAtEnd: loadavg(),
				};
			if (failure !== undefined && !("pages" in summary)) {
				// What the instrument saw up to the failure: the same report, marked partial.
				try {
					await meter.drain();
					driver.consume(meter);
					meter.finish();
					summary.partialAtFailure = {
						qualification: "measured from play start up to the failure; no conservation or gate verdict",
						rolloversObserved: meter.rolloverWindows().length,
						stageDurationsMs: meter.stageDurations(),
						pages: { creator: meter.report("creator"), member: meter.report("member") },
						rolloverIssueLatency: issueLatency(meter, driver).rolloverIssueLatency,
						app: { ...driver.report(meter), name: app },
						clock: meter.clockCalibration(),
						pageErrors,
					};
				} catch (error) {
					summary.partialAtFailureError = String(error).slice(0, 1_000);
				}
			}
			writeFileSync(join(OUT, `${base}-summary.json`), JSON.stringify(summary, null, 2));
			writeFileSync(join(OUT, `${base}-console.txt`), consoleTail.join("\n") + "\n");
			writeFileSync(join(OUT, `${base}-refusals.txt`), refusals.join("\n\n") + "\n");
			await Promise.allSettled(contexts.map((context) => context.close()));
		}
	});
