import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The v3-chat demo rolls its own rooms over (examples/v3-chat/src/rollover.ts) and its members
// follow by the shared successor delivery (examples/v3-room successor-delivery) on the demo's
// channel: the creator announces each adopted successor, members install it, and a member that
// was closed fetches the latest offer when it reopens. The room signs the demo's exported
// profile (examples/v3-chat/src/profile.ts).

const ENTRY = resolve(import.meta.dirname, "fixtures/v3-chat-rollover/entry.ts");
const OFFER_MAX_BYTES = 120 * 1024;
const FOLLOW_MS = 60_000;

type Snapshot = Readonly<{
	accepted: readonly Readonly<{ text: string }>[];
	authority: Readonly<{ epoch: number; profileId: string }> | null;
	ready: boolean;
}>;
type DeliveryStats = Readonly<{
	announced: number;
	answered: number;
	requested: number;
	installed: number;
	refused: number;
	oversize: number;
	malformed: number;
	largestOfferBytes: number;
	lastError: string | undefined;
}>;
type Rollover = Readonly<{
	policy: Readonly<{ epoch: number; rollovers: number; status: Readonly<{ state: string }> }> | null;
	delivery: DeliveryStats | null;
}>;

declare global {
	interface Window {
		readonly v3ChatRollover: Readonly<{
			create(input: Readonly<{ channelName: string; databaseName: string }>): Promise<string>;
			join(
				input: Readonly<{ channelName: string; clientId: string; databaseName: string; invite: string }>,
				kind: "create" | "reopen"
			): Promise<void>;
			send(text: string): Promise<void>;
			snapshot(): Snapshot;
			rollover(): Rollover;
			close(): Promise<void>;
		}>;
	}
}

let directory = "";
let source = "";
let server: Server | undefined;
let origin = "";

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "v3-chat-rollover-"));
	const output = join(directory, "v3-chat-rollover.mjs");
	await build({
		bundle: true,
		entryPoints: [ENTRY],
		format: "esm",
		logLevel: "silent",
		outfile: output,
		platform: "browser",
		target: "es2022",
	});
	source = readFileSync(output, "utf8");
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
	await page.waitForFunction(() => "v3ChatRollover" in globalThis);
}

const snapshot = (page: Page): Promise<Snapshot> => page.evaluate(() => window.v3ChatRollover.snapshot());
const rollover = (page: Page): Promise<Rollover> => page.evaluate(() => window.v3ChatRollover.rollover());
const epochOf = async (page: Page): Promise<number> => (await snapshot(page)).authority?.epoch ?? 0;
const texts = async (page: Page): Promise<readonly string[]> => (await snapshot(page)).accepted.map(({ text }) => text);

/**
 * Alice sends messages, one at a time, until her room has adopted `target` epochs.
 * @param alice - The creator's page.
 * @param target - The epoch to reach.
 * @param label - Message prefix.
 * @returns The texts sent.
 */
async function sendUntil(alice: Page, target: number, label: string): Promise<string[]> {
	const sent: string[] = [];
	for (let index = 0; (await epochOf(alice)) < target; index++) {
		if (index >= 20 * target) throw new Error(`alice reached epoch ${await epochOf(alice)} of ${target}`);
		const text = `${label}-${index}`;
		await alice.evaluate((value) => window.v3ChatRollover.send(value), text);
		sent.push(text);
	}
	return sent;
}

test("members follow the demo's own rollovers, and a closed member catches up when it reopens", async ({ context }) => {
	test.setTimeout(420_000);
	const [alice, bob, carol] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
	const run = crypto.randomUUID();
	const channelName = `v3-chat-rollover-${run}`;
	const input = (clientId: string) => ({ channelName, clientId, databaseName: `v3-chat-rollover-${clientId}-${run}` });
	try {
		await Promise.all([install(alice), install(bob), install(carol)]);
		const invite = await alice.evaluate((value) => window.v3ChatRollover.create(value), input("alice"));
		await bob.evaluate(([value, kind]) => window.v3ChatRollover.join(value, kind), [
			{ ...input("bob"), invite },
			"create",
		] as const);
		await carol.evaluate(([value, kind]) => window.v3ChatRollover.join(value, kind), [
			{ ...input("carol"), invite },
			"create",
		] as const);

		// Three rollovers by the creator's budget; both members install each successor.
		await sendUntil(alice, 3, "first");
		const first = await epochOf(alice);
		await expect.poll(() => epochOf(bob), { timeout: FOLLOW_MS }).toBe(first);
		await expect.poll(() => epochOf(carol), { timeout: FOLLOW_MS }).toBe(first);
		expect((await snapshot(alice)).authority?.profileId).toBe("creator-trusted-settlement-v1");
		expect((await snapshot(bob)).authority?.profileId).toBe("creator-trusted-settlement-v1");
		// A Writer keeps writing in the new epoch.
		await bob.evaluate(() => window.v3ChatRollover.send("bob-after-rollover"));
		await expect.poll(() => texts(alice), { timeout: FOLLOW_MS }).toContain("bob-after-rollover");

		// Bob is closed for two more rollovers, then reopens and fetches the latest offer.
		await bob.evaluate(() => window.v3ChatRollover.close());
		await sendUntil(alice, first + 2, "offline");
		const second = await epochOf(alice);
		await expect.poll(() => epochOf(carol), { timeout: FOLLOW_MS }).toBe(second);
		await bob.evaluate(([value, kind]) => window.v3ChatRollover.join(value, kind), [
			{ ...input("bob"), invite },
			"reopen",
		] as const);
		await expect.poll(() => epochOf(bob), { timeout: FOLLOW_MS }).toBe(await epochOf(alice));
		await bob.evaluate(() => window.v3ChatRollover.send("bob-after-reopen"));
		await expect.poll(() => texts(alice), { timeout: FOLLOW_MS }).toContain("bob-after-reopen");
		await expect.poll(() => texts(bob), { timeout: FOLLOW_MS }).toEqual(await texts(alice));
		await expect.poll(() => texts(carol), { timeout: FOLLOW_MS }).toEqual(await texts(alice));

		const [creator, reopened, member] = await Promise.all([rollover(alice), rollover(bob), rollover(carol)]);
		process.stdout.write(
			`V3_CHAT_ROLLOVER epoch=${await epochOf(alice)} creator=${JSON.stringify(creator)} bob=${JSON.stringify(reopened)} carol=${JSON.stringify(member)}\n`
		);
		expect(creator.policy?.rollovers).toBeGreaterThanOrEqual(5);
		expect(creator.delivery?.announced).toBeGreaterThan(0);
		expect(creator.delivery?.largestOfferBytes).toBeGreaterThan(0);
		expect(creator.delivery?.largestOfferBytes).toBeLessThanOrEqual(OFFER_MAX_BYTES);
		// Bob's reopened delivery installed what it missed; Carol installed every successor.
		expect(reopened.delivery?.installed).toBeGreaterThanOrEqual(1);
		expect(member.delivery?.installed).toBeGreaterThanOrEqual(await epochOf(alice));
		for (const stats of [creator.delivery, reopened.delivery, member.delivery])
			expect(stats).toMatchObject({ oversize: 0, malformed: 0 });
	} finally {
		await Promise.allSettled([alice, bob, carol].map((page) => page.evaluate(() => window.v3ChatRollover.close())));
		await Promise.all([alice.close(), bob.close(), carol.close()]);
	}
});
