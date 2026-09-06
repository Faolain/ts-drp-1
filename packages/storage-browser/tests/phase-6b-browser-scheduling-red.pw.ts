import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const INTERNAL_DIRECTORY = resolve(PACKAGE_DIRECTORY, "src/internal");
const PRIMARY_DISPATCH = resolve(INTERNAL_DIRECTORY, "primary-dispatch.ts");
const D109E_READY = existsSync(PRIMARY_DISPATCH);
const PRODUCTION_OWNERS = Object.freeze([
	"src/internal/primary-dispatch.ts",
	"src/internal/seal-vote-dispatch.ts",
	"src/internal/ahe-reclamation.ts",
	"src/internal/idb-adapter.ts",
]);
const TEST_OWNERS = Object.freeze([
	"tests/assets/phase-6b-ahe-reclamation-entry.ts",
	"tests/phase-6b-browser-scheduling-red.pw.ts",
	"playwright.phase-6b-browser-scheduling.config.ts",
]);
const MODES = Object.freeze([
	"granted",
	"native",
	"off",
	"absent",
	"non-callable",
	"throw",
	"reject",
	"abort",
	"unavailable",
	"timeout",
	"stale-late",
]);

type SchedulingFixture = Readonly<{
	prepareSchedulingScenario(databaseName: string): Promise<Record<string, unknown>>;
	runChangedPreconditionScenario(databaseName: string): Promise<Record<string, unknown>>;
	runLifecycleScenario(databaseName: string, event: "close" | "versionchange"): Promise<Record<string, unknown>>;
	runPreparedCleanup(
		databaseName: string,
		input: Record<string, unknown>,
		mode: string
	): Promise<Record<string, unknown>>;
	runSchedulingMode(databaseName: string, mode: string): Promise<Record<string, unknown>>;
}>;

let origin = "";
let server: Server;
const tokens = new Set<string>();

test.beforeAll(async () => {
	const directory = process.env.PHASE_6B_AHE_RECLAMATION_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D109E_BROWSER_ASSETS_MISSING");
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const [, token, asset] = url.pathname.split("/");
		if (!tokens.has(token ?? "") || !/^phase-6b-ahe-reclamation\.(?:html|js)$/u.test(asset ?? "")) {
			response.writeHead(404).end();
			return;
		}
		try {
			response
				.writeHead(200, {
					"content-type": asset?.endsWith(".js") === true ? "text/javascript" : "text/html",
					"cross-origin-embedder-policy": "require-corp",
					"cross-origin-opener-policy": "same-origin",
				})
				.end(readFileSync(join(directory, asset as string)));
		} catch {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D109E_BROWSER_SERVER_BIND_FAILED");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise, reject) =>
		server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
	);
});

function transition(): Readonly<{ readonly token: string; readonly url: string }> {
	const token = crypto.randomUUID();
	tokens.add(token);
	return Object.freeze({ token, url: `${origin}/${token}/phase-6b-ahe-reclamation.html` });
}

function exactDeletedPrefix(): readonly string[] {
	return ["1".padStart(64, "0"), "2".padStart(64, "0")];
}

test("freezes the D.109e internal owner and source-shape boundary", () => {
	expect(PRODUCTION_OWNERS).toEqual([
		"src/internal/primary-dispatch.ts",
		"src/internal/seal-vote-dispatch.ts",
		"src/internal/ahe-reclamation.ts",
		"src/internal/idb-adapter.ts",
	]);
	expect(TEST_OWNERS).toEqual([
		"tests/assets/phase-6b-ahe-reclamation-entry.ts",
		"tests/phase-6b-browser-scheduling-red.pw.ts",
		"playwright.phase-6b-browser-scheduling.config.ts",
	]);
	for (const owner of [...PRODUCTION_OWNERS.slice(1), ...TEST_OWNERS]) {
		expect(existsSync(resolve(PACKAGE_DIRECTORY, owner)), `D109E_OWNER_MISSING:${owner}`).toBe(true);
	}
	const sources = new Map(
		readdirSync(INTERNAL_DIRECTORY)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => [name, readFileSync(resolve(INTERNAL_DIRECTORY, name), "utf8")])
	);
	const runtimeLockOwners = [...sources]
		.filter(([, source]) => source.includes('Reflect.get(navigator, "locks")'))
		.map(([name]) => name);
	const seal = sources.get("seal-vote-dispatch.ts") ?? "";
	const ahe = sources.get("ahe-reclamation.ts") ?? "";
	if (!D109E_READY) {
		expect(runtimeLockOwners).toEqual(["seal-vote-dispatch.ts"]);
		expect(seal).toContain("const LOCK_TIMEOUT_MILLISECONDS = 250;");
		expect(seal).toContain('{ ifAvailable: true, mode: "exclusive" }');
		expect(ahe).not.toContain("runInternalPrimaryDispatch");
		return;
	}
	const primary = sources.get("primary-dispatch.ts") ?? "";
	expect(runtimeLockOwners).toEqual(["primary-dispatch.ts"]);
	expect(primary.match(/const LOCK_TIMEOUT_MILLISECONDS = 250;/gu)).toHaveLength(1);
	expect(primary.match(/\{ ifAvailable: true, mode: "exclusive" \}/gu)).toHaveLength(1);
	expect(primary).toContain("new TextEncoder().encode(databaseName).length");
	expect(seal).toContain("runInternalPrimaryDispatch");
	expect(seal).toContain("seal-vote:v2");
	expect(seal).not.toContain("LOCK_TIMEOUT_MILLISECONDS");
	expect(ahe).toContain("runInternalPrimaryDispatch");
	expect(ahe).toContain("ahe-reclamation:v1");
	const captureIndex = ahe.indexOf("captureAheReclamationInput(input)");
	const dispatchIndex = ahe.indexOf("runInternalPrimaryDispatch", captureIndex);
	const classifyIndex = ahe.indexOf("classifyAheReclamation", dispatchIndex);
	expect(captureIndex).toBeGreaterThan(-1);
	expect(dispatchIndex).toBeGreaterThan(captureIndex);
	expect(classifyIndex).toBeGreaterThan(dispatchIndex);
	expect(readFileSync(resolve(PACKAGE_DIRECTORY, "package.json"), "utf8")).not.toContain("primary-dispatch");
});

test("[RED readiness] requires the shared browser primary dispatcher", () => {
	const missing = PRODUCTION_OWNERS.filter((owner) => !existsSync(resolve(PACKAGE_DIRECTORY, owner)));
	expect({ missing, ready: D109E_READY }, "D109E_PRIMARY_DISPATCH_MISSING").toEqual({ missing: [], ready: true });
});

test("runs the genuine cleanup once through every granted and unelected scheduling mode", async ({ page }) => {
	test.skip(!D109E_READY, "D109E_PRIMARY_DISPATCH_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const results = await page.evaluate(async (modes) => {
			const selected = (globalThis as unknown as { phase6bAheReclamation: SchedulingFixture }).phase6bAheReclamation;
			const values = [];
			for (const mode of modes) {
				const databaseName = `d109e-${mode}-${crypto.randomUUID()}`;
				values.push({ databaseName, mode, value: await selected.runSchedulingMode(databaseName, mode) });
			}
			return values;
		}, MODES);
		for (const { databaseName, mode, value } of results) {
			expect(value.receipt).toMatchObject({ deletedGenerationIds: exactDeletedPrefix() });
			expect(value.transactionEntries, `D109E_TASK_ENTRY_COUNT:${mode}`).toBe(1);
			if (mode === "granted") {
				const expectedName = `ts-drp:ahe-reclamation:v1:${new TextEncoder().encode(databaseName).length}:${databaseName}`;
				expect(value.names).toEqual([expectedName]);
			}
			expect(typeof value.nativeAvailable).toBe("boolean");
		}
	} finally {
		tokens.delete(issued.token);
	}
});

test("serializes two same-context tabs into one delete and one replay", async ({ context, page }) => {
	test.skip(!D109E_READY, "D109E_PRIMARY_DISPATCH_MISSING");
	const first = transition();
	const second = transition();
	const peer = await context.newPage();
	try {
		await Promise.all([page.goto(first.url, { waitUntil: "load" }), peer.goto(second.url, { waitUntil: "load" })]);
		const databaseName = `d109e-tabs-${crypto.randomUUID()}`;
		const input = await page.evaluate(
			(name) =>
				(
					globalThis as unknown as { phase6bAheReclamation: SchedulingFixture }
				).phase6bAheReclamation.prepareSchedulingScenario(name),
			databaseName
		);
		const values = await Promise.all([
			page.evaluate(
				([name, request]) =>
					(
						globalThis as unknown as { phase6bAheReclamation: SchedulingFixture }
					).phase6bAheReclamation.runPreparedCleanup(name, request, "native"),
				[databaseName, input] as const
			),
			peer.evaluate(
				([name, request]) =>
					(
						globalThis as unknown as { phase6bAheReclamation: SchedulingFixture }
					).phase6bAheReclamation.runPreparedCleanup(name, request, "native"),
				[databaseName, input] as const
			),
		]);
		expect(
			values
				.map((value) => (value.receipt as { deletedGenerationIds: readonly string[] }).deletedGenerationIds.length)
				.sort()
		).toEqual([0, 2]);
	} finally {
		await peer.close();
		tokens.delete(first.token);
		tokens.delete(second.token);
	}
});

test("refuses close and versionchange before grant, then permits successor takeover", async ({ page }) => {
	test.skip(!D109E_READY, "D109E_PRIMARY_DISPATCH_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		for (const event of ["close", "versionchange"] as const) {
			const value = await page.evaluate(
				([databaseName, lifecycleEvent]) =>
					(
						globalThis as unknown as { phase6bAheReclamation: SchedulingFixture }
					).phase6bAheReclamation.runLifecycleScenario(databaseName, lifecycleEvent),
				[`d109e-${event}-${crypto.randomUUID()}`, event] as const
			);
			expect(value).toMatchObject({
				code: "AHE_RECLAMATION_STORE_CLOSED",
				transactionEntries: 0,
				unchangedBeforeTakeover: true,
			});
			expect(value.receipt).toMatchObject({ deletedGenerationIds: exactDeletedPrefix() });
		}
	} finally {
		tokens.delete(issued.token);
	}
});

test("rechecks a lawful generation-six head change after delayed grant", async ({ page }) => {
	test.skip(!D109E_READY, "D109E_PRIMARY_DISPATCH_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const value = await page.evaluate(
			(databaseName) =>
				(
					globalThis as unknown as { phase6bAheReclamation: SchedulingFixture }
				).phase6bAheReclamation.runChangedPreconditionScenario(databaseName),
			`d109e-changed-${crypto.randomUUID()}`
		);
		expect(value).toMatchObject({
			advanced: { generationId: "6".padStart(64, "0"), revision: 6 },
			code: "AHE_RECLAMATION_RETRY_REQUIRED",
			imageUnchanged: true,
			readBack: { generationId: "6".padStart(64, "0"), revision: 6 },
			transactionEntries: 0,
		});
	} finally {
		tokens.delete(issued.token);
	}
});
