import { type Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { driveActiveAppEndurance } from "./driver.js";
import type { AppKind, RoleEndpoint } from "../track-m-apps/long-room-driver.js";

const output = process.env.ACTIVE_ENDURANCE_OUT ?? join(tmpdir(), `active-browser-${Date.now()}`);
const epochs = Number(process.env.ACTIVE_ENDURANCE_EPOCHS ?? 6);
const moves = Number(process.env.ACTIVE_ENDURANCE_MOVES ?? 2);
const streamLimit = Number(process.env.ACTIVE_ENDURANCE_STREAM ?? 4);
const apps = (process.env.ACTIVE_ENDURANCE_APPS ?? "canvas,grid,chat").split(",") as AppKind[];
const servers: Server[] = [];
const origins: string[] = [];

test.beforeAll(async () => {
	mkdirSync(output, { recursive: true });
	const assets = process.env.TRACK_M_APPS_ASSET_DIR;
	if (assets === undefined) throw new Error("ENDURANCE_BROWSER_ASSETS_REQUIRED");
	for (let role = 0; role < 2; role++) {
		const server = createServer((request, response) => {
			const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
			if (!["tma.html", "tma-entry.js"].includes(name)) return void response.writeHead(404).end();
			response.setHeader("Content-Type", name.endsWith(".js") ? "application/javascript" : "text/html");
			response.end(readFileSync(join(assets, name)));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("ENDURANCE_BROWSER_ADDRESS");
		servers.push(server);
		origins.push(`http://127.0.0.1:${address.port}`);
	}
});
test.afterAll(async () => {
	await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function endpoint(page: Page): RoleEndpoint {
	return new Proxy({} as RoleEndpoint, {
		get:
			(_target, method: string) =>
			(...args: unknown[]) =>
				page.evaluate(
					([selected, values]) => {
						const api = Reflect.get(window, "trackMAppsRole") as {
							call(name: string, input: readonly unknown[]): Promise<unknown>;
						};
						return api.call(selected, values);
					},
					[method, args] as const
				),
	});
}

for (const app of apps)
	test(`${app}: active app on native IndexedDB`, async ({ context, page, browserName }) => {
		const pages = [page, await context.newPage()] as const;
		const creator = endpoint(pages[0]);
		const recipient = endpoint(pages[1]);
		const log = join(output, `${browserName}-${app}.jsonl`);
		const options = {
			app,
			host: "room-retention",
			recipient: "writer",
			creatorLull: false,
			epochs,
			moves,
			chatFormat: "shares",
		};
		const metadata = {
			kind: "configuration",
			...options,
			sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			browserName,
			transport: "scripted signed bytes with native v2 successor membership",
			streamLimit,
		};
		const sourceDiff = execFileSync("git", ["diff", "--no-ext-diff", "HEAD"], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		writeFileSync(join(output, `${browserName}-${app}-source.diff`), sourceDiff);
		Object.assign(metadata, {
			dirtyTracked: sourceDiff.length !== 0,
			sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
		});
		appendFileSync(log, JSON.stringify(metadata) + "\n");
		const unique = `${browserName}/${app}/${Date.now()}`;
		try {
			await pages[1].exposeFunction("trackMAppsRelay", (request: string) => creator.dispatch(request));
			for (const [role, selected] of pages.entries()) {
				selected.on("pageerror", (error) =>
					appendFileSync(log, JSON.stringify({ kind: "pageerror", role, error: String(error) }) + "\n")
				);
				await selected.goto(`${origins[role]}/tma.html`);
				await selected.waitForFunction(() => document.title === "track-m-apps ready");
				await selected.evaluate(
					([configuration, index, id]) => {
						const api = Reflect.get(window, "trackMAppsRole") as {
							open(value: unknown, role: number, unique: string): Promise<void>;
						};
						return api.open(configuration, index, id);
					},
					[options, role, unique] as const
				);
			}
			const summary = await driveActiveAppEndurance({
				app,
				epochs,
				moves,
				streamLimit,
				peers: [creator, recipient],
				write: (record) => appendFileSync(log, JSON.stringify(record) + "\n"),
			});
			writeFileSync(
				join(output, `${browserName}-${app}-summary.json`),
				JSON.stringify({ ...metadata, ...summary }, null, 2)
			);
		} finally {
			await Promise.all(
				pages.map((selected) =>
					selected.evaluate(async () => {
						const api = Reflect.get(window, "trackMAppsRole") as { shutdown(): Promise<void> } | undefined;
						await api?.shutdown();
					})
				)
			);
		}
	});
