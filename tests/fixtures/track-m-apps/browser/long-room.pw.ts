import { expect, type Page, test } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, normalize } from "node:path";

import {
	driveLongRoom,
	type EpochRecord,
	labelOf,
	type LongRoomOptions,
	type RoleEndpoint,
} from "../long-room-driver.js";

// Track M measurement: the Canvas and Chat long rooms in a real browser (genuine seal,
// adoption, install and both roles' recovery-pool lulls; per-store census and per-transition
// latency per epoch). The creator and the recipient are two pages on two origins (each its
// own IndexedDB and Web Locks; one origin would put both rooms of the object behind the same
// writer lock), driven from this process by tests/fixtures/track-m-apps/long-room-driver.ts.
// Every latency is measured inside the page that does the work; the recipient's install
// includes its material requests' round trips through this process to the creator page.
// It asserts only the room's own progress, never a bound: the numbers are the point. Cases
// run interleaved (hosts innermost; odd repeats reverse the host order, ABBA).
//
// TRACK_M_APPS_APPS=canvas,chat  TRACK_M_APPS_HOSTS=room,room-retention  TRACK_M_APPS_EPOCHS=16
// TRACK_M_APPS_CANVAS_RECIPIENTS=receive-only  TRACK_M_APPS_CHAT_RECIPIENTS=writer
// TRACK_M_APPS_LULLS=product  TRACK_M_APPS_REPEAT=1  TRACK_M_APPS_MOVES=2  TRACK_M_APPS_SETTLE_MS=<ms>
// TRACK_M_APPS_OUT=<dir> (JSONL per case)  TRACK_M_APPS_TREE=<label>
//
// Measurement only, off by default: TRACK_M_APPS_HEAP=1 adds each page's used JS heap after a
// forced collection (HeapProfiler.collectGarbage, then Runtime.getHeapUsage) to every epoch's
// record, taken once per epoch after both lulls and the post-lull census.
// TRACK_M_APPS_HEAP_SNAPSHOTS=<epoch,...> (requires TRACK_M_APPS_OUT) also writes a V8 heap
// snapshot of each page at those epochs: <OUT>/<label>-<tree>-e<epoch>-<creator|recipient>.heapsnapshot.

type Host = "browser" | "room" | "room-retention";
function selection<Value extends string>(name: string, allowed: readonly Value[], fallback: readonly Value[]): Value[] {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return [...fallback];
	const values = raw.split(",").map((value) => value.trim());
	for (const value of values)
		if (!allowed.includes(value as Value)) throw new TypeError(`TRACK_M_APPS_SELECTION ${name}=${value}`);
	return values as Value[];
}

const EPOCHS = Number(process.env.TRACK_M_APPS_EPOCHS ?? 16);
const REPEAT = Number(process.env.TRACK_M_APPS_REPEAT ?? 1);
const MOVES = Number(process.env.TRACK_M_APPS_MOVES ?? 2);
const APPS = selection("TRACK_M_APPS_APPS", ["canvas", "chat"], ["canvas", "chat"]);
const HOSTS = selection<Host>("TRACK_M_APPS_HOSTS", ["browser", "room", "room-retention"], ["room", "room-retention"]);
const RECIPIENTS = {
	canvas: selection("TRACK_M_APPS_CANVAS_RECIPIENTS", ["receive-only", "writer"], ["receive-only"]),
	chat: selection("TRACK_M_APPS_CHAT_RECIPIENTS", ["receive-only", "writer"], ["writer"]),
};
const LULLS = selection("TRACK_M_APPS_LULLS", ["product", "reader"], ["product"]);
const SETTLE = process.env.TRACK_M_APPS_SETTLE_MS;
const OUT = process.env.TRACK_M_APPS_OUT;
const TREE = process.env.TRACK_M_APPS_TREE ?? "unknown";
const HEAP_SNAPSHOTS = new Set(
	(process.env.TRACK_M_APPS_HEAP_SNAPSHOTS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== "")
		.map((value) => {
			const epoch = Number(value);
			if (!Number.isSafeInteger(epoch) || epoch < 1) throw new TypeError(`TRACK_M_APPS_HEAP_SNAPSHOTS ${value}`);
			return epoch;
		})
);
if (HEAP_SNAPSHOTS.size !== 0 && OUT === undefined) throw new TypeError("TRACK_M_APPS_HEAP_SNAPSHOTS_REQUIRE_OUT");
const HEAP = process.env.TRACK_M_APPS_HEAP === "1" || HEAP_SNAPSHOTS.size !== 0;
const LULL_KINDS = ["maintained", "not-needed", "deferred:unsupported", "deferred:busy"];
const METHODS = [
	"issue",
	"published",
	"receive",
	"state",
	"seal",
	"adopt",
	"exportOffer",
	"dispatch",
	"install",
	"authorityEpoch",
	"lull",
	"census",
	"drainEvents",
	"close",
] as const satisfies readonly (keyof RoleEndpoint)[];

const cases: { options: LongRoomOptions; repeat: number }[] = [];
for (let repeat = 0; repeat < REPEAT; repeat++)
	for (const app of APPS)
		for (const recipient of RECIPIENTS[app])
			for (const lull of LULLS)
				for (const host of repeat % 2 === 0 ? HOSTS : [...HOSTS].reverse())
					cases.push({
						options: { app, host, recipient, creatorLull: lull === "reader", epochs: EPOCHS, moves: MOVES },
						repeat,
					});

// Two static servers over the same bundle: two origins.
const servers: Server[] = [];
const origins: string[] = [];
test.beforeAll(async () => {
	const assets = process.env.TRACK_M_APPS_ASSET_DIR;
	if (assets === undefined) throw new Error("TRACK_M_APPS_ASSET_DIR_REQUIRED");
	for (let index = 0; index < 2; index++) {
		const server = createServer((request, response) => {
			const pathname = normalize(new URL(request.url ?? "/", "http://localhost").pathname).replace(/^\/+/, "");
			const file = join(assets, pathname);
			if (!file.startsWith(assets) || !existsSync(file)) return void response.writeHead(404).end();
			const type = file.endsWith(".html")
				? "text/html"
				: file.endsWith(".js")
					? "text/javascript"
					: "application/octet-stream";
			response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(readFileSync(file));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("TRACK_M_APPS_SERVER_ADDRESS");
		servers.push(server);
		origins.push(`http://127.0.0.1:${address.port}`);
	}
});
test.afterAll(async () => {
	await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function endpointOf(page: Page): RoleEndpoint {
	return Object.fromEntries(
		METHODS.map((method) => [
			method,
			(...args: unknown[]): Promise<unknown> =>
				page.evaluate(
					([selected, values]) =>
						(
							window as unknown as {
								trackMAppsRole: { call(method: string, args: readonly unknown[]): Promise<unknown> };
							}
						).trackMAppsRole.call(selected, values),
					[method, args] as const
				),
		])
	) as unknown as RoleEndpoint;
}

for (const { options, repeat } of cases) {
	const label = labelOf(options);
	test(`${label} (${EPOCHS} epochs, repeat ${repeat})`, async ({ page, context, browserName }) => {
		const file =
			OUT === undefined
				? undefined
				: join(OUT, `${label}-${TREE}-${browserName}${REPEAT > 1 ? `-r${repeat}` : ""}.jsonl`);
		if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
		const pages = [page, await context.newPage()] as const;
		const unique = `${label}/${repeat}/${Date.now()}/${Math.random()}`;
		for (const [index, selected] of pages.entries()) {
			selected.on("pageerror", (error) =>
				process.stdout.write(`TRACK_M_APPS_PAGE_ERROR ${label} role=${index} ${String(error)}\n`)
			);
			await selected.goto(`${origins[index]}/tma.html`);
			await selected.waitForFunction(() => document.title === "track-m-apps ready", undefined, {
				timeout: 120_000,
			});
		}
		const [creator, recipient] = [endpointOf(pages[0]), endpointOf(pages[1])];
		await pages[1].exposeFunction("trackMAppsRelay", (request: string) => creator.dispatch(request));
		// Measurement only (TRACK_M_APPS_HEAP): the creator's event drain follows both lulls and the
		// post-lull census once per epoch, so the heap is read there.
		const sessions = HEAP ? await Promise.all(pages.map((selected) => context.newCDPSession(selected))) : [];
		let heap: Record<string, Readonly<{ usedSize: number; totalSize: number }>> | undefined;
		let measured = 0;
		const measureHeap = async (): Promise<void> => {
			measured++;
			heap = {};
			for (const [index, session] of sessions.entries()) {
				const role = index === 0 ? "creator" : "recipient";
				await session.send("HeapProfiler.collectGarbage");
				const usage = await session.send("Runtime.getHeapUsage");
				heap[role] = { usedSize: usage.usedSize, totalSize: usage.totalSize };
				if (!HEAP_SNAPSHOTS.has(measured) || OUT === undefined) continue;
				const path = join(OUT, `${label}-${TREE}-e${measured}-${role}.heapsnapshot`);
				writeFileSync(path, "");
				const chunk = ({ chunk: value }: { chunk: string }): void => appendFileSync(path, value);
				session.on("HeapProfiler.addHeapSnapshotChunk", chunk);
				try {
					await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
				} finally {
					session.off("HeapProfiler.addHeapSnapshotChunk", chunk);
				}
			}
		};
		const driven: RoleEndpoint = HEAP
			? {
					...creator,
					drainEvents: async () => {
						await measureHeap();
						return creator.drainEvents();
					},
				}
			: creator;
		for (const [index, selected] of pages.entries())
			await selected.evaluate(
				([selectedOptions, role, value]) =>
					(
						window as unknown as {
							trackMAppsRole: { open(options: unknown, index: number, unique: string): Promise<void> };
						}
					).trackMAppsRole.open(selectedOptions, role, value),
				[options, index, unique] as const
			);
		const run = await driveLongRoom(options, [driven, recipient], {
			...(SETTLE === undefined ? {} : { settleMs: Number(SETTLE) }),
			write: (record: EpochRecord) => {
				if (file !== undefined)
					appendFileSync(
						file,
						`${JSON.stringify({ label, tree: TREE, browser: browserName, repeat, ...record, ...(heap === undefined ? {} : { heap }) })}\n`
					);
			},
			log: (line) => process.stdout.write(`${line} [${browserName}]\n`),
		});
		expect(run.epochs).toHaveLength(EPOCHS);
		for (const record of run.epochs) {
			expect(LULL_KINDS).toContain(record.lulls.creator);
			expect(LULL_KINDS).toContain(record.lulls.recipient);
		}
	});
}
