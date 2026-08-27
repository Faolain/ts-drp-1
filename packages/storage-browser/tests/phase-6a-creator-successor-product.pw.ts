import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const D108D2_BROWSER_BEHAVIORS = Object.freeze([
	"hot creator adoption exposes oracle authority and issues through the replacement handle",
	"established peer cold reopen accepts the genuine epoch-one live operation",
	"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
] as const);
const contractLoad = import(
	pathToFileURL(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts")).href
) as Promise<
	Readonly<{
		readonly D108D2_BROWSER_BEHAVIORS: readonly [string, string, string];
		isD108d2Authority(value: unknown): boolean;
	}>
>;
let sharedBrowserBehaviors: readonly string[] = [];
let isD108d2Authority: (value: unknown) => boolean = () => false;
const DATABASES = Object.freeze({ creator: "d108d2-creator", established: "d108d2-established", late: "d108d2-late" });
const CHANNEL_NAME = "d108d2-successor-product";

interface ProductBrowserServer {
	readonly origin: string;
	close(): Promise<void>;
}

interface RelayMessageObservation {
	readonly data: Uint8Array;
	readonly objectId: string;
	readonly receiverRealmId?: string;
	readonly sender: string;
	readonly sequence: number;
	readonly sourceRealmId: string;
	readonly type: number;
}

interface RelayAudit {
	readonly incoming: number;
	readonly incomingMessages: readonly RelayMessageObservation[];
	readonly mismatch: number;
	readonly outgoing: number;
	readonly outgoingMessages: readonly RelayMessageObservation[];
	readonly realmId: string;
}

async function startProductBrowserServer(entryPoint: string): Promise<ProductBrowserServer> {
	const configUrl = new URL("../../../vite.config.mts", import.meta.url).href;
	const loaded = (await import(configUrl)) as Readonly<{
		workspaceAliases?: Readonly<Record<string, string>>;
	}>;
	if (loaded.workspaceAliases === undefined) throw new TypeError("D.108d2 workspace aliases are unavailable");
	const aliases = Object.freeze({
		...loaded.workspaceAliases,
		"@ts-drp/node/creator-adoption": resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts"),
		"@ts-drp/node/creator-adoption-activate": resolve(
			REPOSITORY_ROOT,
			"packages/node/src/creator-adoption-activate.ts"
		),
		"@ts-drp/node/creator-adoption-commit": resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-commit.ts"),
	});
	const bundled = await build({
		alias: aliases,
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		platform: "browser",
		write: false,
	});
	const entry = bundled.outputFiles[0]?.text;
	if (entry === undefined) throw new TypeError("D.108d2 browser bundle is absent");
	const server: Server = createServer((request, response) => {
		const headers = {
			"cross-origin-embedder-policy": "require-corp",
			"cross-origin-opener-policy": "same-origin",
		};
		if (request.url === "/entry.js") {
			response.writeHead(200, { ...headers, "cache-control": "no-store", "content-type": "text/javascript" });
			response.end(entry);
			return;
		}
		if (request.url === "/" || request.url === "/index.html") {
			response.writeHead(200, { ...headers, "cache-control": "no-store", "content-type": "text/html" });
			response.end("<!doctype html><meta charset=utf-8><script type=module src=/entry.js></script>");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D.108d2 browser server did not bind");
	return Object.freeze({
		origin: `http://127.0.0.1:${address.port}`,
		close: async (): Promise<void> =>
			new Promise<void>((resolvePromise, reject) =>
				server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
			),
	});
}

type Carrier = Awaited<ReturnType<typeof window.phase6aCreatorSuccessorProduct.exportSuccessor>>;

let servers: readonly ProductBrowserServer[] = [];
let context: BrowserContext | undefined;
let creator: Page | undefined;
let established: Page | undefined;
let late: Page | undefined;
let invite = "";
let genesisRoomId = "";
let carrier: Carrier | undefined;

async function openRealm(
	page: Page,
	origin: string,
	selectedRealmId: string,
	pages: () => readonly Page[]
): Promise<void> {
	await page.exposeFunction("__phase6aProductRelayPost", async (packet: unknown) => {
		await Promise.all(
			pages().map(async (target) => {
				if (target === page || target.isClosed()) return;
				await target.evaluate((selected) => window.phase6aCreatorSuccessorProduct.deliver(selected as never), packet);
			})
		);
	});
	await page.goto(origin);
	await page.evaluate((realmId) => window.phase6aCreatorSuccessorProduct.boot(realmId), selectedRealmId);
}

async function snapshot(page: Page): Promise<Readonly<Record<string, unknown>>> {
	return page.evaluate(() => window.phase6aCreatorSuccessorProduct.snapshot());
}

async function waitForText(page: Page, text: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const selected = await snapshot(page);
				const accepted = selected.accepted as readonly Readonly<Record<string, unknown>>[];
				return accepted.some((message) => message.text === text);
			},
			{ timeout: 15_000 }
		)
		.toBe(true);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
	const contract = await contractLoad;
	sharedBrowserBehaviors = contract.D108D2_BROWSER_BEHAVIORS;
	isD108d2Authority = contract.isD108d2Authority;
	servers = Object.freeze(
		await Promise.all(
			["creator", "established", "late"].map(() =>
				startProductBrowserServer(
					new URL("./assets/phase-6a-creator-successor-product-entry.ts", import.meta.url).pathname
				)
			)
		)
	);
	context = await browser.newContext();
	creator = await context.newPage();
	established = await context.newPage();
	late = await context.newPage();
	const pages = (): readonly Page[] => [creator as Page, established as Page, late as Page];
	await Promise.all([
		openRealm(creator, servers[0]?.origin ?? "about:blank", "creator", pages),
		openRealm(established, servers[1]?.origin ?? "about:blank", "established", pages),
		openRealm(late, servers[2]?.origin ?? "about:blank", "late", pages),
	]);
});

test.afterAll(async () => {
	await Promise.allSettled(
		[creator, established, late].map((page) =>
			page?.isClosed() === false ? page.evaluate(() => window.phase6aCreatorSuccessorProduct.close()) : undefined
		)
	);
	await context?.close();
	await Promise.all(servers.map((server) => server.close()));
});

test("pins the exact successor product browser inventory", () => {
	expect(sharedBrowserBehaviors).toEqual(D108D2_BROWSER_BEHAVIORS);
	expect(D108D2_BROWSER_BEHAVIORS).toEqual([
		"hot creator adoption exposes oracle authority and issues through the replacement handle",
		"established peer cold reopen accepts the genuine epoch-one live operation",
		"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
	]);
});

test(D108D2_BROWSER_BEHAVIORS[0], async () => {
	if (creator === undefined || established === undefined) throw new TypeError("D.108d2 browser realms are absent");
	invite = await creator.evaluate((input) => window.phase6aCreatorSuccessorProduct.create(input), {
		channelName: CHANNEL_NAME,
		clientId: "alice",
		databaseName: DATABASES.creator,
	});
	await established.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "bob",
		databaseName: DATABASES.established,
		invite,
	});
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.send("epoch-zero"));
	await waitForText(established, "epoch-zero");
	const before = await snapshot(creator);
	genesisRoomId = String(before.roomId);
	expect(before).toMatchObject({ authority: null, ready: true, roomId: genesisRoomId });
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.adoptSuccessor());
	carrier = await creator.evaluate(
		(databaseName) => window.phase6aCreatorSuccessorProduct.exportSuccessor(databaseName),
		DATABASES.creator
	);
	const after = await snapshot(creator);
	expect(isD108d2Authority(after.authority)).toBe(true);
	expect(after.authority).toEqual(carrier.authority);
	expect(after.roomId).toBe(carrier.authority.anchorDigest);
	expect(after.roomId).not.toBe(genesisRoomId);
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.send("successor-hot"));
	await waitForText(creator, "successor-hot");
});

test(D108D2_BROWSER_BEHAVIORS[1], async () => {
	if (creator === undefined || established === undefined || carrier === undefined) {
		throw new TypeError("D.108d2 established-peer state is absent");
	}
	await established.evaluate(() => window.phase6aCreatorSuccessorProduct.close());
	await established.evaluate(
		({ carrier, source, target }) => window.phase6aCreatorSuccessorProduct.importSuccessor(carrier, source, target),
		{ carrier, source: DATABASES.creator, target: DATABASES.established }
	);
	await established.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "bob",
		databaseName: DATABASES.established,
		invite,
		successorSnapshotDeclaration: carrier.snapshotDeclaration,
	});
	const reopened = await snapshot(established);
	expect(reopened.authority).toEqual(carrier.authority);
	expect(reopened.roomId).toBe(carrier.authority.anchorDigest);
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.send("successor-live"));
	await waitForText(established, "successor-live");
});

test(D108D2_BROWSER_BEHAVIORS[2], async () => {
	if (creator === undefined || established === undefined || late === undefined || carrier === undefined) {
		throw new TypeError("D.108d2 late-peer state is absent");
	}
	await late.evaluate(
		({ carrier, source, target }) => window.phase6aCreatorSuccessorProduct.importSuccessor(carrier, source, target),
		{ carrier, source: DATABASES.creator, target: DATABASES.late }
	);
	const forgedDeclaration = structuredClone(carrier.snapshotDeclaration) as Readonly<Record<string, unknown>>;
	const forgedScope = {
		...(forgedDeclaration.scope as Readonly<Record<string, unknown>>),
		anchor: "f".repeat(64),
	};
	await expect(
		late.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
			channelName: CHANNEL_NAME,
			clientId: "carol",
			databaseName: DATABASES.late,
			invite,
			successorSnapshotDeclaration: { ...forgedDeclaration, scope: forgedScope },
		})
	).rejects.toThrow();
	expect(await snapshot(late)).toMatchObject({ authority: null, ready: false });
	await late.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "carol",
		databaseName: DATABASES.late,
		invite,
		successorSnapshotDeclaration: carrier.snapshotDeclaration,
	});
	await waitForText(late, "successor-live");
	const retained = await snapshot(late);
	expect(retained.authority).toEqual(carrier.authority);
	expect(retained.roomId).toBe(carrier.authority.anchorDigest);

	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.close());
	await creator.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "alice",
		databaseName: DATABASES.creator,
		invite,
		successorSnapshotDeclaration: carrier.snapshotDeclaration,
	});
	expect((await snapshot(creator)).authority).toEqual(carrier.authority);
	const audits = (await Promise.all(
		[creator, established, late].map((page) => page.evaluate(() => window.phase6aCreatorSuccessorProduct.relayAudit()))
	)) as unknown as readonly RelayAudit[];
	expect(audits.every(({ mismatch }) => mismatch === 0)).toBe(true);
	expect(audits.map(({ realmId }) => realmId)).toEqual(["creator", "established", "late"]);
	const outgoing = new Map<string, RelayMessageObservation>();
	for (const audit of audits) {
		expect(audit.outgoingMessages).toHaveLength(audit.outgoing);
		expect(audit.incomingMessages).toHaveLength(audit.incoming);
		for (const observation of audit.outgoingMessages) {
			expect(observation.sourceRealmId).toBe(audit.realmId);
			expect(observation.data).toBeInstanceOf(Uint8Array);
			expect(observation.data.byteLength).toBeGreaterThan(0);
			const key = `${observation.sourceRealmId}:${observation.sequence}`;
			expect(outgoing.has(key)).toBe(false);
			outgoing.set(key, observation);
		}
	}
	expect(outgoing.size).toBeGreaterThan(0);
	const incoming = audits.flatMap((audit) => audit.incomingMessages.map((observation) => ({ audit, observation })));
	expect(incoming.length).toBeGreaterThan(0);
	for (const { audit, observation } of incoming) {
		expect(observation.receiverRealmId).toBe(audit.realmId);
		expect(observation.sourceRealmId).not.toBe(audit.realmId);
		expect(observation.data).toBeInstanceOf(Uint8Array);
		expect(observation.data.byteLength).toBeGreaterThan(0);
		const sent = outgoing.get(`${observation.sourceRealmId}:${observation.sequence}`);
		expect(sent).toBeDefined();
		expect(Array.from(observation.data)).toEqual(Array.from(sent?.data ?? []));
		expect(observation.objectId).toBe(sent?.objectId);
		expect(observation.sender).toBe(sent?.sender);
		expect(observation.type).toBe(sent?.type);
	}
});
