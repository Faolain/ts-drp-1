import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";
import {
	hangTail,
	installPhaseProbe,
	pageNow,
	type PhaseWindow,
	summarizePhases,
	takePhases,
} from "./fixtures/track-z/phase-probe";

// Track X: the shipped Canvas page (examples/canvas) and the shipped Chat page
// (examples/chat) as long rooms in Chromium, with the pages' own dev servers and real
// browser networking (two relays, real libp2p gossip and direct streams), on the pattern of
// tests/track-v-grid-long-room.pw.ts. The creator creates the room through the page's UI,
// and a second, independent peer joins it with the invite through the UI. Both shipped
// pages open every joiner receive-only (an observer): they have no way to enroll a Writer,
// so the joiner here is the shipped recipient, an observer. Each epoch the creator makes
// MOVES moves through the page's UI (a pixel click, or a message sent with Enter), and the
// harness waits until the recipient's page shows each one. The creator then seals, exports
// and adopts the successor, and the recipient installs it from the creator's peer.
//
// The shipped pages expose no rollover control and no room handle, so the harness appends
// one read-only accessor, `globalThis.__TRACK_X_ROOM__ = () => room`, to the page's own
// /src/index.ts as the dev server serves it. The page's code is otherwise unchanged, and
// the accessor returns the exact room session the page opened. Measurement only: it asserts
// convergence and successful transitions, and bounds nothing. On non-convergence it prints
// TRACK_X_STUCK with the recent console lines (and, with TRACK_X_PROBE=1, whether a later
// creator move converges).
//
// Hang diagnostics (measurement only, all opt-in): TRACK_X_ROLLOVER_TIMEOUT_MS bounds the
// creator's seal/export/adopt evaluate and the recipient's install evaluate; when one does
// not return in time the harness prints TRACK_X_ROLLOVER_HUNG with the step the creator's
// rollover reached, both pages' recent console lines and, with TRACK_X_NET_PROBE=1, every
// network call of each page still in flight. TRACK_X_NET_PROBE=1 also appends
// `globalThis.__TRACK_X_NODE__ = () => node;` to the page's entry module and wraps the page's
// own network node's send and publish methods to time them (observation only: each wrapper
// calls the original with the same arguments and returns its result). TRACK_X_CONSOLE_ALL=1
// keeps every console line of both pages (not only warnings and errors) for those prints.
// TRACK_X_IDB_PROBE=1 adds an init script to both pages that records every IndexedDB
// transaction (database, stores, mode and the stack that created it) until it completes or
// aborts, and every Web Locks request until its callback settles (observation only: the
// wrappers return the original transaction and call the original request); the hang print then
// lists the ones still open. With TRACK_X_ROLLOVER_TIMEOUT_MS the final room closes are
// abandoned after the same bound, so a hung run ends instead of waiting for the test timeout.
//
// Stress, not measurement (opt-in): TRACK_X_HISTORY_STORM_MS (with TRACK_X_NET_PROBE=1) makes
// the recipient page send the creator a direct retained-history request on the room's history
// control topic every TRACK_X_HISTORY_STORM_MS ms, so the creator answers with targeted
// retained republications all the time. It reproduces the creator seal hang far more often.
//
// Track Z (measurement only, opt-in): TRACK_Z_PHASES=1 installs tests/fixtures/track-z/phase-probe.ts
// in both pages and prints, per epoch, a TRACK_Z_PHASES line that attributes each window (play,
// seal, export, adoption, install, convergence, lulls) to the proof events, spans, IndexedDB
// transactions and long tasks it held. TRACK_Z_LULL=explicit calls the room's
// maintainRecoveryPool() on the creator and then on the recipient after each install, as the
// latency bench's lull mode does, and records each result and its in-page duration.
// TRACK_Z_PAGE_GLOBALS (JSON) sets page globals for a scratch measurement build (see the probe).
const EPOCHS = Number(process.env.TRACK_X_EPOCHS ?? 16);
const MOVES = Number(process.env.TRACK_X_MOVES ?? 2);
const SETTLE_MS = 300;
const CONVERGE_MS = Number(process.env.TRACK_X_CONVERGE_MS ?? 60_000);
const POST_INSTALL_PAUSE_MS = Number(process.env.TRACK_X_POST_INSTALL_PAUSE_MS ?? 0);
const PROBE = process.env.TRACK_X_PROBE === "1";
const CENSUS = process.env.TRACK_X_CENSUS !== "0";
const ROLLOVER_TIMEOUT_MS = Number(process.env.TRACK_X_ROLLOVER_TIMEOUT_MS ?? 0);
const NET_PROBE = process.env.TRACK_X_NET_PROBE === "1";
const CONSOLE_ALL = process.env.TRACK_X_CONSOLE_ALL === "1";
const IDB_PROBE = process.env.TRACK_X_IDB_PROBE === "1";
const HISTORY_STORM_MS = Number(process.env.TRACK_X_HISTORY_STORM_MS ?? 0);
const PHASES = process.env.TRACK_Z_PHASES === "1";
const LULL = process.env.TRACK_Z_LULL ?? "off";
if (LULL !== "off" && LULL !== "explicit") throw new Error("TRACK_Z_LULL must be off or explicit");
const ACCESSOR =
	"\n;globalThis.__TRACK_X_ROOM__ = () => room;\n" + (NET_PROBE ? ";globalThis.__TRACK_X_NODE__ = () => node;\n" : "");

interface Census {
	readonly databases: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly usage: number | null;
}

interface ShippedApp {
	readonly name: "canvas" | "chat";
	readonly origin: string;
	readonly headFactory: string;
	readonly sessionGlobal: string;
	/** Creates the room through the UI and returns its invite. */
	create(page: Page): Promise<string>;
	/** Joins with the invite through the UI. */
	join(page: Page, invite: string): Promise<void>;
	/** Makes one creator move through the UI; returns its key and the in-page ms until the creator shows it. */
	move(page: Page, epoch: number, ordinal: number): Promise<Readonly<{ key: unknown; ms: number }>>;
	/** Whether the page shows the move. */
	shows(page: Page, key: unknown): Promise<boolean>;
	/** The page's comparable view of the room's state. */
	view(page: Page): Promise<unknown>;
}

const canvas: ShippedApp = {
	name: "canvas",
	origin: "http://127.0.0.1:4180",
	headFactory: "__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__",
	sessionGlobal: "__TS_DRP_CANVAS_SESSION__",
	async create(page) {
		await expect(page.locator("#create")).toBeEnabled();
		await page.locator("#create").click();
		await expect(page.getByTestId("canvas-stage")).toBeVisible();
		await expect(page.locator("#canvasInvite")).not.toHaveValue("");
		return page.locator("#canvasInvite").inputValue();
	},
	async join(page, invite) {
		await expect(page.locator("#connect")).toBeEnabled();
		await page.locator("#canvasIdInput").fill(invite);
		await page.locator("#connect").click();
		await expect(page.getByTestId("canvas-stage")).toBeVisible();
	},
	async move(page, epoch, ordinal) {
		const id = `${epoch % 10}-${ordinal % 10}`;
		return page.evaluate(async (pixelId) => {
			const pixel = document.getElementById(pixelId);
			if (pixel === null) throw new Error("TRACK_X_CANVAS_PIXEL_ABSENT");
			const before = pixel.style.backgroundColor;
			const started = performance.now();
			pixel.click();
			while (pixel.style.backgroundColor === before) {
				if (performance.now() - started > 60_000) throw new Error("TRACK_X_CANVAS_PAINT_NOT_SHOWN");
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return { key: { id: pixelId, color: pixel.style.backgroundColor }, ms: performance.now() - started };
		}, id);
	},
	async shows(page, key) {
		const { id, color } = key as { id: string; color: string };
		return page.evaluate(
			({ pixelId, expected }) => document.getElementById(pixelId)?.style.backgroundColor === expected,
			{ pixelId: id, expected: color }
		);
	},
	async view(page) {
		return page.evaluate(() =>
			Array.from(document.querySelectorAll<HTMLElement>("#canvas > div"), (pixel) => [
				pixel.id,
				pixel.style.backgroundColor,
			])
		);
	},
};

const chat: ShippedApp = {
	name: "chat",
	origin: "http://127.0.0.1:4181",
	headFactory: "__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__",
	sessionGlobal: "__TS_DRP_CHAT_SESSION__",
	async create(page) {
		await expect(page.locator("#createRoom")).toBeEnabled();
		await page.locator("#createRoom").click();
		await expect(page.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
		await expect(page.locator("#messageInput")).toBeEnabled();
		return page.locator("#chatInvite").inputValue();
	},
	async join(page, invite) {
		await expect(page.locator("#joinRoom")).toBeEnabled();
		await page.locator("#roomInput").fill(invite);
		await page.locator("#joinRoom").click();
		await expect(page.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
	},
	async move(page, epoch, ordinal) {
		const text = `track-x e${epoch + 1} m${ordinal}`;
		return page.evaluate(async (value) => {
			const input = document.getElementById("messageInput") as HTMLInputElement;
			const shown = (): boolean =>
				Array.from(document.querySelectorAll(".message-content")).some((element) => element.textContent === value);
			const started = performance.now();
			input.value = value;
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
			// Accepted and published: the page clears the input when issue() resolves.
			while (!shown() || input.value !== "") {
				if (performance.now() - started > 60_000) throw new Error("TRACK_X_CHAT_MESSAGE_NOT_SHOWN");
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return { key: value, ms: performance.now() - started };
		}, text);
	},
	async shows(page, key) {
		return page.evaluate(
			(value) =>
				Array.from(document.querySelectorAll(".message-content")).some((element) => element.textContent === value),
			key as string
		);
	},
	async view(page) {
		return page.evaluate(() =>
			Array.from(document.querySelectorAll<HTMLElement>(".message"), (row) => [
				row.dataset.clientOperationId,
				row.querySelector(".message-content")?.textContent,
			]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
		);
	},
};

// Observation only: counts records per object store of every IndexedDB database of the
// page's origin, read-only, closing each connection at once (as Track V's harness does).
async function census(page: Page): Promise<Census> {
	return page.evaluate(async () => {
		const request = <Value>(value: IDBRequest<Value>): Promise<Value> =>
			new Promise((resolve, reject) => {
				value.onsuccess = (): void => resolve(value.result);
				value.onerror = (): void => reject(value.error);
			});
		const databases: Record<string, Record<string, number>> = {};
		for (const { name } of await indexedDB.databases()) {
			if (name === undefined) continue;
			const opened = indexedDB.open(name);
			opened.onupgradeneeded = (): void => opened.transaction?.abort();
			let database: IDBDatabase;
			try {
				database = await request(opened);
			} catch {
				continue;
			}
			try {
				const stores: Record<string, number> = {};
				for (const store of Array.from(database.objectStoreNames))
					stores[store] = await request(database.transaction(store, "readonly").objectStore(store).count());
				databases[name] = stores;
			} finally {
				database.close();
			}
		}
		const estimate = await navigator.storage.estimate();
		return { databases, usage: estimate.usage ?? null };
	});
}

const total = (value: Census): number =>
	Object.values(value.databases).reduce(
		(sum, stores) => sum + Object.values(stores).reduce((inner, count) => inner + count, 0),
		0
	);
const issuance = (value: Census): Readonly<{ issuedRecords: number | null; issuanceOutbox: number | null }> | null => {
	const entry = Object.entries(value.databases).find(([name]) => name.endsWith("--drp-issuance-v1"));
	return entry === undefined
		? null
		: { issuedRecords: entry[1].issuedRecords ?? null, issuanceOutbox: entry[1].issuanceOutbox ?? null };
};

// Appends the read-only room accessor to the page's own entry module as served.
async function exposeRoom(context: BrowserContext, app: ShippedApp): Promise<void> {
	await context.route(
		(url) => url.origin === app.origin && url.pathname === "/src/index.ts",
		async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			if (!/\blet room\b/u.test(body)) throw new Error("TRACK_X_ROOM_BINDING_ABSENT");
			const headers = { ...response.headers() };
			delete headers["content-length"];
			await route.fulfill({ status: response.status(), headers, body: body + ACCESSOR });
		}
	);
}

async function openApp(page: Page, app: ShippedApp): Promise<void> {
	await page.goto(`${app.origin}/`);
	await page.waitForFunction((name) => {
		const session = Reflect.get(window, name) as { snapshot(): { relayReservations: readonly unknown[] } } | undefined;
		return (session?.snapshot().relayReservations.length ?? 0) >= 1;
	}, app.sessionGlobal);
}

const peerIdOf = (page: Page, app: ShippedApp): Promise<string> =>
	page.evaluate(
		(name) => (Reflect.get(window, name) as { snapshot(): { peerId: string } }).snapshot().peerId,
		app.sessionGlobal
	);

const pageMs = (page: Page): Promise<number> => page.evaluate(() => Math.round(performance.now()));

const connectedPeers = (page: Page): Promise<readonly string[]> =>
	page.evaluate(
		() =>
			(
				Reflect.get(globalThis, "__TRACK_X_ROOM__") as () => { connectedPeers(): readonly string[] } | undefined
			)()?.connectedPeers() ?? []
	);

interface LullResult {
	readonly kind: string;
	readonly reason: string | null;
	readonly ms: number;
	readonly start: number;
	readonly end: number;
}

// Track Z: the room's own maintainRecoveryPool(), with its result and in-page duration (absolute page times).
const runLull = (page: Page): Promise<LullResult> =>
	page.evaluate(async () => {
		const room = (
			Reflect.get(globalThis, "__TRACK_X_ROOM__") as () => {
				maintainRecoveryPool(): Promise<{ kind: string; reason?: string }>;
			}
		)();
		const start = performance.timeOrigin + performance.now();
		const result = await room.maintainRecoveryPool();
		const end = performance.timeOrigin + performance.now();
		return { kind: result.kind, reason: result.reason ?? null, ms: end - start, start, end };
	});

// Observation only: open IndexedDB transactions and Web Locks requests of the page.
function idbProbeInitScript(): void {
	const open = new Map<number, Readonly<Record<string, unknown>>>();
	let sequence = 0;
	const stack = (): string =>
		(new Error().stack ?? "")
			.split("\n")
			.slice(2, 14)
			.map((line) => line.trim().replace(/https?:\/\/127\.0\.0\.1:\d+\/@fs\/\S*?\/(packages|examples)\//u, "$1/"))
			.join(" | ");
	const transaction = IDBDatabase.prototype.transaction;
	IDBDatabase.prototype.transaction = function (
		this: IDBDatabase,
		...args: Parameters<IDBDatabase["transaction"]>
	): IDBTransaction {
		const created = Reflect.apply(transaction, this, args) as IDBTransaction;
		const id = ++sequence;
		const stores = args[0];
		open.set(id, {
			kind: "idb",
			db: this.name,
			stores: (Array.isArray(stores) ? stores : [stores]).join(","),
			mode: args[1] ?? "readonly",
			at: Math.round(performance.now()),
			stack: stack(),
		});
		const done = (): void => {
			open.delete(id);
		};
		created.addEventListener("complete", done);
		created.addEventListener("abort", done);
		return created;
	};
	const locks = (navigator as Navigator & { locks?: LockManager }).locks;
	if (locks !== undefined) {
		const request = locks.request;
		locks.request = function (this: LockManager, ...args: unknown[]): Promise<unknown> {
			const id = ++sequence;
			const options = typeof args[1] === "object" && args[1] !== null ? (args[1] as LockOptions) : undefined;
			open.set(id, {
				kind: "lock",
				name: args[0],
				mode: options?.mode ?? "exclusive",
				ifAvailable: options?.ifAvailable === true,
				at: Math.round(performance.now()),
				stack: stack(),
			});
			const result = Reflect.apply(request, this, args) as Promise<unknown>;
			void result.then(
				() => open.delete(id),
				() => open.delete(id)
			);
			return result;
		} as LockManager["request"];
	}
	Reflect.set(globalThis, "__TRACK_X_IDB__", { open, count: (): number => sequence });
}

async function readIdbProbe(page: Page): Promise<unknown> {
	return page.evaluate(() => {
		const state = Reflect.get(globalThis, "__TRACK_X_IDB__") as
			| { open: Map<number, Readonly<Record<string, unknown>>>; count(): number }
			| undefined;
		if (state === undefined) return null;
		const now = Math.round(performance.now());
		return {
			now,
			created: state.count(),
			open: [...state.open.values()]
				.map((entry) => ({ ...entry, ageMs: now - (entry.at as number) }))
				.sort((left, right) => right.ageMs - left.ageMs)
				.slice(0, 40),
		};
	});
}

// Observation only: times the page's own network node's send and publish calls.
async function installNetProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const node = (
			Reflect.get(globalThis, "__TRACK_X_NODE__") as (() => { networkNode: object } | undefined) | undefined
		)?.();
		if (node === undefined) throw new Error("TRACK_X_NODE_ABSENT");
		const network = node.networkNode as Record<string, unknown>;
		const state = {
			sequence: 0,
			inflight: new Map<number, Readonly<Record<string, unknown>>>(),
			slow: [] as Readonly<Record<string, unknown>>[],
			counts: {} as Record<string, number>,
		};
		Reflect.set(globalThis, "__TRACK_X_NET__", state);
		for (const name of [
			"sendMessage",
			"publishMessage",
			"sendSyncMessage",
			"sendSyncResponseMessage",
			"broadcastMessage",
		]) {
			const original = network[name];
			if (typeof original !== "function") continue;
			network[name] = function (this: unknown, ...args: unknown[]): unknown {
				const id = ++state.sequence;
				const started = performance.now();
				const target = typeof args[0] === "string" ? args[0].slice(-12) : typeof args[0];
				const type = (args[1] as { type?: unknown } | undefined)?.type;
				state.inflight.set(id, { name, target, type, started: Math.round(started) });
				state.counts[name] = (state.counts[name] ?? 0) + 1;
				const settle = (): void => {
					const ms = performance.now() - started;
					state.inflight.delete(id);
					if (ms > 1_000) {
						state.slow.push({ name, target, type, started: Math.round(started), ms: Math.round(ms) });
						if (state.slow.length > 60) state.slow.shift();
					}
				};
				let result: unknown;
				try {
					result = Reflect.apply(original as (...values: unknown[]) => unknown, this, args);
				} catch (error) {
					settle();
					throw error;
				}
				if (result instanceof Promise) void result.then(settle, settle);
				else settle();
				return result;
			};
		}
	});
}

async function readNetProbe(page: Page): Promise<unknown> {
	return page.evaluate(() => {
		const state = Reflect.get(globalThis, "__TRACK_X_NET__") as
			| { inflight: Map<number, unknown>; slow: unknown[]; counts: unknown }
			| undefined;
		return {
			now: Math.round(performance.now()),
			step: Reflect.get(globalThis, "__TRACK_X_STEP__") ?? null,
			inflight: state === undefined ? null : [...state.inflight.values()],
			slow: state?.slow ?? null,
			counts: state?.counts ?? null,
		};
	});
}

// Per-epoch summary of the probe: calls in flight now, and the slow calls since the last one.
async function takeNetProbe(page: Page): Promise<unknown> {
	return page.evaluate(() => {
		const state = Reflect.get(globalThis, "__TRACK_X_NET__") as
			| { inflight: Map<number, { started: number }>; slow: unknown[]; counts: Record<string, number> }
			| undefined;
		if (state === undefined) return null;
		const now = performance.now();
		const slow = state.slow.splice(0);
		return {
			inflight: state.inflight.size,
			oldestInflightMs: Math.round(Math.max(0, ...[...state.inflight.values()].map(({ started }) => now - started))),
			slow,
			counts: { ...state.counts },
		};
	});
}

/**
 * Resolves with the evaluation, or with undefined once `ms` passes (0: no bound).
 * @param evaluation - The pending page evaluation.
 * @param ms - The bound.
 * @returns The result, or undefined on timeout.
 */
async function bounded<Value>(evaluation: Promise<Value>, ms: number): Promise<Readonly<{ value: Value }> | undefined> {
	if (ms <= 0) return { value: await evaluation };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			evaluation.then((value) => ({ value })),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function waitShown(app: ShippedApp, page: Page, key: unknown, timeout: number): Promise<boolean> {
	try {
		await expect.poll(() => app.shows(page, key), { timeout }).toBe(true);
		return true;
	} catch {
		return false;
	}
}

for (const app of [canvas, chat])
	test(`the shipped ${app.name} page runs ${EPOCHS} creator successors with a joined recipient (measurement)`, async ({
		browser,
		request,
	}, info) => {
		test.setTimeout(1_800_000);
		expect((await request.post("http://127.0.0.1:4175/grid-control/registry/reset")).ok()).toBe(true);
		const creatorContext = await browser.newContext();
		const receiverContext = await browser.newContext();
		const contexts = [creatorContext, receiverContext];
		// Independent peers own independent account floors, as Track V's Grid harness does.
		await installGridRoomHeadAuthority([creatorContext], app.headFactory);
		await installGridRoomHeadAuthority([receiverContext], app.headFactory, "create");
		await exposeRoom(creatorContext, app);
		await exposeRoom(receiverContext, app);
		if (IDB_PROBE)
			await Promise.all([
				creatorContext.addInitScript(idbProbeInitScript),
				receiverContext.addInitScript(idbProbeInitScript),
			]);
		if (PHASES || process.env.TRACK_Z_PAGE_GLOBALS !== undefined)
			await Promise.all([installPhaseProbe(creatorContext), installPhaseProbe(receiverContext)]);
		const creator = await creatorContext.newPage();
		const receiver = await receiverContext.newPage();
		const records: unknown[] = [];
		const started = Date.now();
		// Observation only: console warnings and errors per page since the last epoch record,
		// keyed by their first two words, and a tail of the recent lines with test-time ms.
		const consoleCounts = { creator: new Map<string, number>(), recipient: new Map<string, number>() };
		const consoleTail: string[] = [];
		const consoleAll: string[] = [];
		const ingress: string[] = [];
		for (const [label, page] of [
			["creator", creator],
			["recipient", receiver],
		] as const) {
			page.on("pageerror", (error) => consoleTail.push(`${label} ${Date.now() - started} pageerror ${error.message}`));
			page.on("console", (message) => {
				if (CONSOLE_ALL) {
					consoleAll.push(`${label} ${Date.now() - started} ${message.type()} ${message.text().slice(0, 240)}`);
					if (consoleAll.length > 400) consoleAll.shift();
				}
				if (message.type() !== "warning" && message.type() !== "error") return;
				const key = `${message.type()} ${message.text().split(/\s+/u).slice(0, 2).join(" ").slice(0, 80)}`;
				consoleCounts[label].set(key, (consoleCounts[label].get(key) ?? 0) + 1);
				const line = `${label} ${Date.now() - started} ${message.type()} ${message.text().slice(0, 240)}`;
				consoleTail.push(line);
				if (consoleTail.length > 200) consoleTail.shift();
				if (message.text().includes("v3-ingress")) ingress.push(line);
			});
		}
		const takeConsole = (): Readonly<Record<"creator" | "recipient", Readonly<Record<string, number>>>> => {
			const taken = {
				creator: Object.fromEntries(consoleCounts.creator),
				recipient: Object.fromEntries(consoleCounts.recipient),
			};
			consoleCounts.creator.clear();
			consoleCounts.recipient.clear();
			return taken;
		};
		const hung = async (phase: string, epoch: number): Promise<never> => {
			const probe = async (page: Page): Promise<unknown> =>
				(await bounded(NET_PROBE ? readNetProbe(page) : pageMs(page), 10_000))?.value ?? "unresponsive";
			const report = {
				app: app.name,
				phase,
				epoch,
				testMs: Date.now() - started,
				creator: await probe(creator),
				recipient: await probe(receiver),
				...(IDB_PROBE
					? {
							idb: {
								creator: (await bounded(readIdbProbe(creator), 10_000))?.value ?? "unresponsive",
								recipient: (await bounded(readIdbProbe(receiver), 10_000))?.value ?? "unresponsive",
							},
						}
					: {}),
				console: consoleTail.slice(-120),
				consoleAll: consoleAll.slice(-300),
				// Track Z: the step the creator's rollover reached, and with TRACK_Z_PHASES the spans it completed.
				step: (
					await bounded(
						creator.evaluate(() => Reflect.get(globalThis, "__TRACK_X_STEP__") ?? null),
						10_000
					)
				)?.value,
				...(PHASES ? { tail: { creator: await hangTail(creator), recipient: await hangTail(receiver) } } : {}),
			};
			process.stdout.write(`TRACK_X_ROLLOVER_HUNG ${JSON.stringify(report)}\n`);
			throw new Error(`TRACK_X_ROLLOVER_HUNG ${app.name} epoch ${epoch} ${phase}`);
		};
		try {
			await Promise.all([openApp(creator, app), openApp(receiver, app)]);
			if (NET_PROBE) await Promise.all([installNetProbe(creator), installNetProbe(receiver)]);
			const invite = await app.create(creator);
			await app.join(receiver, invite);
			const creatorPeer = await peerIdOf(creator, app);
			const receiverPeer = await peerIdOf(receiver, app);
			await expect.poll(() => connectedPeers(creator), { timeout: 60_000 }).toContain(receiverPeer);
			await expect.poll(() => connectedPeers(receiver), { timeout: 60_000 }).toContain(creatorPeer);
			process.stdout.write(
				`TRACK_X_OPENED ${JSON.stringify({ app: app.name, ms: Date.now() - started, creatorPeer, receiverPeer })}\n`
			);
			if (HISTORY_STORM_MS > 0) {
				const storm = await receiver.evaluate(
					({ creator: target, ms }) => {
						const node = (Reflect.get(globalThis, "__TRACK_X_NODE__") as () => { networkNode: unknown })();
						const network = node.networkNode as {
							peerId: string;
							getSubscribedTopics(): string[];
							sendMessage(peer: string, message: unknown): Promise<void>;
						};
						const controlId = network
							.getSubscribedTopics()
							.find((topic) => topic.startsWith("/ts-drp/room-history/1/"));
						if (controlId === undefined) throw new Error("TRACK_X_HISTORY_CONTROL_TOPIC_ABSENT");
						const data = new TextEncoder().encode("ts-drp-room-history-request-v1");
						Reflect.set(
							globalThis,
							"__TRACK_X_STORM__",
							setInterval(() => {
								void network
									.sendMessage(target, { data: data.slice(), objectId: controlId, sender: network.peerId, type: 8 })
									.catch(() => undefined);
							}, ms)
						);
						return controlId;
					},
					{ creator: creatorPeer, ms: HISTORY_STORM_MS }
				);
				process.stdout.write(`TRACK_X_HISTORY_STORM ${JSON.stringify({ ms: HISTORY_STORM_MS, controlId: storm })}\n`);
			}
			// Track Z: everything before the first epoch (open, create, join) is one window.
			let phaseFrom = 0;
			if (PHASES) {
				const openedAt = (await pageNow(creator)) + 1;
				const windows: PhaseWindow[] = [{ name: "open", start: 0, end: openedAt }];
				const [creatorRaw, recipientRaw] = await Promise.all([takePhases(creator), takePhases(receiver)]);
				process.stdout.write(
					`TRACK_Z_PHASES ${JSON.stringify({
						app: app.name,
						epoch: 0,
						creator: summarizePhases(creatorRaw, windows),
						recipient: summarizePhases(recipientRaw, windows),
						databases: {
							creator: Object.keys((await census(creator)).databases),
							recipient: Object.keys((await census(receiver)).databases),
						},
					})}\n`
				);
				phaseFrom = openedAt;
			}
			for (let epoch = 0; epoch < EPOCHS; epoch++) {
				const issueMs: number[] = [];
				const deliveryMs: number[] = [];
				for (let ordinal = 0; ordinal < MOVES; ordinal++) {
					const moved = await app.move(creator, epoch, ordinal);
					issueMs.push(Math.round(moved.ms));
					const sent = Date.now();
					if (!(await waitShown(app, receiver, moved.key, CONVERGE_MS))) {
						const stuck = {
							app: app.name,
							epoch: epoch + 1,
							ordinal,
							key: moved.key,
							testMs: Date.now() - started,
							pageMs: { creator: await pageMs(creator), recipient: await pageMs(receiver) },
							console: consoleTail,
						};
						process.stdout.write(`TRACK_X_STUCK ${JSON.stringify(stuck)}\n`);
						if (PROBE) {
							const later = await app.move(creator, epoch, MOVES + ordinal);
							const laterShown = await waitShown(app, receiver, later.key, 20_000);
							const originalShown = await app.shows(receiver, moved.key);
							process.stdout.write(
								`TRACK_X_PROBE ${JSON.stringify({ app: app.name, epoch: epoch + 1, laterShown, originalShown, ingress: ingress.slice(-40) })}\n`
							);
						}
						throw new Error(`TRACK_X_NOT_DELIVERED ${app.name} epoch ${epoch + 1} move ${ordinal}`);
					}
					deliveryMs.push(Date.now() - sent);
				}
				await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
				const rolloverEvaluation = creator.evaluate(async () => {
					const step = (name: string): void => {
						Reflect.set(globalThis, "__TRACK_X_STEP__", { name, at: Math.round(performance.now()) });
					};
					const room = (Reflect.get(globalThis, "__TRACK_X_ROOM__") as () => unknown)() as {
						sealEpoch(): Promise<{ ok: boolean; epoch: number; successorEpoch: number }>;
						exportCreatorSuccessor(): Promise<Record<string, Uint8Array>>;
						adoptCreatorSuccessor(): Promise<unknown>;
					};
					// Absolute page times of the step boundaries (Track Z's windows).
					const marks: number[] = [];
					const mark = (): void => {
						marks.push(performance.timeOrigin + performance.now());
					};
					let begun = performance.now();
					mark();
					step("seal");
					const close = await room.sealEpoch();
					const seal = performance.now() - begun;
					mark();
					if (!close.ok) throw new Error("TRACK_X_HEALTHY_CLOSE_REFUSED");
					begun = performance.now();
					step("export");
					const offer = await room.exportCreatorSuccessor();
					const exported = performance.now() - begun;
					mark();
					begun = performance.now();
					step("adopt");
					await room.adoptCreatorSuccessor();
					const adoption = performance.now() - begun;
					mark();
					step("done");
					return {
						close: { ok: close.ok, epoch: close.epoch, successorEpoch: close.successorEpoch },
						ms: { seal, export: exported, adoption },
						marks,
						offer: Object.fromEntries(Object.entries(offer).map(([key, value]) => [key, Array.from(value)])),
					};
				});
				// A timed-out evaluation is abandoned; its later rejection (the page closing) is not unhandled.
				void rolloverEvaluation.catch(() => undefined);
				const rolloverResult = await bounded(rolloverEvaluation, ROLLOVER_TIMEOUT_MS);
				if (rolloverResult === undefined) await hung("creator rollover", epoch + 1);
				const rollover = (rolloverResult as NonNullable<typeof rolloverResult>).value;
				expect(rollover.close).toEqual({ ok: true, epoch, successorEpoch: epoch + 1 });
				const installEvaluation = receiver.evaluate(
					async ({ offer, peer }) => {
						const room = (Reflect.get(globalThis, "__TRACK_X_ROOM__") as () => unknown)() as {
							installCreatorSuccessor(input: unknown): Promise<unknown>;
						};
						const begun = performance.now();
						const start = performance.timeOrigin + begun;
						await room.installCreatorSuccessor({
							peers: [peer],
							offer: Object.fromEntries(Object.entries(offer).map(([key, value]) => [key, new Uint8Array(value)])),
						});
						const ended = performance.now();
						return { ms: ended - begun, start, end: performance.timeOrigin + ended };
					},
					{ offer: rollover.offer, peer: creatorPeer }
				);
				void installEvaluation.catch(() => undefined);
				const installResult = await bounded(installEvaluation, ROLLOVER_TIMEOUT_MS);
				if (installResult === undefined) await hung("recipient install", epoch + 1);
				const installed = (installResult as NonNullable<typeof installResult>).value;
				const install = installed.ms;
				await expect.poll(() => app.view(receiver), { timeout: CONVERGE_MS }).toEqual(await app.view(creator));
				if (POST_INSTALL_PAUSE_MS > 0) await new Promise((resolve) => setTimeout(resolve, POST_INSTALL_PAUSE_MS));
				// Track Z: the explicit lull, creator first and then the recipient, as the bench orders it.
				const convergedAt = await pageNow(creator);
				const lull =
					LULL === "explicit" ? { creator: await runLull(creator), recipient: await runLull(receiver) } : undefined;
				const skipped: Census = { databases: {}, usage: null };
				const censusAt = await pageNow(creator);
				const [creatorCensus, recipientCensus] = CENSUS
					? await Promise.all([census(creator), census(receiver)])
					: [skipped, skipped];
				if (PHASES) {
					const takenAt = await pageNow(creator);
					const [sealAt, exportAt, adoptAt, adoptedAt] = rollover.marks as [number, number, number, number];
					const windows: PhaseWindow[] = [
						{ name: "play", start: phaseFrom, end: sealAt },
						{ name: "seal", start: sealAt, end: exportAt },
						{ name: "export", start: exportAt, end: adoptAt },
						{ name: "adopt", start: adoptAt, end: adoptedAt },
						{ name: "handoff", start: adoptedAt, end: installed.start },
						{ name: "install", start: installed.start, end: installed.end },
						{ name: "converge", start: installed.end, end: lull?.creator.start ?? convergedAt },
						...(lull === undefined
							? []
							: [
									{ name: "lull-creator", start: lull.creator.start, end: lull.creator.end },
									{ name: "lull-recipient", start: lull.recipient.start, end: lull.recipient.end },
								]),
						{ name: "census", start: censusAt, end: takenAt + 1 },
					];
					const [creatorRaw, recipientRaw] = await Promise.all([takePhases(creator), takePhases(receiver)]);
					process.stdout.write(
						`TRACK_Z_PHASES ${JSON.stringify({
							app: app.name,
							epoch: epoch + 1,
							creator: summarizePhases(creatorRaw, windows),
							recipient: summarizePhases(recipientRaw, windows),
							auto: { creator: creatorRaw.auto, recipient: recipientRaw.auto },
							dropped: { creator: creatorRaw.dropped, recipient: recipientRaw.dropped },
						})}\n`
					);
					phaseFrom = takenAt + 1;
				}
				const record = {
					app: app.name,
					epoch: epoch + 1,
					testMs: Date.now() - started,
					pageMs: { creator: await pageMs(creator), recipient: await pageMs(receiver) },
					ms: { ...rollover.ms, install },
					...(lull === undefined
						? {}
						: {
								lull: {
									creator: { kind: lull.creator.kind, reason: lull.creator.reason, ms: lull.creator.ms },
									recipient: { kind: lull.recipient.kind, reason: lull.recipient.reason, ms: lull.recipient.ms },
								},
							}),
					issueMs,
					deliveryMs,
					creator: { rows: total(creatorCensus), issuance: issuance(creatorCensus), usage: creatorCensus.usage },
					recipient: {
						rows: total(recipientCensus),
						issuance: issuance(recipientCensus),
						usage: recipientCensus.usage,
					},
					console: takeConsole(),
					...(NET_PROBE
						? { net: { creator: await takeNetProbe(creator), recipient: await takeNetProbe(receiver) } }
						: {}),
				};
				records.push(record);
				process.stdout.write(`TRACK_X_CHROMIUM ${JSON.stringify(record)}\n`);
			}
			await info.attach(`track-x-${app.name}-long-room`, {
				body: JSON.stringify({ app: app.name, epochs: EPOCHS, records, ingress }),
				contentType: "application/json",
			});
		} finally {
			process.stdout.write(`TRACK_X_INGRESS ${JSON.stringify({ app: app.name, ingress })}\n`);
			// With TRACK_X_ROLLOVER_TIMEOUT_MS, a room close that joins a hung rollover is abandoned
			// after the same bound, so a hung run ends instead of waiting for the test timeout.
			const closes = [creator, receiver].map((page) =>
				page.evaluate(() =>
					(Reflect.get(globalThis, "__TRACK_X_ROOM__") as () => { close(): Promise<void> } | undefined)()?.close()
				)
			);
			for (const close of closes) void close.catch(() => undefined);
			await bounded(Promise.allSettled(closes), ROLLOVER_TIMEOUT_MS);
			await Promise.allSettled([creator.close(), receiver.close(), ...contexts.map((context) => context.close())]);
		}
	});
