import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const D108D2_BROWSER_BEHAVIORS = Object.freeze([
	"hot creator adoption exposes oracle authority and issues through the replacement handle",
	"established peer cold reopen accepts the genuine epoch-one live operation",
	"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
] as const);
const D108E2B_BROWSER_BEHAVIORS = Object.freeze([
	"concurrent adoption shares one success and one underlying transition",
	"concurrent adoption shares one real verification failure",
	"close joins a paused adoption before releasing lifetime ownership",
	"predecessor deactivation failure cleans the replacement before escaping",
] as const);
const contractLoad = import(
	pathToFileURL(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts")).href
) as Promise<
	Readonly<{
		readonly D108D2_BROWSER_BEHAVIORS: readonly [string, string, string];
		readonly D108E2B_BROWSER_BEHAVIORS: readonly [string, string, string, string];
		isD108d2Authority(value: unknown): boolean;
	}>
>;
let sharedBrowserBehaviors: readonly string[] = [];
let sharedLifetimeBehaviors: readonly string[] = [];
let isD108d2Authority: (value: unknown) => boolean = () => false;
const DATABASES = Object.freeze({ creator: "d108d2-creator", established: "d108d2-established", late: "d108d2-late" });
const CHANNEL_NAME = "d108d2-successor-product";

function lifetimeInstrumentationPlugin(): Plugin {
	const v3Live = resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts");
	const creatorClose = resolve(REPOSITORY_ROOT, "packages/node/src/creator-close.ts");
	const creatorAdoption = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts");
	const creatorAdoptionCommit = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-commit.ts");
	const creatorAdoptionActivate = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-activate.ts");
	const shared = `
const stateSymbol = Symbol.for("ts-drp/d108e2b/lifetime-state");
const planeMapSymbol = Symbol.for("ts-drp/d108e2b/instrumented-planes");
function createState() {
  const state = {
    activationCount: 0,
    commitCount: 0,
    pauseVerification: false,
    predecessorDeactivateCount: 0,
    rejectPredecessorDeactivate: false,
    releaseVerification: undefined,
    replacementDeactivateCount: 0,
    replacementDeactivateCompletedCount: 0,
    replacementPlanes: new Set(),
    verificationCount: 0,
    verificationGate: Promise.resolve(),
  };
  const configure = (input) => {
    state.activationCount = 0;
    state.commitCount = 0;
    state.pauseVerification = input.pauseVerification === true;
    state.predecessorDeactivateCount = 0;
    state.rejectPredecessorDeactivate = input.rejectPredecessorDeactivate === true;
    state.replacementDeactivateCount = 0;
    state.replacementDeactivateCompletedCount = 0;
    state.verificationCount = 0;
    state.verificationGate = state.pauseVerification
      ? new Promise((resolve) => { state.releaseVerification = resolve; })
      : Promise.resolve();
    if (!state.pauseVerification) state.releaseVerification = undefined;
  };
  Object.defineProperty(globalThis, "__d108e2bLifetimeInstrumentation", {
    configurable: false,
    value: Object.freeze({
      cleanupReplacements: async () => {
        await Promise.allSettled(Array.from(state.replacementPlanes, (plane) => plane.deactivate()));
      },
      configure,
      releaseVerification: () => {
        state.pauseVerification = false;
        state.releaseVerification?.();
        state.releaseVerification = undefined;
      },
      snapshot: () => Object.freeze({
        activationCount: state.activationCount,
        commitCount: state.commitCount,
        predecessorDeactivateCount: state.predecessorDeactivateCount,
        replacementDeactivateCount: state.replacementDeactivateCount,
        replacementDeactivateCompletedCount: state.replacementDeactivateCompletedCount,
        verificationCount: state.verificationCount,
      }),
    }),
    writable: false,
  });
  return state;
}
const state = globalThis[stateSymbol] ?? (globalThis[stateSymbol] = createState());
const instrumentedPlanes = globalThis[planeMapSymbol] ?? (globalThis[planeMapSymbol] = new WeakMap());
const unwrapPlane = (plane) => instrumentedPlanes.get(plane) ?? plane;
const instrumentPlane = (plane, kind) => {
  const wrapper = {};
  for (const key of Reflect.ownKeys(plane)) {
    const descriptor = Object.getOwnPropertyDescriptor(plane, key);
    if (descriptor === undefined) continue;
    if (key === "deactivate") {
      Object.defineProperty(wrapper, key, {
        enumerable: descriptor.enumerable,
        value: async () => {
          if (kind === "predecessor") {
            state.predecessorDeactivateCount += 1;
            if (state.rejectPredecessorDeactivate) {
              state.rejectPredecessorDeactivate = false;
              return Promise.reject(new TypeError("D.108e2b injected predecessor deactivation failure"));
            }
          } else {
            state.replacementDeactivateCount += 1;
          }
          const result = await Reflect.apply(plane.deactivate, plane, []);
          if (kind === "replacement") {
            state.replacementDeactivateCompletedCount += 1;
            state.replacementPlanes.delete(wrapper);
          }
          return result;
        },
      });
    } else if ("value" in descriptor) {
      Object.defineProperty(wrapper, key, {
        enumerable: descriptor.enumerable,
        value: typeof descriptor.value === "function"
          ? (...args) => Reflect.apply(descriptor.value, plane, args)
          : descriptor.value,
      });
    } else {
      Object.defineProperty(wrapper, key, {
        enumerable: descriptor.enumerable,
        get: () => Reflect.get(plane, key, plane),
      });
    }
  }
  Object.freeze(wrapper);
  if (kind === "replacement") state.replacementPlanes.add(wrapper);
  instrumentedPlanes.set(wrapper, plane);
  return wrapper;
};`;
	return {
		name: "d108e2b-lifetime-instrumentation",
		setup(context): void {
			const modules = new Map<string, string>([
				[
					"@ts-drp/node/v3-live",
					`${shared}
import * as actual from ${JSON.stringify(v3Live)};
export const prepareV3LiveGeneration = actual.prepareV3LiveGeneration;
export const recoverV3LiveReplica = actual.recoverV3LiveReplica;
export const routeV3Ingress = actual.routeV3Ingress;
export const activateV3LivePlane = (input) => {
  const result = actual.activateV3LivePlane(input);
  return result.ok === true ? Object.freeze({ ...result, handle: instrumentPlane(result.handle, "predecessor") }) : result;
};
export const bindV3BlueprintLivePlane = (input) => actual.bindV3BlueprintLivePlane(
  input !== null && typeof input === "object" && "plane" in input
    ? { ...input, plane: unwrapPlane(input.plane) }
    : input
);
export const routeV3RetainedIngress = (handle, message) => actual.routeV3RetainedIngress(unwrapPlane(handle), message);
export const republishV3RetainedTo = (handle, targetPeerId) => actual.republishV3RetainedTo(unwrapPlane(handle), targetPeerId);`,
				],
				[
					"@ts-drp/node/creator-close",
					`${shared}
import * as actual from ${JSON.stringify(creatorClose)};
export const bindCreatorLiveClose = (input) => actual.bindCreatorLiveClose({ ...input, plane: unwrapPlane(input.plane) });`,
				],
				[
					"@ts-drp/node/creator-adoption",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoption)};
export const verifyCreatorSuccessorAdoption = async (input) => {
  state.verificationCount += 1;
  if (state.pauseVerification) await state.verificationGate;
  return actual.verifyCreatorSuccessorAdoption(input);
};`,
				],
				[
					"@ts-drp/node/creator-adoption-commit",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionCommit)};
export const commitCreatorSuccessorAdoption = async (input) => {
  state.commitCount += 1;
  return actual.commitCreatorSuccessorAdoption(input);
};`,
				],
				[
					"@ts-drp/node/creator-adoption-activate",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionActivate)};
export const reopenCreatorSuccessorAdoption = actual.reopenCreatorSuccessorAdoption;
export const activateCreatorSuccessorAdoption = async (input) => {
  state.activationCount += 1;
  const result = await actual.activateCreatorSuccessorAdoption(input);
  return result.ok === true ? Object.freeze({ ...result, handle: instrumentPlane(result.handle, "replacement") }) : result;
};`,
				],
			]);
			for (const specifier of modules.keys()) {
				context.onResolve({ filter: new RegExp(`^${specifier}$`) }, () => ({
					namespace: "d108e2b-lifetime",
					path: specifier,
				}));
			}
			context.onLoad({ filter: /.*/, namespace: "d108e2b-lifetime" }, ({ path }) => ({
				contents: modules.get(path),
				loader: "js",
				resolveDir: REPOSITORY_ROOT,
			}));
		},
	};
}

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

interface LifetimeCounts {
	readonly activationCount: number;
	readonly commitCount: number;
	readonly predecessorDeactivateCount: number;
	readonly replacementDeactivateCount: number;
	readonly replacementDeactivateCompletedCount: number;
	readonly verificationCount: number;
}

async function startProductBrowserServer(entryPoint: string): Promise<ProductBrowserServer> {
	const configUrl = new URL("../../../vite.config.mts", import.meta.url).href;
	const loaded = (await import(configUrl)) as Readonly<{
		workspaceAliases?: Readonly<Record<string, string>>;
	}>;
	if (loaded.workspaceAliases === undefined) throw new TypeError("D.108d2 workspace aliases are unavailable");
	const aliases = Object.freeze(
		Object.fromEntries(
			Object.entries(loaded.workspaceAliases).filter(
				([specifier]) =>
					!new Set([
						"@ts-drp/node/creator-adoption",
						"@ts-drp/node/creator-adoption-activate",
						"@ts-drp/node/creator-adoption-commit",
						"@ts-drp/node/creator-close",
						"@ts-drp/node/v3-live",
					]).has(specifier)
			)
		)
	);
	const bundled = await build({
		alias: aliases,
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		platform: "browser",
		plugins: [lifetimeInstrumentationPlugin()],
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
	sharedLifetimeBehaviors = contract.D108E2B_BROWSER_BEHAVIORS;
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
	expect(sharedLifetimeBehaviors).toEqual([
		"concurrent adoption shares one success and one underlying transition",
		"concurrent adoption shares one real verification failure",
		"close joins a paused adoption before releasing lifetime ownership",
		"predecessor deactivation failure cleans the replacement before escaping",
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

let lifetimeScenario = 0;

async function openLifetimeCreator(sealed: boolean): Promise<Page> {
	if (creator === undefined) throw new TypeError("D.108e2b creator realm is absent");
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.close()).catch(() => undefined);
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.cleanupLifetimeReplacements());
	lifetimeScenario += 1;
	await creator.evaluate((input) => window.phase6aCreatorSuccessorProduct.create(input), {
		channelName: `${CHANNEL_NAME}-lifetime-${lifetimeScenario}`,
		clientId: "alice",
		databaseName: `d108e2b-lifetime-${lifetimeScenario}`,
	});
	if (sealed) await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
	return creator;
}

async function closeLifetimeCreator(page: Page): Promise<void> {
	if (page.isClosed()) return;
	await page.evaluate(() => window.phase6aCreatorSuccessorProduct.close()).catch(() => undefined);
	await page.evaluate(() => window.phase6aCreatorSuccessorProduct.cleanupLifetimeReplacements());
}

test(D108E2B_BROWSER_BEHAVIORS.join("; "), async () => {
	const counts = async (page: Page): Promise<LifetimeCounts> => {
		const selected = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.lifetimeSnapshot());
		return {
			activationCount: selected.activationCount,
			commitCount: selected.commitCount,
			predecessorDeactivateCount: selected.predecessorDeactivateCount,
			replacementDeactivateCount: selected.replacementDeactivateCount,
			replacementDeactivateCompletedCount: selected.replacementDeactivateCompletedCount,
			verificationCount: selected.verificationCount,
		};
	};

	const successful = await openLifetimeCreator(true);
	await successful.evaluate(() => window.phase6aCreatorSuccessorProduct.configureLifetime({}));
	const successfulSettlements = await successful.evaluate(() =>
		window.phase6aCreatorSuccessorProduct.concurrentAdoption()
	);
	const successfulCounts = await counts(successful);
	await closeLifetimeCreator(successful);

	const failing = await openLifetimeCreator(false);
	await failing.evaluate(() => window.phase6aCreatorSuccessorProduct.configureLifetime({}));
	const failingSettlements = await failing.evaluate(() => window.phase6aCreatorSuccessorProduct.concurrentAdoption());
	const failingCounts = await counts(failing);
	await closeLifetimeCreator(failing);

	const closing = await openLifetimeCreator(true);
	await closing.evaluate(() => window.phase6aCreatorSuccessorProduct.configureLifetime({ pauseVerification: true }));
	await closing.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	await expect
		.poll(() => closing.evaluate(() => window.phase6aCreatorSuccessorProduct.lifetimeSnapshot().verificationCount))
		.toBe(1);
	await closing.evaluate(() => window.phase6aCreatorSuccessorProduct.beginClose());
	const closeBeforeRelease = await closing.evaluate(() => window.phase6aCreatorSuccessorProduct.lifetimeSnapshot());
	await closing.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseVerification());
	const [adoptionAfterRelease, closeAfterRelease] = await Promise.all([
		closing.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
		closing.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForClose()),
	]);
	const closeCounts = await counts(closing);
	await closeLifetimeCreator(closing);

	const deactivation = await openLifetimeCreator(true);
	await deactivation.evaluate(() =>
		window.phase6aCreatorSuccessorProduct.configureLifetime({ rejectPredecessorDeactivate: true })
	);
	await deactivation.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	const deactivationSettlement = await deactivation.evaluate(() =>
		window.phase6aCreatorSuccessorProduct.waitForAdoption()
	);
	const deactivationCounts = await counts(deactivation);
	const deactivationSnapshot = await snapshot(deactivation);
	await closeLifetimeCreator(deactivation);

	expect({
		close: {
			adoptionDetail: adoptionAfterRelease.detail,
			adoptionOrder: adoptionAfterRelease.order,
			adoptionSettledBeforeRelease: closeBeforeRelease.adoptionSettled,
			adoptionStatus: adoptionAfterRelease.status,
			cleanupBalanced:
				closeCounts.activationCount === closeCounts.replacementDeactivateCount &&
				closeCounts.replacementDeactivateCount === closeCounts.replacementDeactivateCompletedCount,
			closeOrder: closeAfterRelease.order,
			closeSettledBeforeRelease: closeBeforeRelease.closeSettled,
			closeStatus: closeAfterRelease.status,
			predecessorReleasedOnce: closeCounts.predecessorDeactivateCount === 1,
		},
		deactivation: {
			authority: deactivationSnapshot.authority,
			counts: deactivationCounts,
			settlement: deactivationSettlement,
		},
		failure: {
			counts: failingCounts,
			sameSettlement:
				JSON.stringify(failingSettlements[0]) === JSON.stringify(failingSettlements[1]) &&
				failingSettlements[0].status === "rejected",
		},
		success: { counts: successfulCounts, settlements: successfulSettlements },
	}).toEqual({
		close: {
			adoptionDetail: "v3 room session is closed",
			adoptionOrder: 1,
			adoptionSettledBeforeRelease: false,
			adoptionStatus: "rejected",
			cleanupBalanced: true,
			closeOrder: 2,
			closeSettledBeforeRelease: false,
			closeStatus: "fulfilled",
			predecessorReleasedOnce: true,
		},
		deactivation: {
			authority: null,
			counts: {
				activationCount: 1,
				commitCount: 1,
				predecessorDeactivateCount: 1,
				replacementDeactivateCount: 1,
				replacementDeactivateCompletedCount: 1,
				verificationCount: 1,
			},
			settlement: {
				detail: "D.108e2b injected predecessor deactivation failure",
				lifetime: {
					activationCount: 1,
					commitCount: 1,
					predecessorDeactivateCount: 1,
					replacementDeactivateCount: 1,
					replacementDeactivateCompletedCount: 1,
					verificationCount: 1,
				},
				order: 1,
				status: "rejected",
			},
		},
		failure: {
			counts: {
				activationCount: 0,
				commitCount: 0,
				predecessorDeactivateCount: 0,
				replacementDeactivateCount: 0,
				replacementDeactivateCompletedCount: 0,
				verificationCount: 1,
			},
			sameSettlement: true,
		},
		success: {
			counts: {
				activationCount: 1,
				commitCount: 1,
				predecessorDeactivateCount: 1,
				replacementDeactivateCount: 0,
				replacementDeactivateCompletedCount: 0,
				verificationCount: 1,
			},
			settlements: [{ status: "fulfilled" }, { status: "fulfilled" }],
		},
	});
});
