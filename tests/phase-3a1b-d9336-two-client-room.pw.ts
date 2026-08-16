import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ChatSnapshot {
	readonly accepted: readonly Readonly<{
		readonly author: string;
		readonly digest: string;
		readonly text: string;
	}>[];
	readonly acceptedOperationDigest: string;
	readonly durableTranscriptDigest: string;
	readonly ready: boolean;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." | "";
}

declare global {
	interface Window {
		readonly d9336V3Chat: Readonly<{
			create(
				input: Readonly<{
					readonly channelName: string;
					readonly clientId: "alice";
					readonly databaseName: string;
				}>
			): Promise<string>;
			join(
				input: Readonly<{
					readonly channelName: string;
					readonly clientId: "alice" | "bob";
					readonly databaseName: string;
					readonly invite: string;
				}>
			): Promise<void>;
			close(): Promise<void>;
			send(text: string): Promise<void>;
			snapshot(): ChatSnapshot;
		}>;
	}
}

const PRODUCTION = resolve("examples/v3-chat/src/index.ts");
const DIGEST = /^[0-9a-f]{64}$/u;
let directory = "";
let source = "";
let server: Server | undefined;
let origin = "";

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "d9336-v3-chat-"));
	if (!existsSync(PRODUCTION)) {
		source = `Object.defineProperty(globalThis,"d9336V3Chat",{value:Object.freeze({
			create:async()=>{throw new Error("D9336_V3_CHAT_ABSENT")},
			join:async()=>{throw new Error("D9336_V3_CHAT_ABSENT")},
			close:async()=>undefined,
			send:async()=>{throw new Error("D9336_V3_CHAT_ABSENT")},
			snapshot:()=>Object.freeze({ready:false,accepted:[],roomId:"",acceptedOperationDigest:"",durableTranscriptDigest:""})
		})});`;
	} else {
		const output = join(directory, "v3-chat.mjs");
		await build({
			bundle: true,
			entryPoints: [PRODUCTION],
			format: "esm",
			logLevel: "silent",
			outfile: output,
			platform: "browser",
			target: "es2022",
		});
		source = readFileSync(output, "utf8");
	}
	server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<!doctype html><html><body><main id=app></main></body></html>");
	});
	await new Promise<void>((resolvePromise, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new TypeError("browser fixture did not bind");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()) ?? resolvePromise());
	if (directory !== "") rmSync(directory, { force: true, recursive: true });
});

async function install(page: Page): Promise<void> {
	await page.goto(origin);
	await page.addScriptTag({ content: source, type: "module" });
	await page.waitForFunction(() => "d9336V3Chat" in globalThis);
}

async function snapshot(page: Page): Promise<ChatSnapshot> {
	return page.evaluate(() => window.d9336V3Chat.snapshot());
}

test("two isolated clients join one v3 room and observe the same durable transcript", async ({ context }) => {
	const alice = await context.newPage();
	const bob = await context.newPage();
	const run = crypto.randomUUID();
	try {
		await Promise.all([install(alice), install(bob)]);
		const channelName = `d9336-room-${run}`;
		const invite = await alice.evaluate((input) => window.d9336V3Chat.create(input), {
			channelName,
			clientId: "alice",
			databaseName: `d9336-alice-${run}`,
		} as const);
		expect(invite).toMatch(/^[0-9a-f]+$/u);
		await bob.evaluate((input) => window.d9336V3Chat.join(input), {
			channelName: `d9336-room-${run}`,
			clientId: "bob",
			databaseName: `d9336-bob-${run}`,
			invite,
		} as const);
		await expect(snapshot(alice)).resolves.toMatchObject({
			accepted: [],
			ready: true,
			trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
		});
		await expect(snapshot(bob)).resolves.toMatchObject({
			accepted: [],
			ready: true,
			trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
		});

		await alice.evaluate(() => window.d9336V3Chat.send("hello from alice"));
		await expect.poll(async () => (await snapshot(bob)).accepted.map(({ text }) => text)).toEqual(["hello from alice"]);
		await bob.evaluate(() => window.d9336V3Chat.send("hello from bob"));
		await expect.poll(async () => (await snapshot(alice)).accepted.length).toBe(2);
		await expect.poll(async () => (await snapshot(bob)).accepted.length).toBe(2);

		const [aliceState, bobState] = await Promise.all([snapshot(alice), snapshot(bob)]);
		expect(aliceState.roomId).toBe(bobState.roomId);
		expect(aliceState.accepted.map(({ text }) => text)).toEqual(["hello from alice", "hello from bob"]);
		expect(bobState.accepted).toEqual(aliceState.accepted);
		expect(new Set(aliceState.accepted.map(({ author }) => author)).size).toBe(2);
		expect(aliceState.acceptedOperationDigest).toBe(bobState.acceptedOperationDigest);
		expect(aliceState.durableTranscriptDigest).toBe(bobState.durableTranscriptDigest);
		expect(aliceState.acceptedOperationDigest).toMatch(DIGEST);
		expect(aliceState.durableTranscriptDigest).toMatch(DIGEST);
	} finally {
		await Promise.allSettled([
			alice.evaluate(() => window.d9336V3Chat.close()),
			bob.evaluate(() => window.d9336V3Chat.close()),
		]);
		await Promise.all([alice.close(), bob.close()]);
	}
});

test("a client recovers its durable transcript before rejoining live exchange", async ({ context }) => {
	const alice = await context.newPage();
	const bob = await context.newPage();
	const run = crypto.randomUUID();
	const channelName = `d9336-reconnect-${run}`;
	const aliceInput = {
		channelName,
		clientId: "alice",
		databaseName: `d9336-reconnect-alice-${run}`,
	} as const;
	const bobInput = {
		channelName,
		clientId: "bob",
		databaseName: `d9336-reconnect-bob-${run}`,
	};
	try {
		await Promise.all([install(alice), install(bob)]);
		const invite = await alice.evaluate((input) => window.d9336V3Chat.create(input), aliceInput);
		const joiningBobInput = { ...bobInput, invite } as const;
		await bob.evaluate((input) => window.d9336V3Chat.join(input), joiningBobInput);

		await alice.evaluate(() => window.d9336V3Chat.send("before reconnect from alice"));
		await expect.poll(async () => (await snapshot(bob)).accepted.length).toBe(1);
		await bob.evaluate(() => window.d9336V3Chat.send("before reconnect from bob"));
		await expect.poll(async () => (await snapshot(alice)).accepted.length).toBe(2);
		await expect.poll(async () => (await snapshot(bob)).accepted.length).toBe(2);

		const durableBeforeClose = await snapshot(bob);
		await bob.evaluate(() => window.d9336V3Chat.close());
		await bob.evaluate((input) => window.d9336V3Chat.join(input), joiningBobInput);
		const recoveredBeforeExchange = await snapshot(bob);
		expect(recoveredBeforeExchange.ready).toBe(true);
		expect(recoveredBeforeExchange.trustStatus).toBe("Creator-trusted; not Byzantine-fault-tolerant.");
		expect(recoveredBeforeExchange.accepted).toEqual(durableBeforeClose.accepted);
		expect(recoveredBeforeExchange.acceptedOperationDigest).toBe(durableBeforeClose.acceptedOperationDigest);
		expect(recoveredBeforeExchange.durableTranscriptDigest).toBe(durableBeforeClose.durableTranscriptDigest);

		await bob.evaluate(() => window.d9336V3Chat.send("after reconnect from bob"));
		await expect.poll(async () => (await snapshot(alice)).accepted.length).toBe(3);
		await expect.poll(async () => (await snapshot(bob)).accepted.length).toBe(3);

		const [aliceState, bobState] = await Promise.all([snapshot(alice), snapshot(bob)]);
		expect(bobState.accepted).toEqual(aliceState.accepted);
		expect(bobState.accepted.map(({ text }) => text)).toEqual([
			"before reconnect from alice",
			"before reconnect from bob",
			"after reconnect from bob",
		]);
		expect(bobState.acceptedOperationDigest).toBe(aliceState.acceptedOperationDigest);
		expect(bobState.durableTranscriptDigest).toBe(aliceState.durableTranscriptDigest);
		expect(bobState.acceptedOperationDigest).toMatch(DIGEST);
		expect(bobState.durableTranscriptDigest).toMatch(DIGEST);
	} finally {
		await Promise.allSettled([
			alice.evaluate(() => window.d9336V3Chat.close()),
			bob.evaluate(() => window.d9336V3Chat.close()),
		]);
		await Promise.all([alice.close(), bob.close()]);
	}
});

test("a joiner rejects a modified creator invite before becoming ready", async ({ context }) => {
	const alice = await context.newPage();
	const bob = await context.newPage();
	const run = crypto.randomUUID();
	try {
		await Promise.all([install(alice), install(bob)]);
		const invite = await alice.evaluate((input) => window.d9336V3Chat.create(input), {
			channelName: `d9336-reject-${run}`,
			clientId: "alice",
			databaseName: `d9336-reject-alice-${run}`,
		} as const);
		const final = invite.at(-1);
		if (final === undefined) throw new TypeError("creator invite is empty");
		const modifiedInvite = `${invite.slice(0, -1)}${final === "0" ? "1" : "0"}`;
		await expect(
			bob.evaluate((input) => window.d9336V3Chat.join(input), {
				channelName: `d9336-reject-${run}`,
				clientId: "bob",
				databaseName: `d9336-reject-bob-${run}`,
				invite: modifiedInvite,
			} as const)
		).rejects.toThrow();
		await expect(snapshot(bob)).resolves.toMatchObject({ accepted: [], ready: false, trustStatus: "" });
	} finally {
		await Promise.allSettled([
			alice.evaluate(() => window.d9336V3Chat.close()),
			bob.evaluate(() => window.d9336V3Chat.close()),
		]);
		await Promise.all([alice.close(), bob.close()]);
	}
});
