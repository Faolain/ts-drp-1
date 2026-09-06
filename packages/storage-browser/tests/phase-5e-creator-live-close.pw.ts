import { expect, type Page, type Response, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");

function hasPackageExport(packagePath: string, subpath: string): boolean {
	const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, packagePath), "utf8")) as Readonly<{
		readonly exports?: Readonly<Record<string, unknown>>;
	}>;
	return Object.hasOwn(manifest.exports ?? {}, subpath);
}

function hasOrderedAlias(source: string, specific: string, bare: string): boolean {
	const specificIndex = source.indexOf(`"${specific}"`);
	const bareIndex = source.indexOf(`"${bare}"`);
	return specificIndex >= 0 && (bareIndex < 0 || specificIndex < bareIndex);
}

function greenReady(): boolean {
	if (
		!["packages/control-plane/src/creator-trust-advance.ts", "packages/node/src/creator-close.ts"].every((path) =>
			existsSync(resolve(REPOSITORY_ROOT, path))
		)
	)
		return false;
	if (
		!hasPackageExport("packages/control-plane/package.json", "./creator-trust-advance") ||
		!hasPackageExport("packages/node/package.json", "./creator-close")
	)
		return false;
	const vite = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
	return (
		hasOrderedAlias(vite, "@ts-drp/control-plane/creator-trust-advance", "@ts-drp/control-plane") &&
		hasOrderedAlias(vite, "@ts-drp/node/creator-close", "@ts-drp/node")
	);
}

const GREEN_READY = greenReady();

interface ModelRef {
	readonly byteLength: number;
	readonly digest: string;
}

function expectedCombinedClosure(
	input: Readonly<{
		current: readonly ModelRef[];
		currentTrustRef: ModelRef;
		proofRefs: readonly ModelRef[];
		retirementRef: ModelRef;
		successorTrustRef: ModelRef;
	}>
): readonly ModelRef[] {
	const retained = input.current.filter(({ digest }) => digest !== input.currentTrustRef.digest);
	if (retained.length !== input.current.length - 1) throw new TypeError("current trust ref must occur exactly once");
	return [...retained, input.successorTrustRef, ...input.proofRefs, input.retirementRef].sort((left, right) =>
		left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
	);
}

let server: Phase4cBrowserServer | undefined;

const FIXTURE_WAIT_MS = 5_000;
const INSPECTION_WAIT_MS = 2_000;
const TELEMETRY_ENTRY_LIMIT = 5;
const TELEMETRY_TEXT_LIMIT = 512;
const LIVE_CLOSE_API_FUNCTIONS = [
	"close",
	"create",
	"inspectDurableHead",
	"join",
	"sealEpoch",
	"send",
	"snapshot",
	"status",
] as const;

type LiveCloseApiState =
	| Readonly<{ kind: "absent" }>
	| Readonly<{ detail: string; kind: "inspection-failed" }>
	| Readonly<{ kind: "inspection-timeout" }>
	| Readonly<{ kind: "missing-functions"; missing: readonly string[] }>
	| Readonly<{ kind: "non-object"; valueType: string }>
	| Readonly<{ kind: "ready" }>;

interface FixtureTelemetry {
	readonly consoleErrors: string[];
	readonly pageErrors: string[];
	readonly requestFailures: Readonly<{ error: string; url: string }>[];
	readonly responses: Readonly<{ contentType: string; status: number; url: string }>[];
}

function boundedText(value: unknown): string {
	return String(value).slice(0, TELEMETRY_TEXT_LIMIT);
}

function recordBounded<T>(target: T[], value: T): void {
	if (target.length < TELEMETRY_ENTRY_LIMIT) target.push(value);
}

function requireServerOrigin(): string {
	if (server === undefined) throw new TypeError("phase-5e live-close server is unavailable");
	return server.origin;
}

function matchesExactUrl(response: Response, expected: string): boolean {
	return response.url() === expected;
}

async function inspectLiveCloseApi(page: Page): Promise<LiveCloseApiState> {
	return page.evaluate((functionNames) => {
		if (!Object.hasOwn(window, "phase5eCreatorLiveClose")) return { kind: "absent" } as const;
		const value: unknown = Reflect.get(window, "phase5eCreatorLiveClose");
		if (value === null || typeof value !== "object") {
			return { kind: "non-object", valueType: value === null ? "null" : typeof value } as const;
		}
		const missing = functionNames.filter((name) => typeof Reflect.get(value, name) !== "function");
		return missing.length === 0 ? ({ kind: "ready" } as const) : ({ kind: "missing-functions", missing } as const);
	}, LIVE_CLOSE_API_FUNCTIONS);
}

async function inspectLiveCloseApiBounded(page: Page): Promise<LiveCloseApiState> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			inspectLiveCloseApi(page).catch(
				(error: unknown): LiveCloseApiState => ({
					detail: boundedText(error),
					kind: "inspection-failed",
				})
			),
			new Promise<LiveCloseApiState>((resolvePromise) => {
				timer = setTimeout(() => resolvePromise({ kind: "inspection-timeout" }), INSPECTION_WAIT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function loadCreatorLiveCloseFixture(page: Page, origin: string): Promise<void> {
	const abortController = new AbortController();
	const telemetry: FixtureTelemetry = {
		consoleErrors: [],
		pageErrors: [],
		requestFailures: [],
		responses: [],
	};
	const documentUrl = `${origin}/`;
	const entryUrl = `${origin}/entry.js`;
	const onConsole = (message: { text(): string; type(): string }): void => {
		if (message.type() === "error") recordBounded(telemetry.consoleErrors, boundedText(message.text()));
	};
	const onPageError = (error: Error): void => recordBounded(telemetry.pageErrors, boundedText(error.message));
	const onRequestFailed = (request: { failure(): null | { errorText: string }; url(): string }): void => {
		if (request.url() !== documentUrl && request.url() !== entryUrl) return;
		recordBounded(telemetry.requestFailures, {
			error: boundedText(request.failure()?.errorText ?? "unknown request failure"),
			url: boundedText(request.url()),
		});
	};
	const onResponse = (response: Response): void => {
		if (response.url() !== documentUrl && response.url() !== entryUrl) return;
		recordBounded(telemetry.responses, {
			contentType: boundedText(response.headers()["content-type"] ?? ""),
			status: response.status(),
			url: boundedText(response.url()),
		});
	};
	page.on("console", onConsole);
	page.on("pageerror", onPageError);
	page.on("requestfailed", onRequestFailed);
	page.on("response", onResponse);

	try {
		const documentResponsePromise = page.waitForResponse((response) => matchesExactUrl(response, documentUrl), {
			signal: abortController.signal,
			timeout: FIXTURE_WAIT_MS,
		});
		const entryResponsePromise = page.waitForResponse((response) => matchesExactUrl(response, entryUrl), {
			signal: abortController.signal,
			timeout: FIXTURE_WAIT_MS,
		});
		const [documentResponse, entryResponse] = await Promise.all([
			documentResponsePromise,
			entryResponsePromise,
			page.goto(origin, { signal: abortController.signal, timeout: FIXTURE_WAIT_MS }),
		]);
		const documentContentType = documentResponse.headers()["content-type"] ?? "";
		if (!documentResponse.ok() || !documentContentType.startsWith("text/html")) {
			throw new TypeError("phase-5e live-close document response is invalid");
		}
		const entryContentType = entryResponse.headers()["content-type"] ?? "";
		if (!entryResponse.ok() || !entryContentType.startsWith("text/javascript")) {
			throw new TypeError("phase-5e live-close entry response is invalid");
		}
		await page.waitForFunction(
			(functionNames) => {
				const value: unknown = Reflect.get(window, "phase5eCreatorLiveClose");
				return (
					value !== null &&
					typeof value === "object" &&
					functionNames.every((name) => typeof Reflect.get(value, name) === "function")
				);
			},
			LIVE_CLOSE_API_FUNCTIONS,
			{ polling: 100, timeout: FIXTURE_WAIT_MS }
		);
		if (telemetry.pageErrors.length > 0 || telemetry.requestFailures.length > 0) {
			throw new TypeError("phase-5e live-close bootstrap emitted an error");
		}
	} catch (cause) {
		abortController.abort();
		const apiState = await inspectLiveCloseApiBounded(page);
		throw new Error(
			`phase-5e live-close fixture readiness failed: ${JSON.stringify({
				apiState,
				cause: boundedText(cause),
				causeStack: boundedText(cause instanceof Error ? cause.stack : cause),
				telemetry,
			})}`,
			{ cause }
		);
	} finally {
		abortController.abort();
		page.off("console", onConsole);
		page.off("pageerror", onPageError);
		page.off("requestfailed", onRequestFailed);
		page.off("response", onResponse);
	}
}

interface CreatorLiveCloseApi {
	close(): Promise<void>;
	create(input: Readonly<{ channelName: string; clientId: "alice"; databaseName: string }>): Promise<string>;
	inspectDurableHead(databaseName: string): Promise<
		Readonly<{
			generationId: string;
			references: readonly Readonly<{ byteLength: number; digest: string }>[];
			revision: number;
			trustRef: Readonly<{ byteLength: number; digest: string }>;
		}>
	>;
	join(
		input: Readonly<{ channelName: string; clientId: "bob" | "carol"; databaseName: string; invite: string }>
	): Promise<void>;
	sealEpoch(): Promise<
		Readonly<{
			closedVertexCount: number;
			commitQcRef: Readonly<{ byteLength: number; digest: string }>;
			currentTrustRef: Readonly<{ byteLength: number; digest: string }>;
			cutValueRef: Readonly<{ byteLength: number; digest: string }>;
			epoch: number;
			lifecycle: "successor-pending-adoption";
			ok: true;
			successorAnchorDigest: string;
			successorEpoch: number;
			successorTrustRef: Readonly<{ byteLength: number; digest: string }>;
		}>
	>;
	send(text: string): Promise<void>;
	snapshot(): Readonly<{ readonly accepted: readonly Readonly<{ readonly text: string }>[] }>;
	status(): Readonly<Record<string, unknown>>;
}

declare global {
	interface Window {
		readonly phase5eCreatorLiveClose: CreatorLiveCloseApi;
	}
}

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5e-creator-live-close-entry.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.107d live close owners are intentionally absent in RED");

test("reports bounded telemetry when the entry bootstrap fails", async ({ page }) => {
	const origin = requireServerOrigin();
	const entryUrl = `${origin}/entry.js`;
	await page.route(entryUrl, (route) => route.abort("failed"));
	try {
		let captured: unknown;
		try {
			await loadCreatorLiveCloseFixture(page, origin);
		} catch (error) {
			captured = error;
		}
		expect(captured).toBeInstanceOf(Error);
		const message = String(captured);
		const diagnostics = JSON.parse(message.slice(message.indexOf("{"))) as Readonly<{
			apiState: LiveCloseApiState;
			telemetry: FixtureTelemetry;
		}>;
		expect(diagnostics.telemetry.requestFailures).toEqual([
			expect.objectContaining({ error: expect.any(String), url: entryUrl }),
		]);
		expect(diagnostics.apiState).toEqual({ kind: "absent" });
	} finally {
		await page.unroute(entryUrl);
	}
});

test("closes a genuine non-empty creator room and terminalizes the old live handle", async ({ page }) => {
	await loadCreatorLiveCloseFixture(page, requireServerOrigin());
	const run = crypto.randomUUID();
	const databaseName = `phase5e-live-close-${run}`;
	const channelName = `phase5e-live-close-${run}`;
	const invite = await page.evaluate((input) => window.phase5eCreatorLiveClose.create(input), {
		channelName,
		clientId: "alice",
		databaseName,
	} as const);
	await page.evaluate(() => window.phase5eCreatorLiveClose.send("close me while live"));
	await expect
		.poll(() => page.evaluate(() => window.phase5eCreatorLiveClose.snapshot().accepted.map(({ text }) => text)))
		.toContain("close me while live");
	const beforeStatus = await page.evaluate(() => window.phase5eCreatorLiveClose.status());
	const before = await page.evaluate((name) => window.phase5eCreatorLiveClose.inspectDurableHead(name), databaseName);
	const sealed = await page.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch());
	const after = await page.evaluate((name) => window.phase5eCreatorLiveClose.inspectDurableHead(name), databaseName);

	expect(invite).toMatch(/^[0-9a-f]+$/u);
	expect(sealed).toMatchObject({
		epoch: 0,
		lifecycle: "successor-pending-adoption",
		ok: true,
		successorEpoch: 1,
	});
	expect(sealed.successorAnchorDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(sealed.closedVertexCount).toBeGreaterThan(0);
	expect(sealed.currentTrustRef).toEqual(before.trustRef);
	expect(after.revision).toBe(before.revision + 1);
	expect(after.generationId).not.toBe(before.generationId);
	expect(after.trustRef).toEqual(sealed.successorTrustRef);
	const knownDigests = new Set([
		...before.references.map(({ digest }) => digest),
		sealed.successorTrustRef.digest,
		sealed.cutValueRef.digest,
		sealed.commitQcRef.digest,
	]);
	const retirementRefs = after.references.filter(({ digest }) => !knownDigests.has(digest));
	expect(retirementRefs).toHaveLength(1);
	const retirementRef = retirementRefs[0];
	if (retirementRef === undefined) throw new TypeError("creator retirement ref is unavailable");
	expect(retirementRef.byteLength).toBeLessThanOrEqual(8192);
	expect(after.references).toEqual(
		expectedCombinedClosure({
			current: before.references,
			currentTrustRef: sealed.currentTrustRef,
			proofRefs: [sealed.cutValueRef, sealed.commitQcRef],
			retirementRef,
			successorTrustRef: sealed.successorTrustRef,
		})
	);

	const status = await page.evaluate(() => window.phase5eCreatorLiveClose.status());
	expect(beforeStatus).toEqual({
		closeAuthority: "available",
		continuity: "continuous",
		lifecycle: "active",
		trust: {
			byzantineFaultTolerant: false,
			kind: "creator-certified",
			quorum: 1,
			signerCount: 1,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant.",
		},
	});
	expect(status).toEqual({
		closeAuthority: "unavailable",
		continuity: "continuous",
		lifecycle: "successor-pending-adoption",
		trust: {
			byzantineFaultTolerant: false,
			kind: "creator-certified",
			quorum: 1,
			signerCount: 1,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant.",
		},
	});
	await expect(page.evaluate(() => window.phase5eCreatorLiveClose.send("too late"))).rejects.toThrow();
	await expect(page.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).rejects.toThrow();
	await page.evaluate(() => window.phase5eCreatorLiveClose.close());
});

test("does not let a connected joined peer claim creator close authority", async ({ context }) => {
	const run = crypto.randomUUID();
	const channelName = `phase5e-live-peer-${run}`;
	const creator = await context.newPage();
	const peer = await context.newPage();
	const latePeer = await context.newPage();
	try {
		const origin = requireServerOrigin();
		await Promise.all([
			loadCreatorLiveCloseFixture(creator, origin),
			loadCreatorLiveCloseFixture(peer, origin),
			loadCreatorLiveCloseFixture(latePeer, origin),
		]);
		const invite = await creator.evaluate((input) => window.phase5eCreatorLiveClose.create(input), {
			channelName,
			clientId: "alice",
			databaseName: `phase5e-live-creator-${run}`,
		} as const);
		await peer.evaluate((input) => window.phase5eCreatorLiveClose.join(input), {
			channelName,
			clientId: "carol",
			databaseName: `phase5e-live-peer-${run}`,
			invite,
		} as const);
		await creator.evaluate(() => window.phase5eCreatorLiveClose.send("peer must receive this"));
		await expect
			.poll(() => peer.evaluate(() => window.phase5eCreatorLiveClose.snapshot().accepted.map(({ text }) => text)))
			.toContain("peer must receive this");
		expect(await peer.evaluate(() => window.phase5eCreatorLiveClose.status())).toMatchObject({
			closeAuthority: "unavailable",
			lifecycle: "active",
		});
		await expect(peer.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).rejects.toThrow(
			/creator close authority/iu
		);
		expect(await creator.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).toMatchObject({
			lifecycle: "successor-pending-adoption",
			ok: true,
		});
		await latePeer.evaluate((input) => window.phase5eCreatorLiveClose.join(input), {
			channelName,
			clientId: "bob",
			databaseName: `phase5e-live-late-peer-${run}`,
			invite,
		} as const);
		await expect
			.poll(() => latePeer.evaluate(() => window.phase5eCreatorLiveClose.snapshot().accepted.map(({ text }) => text)))
			.toContain("peer must receive this");
		await creator.evaluate(() => window.phase5eCreatorLiveClose.close());
		await peer.evaluate(() => window.phase5eCreatorLiveClose.close());
		await latePeer.evaluate(() => window.phase5eCreatorLiveClose.close());
	} finally {
		await Promise.all([creator.close(), peer.close(), latePeer.close()]);
	}
});
