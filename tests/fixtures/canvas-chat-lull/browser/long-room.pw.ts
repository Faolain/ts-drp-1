import { expect, type Page, test } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, normalize } from "node:path";

import {
	type BoundMode,
	driveLongRoom,
	type EpochRecord,
	labelOf,
	type LongRoomOptions,
	type RoleEndpoint,
} from "../long-room-driver.js";

// Track Q evidence: the Canvas and Chat long rooms in a real browser (genuine seal, adoption,
// install and both roles' recovery-pool lulls, moves while the creator's lull runs). The
// creator and the recipient are two pages on two origins, driven from this process by
// long-room-driver.ts (Track M's tests/fixtures/track-m-apps/browser/long-room.pw.ts,
// da3704ac, without its retention host). Each case runs the shipped composition and the same
// composition without its resource bound reader ("absent", the pre-Track-Q shape) as
// interleaved pairs: odd repeats reverse the order (ABBA). Every latency is measured inside
// the page that does the work; long tasks are read from each page after each epoch.
//
// CANVAS_CHAT_LULL_APPS=canvas,chat  CANVAS_CHAT_LULL_HOSTS=room,browser  CANVAS_CHAT_LULL_EPOCHS=8
// CANVAS_CHAT_LULL_CANVAS_RECIPIENTS=receive-only  CANVAS_CHAT_LULL_CHAT_RECIPIENTS=writer
// CANVAS_CHAT_LULL_BOUNDS=shipped,absent  CANVAS_CHAT_LULL_REPEAT=3  CANVAS_CHAT_LULL_MOVES=2
// CANVAS_CHAT_LULL_LULL_MOVES=2  CANVAS_CHAT_LULL_SETTLE_MS=300  CANVAS_CHAT_LULL_OUT=<dir>
// CANVAS_CHAT_LULL_TREE=<label>  CANVAS_CHAT_LULL_REPEAT_FROM=<n>
// CANVAS_CHAT_LULL_PREBUILT_ASSETS=<dir> (a bundle build.ts already made, global-setup.ts)

type Host = "browser" | "room";
function selection<Value extends string>(name: string, allowed: readonly Value[], fallback: readonly Value[]): Value[] {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return [...fallback];
	const values = raw.split(",").map((value) => value.trim());
	for (const value of values)
		if (!allowed.includes(value as Value)) throw new TypeError(`CANVAS_CHAT_LULL_SELECTION ${name}=${value}`);
	return values as Value[];
}

const EPOCHS = Number(process.env.CANVAS_CHAT_LULL_EPOCHS ?? 8);
const REPEAT = Number(process.env.CANVAS_CHAT_LULL_REPEAT ?? 3);
// The first repeat's index (measurement only: runs split across invocations keep distinct indices).
const REPEAT_FROM = Number(process.env.CANVAS_CHAT_LULL_REPEAT_FROM ?? 0);
const MOVES = Number(process.env.CANVAS_CHAT_LULL_MOVES ?? 2);
const LULL_MOVES = Number(process.env.CANVAS_CHAT_LULL_LULL_MOVES ?? 2);
const APPS = selection("CANVAS_CHAT_LULL_APPS", ["canvas", "chat"], ["canvas", "chat"]);
const HOSTS = selection<Host>("CANVAS_CHAT_LULL_HOSTS", ["browser", "room"], ["room"]);
const RECIPIENTS = {
	canvas: selection("CANVAS_CHAT_LULL_CANVAS_RECIPIENTS", ["receive-only", "writer"], ["receive-only"]),
	chat: selection("CANVAS_CHAT_LULL_CHAT_RECIPIENTS", ["receive-only", "writer"], ["writer"]),
};
const BOUNDS = selection<BoundMode>("CANVAS_CHAT_LULL_BOUNDS", ["shipped", "absent"], ["shipped", "absent"]);
const SETTLE = Number(process.env.CANVAS_CHAT_LULL_SETTLE_MS ?? 300);
const OUT = process.env.CANVAS_CHAT_LULL_OUT;
const TREE = process.env.CANVAS_CHAT_LULL_TREE ?? "unknown";
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
	"lullWithIngress",
	"accepted",
	"census",
	"drainEvents",
	"close",
] as const satisfies readonly (keyof RoleEndpoint)[];

const cases: { options: LongRoomOptions; repeat: number }[] = [];
for (let repeat = REPEAT_FROM; repeat < REPEAT_FROM + REPEAT; repeat++)
	for (const app of APPS)
		for (const host of HOSTS)
			for (const recipient of RECIPIENTS[app])
				for (const bound of repeat % 2 === 0 ? BOUNDS : [...BOUNDS].reverse())
					cases.push({
						options: { app, host, recipient, bound, epochs: EPOCHS, moves: MOVES, lullMoves: LULL_MOVES },
						repeat,
					});

// Two static servers over the same bundle: two origins.
const servers: Server[] = [];
const origins: string[] = [];
test.beforeAll(async () => {
	const assets = process.env.CANVAS_CHAT_LULL_ASSET_DIR;
	if (assets === undefined) throw new Error("CANVAS_CHAT_LULL_ASSET_DIR_REQUIRED");
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
		if (address === null || typeof address === "string") throw new Error("CANVAS_CHAT_LULL_SERVER_ADDRESS");
		servers.push(server);
		origins.push(`http://127.0.0.1:${address.port}`);
	}
});
test.afterAll(async () => {
	await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface RoleWindow {
	canvasChatLullRole: {
		call(method: string, args: readonly unknown[]): Promise<unknown>;
		open(options: unknown, index: number, unique: string): Promise<void>;
		longTasks(): Readonly<Record<string, unknown>>;
	};
}

function endpointOf(page: Page): RoleEndpoint {
	return Object.fromEntries(
		METHODS.map((method) => [
			method,
			(...args: unknown[]): Promise<unknown> =>
				page.evaluate(
					([selected, values]) => (window as unknown as RoleWindow).canvasChatLullRole.call(selected, values),
					[method, args] as const
				),
		])
	) as unknown as RoleEndpoint;
}

for (const { options, repeat } of cases) {
	const label = labelOf(options);
	test(`${label} (${EPOCHS} epochs, repeat ${repeat})`, async ({ page, context, browserName }) => {
		const file = OUT === undefined ? undefined : join(OUT, `${label}-${TREE}-${browserName}-r${repeat}.jsonl`);
		if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
		const pages = [page, await context.newPage()] as const;
		const unique = `${label}/${repeat}/${Date.now()}/${Math.random()}`;
		for (const [index, selected] of pages.entries()) {
			selected.on("pageerror", (error) =>
				process.stdout.write(`CANVAS_CHAT_LULL_PAGE_ERROR ${label} role=${index} ${String(error)}\n`)
			);
			await selected.goto(`${origins[index]}/ccl.html`);
			await selected.waitForFunction(() => document.title === "canvas-chat-lull ready", undefined, {
				timeout: 120_000,
			});
		}
		const [creator, recipient] = [endpointOf(pages[0]), endpointOf(pages[1])];
		await pages[1].exposeFunction("canvasChatLullRelay", (request: string) => creator.dispatch(request));
		for (const [index, selected] of pages.entries())
			await selected.evaluate(
				([selectedOptions, role, value]) =>
					(window as unknown as RoleWindow).canvasChatLullRole.open(selectedOptions, role, value),
				[options, index, unique] as const
			);
		const run = await driveLongRoom(options, [creator, recipient], {
			settleMs: SETTLE,
			sample: async () => ({
				creatorLongTasks: await pages[0].evaluate(() =>
					(window as unknown as RoleWindow).canvasChatLullRole.longTasks()
				),
				recipientLongTasks: await pages[1].evaluate(() =>
					(window as unknown as RoleWindow).canvasChatLullRole.longTasks()
				),
			}),
			write: (record: EpochRecord) => {
				if (file !== undefined)
					appendFileSync(file, `${JSON.stringify({ label, tree: TREE, browser: browserName, repeat, ...record })}\n`);
			},
			log: (line) => process.stdout.write(`${line} [${browserName} r${repeat}]\n`),
		});
		expect(run.epochs).toHaveLength(EPOCHS);
		for (const record of run.epochs) {
			if (record.lullIngress !== undefined) {
				expect(record.lullIngress.allAdmitted).toBe(true);
				expect(record.lullIngress.fifo).toBe(true);
			}
			if (options.bound === "absent") expect(record.lulls.creator).toBe("deferred:unsupported");
			else if (record.epoch >= 3) expect(record.lulls.creator).not.toBe("deferred:unsupported");
		}
	});
}
