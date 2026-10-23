import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";
import {
	hangTail,
	installPhaseProbe,
	lullWindows,
	pageNow,
	type PhaseWindow,
	summarizePhases,
	takePhases,
} from "./fixtures/track-z/phase-probe";

// Track V: the shipped Grid page (examples/grid, served by its own dev server with real
// browser networking, as phase-3a1b-d9346-v3-zone.pw.ts serves it) as a long zone in
// Chromium. The creator and one enrolled Writer each place two blocks every epoch through
// the page's own zone API; the creator seals, exports and adopts each successor, and the
// Writer installs it from the creator over the real snapshot protocol. Each epoch records
// the in-page latency of every call and an observation-only IndexedDB census of both pages
// (record counts per store, and the origin usage the browser reports). The same block ids
// move every epoch, so the zone state stays the same size. Measurement: it asserts
// convergence and successful transitions, and bounds nothing; the bounded-storage proof is
// the native test tests/grid-long-room-issuance-retention-native.test.ts. It also counts
// each page's console warnings per epoch and, when a block does not converge, prints the
// recent console lines (TRACK_V_GRID_STUCK). Track V found that on the settlement profile
// the creator's blocks stop reaching the Writer after four successors (see
// docs/realtime-latency/tracks/32-track-v-settlement-for-grid-and-chat/RESULT.md).
const EPOCHS = Number(process.env.TRACK_V_GRID_EPOCHS ?? 16);
const MOVES = 2;
const SETTLE_MS = 300;
// Diagnostics only. A pause between the Writer's install and the next epoch's first move, and
// a probe that, when a placed block does not converge, records what still converges.
const POST_INSTALL_PAUSE_MS = Number(process.env.TRACK_V_GRID_POST_INSTALL_PAUSE_MS ?? 0);
const PROBE = process.env.TRACK_V_GRID_PROBE === "1";
// Diagnostics: TRACK_V_GRID_CENSUS=0 skips the IndexedDB census, to rule out any effect of its reads.
const CENSUS = process.env.TRACK_V_GRID_CENSUS !== "0";
// Track Z (measurement only, opt-in): TRACK_Z_PHASES=1 installs tests/fixtures/track-z/phase-probe.ts in
// both pages and prints, per epoch, a TRACK_Z_PHASES line that attributes each window (play, seal, export,
// adoption, install, convergence, lulls) to the proof events, spans, IndexedDB transactions and long tasks it
// held. TRACK_Z_LULL=explicit calls maintainRecoveryPool() on the creator's and then the Writer's room after
// each install, as the latency bench's lull mode does. The shipped zone API has no such call, so the harness
// adds one to the served /src/v3-zone.ts that delegates to the zone's current room exactly as its
// sealEpoch() does; nothing else in the page changes. TRACK_Z_PAGE_GLOBALS (JSON) sets page globals for a
// scratch measurement build (see the probe).
// TRACK_Z_ROLLOVER_TIMEOUT_MS bounds the creator's seal/export/adopt evaluate, the Writer's install evaluate
// and the final zone closes, as Track X's TRACK_X_ROLLOVER_TIMEOUT_MS does for Canvas and Chat: a rollover
// that does not return in time prints TRACK_Z_ROLLOVER_HUNG with the step the creator reached and the
// recent console lines, and fails the test instead of holding the shared ports until the test timeout.
const PHASES = process.env.TRACK_Z_PHASES === "1";
const LULL = process.env.TRACK_Z_LULL ?? "off";
if (LULL !== "off" && LULL !== "explicit") throw new Error("TRACK_Z_LULL must be off or explicit");
const ROLLOVER_TIMEOUT_MS = Number(process.env.TRACK_Z_ROLLOVER_TIMEOUT_MS ?? 0);
// TRACK_Z_WRITER_FIRST=1: each epoch's moves start with the Writer's (ordinals 1, 0, 3, 2), so its first move is
// issued right after its install, while its own lull and the creator's may still run (addition 3's Writer issue and
// creator admission during a lull). Ordinals keep their issuer: even the creator, odd the Writer.
const WRITER_FIRST = process.env.TRACK_Z_WRITER_FIRST === "1";

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

const readStep = async (page: Page): Promise<unknown> =>
	(
		await bounded(
			page.evaluate(() => ({
				now: Math.round(performance.now()),
				step: Reflect.get(globalThis, "__TRACK_Z_STEP__") ?? null,
			})),
			10_000
		)
	)?.value ?? "unresponsive";

interface LullResult {
	readonly kind: string;
	readonly reason: string | null;
	readonly ms: number;
	readonly start: number;
	readonly end: number;
}

async function exposeZoneLull(context: BrowserContext): Promise<void> {
	await context.route(
		(url) => url.port === "4174" && url.pathname === "/src/v3-zone.ts",
		async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			const anchor = /\n([ \t]*)sealEpoch\(\) \{\n/gu;
			const found = [...body.matchAll(anchor)];
			if (found.length !== 1) throw new Error("TRACK_Z_ZONE_SEAL_ANCHOR_ABSENT");
			const indent = found[0]?.[1] ?? "";
			const method =
				`\n${indent}maintainRecoveryPool() {\n${indent}  const selected = room;\n` +
				`${indent}  if (selected === undefined || closeRequested) return Promise.reject(new TypeError("v3 zone is not open"));\n` +
				`${indent}  return selected.maintainRecoveryPool();\n${indent}},`;
			const headers = { ...response.headers() };
			delete headers["content-length"];
			await route.fulfill({
				status: response.status(),
				headers,
				body: body.replace(anchor, (match) => method + match),
			});
		}
	);
}

const runLull = (page: Page): Promise<LullResult> =>
	page.evaluate(async () => {
		const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as {
			maintainRecoveryPool(): Promise<{ kind: string; reason?: string }>;
		};
		const start = performance.timeOrigin + performance.now();
		const result = await api.maintainRecoveryPool();
		const end = performance.timeOrigin + performance.now();
		return { kind: result.kind, reason: result.reason ?? null, ms: end - start, start, end };
	});

// Track X (decision row 60), opt-in: TRACK_V_PLAY_THROUGH_ROLLOVER=1 keeps the Writer playing through
// every rollover, as a real game does. It places a block every TRACK_V_PLAY_THROUGH_MS (default 75)
// while the creator seals, exports and adopts and while the Writer installs. A placement the Writer's
// own install refuses is counted, not failed. Each epoch then asserts that the creator holds every
// block the Writer placed (its last placement of each id; a move outside the sealed cut arrives as
// its replacement). Without it, play pauses during rollovers as before.
const PLAY_THROUGH = process.env.TRACK_V_PLAY_THROUGH_ROLLOVER === "1";
const PLAY_THROUGH_MS = Number(process.env.TRACK_V_PLAY_THROUGH_MS ?? 75);
// Convergence polls every 25 ms, so each move's delivery time (placement to the other page) is recorded.
const POLL = { intervals: [25] };

interface Block {
	readonly id: string;
	readonly kind: string;
	readonly x: number;
	readonly y: number;
}

interface PlayThrough {
	phase: "rollover" | "install";
	stop(): Promise<{
		readonly placed: number;
		readonly refused: Readonly<Record<"rollover" | "install", number>>;
		readonly firstRefusal: string | null;
		readonly placeMs: readonly number[];
		readonly last: readonly Block[];
	}>;
}

// The Writer's play during one rollover: a placement every PLAY_THROUGH_MS until stopped. Ids
// repeat, so the zone state stays the same size.
function playThrough(page: Page, epoch: number): PlayThrough {
	let running = true;
	const refused = { rollover: 0, install: 0 };
	let firstRefusal: string | null = null;
	const placeMs: number[] = [];
	const last = new Map<string, Block>();
	const state: PlayThrough = {
		phase: "rollover",
		stop: async () => {
			running = false;
			await loop;
			return { placed: placeMs.length, refused, firstRefusal, placeMs, last: [...last.values()] };
		},
	};
	const loop = (async (): Promise<void> => {
		for (let sequence = 0; running; sequence++) {
			await new Promise((resolve) => setTimeout(resolve, PLAY_THROUGH_MS));
			if (!running) break;
			const block = { id: `play-${sequence % 4}`, kind: "glass", x: 20 + (sequence % 40), y: 9 + (epoch % 4) };
			const phase = state.phase;
			try {
				placeMs.push(
					await page.evaluate(async (value) => {
						const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> };
						const started = performance.now();
						await api.placeBlock(value);
						return performance.now() - started;
					}, block)
				);
				last.set(block.id, block);
			} catch (error) {
				refused[phase]++;
				firstRefusal ??= `${phase}: ${String(error).slice(0, 300)}`;
			}
		}
	})();
	return state;
}

const quantiles = (values: readonly number[]): Readonly<{ count: number; p50: number; max: number }> | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return {
		count: sorted.length,
		p50: Math.round(sorted[Math.floor((sorted.length - 1) / 2)] ?? 0),
		max: Math.round(sorted.at(-1) ?? 0),
	};
};

interface Census {
	readonly databases: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly usage: number | null;
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_GRID_SESSION__") !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
	await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_V3_ZONE__") !== undefined, undefined, {
		timeout: 10_000,
	});
}

async function zone(page: Page): Promise<{
	readonly blocks: readonly unknown[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localPeerId: string;
	readonly ready: boolean;
}> {
	return page.evaluate(() => {
		const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { snapshot(): unknown } | undefined;
		if (api === undefined) throw new Error("TRACK_V_ZONE_API_ABSENT");
		const snapshot = api.snapshot() as Record<string, unknown>;
		return {
			blocks: snapshot.blocks as unknown[],
			durableVertexCount: snapshot.durableVertexCount as number,
			enrollment: snapshot.enrollment as string,
			invite: snapshot.invite as string,
			localPeerId: snapshot.localPeerId as string,
			ready: snapshot.ready as boolean,
		};
	});
}

// Observation only: counts records per object store of every IndexedDB database of the
// page's origin, read-only, closing each connection at once.
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

// Diagnostics after a block did not converge: does a later block from either Writer converge,
// and does the next successor's install repair the Writer's view?
async function probeStuck(creator: Page, receiver: Page, epoch: number): Promise<void> {
	const place = (page: Page, block: unknown): Promise<void> =>
		page.evaluate(async (value) => {
			await (Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> }).placeBlock(
				value
			);
		}, block);
	const converges = async (page: Page, block: unknown): Promise<boolean> => {
		try {
			await expect.poll(async () => (await zone(page)).blocks, { timeout: 20_000 }).toContainEqual(block);
			return true;
		} catch {
			return false;
		}
	};
	const later = { id: "probe-creator", kind: "wood", x: 100 + epoch, y: 0 };
	await place(creator, later);
	const laterCreatorBlock = await converges(receiver, later);
	const reverse = { id: "probe-recipient", kind: "wood", x: 100 + epoch, y: 1 };
	await place(receiver, reverse);
	const recipientBlock = await converges(creator, reverse);
	const views = async (): Promise<unknown> => ({
		creator: (await zone(creator)).blocks,
		recipient: (await zone(receiver)).blocks,
		creatorVertices: (await zone(creator)).durableVertexCount,
		recipientVertices: (await zone(receiver)).durableVertexCount,
	});
	process.stdout.write(
		`TRACK_V_GRID_PROBE ${JSON.stringify({ epoch: epoch + 1, laterCreatorBlock, recipientBlock, views: await views() })}\n`
	);
}

test(`the shipped Grid page runs ${EPOCHS} creator successors with an enrolled Writer (measurement)`, async ({
	browser,
}, info) => {
	test.setTimeout(1_800_000);
	const creatorContext = await browser.newContext();
	const receiverContext = await browser.newContext();
	const contexts = [creatorContext, receiverContext];
	// Independent Writers own independent account floors, as the d9346 rollover test does.
	await installGridRoomHeadAuthority([creatorContext]);
	await installGridRoomHeadAuthority([receiverContext], "__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__", "create");
	if (PHASES || process.env.TRACK_Z_PAGE_GLOBALS !== undefined)
		await Promise.all([installPhaseProbe(creatorContext), installPhaseProbe(receiverContext)]);
	if (LULL === "explicit") await Promise.all([exposeZoneLull(creatorContext), exposeZoneLull(receiverContext)]);
	const creator = await creatorContext.newPage();
	const receiver = await receiverContext.newPage();
	const records: unknown[] = [];
	// Observation only: browser console warnings and errors per page since the last epoch
	// record, keyed by their first two words (for example "::v3-ingress graph-rejected").
	const consoleCounts = { creator: new Map<string, number>(), recipient: new Map<string, number>() };
	const consoleTail: string[] = [];
	for (const [label, page] of [
		["creator", creator],
		["recipient", receiver],
	] as const)
		page.on("console", (message) => {
			if (message.type() !== "warning" && message.type() !== "error") return;
			const key = `${message.type()} ${message.text().split(/\s+/u).slice(0, 2).join(" ").slice(0, 80)}`;
			consoleCounts[label].set(key, (consoleCounts[label].get(key) ?? 0) + 1);
			consoleTail.push(`${label} ${Math.round(performance.now())} ${message.type()} ${message.text().slice(0, 240)}`);
			if (consoleTail.length > 200) consoleTail.shift();
		});
	const takeConsole = (): Readonly<Record<"creator" | "recipient", Readonly<Record<string, number>>>> => {
		const taken = {
			creator: Object.fromEntries(consoleCounts.creator),
			recipient: Object.fromEntries(consoleCounts.recipient),
		};
		consoleCounts.creator.clear();
		consoleCounts.recipient.clear();
		return taken;
	};
	try {
		await Promise.all([openGrid(creator), openGrid(receiver)]);
		const [creatorEnrollment, receiverEnrollment] = await Promise.all([zone(creator), zone(receiver)]);
		await creator.fill("#zoneMemberEnrollment", receiverEnrollment.enrollment);
		await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		const created = await zone(creator);
		await receiver.fill("#gridInput", created.invite);
		await receiver.click("#joinGrid");
		await expect.poll(async () => (await zone(receiver)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		// Track Z: everything before the first epoch (open, create, join) is one window.
		let phaseFrom = 0;
		if (PHASES) {
			const openedAt = (await pageNow(creator)) + 1;
			const windows: PhaseWindow[] = [{ name: "open", start: 0, end: openedAt }];
			const [creatorRaw, recipientRaw] = await Promise.all([takePhases(creator), takePhases(receiver)]);
			process.stdout.write(
				`TRACK_Z_PHASES ${JSON.stringify({
					app: "grid",
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
			const issueMs: { creator: number[]; recipient: number[] } = { creator: [], recipient: [] };
			// Track Z: [ordinal (even: creator, odd: Writer), issue start, issue ms, first seen by the other page]
			// in absolute page time.
			const deliveryMs: { creator: number[]; recipient: number[] } = { creator: [], recipient: [] };
			const moveTimes: [number, number, number, number][] = [];
			for (let step = 0; step < MOVES * 2; step++) {
				const ordinal = WRITER_FIRST ? step ^ 1 : step;
				const index = ordinal % 2;
				const [page, other] = index === 0 ? [creator, receiver] : [receiver, creator];
				const block = { id: `block-${index}-${ordinal >> 1}`, kind: "stone", x: epoch, y: index };
				const placedAt = Date.now();
				const [ms, at] = await page.evaluate(async (value) => {
					const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> };
					const started = performance.now();
					await api.placeBlock(value);
					return [performance.now() - started, performance.timeOrigin + started] as const;
				}, block);
				issueMs[index === 0 ? "creator" : "recipient"].push(ms);
				if (PHASES) {
					// Polls inside the other page every 5 ms until its zone holds the block.
					const seen = await other.evaluate(
						async ({ id, bound }) => {
							const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as {
								snapshot(): { blocks: readonly { id: string }[] };
							};
							const started = performance.now();
							while (!api.snapshot().blocks.some((entry) => entry.id === id)) {
								if (performance.now() - started > bound) return null;
								await new Promise((resolve) => setTimeout(resolve, 5));
							}
							return performance.timeOrigin + performance.now();
						},
						{ id: block.id, bound: 60_000 }
					);
					if (seen !== null) moveTimes.push([ordinal, Math.round(at), Math.round(ms), Math.round(seen)]);
				}
				try {
					await expect
						.poll(async () => (await zone(other)).blocks, { timeout: PROBE ? 20_000 : 60_000, ...POLL })
						.toContainEqual(block);
					deliveryMs[index === 0 ? "creator" : "recipient"].push(Date.now() - placedAt);
				} catch (error) {
					process.stdout.write(
						`TRACK_V_GRID_STUCK ${JSON.stringify({ epoch: epoch + 1, ordinal, block, console: consoleTail })}\n`
					);
					if (PROBE) await probeStuck(creator, receiver, epoch);
					throw error;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
			const hung = async (phase: string): Promise<never> => {
				process.stdout.write(
					`TRACK_Z_ROLLOVER_HUNG ${JSON.stringify({
						app: "grid",
						phase,
						epoch: epoch + 1,
						creator: await readStep(creator),
						recipient: await readStep(receiver),
						...(PHASES ? { tail: { creator: await hangTail(creator), recipient: await hangTail(receiver) } } : {}),
						console: consoleTail.slice(-60),
					})}\n`
				);
				throw new Error(`TRACK_Z_ROLLOVER_HUNG ${phase} epoch ${epoch + 1}`);
			};
			const play = PLAY_THROUGH ? playThrough(receiver, epoch) : undefined;
			const transition = async () => {
				const rolloverEvaluation = creator.evaluate(async () => {
					const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as {
						sealEpoch(): Promise<{ ok: boolean; epoch: number; successorEpoch: number }>;
						exportCreatorSuccessor(): Promise<Record<string, Uint8Array>>;
						adoptCreatorSuccessor(): Promise<unknown>;
					};
					// Absolute page times of the step boundaries (Track Z's windows).
					const marks: number[] = [];
					const mark = (): void => {
						marks.push(performance.timeOrigin + performance.now());
					};
					const step = (name: string): void => {
						Reflect.set(globalThis, "__TRACK_Z_STEP__", { name, at: Math.round(performance.now()) });
					};
					let started = performance.now();
					mark();
					step("seal");
					const close = await api.sealEpoch();
					const seal = performance.now() - started;
					mark();
					if (!close.ok) throw new Error("TRACK_V_HEALTHY_CLOSE_REFUSED");
					started = performance.now();
					step("export");
					const offer = await api.exportCreatorSuccessor();
					const exported = performance.now() - started;
					mark();
					started = performance.now();
					step("adopt");
					await api.adoptCreatorSuccessor();
					const adoption = performance.now() - started;
					mark();
					step("done");
					return {
						close: { ok: close.ok, epoch: close.epoch, successorEpoch: close.successorEpoch },
						ms: { seal, export: exported, adoption },
						marks,
						offer: Object.fromEntries(
							[
								"exactCanonicalCutValueBytes",
								"exactCanonicalCommitQcBytes",
								"exactCanonicalTrustStateRecordBytes",
								"exactCanonicalSnapshotManifestBytes",
							].map((key) => [key, Array.from(offer[key] ?? [])])
						),
					};
				});
				// A timed-out evaluation is abandoned; its later rejection (the page closing) is not unhandled.
				void rolloverEvaluation.catch(() => undefined);
				const rolloverResult = await bounded(rolloverEvaluation, ROLLOVER_TIMEOUT_MS);
				if (rolloverResult === undefined) await hung("creator rollover");
				const rollover = (rolloverResult as NonNullable<typeof rolloverResult>).value;
				expect(rollover.close).toEqual({ ok: true, epoch, successorEpoch: epoch + 1 });
				if (play !== undefined) play.phase = "install";
				const installEvaluation = receiver.evaluate(
					async ({ offer, peer }) => {
						const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as {
							installCreatorSuccessor(input: unknown): Promise<unknown>;
						};
						const started = performance.now();
						const start = performance.timeOrigin + started;
						await api.installCreatorSuccessor({
							peers: [peer],
							offer: Object.fromEntries(Object.entries(offer).map(([key, value]) => [key, new Uint8Array(value)])),
						});
						const ended = performance.now();
						return { ms: ended - started, start, end: performance.timeOrigin + ended };
					},
					{ offer: rollover.offer, peer: creatorEnrollment.localPeerId }
				);
				void installEvaluation.catch(() => undefined);
				const installResult = await bounded(installEvaluation, ROLLOVER_TIMEOUT_MS);
				if (installResult === undefined) await hung("recipient install");
				const installed = (installResult as NonNullable<typeof installResult>).value;
				const install = installed.ms;
				return { rollover, installed, install };
			};
			const { rollover, installed, install } = await transition().catch(async (error: unknown) => {
				if (play !== undefined) {
					const partial = await play.stop();
					process.stdout.write(
						`TRACK_V_PLAY_THROUGH_FAILED ${JSON.stringify({
							epoch: epoch + 1,
							error: String(error).slice(0, 800),
							play: { ...partial, placeMs: quantiles(partial.placeMs) },
							console: consoleTail.slice(-40),
						})}\n`
					);
				}
				throw error;
			});
			const played = await play?.stop();
			// Both pages converge, and the creator holds every block the Writer placed during the
			// rollover (none when play pauses).
			const same = (left: Block, right: Block): boolean =>
				left.id === right.id && left.kind === right.kind && left.x === right.x && left.y === right.y;
			const convergenceStarted = Date.now();
			try {
				await expect
					.poll(
						async () => {
							const [mine, theirs] = await Promise.all([zone(creator), zone(receiver)]);
							const held = mine.blocks as readonly Block[];
							return {
								equal: JSON.stringify(mine.blocks) === JSON.stringify(theirs.blocks),
								missing: (played?.last ?? []).filter((block) => !held.some((value) => same(value, block))),
							};
						},
						// Paused play keeps the config's 20 s; play through allows for the rebased moves.
						{ ...(PLAY_THROUGH ? { timeout: 60_000 } : {}), ...POLL }
					)
					.toEqual({ equal: true, missing: [] });
			} catch (error) {
				process.stdout.write(
					`TRACK_V_PLAY_THROUGH_STUCK ${JSON.stringify({ epoch: epoch + 1, last: played?.last, console: consoleTail.slice(-60) })}\n`
				);
				throw error;
			}
			const convergeMs = Date.now() - convergenceStarted;
			if (POST_INSTALL_PAUSE_MS > 0) await new Promise((resolve) => setTimeout(resolve, POST_INSTALL_PAUSE_MS));
			// Track Z: the explicit lull, creator first and then the Writer, as the bench orders it.
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
						app: "grid",
						epoch: epoch + 1,
						creator: summarizePhases(creatorRaw, windows),
						recipient: summarizePhases(recipientRaw, windows),
						lulls: { creator: lullWindows(creatorRaw), recipient: lullWindows(recipientRaw) },
						moves: moveTimes,
						auto: { creator: creatorRaw.auto, recipient: recipientRaw.auto },
						dropped: { creator: creatorRaw.dropped, recipient: recipientRaw.dropped },
					})}\n`
				);
				phaseFrom = takenAt + 1;
			}
			const record = {
				epoch: epoch + 1,
				ms: { ...rollover.ms, install, converge: convergeMs },
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
				...(played === undefined
					? {}
					: {
							play: {
								everyMs: PLAY_THROUGH_MS,
								placed: played.placed,
								refused: played.refused,
								firstRefusal: played.firstRefusal,
								placeMs: quantiles(played.placeMs),
							},
						}),
				creator: { rows: total(creatorCensus), issuance: issuance(creatorCensus), usage: creatorCensus.usage },
				recipient: { rows: total(recipientCensus), issuance: issuance(recipientCensus), usage: recipientCensus.usage },
				stores: { creator: creatorCensus.databases, recipient: recipientCensus.databases },
				console: takeConsole(),
			};
			records.push(record);
			process.stdout.write(`TRACK_V_GRID_CHROMIUM ${JSON.stringify(record)}\n`);
		}
		await info.attach("track-v-grid-long-room", {
			body: JSON.stringify({ epochs: EPOCHS, records }),
			contentType: "application/json",
		});
	} finally {
		// With TRACK_Z_ROLLOVER_TIMEOUT_MS, a zone close that joins a hung rollover is abandoned after the same bound.
		const closes = [creator, receiver].map((page) =>
			page.evaluate(() =>
				(Reflect.get(window, "__TS_DRP_V3_ZONE__") as { close(): Promise<void> } | undefined)?.close()
			)
		);
		for (const close of closes) void close.catch(() => undefined);
		await bounded(Promise.allSettled(closes), ROLLOVER_TIMEOUT_MS);
		await Promise.allSettled([creator.close(), receiver.close(), ...contexts.map((context) => context.close())]);
	}
});
