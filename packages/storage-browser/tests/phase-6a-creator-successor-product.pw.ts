import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const contractLoad = import(
	pathToFileURL(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts")).href
) as Promise<
	Readonly<{
		readonly D108D2_BROWSER_BEHAVIORS: readonly [string, string, string];
		readonly D108E2B_BROWSER_BEHAVIORS: readonly [string, string, string, string];
		readonly D108E2C_PRODUCT_BROWSER_BEHAVIORS: readonly [string, string];
		readonly D108E3_BROWSER_BEHAVIORS: readonly [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		isD108d2Authority(value: unknown): boolean;
	}>
>;
// @ts-expect-error Playwright loads this ESM test before registration; the package typecheck uses an older module target.
const contract = await contractLoad;
const D108D2_BROWSER_BEHAVIORS = contract.D108D2_BROWSER_BEHAVIORS;
const D108E2B_BROWSER_BEHAVIORS = contract.D108E2B_BROWSER_BEHAVIORS;
const D108E2C_PRODUCT_BROWSER_BEHAVIORS = contract.D108E2C_PRODUCT_BROWSER_BEHAVIORS;
const D108E3_BROWSER_BEHAVIORS = contract.D108E3_BROWSER_BEHAVIORS;
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
const planeIdMapSymbol = Symbol.for("ts-drp/d108e3/instrumented-plane-ids");
const closeHandlePlaneIdMapSymbol = Symbol.for("ts-drp/d108e3/close-handle-plane-ids");
function createState() {
  const state = {
    activationCount: 0,
    activationFailureGate: Promise.resolve(),
    commitCount: 0,
    injectActivationFailure: false,
    independentVerificationCount: 0,
    issueThrowCount: 0,
    latestPredecessorPlaneId: 0,
    migrationRecordGate: Promise.resolve(),
    migrationRecordIssueCount: 0,
    nestedPredecessorDeactivateCount: 0,
    nextPlaneId: 1,
    pauseAfterActivation: false,
    pauseActivationFailure: false,
    pauseAfterPredecessorDeactivation: false,
    pauseMigrationRecord: false,
    pauseTerminalTransition: false,
    pauseVerification: false,
    postActivationGate: Promise.resolve(),
    postActivationPauseCount: 0,
    postPredecessorDeactivationGate: Promise.resolve(),
    postPredecessorDeactivationPauseCount: 0,
    predecessorDeactivateCount: 0,
    rejectPredecessorDeactivate: false,
    rejectReplacementDeactivate: false,
    releaseActivationFailure: undefined,
    releaseMigrationRecord: undefined,
    releasePostActivation: undefined,
    releasePostPredecessorDeactivation: undefined,
    releaseTerminalTransition: undefined,
    releaseVerification: undefined,
    replacementDeactivateCount: 0,
    replacementDeactivateCompletedCount: 0,
    replacementPlanes: new Set(),
    targetPlaneId: 0,
    terminalTransitionCount: 0,
    terminalTransitionGate: Promise.resolve(),
    throwIssueLocal: false,
    verificationCount: 0,
    verificationGate: Promise.resolve(),
  };
  const configure = (input) => {
    state.activationCount = 0;
    state.commitCount = 0;
    state.injectActivationFailure = input.injectActivationFailure === true;
    state.independentVerificationCount = 0;
    state.issueThrowCount = 0;
    state.migrationRecordIssueCount = 0;
    state.nestedPredecessorDeactivateCount = 0;
    state.pauseAfterActivation = input.pauseAfterActivation === true;
    state.pauseActivationFailure = input.pauseActivationFailure === true;
    state.pauseAfterPredecessorDeactivation = input.pauseAfterPredecessorDeactivation === true;
    state.pauseMigrationRecord = input.pauseMigrationRecord === true;
    state.pauseTerminalTransition = input.pauseTerminalTransition === true;
    state.pauseVerification = input.pauseVerification === true;
    state.postActivationPauseCount = 0;
    state.postPredecessorDeactivationPauseCount = 0;
    state.predecessorDeactivateCount = 0;
    state.rejectPredecessorDeactivate = input.rejectPredecessorDeactivate === true;
    state.rejectReplacementDeactivate = input.rejectReplacementDeactivate === true;
    state.replacementDeactivateCount = 0;
    state.replacementDeactivateCompletedCount = 0;
    if (input.retainTarget !== true) state.targetPlaneId = state.latestPredecessorPlaneId;
    state.terminalTransitionCount = 0;
    state.throwIssueLocal = input.throwIssueLocal === true;
    state.verificationCount = 0;
    state.activationFailureGate = state.pauseActivationFailure
      ? new Promise((resolve) => { state.releaseActivationFailure = resolve; })
      : Promise.resolve();
    state.migrationRecordGate = state.pauseMigrationRecord
      ? new Promise((resolve) => { state.releaseMigrationRecord = resolve; })
      : Promise.resolve();
    state.postActivationGate = state.pauseAfterActivation
      ? new Promise((resolve) => { state.releasePostActivation = resolve; })
      : Promise.resolve();
    state.postPredecessorDeactivationGate = state.pauseAfterPredecessorDeactivation
      ? new Promise((resolve) => { state.releasePostPredecessorDeactivation = resolve; })
      : Promise.resolve();
    state.verificationGate = state.pauseVerification
      ? new Promise((resolve) => { state.releaseVerification = resolve; })
      : Promise.resolve();
    state.terminalTransitionGate = state.pauseTerminalTransition
      ? new Promise((resolve) => { state.releaseTerminalTransition = resolve; })
      : Promise.resolve();
    if (!state.pauseActivationFailure) state.releaseActivationFailure = undefined;
    if (!state.pauseMigrationRecord) state.releaseMigrationRecord = undefined;
    if (!state.pauseAfterActivation) state.releasePostActivation = undefined;
    if (!state.pauseAfterPredecessorDeactivation) state.releasePostPredecessorDeactivation = undefined;
    if (!state.pauseVerification) state.releaseVerification = undefined;
    if (!state.pauseTerminalTransition) state.releaseTerminalTransition = undefined;
  };
  Object.defineProperty(globalThis, "__d108e2bLifetimeInstrumentation", {
    configurable: false,
    value: Object.freeze({
      cleanupReplacements: async () => {
        await Promise.allSettled(Array.from(state.replacementPlanes, (plane) => plane.deactivate()));
      },
      configure,
      releaseActivationFailure: () => {
        state.pauseActivationFailure = false;
        state.releaseActivationFailure?.();
        state.releaseActivationFailure = undefined;
      },
      releaseMigrationRecord: () => {
        state.pauseMigrationRecord = false;
        state.releaseMigrationRecord?.();
        state.releaseMigrationRecord = undefined;
      },
      releasePostActivation: () => {
        state.pauseAfterActivation = false;
        state.releasePostActivation?.();
        state.releasePostActivation = undefined;
      },
      releasePostPredecessorDeactivation: () => {
        state.pauseAfterPredecessorDeactivation = false;
        state.releasePostPredecessorDeactivation?.();
        state.releasePostPredecessorDeactivation = undefined;
      },
      releaseTerminalTransition: () => {
        state.pauseTerminalTransition = false;
        state.releaseTerminalTransition?.();
        state.releaseTerminalTransition = undefined;
      },
      releaseVerification: () => {
        state.pauseVerification = false;
        state.releaseVerification?.();
        state.releaseVerification = undefined;
      },
      snapshot: () => Object.freeze({
        activationCount: state.activationCount,
        commitCount: state.commitCount,
        postActivationPauseCount: state.postActivationPauseCount,
        postPredecessorDeactivationPauseCount: state.postPredecessorDeactivationPauseCount,
        predecessorDeactivateCount: state.predecessorDeactivateCount,
        replacementDeactivateCount: state.replacementDeactivateCount,
        replacementDeactivateCompletedCount: state.replacementDeactivateCompletedCount,
        verificationCount: state.verificationCount,
      }),
      transitionSnapshot: () => Object.freeze({
        activationCount: state.activationCount,
        commitCount: state.commitCount,
        independentVerificationCount: state.independentVerificationCount,
        issueThrowCount: state.issueThrowCount,
        migrationRecordIssueCount: state.migrationRecordIssueCount,
        nestedPredecessorDeactivateCount: state.nestedPredecessorDeactivateCount,
        postActivationPauseCount: state.postActivationPauseCount,
        postPredecessorDeactivationPauseCount: state.postPredecessorDeactivationPauseCount,
        predecessorDeactivateCount: state.predecessorDeactivateCount,
        replacementDeactivateCount: state.replacementDeactivateCount,
        replacementDeactivateCompletedCount: state.replacementDeactivateCompletedCount,
        terminalTransitionCount: state.terminalTransitionCount,
        verificationCount: state.verificationCount,
      }),
    }),
    writable: false,
  });
  return state;
}
const state = globalThis[stateSymbol] ?? (globalThis[stateSymbol] = createState());
const instrumentedPlanes = globalThis[planeMapSymbol] ?? (globalThis[planeMapSymbol] = new WeakMap());
const planeIds = globalThis[planeIdMapSymbol] ?? (globalThis[planeIdMapSymbol] = new WeakMap());
const closeHandlePlaneIds = globalThis[closeHandlePlaneIdMapSymbol] ??
  (globalThis[closeHandlePlaneIdMapSymbol] = new WeakMap());
const unwrapPlane = (plane) => instrumentedPlanes.get(plane) ?? plane;
const instrumentPlane = (plane, kind, ownerPlaneId) => {
  const planeId = kind === "predecessor" ? state.nextPlaneId++ : ownerPlaneId;
  if (kind === "predecessor") state.latestPredecessorPlaneId = planeId;
  const wrapper = {};
  for (const key of Reflect.ownKeys(plane)) {
    const descriptor = Object.getOwnPropertyDescriptor(plane, key);
    if (descriptor === undefined) continue;
    if (key === "deactivate") {
      Object.defineProperty(wrapper, key, {
        enumerable: descriptor.enumerable,
        value: async () => {
          if (kind === "predecessor") {
            if (planeId === state.targetPlaneId) state.predecessorDeactivateCount += 1;
            else state.nestedPredecessorDeactivateCount += 1;
            if (planeId === state.targetPlaneId && state.rejectPredecessorDeactivate) {
              state.rejectPredecessorDeactivate = false;
              return Promise.reject(new TypeError("D.108e2b injected predecessor deactivation failure"));
            }
          } else {
            if (planeId === state.targetPlaneId) state.replacementDeactivateCount += 1;
            if (planeId === state.targetPlaneId && state.rejectReplacementDeactivate) {
              state.rejectReplacementDeactivate = false;
              return Promise.reject(new TypeError("D.108e3 injected replacement deactivation failure"));
            }
          }
          const result = await Reflect.apply(plane.deactivate, plane, []);
          if (kind === "predecessor" && planeId === state.targetPlaneId && state.pauseAfterPredecessorDeactivation) {
            state.postPredecessorDeactivationPauseCount += 1;
            await state.postPredecessorDeactivationGate;
          } else if (kind === "replacement" && planeId === state.targetPlaneId) {
            state.replacementDeactivateCompletedCount += 1;
            state.replacementPlanes.delete(wrapper);
          }
          return result;
        },
      });
    } else if (key === "issueLocal") {
      Object.defineProperty(wrapper, key, {
        enumerable: descriptor.enumerable,
        value: (...args) => {
          const operations = args[0]?.operations;
          const hasAction = (action) => Array.isArray(operations) &&
            operations.some((entry) => entry?.operation?.action === action);
          if (planeId === state.targetPlaneId && state.throwIssueLocal && hasAction("message")) {
            state.throwIssueLocal = false;
            state.issueThrowCount += 1;
            throw new TypeError("D.108e3 injected pending-issue drain failure");
          }
          const result = Reflect.apply(descriptor.value, plane, args);
          if (hasAction("migrationRecord")) {
            state.migrationRecordIssueCount += 1;
            if (state.pauseMigrationRecord) return state.migrationRecordGate.then(() => result);
          }
          return result;
        },
      });
    } else if (key === "beginTerminalTransition") {
      Object.defineProperty(wrapper, key, {
        enumerable: descriptor.enumerable,
        value: async (...args) => {
          const result = Reflect.apply(descriptor.value, plane, args);
          if (planeId === state.targetPlaneId) {
            state.terminalTransitionCount += 1;
            if (state.pauseTerminalTransition) await state.terminalTransitionGate;
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
  planeIds.set(wrapper, planeId);
  planeIds.set(plane, planeId);
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
export const bindCreatorLiveClose = async (input) => {
  const planeId = planeIds.get(input.plane);
  const result = await actual.bindCreatorLiveClose({ ...input, plane: unwrapPlane(input.plane) });
  if (planeId !== undefined && result.ok === true) closeHandlePlaneIds.set(result.handle, planeId);
  return result;
};`,
				],
				[
					"@ts-drp/node/creator-adoption",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoption)};
export const verifyCreatorSuccessorAdoption = async (input) => {
  const targeted = closeHandlePlaneIds.get(input.handle) === state.targetPlaneId;
  if (targeted) state.verificationCount += 1;
  else state.independentVerificationCount += 1;
  if (targeted && state.pauseVerification) await state.verificationGate;
  return actual.verifyCreatorSuccessorAdoption(input);
};`,
				],
				[
					"@ts-drp/node/creator-adoption-commit",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionCommit)};
export const commitCreatorSuccessorAdoption = async (input) => {
  if (closeHandlePlaneIds.get(input.handle) === state.targetPlaneId) state.commitCount += 1;
  return actual.commitCreatorSuccessorAdoption(input);
};`,
				],
				[
					"@ts-drp/node/creator-adoption-activate",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionActivate)};
export const reopenCreatorSuccessorAdoption = actual.reopenCreatorSuccessorAdoption;
export const activateCreatorSuccessorAdoption = async (input) => {
  const planeId = closeHandlePlaneIds.get(input.handle);
  const targeted = planeId === state.targetPlaneId;
  if (targeted) state.activationCount += 1;
  if (targeted && state.injectActivationFailure) {
    state.injectActivationFailure = false;
    if (state.pauseActivationFailure) await state.activationFailureGate;
    return Object.freeze({ kind: "authority-unavailable", ok: false });
  }
  const result = await actual.activateCreatorSuccessorAdoption(input);
  if (targeted && result.ok === true && state.pauseAfterActivation) {
    state.postActivationPauseCount += 1;
    await state.postActivationGate;
  }
  return result.ok === true
    ? Object.freeze({ ...result, handle: instrumentPlane(result.handle, "replacement", planeId) })
    : result;
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
		format: "esm",
		platform: "browser",
		plugins: [lifetimeInstrumentationPlugin()],
		stdin: {
			contents: `
import { createV3ChatApplication } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "examples/v3-chat/src/index.ts"))};
import { createV3RoomCreatorInviteMaterial, createV3RoomSession } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "examples/v3-room/src/index.ts"))};
import { Keychain } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "packages/keychain/src/index.ts"))};
import { createRecoverableFinalitySigner } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "packages/keychain/src/finality.ts"))};
import ${JSON.stringify(entryPoint)};
Object.defineProperty(globalThis, "__d108e3DirectRoomDependencies", {
  configurable: false,
  value: Object.freeze({
    createRecoverableFinalitySigner,
    createV3ChatApplication,
    createV3RoomCreatorInviteMaterial,
    createV3RoomSession,
    Keychain,
  }),
  writable: false,
});`,
			loader: "js",
			resolveDir: REPOSITORY_ROOT,
		},
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
	await page.waitForFunction(() => typeof window.phase6aCreatorSuccessorProduct === "object");
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
	expect(D108D2_BROWSER_BEHAVIORS).toEqual([
		"hot creator adoption exposes oracle authority and issues through the replacement handle",
		"established peer cold reopen accepts the genuine epoch-one live operation",
		"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
	]);
	expect(D108E2B_BROWSER_BEHAVIORS).toEqual([
		"concurrent adoption shares one success and one underlying transition",
		"concurrent adoption shares one real verification failure",
		"close joins a paused adoption before releasing lifetime ownership",
		"predecessor deactivation failure cleans the replacement before escaping",
	]);
	expect(D108E2C_PRODUCT_BROWSER_BEHAVIORS).toEqual([
		"close at the post-activation gate cleans the successor exactly once",
		"close at the post-predecessor-deactivation gate preserves causal cleanup",
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

interface D108e3Creator {
	readonly databaseName: string;
	readonly page: Page;
}

async function openD108e3Creator(sealed: boolean): Promise<D108e3Creator> {
	if (context === undefined || servers[0] === undefined) throw new TypeError("D.108e3 browser harness is absent");
	lifetimeScenario += 1;
	const page = await context.newPage();
	await openRealm(page, servers[0].origin, `d108e3-${lifetimeScenario}`, () => [page]);
	const databaseName = `d108e3-lifetime-${lifetimeScenario}`;
	await page.evaluate((input) => window.phase6aCreatorSuccessorProduct.create(input), {
		channelName: `${CHANNEL_NAME}-d108e3-${lifetimeScenario}`,
		clientId: "alice",
		databaseName,
	});
	if (sealed) await page.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
	return Object.freeze({ databaseName, page });
}

async function disposeD108e3Creator(selected: D108e3Creator): Promise<void> {
	if (selected.page.isClosed()) return;
	await selected.page.evaluate(() => window.phase6aCreatorSuccessorProduct.close()).catch(() => undefined);
	await selected.page
		.evaluate(() => window.phase6aCreatorSuccessorProduct.cleanupLifetimeReplacements())
		.catch(() => undefined);
	await selected.page.close();
}

async function transitionSnapshot(page: Page): Promise<Readonly<Record<string, unknown>>> {
	return page.evaluate(() => window.phase6aCreatorSuccessorProduct.transitionSnapshot()) as unknown as Promise<
		Readonly<Record<string, unknown>>
	>;
}

async function settleBrowserTurns(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolvePromise) => {
				setTimeout(resolvePromise, 250);
			})
	);
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
					postActivationPauseCount: 0,
					postPredecessorDeactivationPauseCount: 0,
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

test(D108E2C_PRODUCT_BROWSER_BEHAVIORS.join("; "), async () => {
	if (creator === undefined) throw new TypeError("D.108e2c creator realm is absent");
	const readiness = await creator.evaluate(() => {
		const api = window.phase6aCreatorSuccessorProduct as unknown as Readonly<Record<string, unknown>>;
		return {
			releasePostActivation: typeof Reflect.get(api, "releasePostActivation") === "function",
			releasePostPredecessorDeactivation: typeof Reflect.get(api, "releasePostPredecessorDeactivation") === "function",
		};
	});
	expect(readiness).toEqual({ releasePostActivation: true, releasePostPredecessorDeactivation: true });

	const runGate = async (
		gate: "postActivation" | "postPredecessorDeactivation"
	): Promise<Readonly<Record<string, unknown>>> => {
		const page = await openLifetimeCreator(true);
		await page.evaluate((selectedGate) => {
			const api = window.phase6aCreatorSuccessorProduct as unknown as Readonly<Record<string, unknown>>;
			const configure = Reflect.get(api, "configureLifetime");
			if (typeof configure !== "function") throw new TypeError("D.108e2c lifetime configuration is unavailable");
			Reflect.apply(configure, api, [
				selectedGate === "postActivation"
					? { pauseAfterActivation: true }
					: { pauseAfterPredecessorDeactivation: true },
			]);
		}, gate);
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
		const pauseField = gate === "postActivation" ? "postActivationPauseCount" : "postPredecessorDeactivationPauseCount";
		await expect
			.poll(async () => {
				const selected = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.lifetimeSnapshot());
				return Reflect.get(selected, pauseField);
			})
			.toBe(1);
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginClose());
		const beforeRelease = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.lifetimeSnapshot());
		const authorityBeforeRelease = (await snapshot(page)).authority;
		await page.evaluate((selectedGate) => {
			const api = window.phase6aCreatorSuccessorProduct as unknown as Readonly<Record<string, unknown>>;
			const release = Reflect.get(
				api,
				selectedGate === "postActivation" ? "releasePostActivation" : "releasePostPredecessorDeactivation"
			);
			if (typeof release !== "function") throw new TypeError("D.108e2c lifetime gate release is unavailable");
			Reflect.apply(release, api, []);
		}, gate);
		const [adoption, close] = await Promise.all([
			page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
			page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForClose()),
		]);
		const afterRelease = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.lifetimeSnapshot());
		await closeLifetimeCreator(page);
		return {
			afterRelease,
			authorityBeforeRelease,
			beforeRelease,
			settlements: { adoption, close },
		};
	};

	const postActivation = await runGate("postActivation");
	const postPredecessorDeactivation = await runGate("postPredecessorDeactivation");
	const finalInstrumentationCounts = {
		activationCount: 1,
		commitCount: 1,
		predecessorDeactivateCount: 1,
		replacementDeactivateCompletedCount: 1,
		replacementDeactivateCount: 1,
		verificationCount: 1,
	};
	const finalCounts = { ...finalInstrumentationCounts, adoptionSettled: true, closeSettled: true };
	expect(postActivation).toEqual({
		afterRelease: { ...finalCounts, postActivationPauseCount: 1, postPredecessorDeactivationPauseCount: 0 },
		authorityBeforeRelease: null,
		beforeRelease: {
			...finalCounts,
			adoptionSettled: false,
			closeSettled: false,
			postActivationPauseCount: 1,
			postPredecessorDeactivationPauseCount: 0,
			predecessorDeactivateCount: 0,
			replacementDeactivateCompletedCount: 0,
			replacementDeactivateCount: 0,
		},
		settlements: {
			adoption: {
				detail: "v3 room session is closed",
				lifetime: {
					...finalInstrumentationCounts,
					postActivationPauseCount: 1,
					postPredecessorDeactivationPauseCount: 0,
					predecessorDeactivateCount: 0,
				},
				order: 1,
				status: "rejected",
			},
			close: {
				lifetime: {
					...finalInstrumentationCounts,
					postActivationPauseCount: 1,
					postPredecessorDeactivationPauseCount: 0,
				},
				order: 2,
				status: "fulfilled",
			},
		},
	});
	expect(postPredecessorDeactivation).toEqual({
		afterRelease: { ...finalCounts, postActivationPauseCount: 0, postPredecessorDeactivationPauseCount: 1 },
		authorityBeforeRelease: null,
		beforeRelease: {
			...finalCounts,
			adoptionSettled: false,
			closeSettled: false,
			postActivationPauseCount: 0,
			postPredecessorDeactivationPauseCount: 1,
			replacementDeactivateCompletedCount: 0,
			replacementDeactivateCount: 0,
		},
		settlements: {
			adoption: {
				detail: "v3 room session is closed",
				lifetime: {
					...finalInstrumentationCounts,
					postActivationPauseCount: 0,
					postPredecessorDeactivationPauseCount: 1,
				},
				order: 1,
				status: "rejected",
			},
			close: {
				lifetime: {
					...finalInstrumentationCounts,
					postActivationPauseCount: 0,
					postPredecessorDeactivationPauseCount: 1,
				},
				order: 2,
				status: "fulfilled",
			},
		},
	});
});

test(D108E3_BROWSER_BEHAVIORS.join("; "), async () => {
	const configure = (page: Page, input: Readonly<Record<string, boolean>>): Promise<void> =>
		page.evaluate((selected) => window.phase6aCreatorSuccessorProduct.configureLifetime(selected), input);
	const selectedCounts = async (page: Page): Promise<Readonly<Record<string, number | boolean>>> => {
		const selected = await transitionSnapshot(page);
		return Object.freeze({
			activationCount: Number(selected.activationCount),
			activationSettled: selected.activationSettled === true,
			adoptionSettled: selected.adoptionSettled === true,
			closeSettled: selected.closeSettled === true,
			independentVerificationCount: Number(selected.independentVerificationCount),
			issueThrowCount: Number(selected.issueThrowCount),
			migrationRecordIssueCount: Number(selected.migrationRecordIssueCount),
			predecessorDeactivateCount: Number(selected.predecessorDeactivateCount),
			replacementDeactivateCompletedCount: Number(selected.replacementDeactivateCompletedCount),
			replacementDeactivateCount: Number(selected.replacementDeactivateCount),
			rehearsalSettled: selected.rehearsalSettled === true,
			sendSettled: selected.sendSettled === true,
			terminalTransitionCount: Number(selected.terminalTransitionCount),
			verificationCount: Number(selected.verificationCount),
		});
	};

	const cleanupFailure = await openD108e3Creator(true);
	await configure(cleanupFailure.page, {
		rejectPredecessorDeactivate: true,
		rejectReplacementDeactivate: true,
	});
	await cleanupFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	const cleanupSettlement = await cleanupFailure.page.evaluate(() =>
		window.phase6aCreatorSuccessorProduct.waitForAdoption()
	);
	const cleanupCounts = await selectedCounts(cleanupFailure.page);
	const cleanupAuthority = (await snapshot(cleanupFailure.page)).authority;
	await disposeD108e3Creator(cleanupFailure);

	const activationFailure = await openD108e3Creator(true);
	await configure(activationFailure.page, { injectActivationFailure: true, pauseActivationFailure: true });
	await activationFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	await expect
		.poll(() =>
			activationFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().activationCount)
		)
		.toBe(1);
	await activationFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginClose());
	const activationBeforeRelease = await selectedCounts(activationFailure.page);
	await activationFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseActivationFailure());
	const [activationAdoption, activationClose] = await Promise.all([
		activationFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
		activationFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForClose()),
	]);
	const activationCounts = await selectedCounts(activationFailure.page);
	await disposeD108e3Creator(activationFailure);

	const drainSuccess = await openD108e3Creator(false);
	const drainSuccessName = `drain-success-${lifetimeScenario}`;
	await drainSuccess.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name),
		drainSuccessName
	);
	await configure(drainSuccess.page, { throwIssueLocal: true });
	await drainSuccess.page.evaluate(
		({ name }) => window.phase6aCreatorSuccessorProduct.beginDirectSend(name, "drain-success"),
		{ name: drainSuccessName }
	);
	await expect
		.poll(() =>
			drainSuccess.page.evaluate(() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().issueThrowCount)
		)
		.toBe(1);
	await drainSuccess.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectClose(name),
		drainSuccessName
	);
	const drainSuccessClose = await drainSuccess.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.waitForDirectClose(name),
		drainSuccessName
	);
	const drainSuccessCounts = await selectedCounts(drainSuccess.page);
	const drainSuccessDeletion = await drainSuccess.page.evaluate(async (prefix) => {
		try {
			return Object.freeze({
				names: await window.phase6aCreatorSuccessorProduct.deleteDatabases(prefix),
				status: "fulfilled" as const,
			});
		} catch (error) {
			return Object.freeze({
				detail: error instanceof Error ? error.message : String(error),
				status: "rejected" as const,
			});
		}
	}, `d108e3-direct-${drainSuccessName}`);
	await drainSuccess.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectClose(name),
		drainSuccessName
	);
	const drainSuccessSecondClose = await drainSuccess.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.waitForDirectClose(name),
		drainSuccessName
	);
	const drainSuccessSecondCounts = await selectedCounts(drainSuccess.page);
	await drainSuccess.page.close();

	const drainFailure = await openD108e3Creator(false);
	const drainFailureName = `drain-failure-${lifetimeScenario}`;
	await drainFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name),
		drainFailureName
	);
	await configure(drainFailure.page, { rejectPredecessorDeactivate: true, throwIssueLocal: true });
	await drainFailure.page.evaluate(
		({ name }) => window.phase6aCreatorSuccessorProduct.beginDirectSend(name, "drain-failure"),
		{ name: drainFailureName }
	);
	await expect
		.poll(() =>
			drainFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().issueThrowCount)
		)
		.toBe(1);
	await drainFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectClose(name),
		drainFailureName
	);
	const drainFailureClose = await drainFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.waitForDirectClose(name),
		drainFailureName
	);
	const drainFailureCounts = await selectedCounts(drainFailure.page);
	await drainFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectClose(name),
		drainFailureName
	);
	const drainFailureSecondClose = await drainFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.waitForDirectClose(name),
		drainFailureName
	);
	const drainFailureSecondCounts = await selectedCounts(drainFailure.page);
	await drainFailure.page.close();

	const rehearsalThenAdoption = await openD108e3Creator(true);
	await configure(rehearsalThenAdoption.page, { pauseMigrationRecord: true });
	await rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginRehearsal());
	await expect
		.poll(() =>
			rehearsalThenAdoption.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().migrationRecordIssueCount
			)
		)
		.toBe(1);
	await rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	await settleBrowserTurns(rehearsalThenAdoption.page);
	const rehearsalThenAdoptionBefore = await selectedCounts(rehearsalThenAdoption.page);
	await rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseMigrationRecord());
	const [rehearsalFirst, rehearsalSecond] = await Promise.all([
		rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForRehearsal()),
		rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
	]);
	const rehearsalThenAdoptionAfter = await selectedCounts(rehearsalThenAdoption.page);
	await disposeD108e3Creator(rehearsalThenAdoption);

	const activationThenAdoption = await openD108e3Creator(true);
	await configure(activationThenAdoption.page, {});
	await activationThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.prepareRehearsal());
	await configure(activationThenAdoption.page, { pauseTerminalTransition: true, retainTarget: true });
	await activationThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginActivation());
	await expect
		.poll(() =>
			activationThenAdoption.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().terminalTransitionCount
			)
		)
		.toBe(1);
	await activationThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	await settleBrowserTurns(activationThenAdoption.page);
	const activationThenAdoptionBefore = await selectedCounts(activationThenAdoption.page);
	await activationThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseTerminalTransition());
	const [activationFirst, activationSecond] = await Promise.all([
		activationThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForActivation()),
		activationThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
	]);
	const activationThenAdoptionAfter = await selectedCounts(activationThenAdoption.page);
	await disposeD108e3Creator(activationThenAdoption);

	const adoptionThenRehearsal = await openD108e3Creator(true);
	await configure(adoptionThenRehearsal.page, { pauseVerification: true });
	await adoptionThenRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	await expect
		.poll(() =>
			adoptionThenRehearsal.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().verificationCount
			)
		)
		.toBe(1);
	await adoptionThenRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginRehearsal());
	await settleBrowserTurns(adoptionThenRehearsal.page);
	const adoptionThenRehearsalBefore = await selectedCounts(adoptionThenRehearsal.page);
	await adoptionThenRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseVerification());
	const [rehearsalAfterAdoption, adoptionBeforeRehearsal] = await Promise.all([
		adoptionThenRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForRehearsal()),
		adoptionThenRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
	]);
	const adoptionThenRehearsalAfter = await selectedCounts(adoptionThenRehearsal.page);
	await disposeD108e3Creator(adoptionThenRehearsal);

	const adoptionThenActivation = await openD108e3Creator(true);
	await configure(adoptionThenActivation.page, {});
	await adoptionThenActivation.page.evaluate(() => window.phase6aCreatorSuccessorProduct.prepareRehearsal());
	await configure(adoptionThenActivation.page, { pauseVerification: true, retainTarget: true });
	await adoptionThenActivation.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginAdoption());
	await expect
		.poll(() =>
			adoptionThenActivation.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().verificationCount
			)
		)
		.toBe(1);
	await adoptionThenActivation.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginActivation());
	await settleBrowserTurns(adoptionThenActivation.page);
	const adoptionThenActivationBefore = await selectedCounts(adoptionThenActivation.page);
	await adoptionThenActivation.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseVerification());
	const [activationAfterAdoption, adoptionBeforeActivation] = await Promise.all([
		adoptionThenActivation.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForActivation()),
		adoptionThenActivation.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
	]);
	const adoptionThenActivationAfter = await selectedCounts(adoptionThenActivation.page);
	await disposeD108e3Creator(adoptionThenActivation);

	const overlappingRehearsal = await openD108e3Creator(true);
	await configure(overlappingRehearsal.page, { pauseMigrationRecord: true });
	await overlappingRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginRehearsal());
	await expect
		.poll(() =>
			overlappingRehearsal.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().migrationRecordIssueCount
			)
		)
		.toBe(1);
	await overlappingRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginOverlappingRehearsal());
	const overlappingRehearsalSecond = await overlappingRehearsal.page.evaluate(() =>
		window.phase6aCreatorSuccessorProduct.waitForOverlappingRehearsal()
	);
	const overlappingRehearsalBefore = await selectedCounts(overlappingRehearsal.page);
	await overlappingRehearsal.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseMigrationRecord());
	const overlappingRehearsalFirst = await overlappingRehearsal.page.evaluate(() =>
		window.phase6aCreatorSuccessorProduct.waitForRehearsal()
	);
	await disposeD108e3Creator(overlappingRehearsal);

	const independent = await openD108e3Creator(false);
	const independentA = `independent-a-${lifetimeScenario}`;
	const independentB = `independent-b-${lifetimeScenario}`;
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name),
		independentA
	);
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.sealDirectCreator(name),
		independentA
	);
	await configure(independent.page, { pauseVerification: true });
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectAdoption(name),
		independentA
	);
	await expect
		.poll(() =>
			independent.page.evaluate(() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().verificationCount)
		)
		.toBe(1);
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name),
		independentB
	);
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.sealDirectCreator(name),
		independentB
	);
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectAdoption(name),
		independentB
	);
	await expect
		.poll(() =>
			independent.page.evaluate(
				(name) => window.phase6aCreatorSuccessorProduct.directAdoptionSettled(name),
				independentB
			)
		)
		.toBe(true);
	const independentBeforeRelease = await selectedCounts(independent.page);
	const independentSettledBeforeRelease = await independent.page.evaluate(
		({ a, b }) =>
			Object.freeze({
				a: window.phase6aCreatorSuccessorProduct.directAdoptionSettled(a),
				b: window.phase6aCreatorSuccessorProduct.directAdoptionSettled(b),
			}),
		{ a: independentA, b: independentB }
	);
	await independent.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseVerification());
	const [independentASettlement, independentBSettlement] = await Promise.all([
		independent.page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(name),
			independentA
		),
		independent.page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(name),
			independentB
		),
	]);
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.closeDirectCreator(name),
		independentA
	);
	await independent.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.closeDirectCreator(name),
		independentB
	);
	await disposeD108e3Creator(independent);

	const retry = await openD108e3Creator(false);
	const retryName = `retry-${lifetimeScenario}`;
	await retry.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name), retryName);
	await configure(retry.page, {});
	await retry.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.beginDirectAdoption(name), retryName);
	const retryFirst = await retry.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(name),
		retryName
	);
	await retry.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.sealDirectCreator(name), retryName);
	await retry.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.beginDirectAdoption(name), retryName);
	const retrySecond = await retry.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(name),
		retryName
	);
	const retryCounts = await selectedCounts(retry.page);
	await retry.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.closeDirectCreator(name), retryName);
	await disposeD108e3Creator(retry);

	expect({
		failures: {
			activation: {
				beforeRelease: {
					adoptionSettled: activationBeforeRelease.adoptionSettled,
					closeSettled: activationBeforeRelease.closeSettled,
				},
				counts: {
					activationCount: activationCounts.activationCount,
					replacementDeactivateCount: activationCounts.replacementDeactivateCount,
				},
				settlements: { adoption: activationAdoption, close: activationClose },
			},
			cleanup: { authority: cleanupAuthority, counts: cleanupCounts, settlement: cleanupSettlement },
			drainFailure: {
				counts: drainFailureCounts,
				secondCounts: drainFailureSecondCounts,
				settlements: { first: drainFailureClose, second: drainFailureSecondClose },
			},
			drainSuccess: {
				counts: drainSuccessCounts,
				deletion: drainSuccessDeletion,
				secondCounts: drainSuccessSecondCounts,
				settlements: { first: drainSuccessClose, second: drainSuccessSecondClose },
			},
		},
		serialization: {
			activationThenAdoption: {
				after: { verificationCount: activationThenAdoptionAfter.verificationCount },
				before: {
					firstSettled: activationThenAdoptionBefore.activationSettled,
					preVerification: activationThenAdoptionBefore.verificationCount,
					secondSettled: activationThenAdoptionBefore.adoptionSettled,
				},
				settled: [
					{ order: activationFirst.order, status: activationFirst.status },
					{ order: activationSecond.order, status: activationSecond.status },
				],
			},
			adoptionThenActivation: {
				after: { terminalTransitionCount: adoptionThenActivationAfter.terminalTransitionCount },
				before: {
					firstSettled: adoptionThenActivationBefore.adoptionSettled,
					preTerminal: adoptionThenActivationBefore.terminalTransitionCount,
					secondSettled: adoptionThenActivationBefore.activationSettled,
				},
				settled: [
					{ order: adoptionBeforeActivation.order, status: adoptionBeforeActivation.status },
					{ order: activationAfterAdoption.order, status: activationAfterAdoption.status },
				],
			},
			adoptionThenRehearsal: {
				after: { migrationRecordIssueCount: adoptionThenRehearsalAfter.migrationRecordIssueCount },
				before: {
					firstSettled: adoptionThenRehearsalBefore.adoptionSettled,
					preRecord: adoptionThenRehearsalBefore.migrationRecordIssueCount,
					secondSettled: adoptionThenRehearsalBefore.rehearsalSettled,
				},
				settled: [
					{ order: adoptionBeforeRehearsal.order, status: adoptionBeforeRehearsal.status },
					{ order: rehearsalAfterAdoption.order, status: rehearsalAfterAdoption.status },
				],
			},
			independent: {
				before: independentSettledBeforeRelease,
				preIndependentVerification: independentBeforeRelease.independentVerificationCount,
				settled: {
					a: { order: independentASettlement.order, status: independentASettlement.status },
					b: { order: independentBSettlement.order, status: independentBSettlement.status },
				},
			},
			overlappingRehearsal: {
				before: {
					migrationRecordIssueCount: overlappingRehearsalBefore.migrationRecordIssueCount,
					rehearsalSettled: overlappingRehearsalBefore.rehearsalSettled,
				},
				settled: { first: overlappingRehearsalFirst, second: overlappingRehearsalSecond },
			},
			rehearsalThenAdoption: {
				after: { verificationCount: rehearsalThenAdoptionAfter.verificationCount },
				before: {
					firstSettled: rehearsalThenAdoptionBefore.rehearsalSettled,
					preVerification: rehearsalThenAdoptionBefore.verificationCount,
					secondSettled: rehearsalThenAdoptionBefore.adoptionSettled,
				},
				settled: [
					{ order: rehearsalFirst.order, status: rehearsalFirst.status },
					{ order: rehearsalSecond.order, status: rehearsalSecond.status },
				],
			},
			retry: {
				settled: [retryFirst.status, retrySecond.status],
				verificationCount: retryCounts.verificationCount,
			},
		},
	}).toEqual({
		failures: {
			activation: {
				beforeRelease: { adoptionSettled: false, closeSettled: false },
				counts: { activationCount: 1, replacementDeactivateCount: 0 },
				settlements: {
					adoption: {
						detail: "v3 room successor activation failed: authority-unavailable",
						lifetime: expect.any(Object),
						order: 1,
						status: "rejected",
					},
					close: { lifetime: expect.any(Object), order: 2, status: "fulfilled" },
				},
			},
			cleanup: {
				authority: null,
				counts: expect.objectContaining({
					predecessorDeactivateCount: 1,
					replacementDeactivateCompletedCount: 0,
					replacementDeactivateCount: 1,
				}),
				settlement: {
					aggregate: [
						"D.108e2b injected predecessor deactivation failure",
						"D.108e3 injected replacement deactivation failure",
					],
					detail: "D.108e2b injected predecessor deactivation failure",
					lifetime: expect.any(Object),
					order: 1,
					status: "rejected",
				},
			},
			drainFailure: {
				counts: expect.objectContaining({ issueThrowCount: 1, predecessorDeactivateCount: 1, sendSettled: false }),
				secondCounts: expect.objectContaining({ predecessorDeactivateCount: 1 }),
				settlements: {
					first: {
						aggregate: [
							"D.108e3 injected pending-issue drain failure",
							"D.108e2b injected predecessor deactivation failure",
						],
						detail: "D.108e3 injected pending-issue drain failure",
						lifetime: expect.any(Object),
						order: 1,
						status: "rejected",
					},
					second: expect.objectContaining({ detail: "D.108e3 injected pending-issue drain failure" }),
				},
			},
			drainSuccess: {
				counts: expect.objectContaining({ issueThrowCount: 1, predecessorDeactivateCount: 1, sendSettled: false }),
				deletion: {
					names: expect.arrayContaining([`d108e3-direct-${drainSuccessName}--ahe`]),
					status: "fulfilled",
				},
				secondCounts: expect.objectContaining({ predecessorDeactivateCount: 1 }),
				settlements: {
					first: expect.objectContaining({
						detail: "D.108e3 injected pending-issue drain failure",
						status: "rejected",
					}),
					second: expect.objectContaining({
						detail: "D.108e3 injected pending-issue drain failure",
						status: "rejected",
					}),
				},
			},
		},
		serialization: {
			activationThenAdoption: {
				after: { verificationCount: 1 },
				before: { firstSettled: false, preVerification: 0, secondSettled: false },
				settled: [
					{ order: 1, status: "fulfilled" },
					{ order: 2, status: "fulfilled" },
				],
			},
			adoptionThenActivation: {
				after: { terminalTransitionCount: 1 },
				before: { firstSettled: false, preTerminal: 0, secondSettled: false },
				settled: [
					{ order: 1, status: "fulfilled" },
					{ order: 2, status: "fulfilled" },
				],
			},
			adoptionThenRehearsal: {
				after: { migrationRecordIssueCount: 1 },
				before: { firstSettled: false, preRecord: 0, secondSettled: false },
				settled: [
					{ order: 1, status: "fulfilled" },
					{ order: 2, status: "fulfilled" },
				],
			},
			independent: {
				before: { a: false, b: true },
				preIndependentVerification: 1,
				settled: {
					a: { order: 2, status: "fulfilled" },
					b: { order: 1, status: "fulfilled" },
				},
			},
			overlappingRehearsal: {
				before: { migrationRecordIssueCount: 1, rehearsalSettled: false },
				settled: {
					first: { lifetime: expect.any(Object), order: 2, status: "fulfilled" },
					second: {
						detail: "v3 room migration rehearsal is already active",
						lifetime: expect.any(Object),
						order: 1,
						status: "rejected",
					},
				},
			},
			rehearsalThenAdoption: {
				after: { verificationCount: 1 },
				before: { firstSettled: false, preVerification: 0, secondSettled: false },
				settled: [
					{ order: 1, status: "fulfilled" },
					{ order: 2, status: "fulfilled" },
				],
			},
			retry: { settled: ["rejected", "fulfilled"], verificationCount: 2 },
		},
	});
});
