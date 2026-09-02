import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { captureProcessForest, processClosure } from "./fixtures/process-forest.js";

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
			string,
		];
		readonly D108E5_BROWSER_BEHAVIORS: readonly [string, string, string, string];
		isD108d2Authority(value: unknown): boolean;
		isD110cBSuccessorAuthority(value: unknown, expectedEpoch: number): boolean;
	}>
>;
// @ts-expect-error Playwright loads this ESM test before registration; the package typecheck uses an older module target.
const contract = await contractLoad;
const D108D2_BROWSER_BEHAVIORS = contract.D108D2_BROWSER_BEHAVIORS;
const D108E2B_BROWSER_BEHAVIORS = contract.D108E2B_BROWSER_BEHAVIORS;
const D108E2C_PRODUCT_BROWSER_BEHAVIORS = contract.D108E2C_PRODUCT_BROWSER_BEHAVIORS;
const D108E3_BROWSER_BEHAVIORS = contract.D108E3_BROWSER_BEHAVIORS;
const D108E5_BROWSER_BEHAVIORS = contract.D108E5_BROWSER_BEHAVIORS;
let isD108d2Authority: (value: unknown) => boolean = () => false;
let isD110cBSuccessorAuthority: (value: unknown, expectedEpoch: number) => boolean = () => false;
const DATABASES = Object.freeze({ creator: "d108d2-creator", established: "d108d2-established", late: "d108d2-late" });
const CHANNEL_NAME = "d108d2-successor-product";

function lifetimeInstrumentationPlugin(): Plugin {
	const v3Live = resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts");
	const creatorClose = resolve(REPOSITORY_ROOT, "packages/node/src/creator-close.ts");
	const creatorAdoption = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts");
	const creatorAdoptionCommit = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-commit.ts");
	const creatorAdoptionStage = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-stage.ts");
	const creatorAdoptionRecover = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-recover.ts");
	const creatorAdoptionActivate = resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-activate.ts");
	const shared = `
const stateSymbol = Symbol.for("ts-drp/d108e2b/lifetime-state");
const planeMapSymbol = Symbol.for("ts-drp/d108e2b/instrumented-planes");
const planeIdMapSymbol = Symbol.for("ts-drp/d108e3/instrumented-plane-ids");
const closeHandlePlaneIdMapSymbol = Symbol.for("ts-drp/d108e3/close-handle-plane-ids");
function createState() {
  const state = {
    acceptedVertexFailureCount: 0,
    acceptedVertexFailureGate: Promise.resolve(),
    activationCount: 0,
    activationFailureGate: Promise.resolve(),
    closeBindCount: 0,
    closeBindFailureCount: 0,
    commitCount: 0,
    coldReopenCount: 0,
    d110c0cRecoveryCallCount: 0,
    d110c0cRecoveryResultKind: null,
    d110c0cRecoverySwapHeadCount: 0,
    failBeforePublication: false,
    injectActivationFailure: false,
    independentVerificationCount: 0,
    issueThrowCount: 0,
    latestPredecessorPlaneId: 0,
    migrationRecordGate: Promise.resolve(),
    migrationRecordIssueCount: 0,
    mutateStagedDescriptor: false,
    nestedPredecessorDeactivateCount: 0,
    nextPlaneId: 1,
    pauseAfterActivation: false,
    pauseAcceptedVertexFailure: false,
    pauseActivationFailure: false,
    pauseAfterPredecessorDeactivation: false,
    pauseMigrationRecord: false,
    pauseRedirectRecovery: false,
    pauseTerminalTransition: false,
    pauseVerification: false,
    postActivationGate: Promise.resolve(),
    postActivationPauseCount: 0,
    postPredecessorDeactivationGate: Promise.resolve(),
    postPredecessorDeactivationPauseCount: 0,
    predecessorDeactivateCount: 0,
    rejectPredecessorDeactivate: false,
    rejectCloseBind: false,
    rejectReplacementDeactivate: false,
    releaseAcceptedVertexFailure: undefined,
    releaseActivationFailure: undefined,
    releaseMigrationRecord: undefined,
    releaseRedirectRecovery: undefined,
    releasePostActivation: undefined,
    releasePostPredecessorDeactivation: undefined,
    releaseTerminalTransition: undefined,
    releaseVerification: undefined,
    replacementDeactivateCount: 0,
    replacementDeactivateCompletedCount: 0,
    replacementPlanes: new Set(),
    redirectRecoveryCount: 0,
    redirectRecoveryGate: Promise.resolve(),
    targetPlaneId: 0,
    terminalTransitionCount: 0,
    terminalTransitionGate: Promise.resolve(),
    throwIssueLocal: false,
    verificationCount: 0,
    d108e5VerificationCount: 0,
    d108e5Mode: false,
    verificationGate: Promise.resolve(),
  };
  const configure = (input) => {
    state.acceptedVertexFailureCount = 0;
    state.activationCount = 0;
    state.closeBindCount = 0;
    state.closeBindFailureCount = 0;
    state.commitCount = 0;
    state.coldReopenCount = 0;
    state.d110c0cRecoveryCallCount = 0;
    state.d110c0cRecoveryResultKind = null;
    state.d110c0cRecoverySwapHeadCount = 0;
    state.failBeforePublication = input.failBeforePublication === true;
    state.injectActivationFailure = input.injectActivationFailure === true;
    state.independentVerificationCount = 0;
    state.issueThrowCount = 0;
    state.migrationRecordIssueCount = 0;
    state.mutateStagedDescriptor = input.mutateStagedDescriptor === true;
    state.nestedPredecessorDeactivateCount = 0;
    state.pauseAfterActivation = input.pauseAfterActivation === true;
    state.pauseAcceptedVertexFailure = input.pauseAcceptedVertexFailure === true;
    state.pauseActivationFailure = input.pauseActivationFailure === true;
    state.pauseAfterPredecessorDeactivation = input.pauseAfterPredecessorDeactivation === true;
    state.pauseMigrationRecord = input.pauseMigrationRecord === true;
    state.pauseRedirectRecovery = input.pauseRedirectRecovery === true;
    state.d108e5Mode = input.pauseRedirectRecovery === true;
    state.pauseTerminalTransition = input.pauseTerminalTransition === true;
    state.pauseVerification = input.pauseVerification === true;
    state.postActivationPauseCount = 0;
    state.postPredecessorDeactivationPauseCount = 0;
    state.predecessorDeactivateCount = 0;
    state.rejectPredecessorDeactivate = input.rejectPredecessorDeactivate === true;
    state.rejectCloseBind = input.rejectCloseBind === true;
    state.rejectReplacementDeactivate = input.rejectReplacementDeactivate === true;
    state.replacementDeactivateCount = 0;
    state.replacementDeactivateCompletedCount = 0;
    state.redirectRecoveryCount = 0;
    if (input.retainTarget !== true) state.targetPlaneId = state.latestPredecessorPlaneId;
    state.terminalTransitionCount = 0;
    state.throwIssueLocal = input.throwIssueLocal === true;
    state.verificationCount = 0;
    state.d108e5VerificationCount = 0;
    state.acceptedVertexFailureGate = state.pauseAcceptedVertexFailure
      ? new Promise((resolve) => { state.releaseAcceptedVertexFailure = resolve; })
      : Promise.resolve();
    state.activationFailureGate = state.pauseActivationFailure
      ? new Promise((resolve) => { state.releaseActivationFailure = resolve; })
      : Promise.resolve();
    state.migrationRecordGate = state.pauseMigrationRecord
      ? new Promise((resolve) => { state.releaseMigrationRecord = resolve; })
      : Promise.resolve();
    state.redirectRecoveryGate = state.pauseRedirectRecovery
      ? new Promise((resolve) => { state.releaseRedirectRecovery = resolve; })
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
    if (!state.pauseAcceptedVertexFailure) state.releaseAcceptedVertexFailure = undefined;
    if (!state.pauseMigrationRecord) state.releaseMigrationRecord = undefined;
    if (!state.pauseRedirectRecovery) state.releaseRedirectRecovery = undefined;
    if (!state.pauseAfterActivation) state.releasePostActivation = undefined;
    if (!state.pauseAfterPredecessorDeactivation) state.releasePostPredecessorDeactivation = undefined;
    if (!state.pauseVerification) state.releaseVerification = undefined;
    if (!state.pauseTerminalTransition) state.releaseTerminalTransition = undefined;
  };
  Object.defineProperty(globalThis, "__d108e2bLifetimeInstrumentation", {
    configurable: false,
    value: Object.freeze({
      acceptedVertex: async () => {
        if (!state.pauseAcceptedVertexFailure) return;
        state.acceptedVertexFailureCount += 1;
        await state.acceptedVertexFailureGate;
        throw new TypeError("D.108e3 injected accepted-vertex failure");
      },
      cleanupReplacements: async () => {
        await Promise.allSettled(Array.from(state.replacementPlanes, (plane) => plane.deactivate()));
      },
      configure,
      d110cColdReopenCount: () => state.coldReopenCount,
      d110c0cRecoverySnapshot: () => Object.freeze({
        callCount: state.d110c0cRecoveryCallCount,
        resultKind: state.d110c0cRecoveryResultKind,
        swapHeadCount: state.d110c0cRecoverySwapHeadCount,
      }),
      d108e5Snapshot: () => Object.freeze({
        redirectRecoveryCount: state.redirectRecoveryCount,
        verificationCount: state.d108e5VerificationCount,
      }),
      releaseAcceptedVertexFailure: () => {
        state.pauseAcceptedVertexFailure = false;
        state.releaseAcceptedVertexFailure?.();
        state.releaseAcceptedVertexFailure = undefined;
      },
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
      releaseRedirectRecovery: () => {
        state.pauseRedirectRecovery = false;
        state.releaseRedirectRecovery?.();
        state.releaseRedirectRecovery = undefined;
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
      d110cBSnapshot: () => Object.freeze({
        activationCount: state.activationCount,
        closeBindCount: state.closeBindCount,
        closeBindFailureCount: state.closeBindFailureCount,
        predecessorDeactivateCount: state.predecessorDeactivateCount,
      }),
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
        acceptedVertexFailureCount: state.acceptedVertexFailureCount,
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
export const recoverV3LiveReplica = async (input) => {
  if (input?.displacedSource?.activationVertexDigest !== undefined) {
    state.redirectRecoveryCount += 1;
    if (state.pauseRedirectRecovery) await state.redirectRecoveryGate;
  }
  return actual.recoverV3LiveReplica(input);
};
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
  if (planeId === state.targetPlaneId) {
    state.closeBindCount += 1;
    if (state.rejectCloseBind) {
      state.rejectCloseBind = false;
      state.closeBindFailureCount += 1;
      return Object.freeze({ ok: false, reason: "STORE_UNAVAILABLE" });
    }
  }
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
  if (state.d108e5Mode) state.d108e5VerificationCount += 1;
  if (targeted) state.verificationCount += 1;
  else state.independentVerificationCount += 1;
  if ((targeted || state.d108e5Mode) && state.pauseVerification) await state.verificationGate;
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
					"@ts-drp/node/creator-adoption-stage",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionStage)};
export const stageCreatorSuccessorAdoption = async (input) => {
  if (closeHandlePlaneIds.get(input.handle) === state.targetPlaneId) state.commitCount += 1;
  const result = await actual.stageCreatorSuccessorAdoption(input);
  if (state.mutateStagedDescriptor && result.ok === true) {
    state.mutateStagedDescriptor = false;
    return Object.freeze({
      ...result,
      descriptor: Object.freeze({ ...result.descriptor, epoch: Number(result.descriptor.epoch) + 1 }),
    });
  }
  return result;
};
export const publishStagedCreatorSuccessorAdoption = async (input) => {
  if (state.failBeforePublication) {
    state.failBeforePublication = false;
    throw new TypeError("D110C controlled pre-publication process death");
  }
  return actual.publishStagedCreatorSuccessorAdoption(input);
};`,
				],
				[
					"@ts-drp/node/creator-adoption-recover",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionRecover)};
export const recoverPendingCreatorSuccessorAdoption = async (input) => {
  state.d110c0cRecoveryCallCount += 1;
  const store = new Proxy(input.store, {
    get(target, key) {
      if (key === "swapHead") {
        return (...args) => {
          state.d110c0cRecoverySwapHeadCount += 1;
          return Reflect.apply(target.swapHead, target, args);
        };
      }
      const selected = Reflect.get(target, key, target);
      return typeof selected === "function" ? selected.bind(target) : selected;
    },
  });
  const result = await actual.recoverPendingCreatorSuccessorAdoption({ ...input, store });
  state.d110c0cRecoveryResultKind = result.ok === true ? result.recovery : result.kind;
  return result;
};`,
				],
				[
					"@ts-drp/node/creator-adoption-activate",
					`${shared}
import * as actual from ${JSON.stringify(creatorAdoptionActivate)};
export const reopenCreatorSuccessorAdoption = async (input) => {
  state.coldReopenCount += 1;
  return actual.reopenCreatorSuccessorAdoption(input);
};
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
						"@ts-drp/node/creator-adoption-recover",
						"@ts-drp/node/creator-adoption-stage",
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

async function heldTsDrpLocks(page: Page): Promise<readonly string[]> {
	return page.evaluate(async () => {
		const query = Reflect.get(navigator.locks, "query");
		if (typeof query !== "function") throw new TypeError("D110C_B_LOCK_QUERY_UNAVAILABLE");
		const selected = (await Reflect.apply(query, navigator.locks, [])) as Readonly<{
			readonly held?: readonly Readonly<{ readonly name?: string }>[];
		}>;
		return Object.freeze(
			(selected.held ?? [])
				.flatMap(({ name }) => (typeof name === "string" && name.startsWith("ts-drp:") ? [name] : []))
				.sort()
		);
	});
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
	isD110cBSuccessorAuthority = contract.isD110cBSuccessorAuthority;
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
		roomHead: {
			currentAnchorDigest: carrier.authority.anchorDigest,
			epoch: carrier.authority.epoch,
			objectId: carrier.authority.objectId,
		},
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
		roomHead: {
			currentAnchorDigest: carrier.authority.anchorDigest,
			epoch: carrier.authority.epoch,
			objectId: carrier.authority.objectId,
		},
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
		roomHead: {
			currentAnchorDigest: carrier.authority.anchorDigest,
			epoch: carrier.authority.epoch,
			objectId: carrier.authority.objectId,
		},
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

test("D.110c-0b0 provider crash and classification matrix fails closed", async () => {
	if (creator === undefined) throw new TypeError("D.110c browser realm is absent");
	const matrix = (await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.d110cFloorMatrix())) as Readonly<
		Record<string, unknown>
	>;
	const adoption = (key: string): Readonly<Record<string, unknown>> => matrix[key] as Readonly<Record<string, unknown>>;
	expect(adoption("beginConflict").detail).toBe("D110C_FLOOR_CONFLICT");
	expect(adoption("beginMalformed").detail).toBe("D110C_FLOOR_INVALID");
	expect(adoption("beginUnavailable").detail).toBe("D110C_FLOOR_UNAVAILABLE");
	expect(adoption("commitConflict").detail).toBe("D110C_FLOOR_CONFLICT");
	expect(adoption("commitMalformed").detail).toBe("D110C_FLOOR_INVALID");
	expect(matrix.createConflict).toBe("D110C_FLOOR_CONFLICT");
	expect(matrix.createMalformed).toBe("D110C_FLOOR_INVALID");
	expect(matrix.createUnavailable).toBe("D110C_FLOOR_UNAVAILABLE");
	expect(matrix.crossGenesis).toBe("D110C_FLOOR_INVALID");
	expect(matrix.floorAhead).toBe("D110C_FLOOR_MISMATCH");
	expect(matrix.headAhead).toBe("D110C_FLOOR_HEAD_AHEAD");
	expect(matrix.migrateCrossObject).toBe("D110C_FLOOR_INVALID");
	expect(matrix.missingReopen).toBe("D110C_FLOOR_MIGRATION_REQUIRED");
	expect(adoption("pendingInvalid").detail).toBe("D110C_FLOOR_PENDING_INVALID");
	expect(matrix.readMalformed).toBe("D110C_FLOOR_INVALID");
	expect(matrix.readUnavailable).toBe("D110C_FLOOR_UNAVAILABLE");
	expect(adoption("regression").detail).toBe("D110C_FLOOR_REGRESSION");

	const noDeclaration = matrix.pendingWithoutDeclaration as Readonly<Record<string, unknown>>;
	expect(noDeclaration).toMatchObject({
		coldReopenCount: 0,
		detail: "D110C_FLOOR_RECOVERY_UNAVAILABLE",
		transportOpenCount: 0,
	});
	for (const [key, operations] of [
		["pendingOldAhe", ["create", "read", "begin", "read", "commit", "read"]],
		["pendingNewAhe", ["create", "read", "begin", "commit", "read", "commit", "read"]],
	] as const) {
		const recovered = matrix[key] as Readonly<Record<string, unknown>>;
		expect(recovered).toMatchObject({ coldReopenCount: 1, operations, transportOpenCount: 1 });
		expect(recovered.state).toMatchObject({ pending: null, stable: { epoch: 1 } });
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
			detail: failingSettlements[0].detail,
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
				verificationCount: 0,
			},
			detail: "D110C_B_ACTIVATION_STALLED",
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
			acceptedVertexFailureCount: Number(selected.acceptedVertexFailureCount),
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
	await configure(rehearsalThenAdoption.page, {});
	await rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.prepareRehearsal());
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
	await rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.beginActivation());
	await settleBrowserTurns(rehearsalThenAdoption.page);
	const rehearsalThenAdoptionBefore = await selectedCounts(rehearsalThenAdoption.page);
	await rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseMigrationRecord());
	const [rehearsalFirst, rehearsalSecond, rehearsalThird] = await Promise.all([
		rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForRehearsal()),
		rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForAdoption()),
		rehearsalThenAdoption.page.evaluate(() => window.phase6aCreatorSuccessorProduct.waitForActivation()),
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

	const queuedAcceptedFailure = await openD108e3Creator(false);
	const queuedAcceptedFailureName = `queued-accepted-failure-${lifetimeScenario}`;
	await queuedAcceptedFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name),
		queuedAcceptedFailureName
	);
	await configure(queuedAcceptedFailure.page, {
		pauseAcceptedVertexFailure: true,
		pauseMigrationRecord: true,
	});
	await queuedAcceptedFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectRehearsal(name),
		queuedAcceptedFailureName
	);
	await expect
		.poll(() =>
			queuedAcceptedFailure.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().migrationRecordIssueCount
			)
		)
		.toBe(1);
	await queuedAcceptedFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectAdoption(name),
		queuedAcceptedFailureName
	);
	await queuedAcceptedFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectSend(name, "queued-accepted-failure"),
		queuedAcceptedFailureName
	);
	await expect
		.poll(() =>
			queuedAcceptedFailure.page.evaluate(
				() => window.phase6aCreatorSuccessorProduct.transitionSnapshot().acceptedVertexFailureCount
			)
		)
		.toBe(1);
	const queuedAcceptedFailureBefore = Object.freeze({
		...(await selectedCounts(queuedAcceptedFailure.page)),
		directAdoptionSettled: await queuedAcceptedFailure.page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.directAdoptionSettled(name),
			queuedAcceptedFailureName
		),
	});
	await queuedAcceptedFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseAcceptedVertexFailure());
	await queuedAcceptedFailure.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseMigrationRecord());
	await queuedAcceptedFailure.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.beginDirectClose(name),
		queuedAcceptedFailureName
	);
	const queuedAcceptedFailureSettlements = await queuedAcceptedFailure.page.evaluate(
		async (name) =>
			Promise.race([
				Promise.all([
					window.phase6aCreatorSuccessorProduct.waitForSend(),
					window.phase6aCreatorSuccessorProduct.waitForDirectRehearsal(name),
					window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(name),
					window.phase6aCreatorSuccessorProduct.waitForDirectClose(name),
				]).then(([send, rehearsal, adoption, close]) =>
					Object.freeze({ adoption, close, rehearsal, send, status: "settled" as const })
				),
				new Promise<Readonly<{ readonly status: "pending" }>>((resolvePromise) => {
					setTimeout(() => resolvePromise(Object.freeze({ status: "pending" as const })), 3_000);
				}),
			]),
		queuedAcceptedFailureName
	);
	const queuedAcceptedFailureCounts = Object.freeze({
		...(await selectedCounts(queuedAcceptedFailure.page)),
		directAdoptionSettled: await queuedAcceptedFailure.page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.directAdoptionSettled(name),
			queuedAcceptedFailureName
		),
	});
	const queuedAcceptedFailureDeletion =
		queuedAcceptedFailureSettlements.status === "settled"
			? await queuedAcceptedFailure.page.evaluate(async (prefix) => {
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
				}, `d108e3-direct-${queuedAcceptedFailureName}`)
			: Object.freeze({ status: "not-attempted" as const });
	await queuedAcceptedFailure.page.close();

	expect({
		failures: {
			acceptedQueued: {
				before: queuedAcceptedFailureBefore,
				counts: queuedAcceptedFailureCounts,
				deletion: queuedAcceptedFailureDeletion,
				settlements: queuedAcceptedFailureSettlements,
			},
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
				after: {
					terminalTransitionCount: rehearsalThenAdoptionAfter.terminalTransitionCount,
					verificationCount: rehearsalThenAdoptionAfter.verificationCount,
				},
				before: {
					activationSettled: rehearsalThenAdoptionBefore.activationSettled,
					firstSettled: rehearsalThenAdoptionBefore.rehearsalSettled,
					preTerminal: rehearsalThenAdoptionBefore.terminalTransitionCount,
					preVerification: rehearsalThenAdoptionBefore.verificationCount,
					secondSettled: rehearsalThenAdoptionBefore.adoptionSettled,
				},
				settled: [
					{ order: rehearsalFirst.order, status: rehearsalFirst.status },
					{ order: rehearsalSecond.order, status: rehearsalSecond.status },
					{ order: rehearsalThird.order, status: rehearsalThird.status },
				],
			},
			retry: {
				settled: [retryFirst.status, retrySecond.status],
				verificationCount: retryCounts.verificationCount,
			},
		},
	}).toEqual({
		failures: {
			acceptedQueued: {
				before: expect.objectContaining({
					acceptedVertexFailureCount: 1,
					adoptionSettled: false,
					directAdoptionSettled: false,
					rehearsalSettled: false,
					sendSettled: false,
				}),
				counts: expect.objectContaining({
					acceptedVertexFailureCount: 1,
					adoptionSettled: false,
					closeSettled: true,
					directAdoptionSettled: true,
					predecessorDeactivateCount: 1,
					rehearsalSettled: true,
					sendSettled: true,
					verificationCount: 0,
				}),
				deletion: {
					names: expect.arrayContaining([`d108e3-direct-${queuedAcceptedFailureName}--ahe`]),
					status: "fulfilled",
				},
				settlements: {
					adoption: expect.objectContaining({ detail: "v3 room session is closed", status: "rejected" }),
					close: expect.objectContaining({ status: "fulfilled" }),
					rehearsal: expect.objectContaining({
						detail: "D.108e3 injected accepted-vertex failure",
						status: "rejected",
					}),
					send: expect.objectContaining({
						detail: "D.108e3 injected accepted-vertex failure",
						status: "rejected",
					}),
					status: "settled",
				},
			},
			activation: {
				beforeRelease: { adoptionSettled: false, closeSettled: false },
				counts: { activationCount: 1, replacementDeactivateCount: 0 },
				settlements: {
					adoption: {
						detail: "D110C_B_ACTIVATION_STALLED",
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
					{ order: 1, status: "rejected" },
					{ order: 2, status: "fulfilled" },
				],
			},
			adoptionThenActivation: {
				after: { terminalTransitionCount: 1 },
				before: { firstSettled: false, preTerminal: 0, secondSettled: false },
				settled: [
					{ order: 1, status: "fulfilled" },
					{ order: 2, status: "rejected" },
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
				after: { terminalTransitionCount: 0, verificationCount: 0 },
				before: {
					activationSettled: false,
					firstSettled: false,
					preTerminal: 0,
					preVerification: 0,
					secondSettled: false,
				},
				settled: [
					{ order: 1, status: "fulfilled" },
					{ order: 2, status: "fulfilled" },
					{ order: 3, status: "rejected" },
				],
			},
			retry: { settled: ["rejected", "fulfilled"], verificationCount: 1 },
		},
	});
});

test(D108E5_BROWSER_BEHAVIORS.join("; "), async () => {
	const runRedirectOrdering = async (
		kind: "activation" | "rehearsal"
	): Promise<
		Readonly<{
			readonly adoptionBeforeLater: boolean;
			readonly adoptionDetail?: string;
			readonly adoptionStatus: "fulfilled" | "rejected";
			readonly beforeRelease: Readonly<{ readonly adoption: boolean; readonly later: boolean }>;
			readonly redirectStatus: "fulfilled" | "rejected";
			readonly verificationCount: number;
		}>
	> => {
		const context = await openD108e3Creator(false);
		const name = `d108e5-${kind}-${lifetimeScenario}`;
		const redirectObservation = `${name}-redirect`;
		const laterObservation = `${name}-later`;
		await context.page.evaluate((selected) => window.phase6aCreatorSuccessorProduct.openDirectCreator(selected), name);
		await context.page.evaluate(
			(selected) => window.phase6aCreatorSuccessorProduct.prepareDirectRehearsal(selected),
			name
		);
		await context.page.evaluate(() =>
			window.phase6aCreatorSuccessorProduct.configureLifetime({
				pauseRedirectRecovery: true,
			})
		);
		await context.page.evaluate(
			({ observation, selected }) =>
				window.phase6aCreatorSuccessorProduct.beginD108e5DirectOperation(selected, observation, "activation"),
			{ observation: redirectObservation, selected: name }
		);
		await expect
			.poll(async () => {
				const state = await context.page.evaluate(
					(observation) =>
						Object.freeze({
							redirectRecoveryCount: window.phase6aCreatorSuccessorProduct.d108e5Snapshot().redirectRecoveryCount,
							settled: window.phase6aCreatorSuccessorProduct.d108e5OperationSettled(observation),
						}),
					redirectObservation
				);
				if (state.settled) {
					const settlement = await context.page.evaluate(
						(observation) => window.phase6aCreatorSuccessorProduct.waitForD108e5DirectOperation(observation),
						redirectObservation
					);
					throw new TypeError(`D.108e5 redirect activation settled before recovery: ${JSON.stringify(settlement)}`);
				}
				return state.redirectRecoveryCount;
			})
			.toBe(1);
		await context.page.evaluate(
			({ observation, operation, selected }) => {
				window.phase6aCreatorSuccessorProduct.beginDirectAdoption(selected);
				window.phase6aCreatorSuccessorProduct.beginD108e5DirectOperation(selected, observation, operation);
			},
			{ observation: laterObservation, operation: kind, selected: name }
		);
		const beforeRelease = await context.page.evaluate(
			({ later, selected }) =>
				Object.freeze({
					adoption: window.phase6aCreatorSuccessorProduct.directAdoptionSettled(selected),
					later: window.phase6aCreatorSuccessorProduct.d108e5OperationSettled(later),
				}),
			{ later: laterObservation, selected: name }
		);
		await context.page.evaluate(() => window.phase6aCreatorSuccessorProduct.releaseRedirectRecovery());
		const [redirect, later, adoption] = await Promise.all([
			context.page.evaluate(
				(observation) => window.phase6aCreatorSuccessorProduct.waitForD108e5DirectOperation(observation),
				redirectObservation
			),
			context.page.evaluate(
				(observation) => window.phase6aCreatorSuccessorProduct.waitForD108e5DirectOperation(observation),
				laterObservation
			),
			context.page.evaluate((selected) => window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(selected), name),
		]);
		const verificationCount = await context.page.evaluate(
			() => window.phase6aCreatorSuccessorProduct.d108e5Snapshot().verificationCount
		);
		await context.page.evaluate((selected) => window.phase6aCreatorSuccessorProduct.closeDirectCreator(selected), name);
		await context.page.close();
		return Object.freeze({
			adoptionBeforeLater:
				typeof adoption.order === "number" && typeof later.order === "number" && adoption.order < later.order,
			adoptionDetail: adoption.detail,
			adoptionStatus: adoption.status,
			beforeRelease,
			redirectStatus: redirect.status,
			verificationCount,
		});
	};

	const rehearsalOrdering = await runRedirectOrdering("rehearsal");
	const activationOrdering = await runRedirectOrdering("activation");

	const bounds = await openD108e3Creator(false);
	const boundsName = `d108e5-bounds-${lifetimeScenario}`;
	await bounds.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name), boundsName);
	const observations = await bounds.page.evaluate(
		(name) => window.phase6aCreatorSuccessorProduct.migrationBoundObservations(name),
		boundsName
	);
	await bounds.page.evaluate((name) => window.phase6aCreatorSuccessorProduct.closeDirectCreator(name), boundsName);
	await bounds.page.close();

	expect.soft(rehearsalOrdering).toMatchObject({
		adoptionBeforeLater: true,
		adoptionDetail: "D110C_B_ACTIVATION_STALLED",
		adoptionStatus: "rejected",
		beforeRelease: { adoption: false, later: false },
		redirectStatus: "fulfilled",
		verificationCount: 0,
	});
	expect.soft(activationOrdering).toMatchObject({
		adoptionBeforeLater: true,
		adoptionDetail: "D110C_B_ACTIVATION_STALLED",
		adoptionStatus: "rejected",
		beforeRelease: { adoption: false, later: false },
		redirectStatus: "fulfilled",
		verificationCount: 0,
	});
	expect.soft(observations.overLimitHex).toBe("v3 room migration target invite is unbounded");
	expect.soft(observations.exact65537).toBe("v3 room migration target invite is unbounded");
	expect.soft(observations.oversizedDigest).toBe("v3 room creator invite anchor is invalid");
	expect.soft(observations.nonByteField).toBe("v3 room creator invite exactCanonicalParametersCarrierBytes is invalid");

	expect(observations.activation49152).not.toBe("v3 room migration activation record is unbounded");
	expect(observations.activation49153).toBe("v3 room migration activation record is unbounded");
	expect(observations.exact65536).not.toBe("v3 room migration target invite is unbounded");
	expect(observations.boundedMutation).toBe("fulfilled");
});

test("D.110c-b advances one genuine room through hot epoch 0 to 1 to 2 and rebinds epoch 2 close custody", async ({
	browser,
	browserName,
}) => {
	const retainedPages = [creator, established, late].filter((page): page is Page => page !== undefined);
	const retainedBefore = await Promise.all(retainedPages.map(snapshot));
	const server = await startProductBrowserServer(
		new URL("./assets/phase-6a-creator-successor-product-entry.ts", import.meta.url).pathname
	);
	const isolatedContext = await browser.newContext();
	const page = await isolatedContext.newPage();
	const databaseName = "d110c-b-hot-creator";
	try {
		await openRealm(page, server.origin, "d110c-b-hot", () => [page]);
		await page.evaluate((input) => window.phase6aCreatorSuccessorProduct.create(input), {
			channelName: "d110c-b-hot-rollover",
			clientId: "alice",
			databaseName,
		});
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.configureLifetime({}));
		const initialLocks = browserName === "chromium" ? await heldTsDrpLocks(page) : Object.freeze([]);
		if (browserName === "chromium") expect(initialLocks).toHaveLength(0);
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.send("d110c-b-epoch-zero"));
		const closeZero = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
		expect(closeZero).toMatchObject({ epoch: 0, successorEpoch: 1 });
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.adoptSuccessor());
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.send("d110c-b-epoch-one"));
		const epochOne = await snapshot(page);
		expect(isD110cBSuccessorAuthority(epochOne.authority, 1)).toBe(true);
		expect(
			isD110cBSuccessorAuthority(
				await page.evaluate(
					({ databaseName: selected, epoch }) =>
						window.phase6aCreatorSuccessorProduct.rawAuthorityAtEpoch(selected, epoch),
					{ databaseName, epoch: 1 }
				),
				1
			)
		).toBe(true);
		expect(await page.evaluate(() => window.phase6aCreatorSuccessorProduct.d110cBSnapshot())).toEqual({
			activationCount: 1,
			closeBindCount: 1,
			closeBindFailureCount: 0,
			predecessorDeactivateCount: 1,
		});
		const epochOneLocks = browserName === "chromium" ? await heldTsDrpLocks(page) : Object.freeze([]);
		if (browserName === "chromium") expect(epochOneLocks).toHaveLength(1);
		const closeOne = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
		expect(closeOne).toMatchObject({ epoch: 1, successorEpoch: 2 });
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.adoptSuccessor());
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.send("d110c-b-epoch-two"));
		const epochTwo = await snapshot(page);
		expect(isD110cBSuccessorAuthority(epochTwo.authority, 2)).toBe(true);
		expect(epochTwo.authority).toMatchObject({
			epoch: 2,
			genesisAnchorDigest: (epochOne.authority as Readonly<Record<string, unknown>>).genesisAnchorDigest,
			objectId: (epochOne.authority as Readonly<Record<string, unknown>>).objectId,
		});
		expect(epochTwo.accepted).toHaveLength(3);
		expect((epochTwo.accepted as readonly Readonly<Record<string, unknown>>[]).map(({ text }) => text)).toEqual([
			"d110c-b-epoch-zero",
			"d110c-b-epoch-one",
			"d110c-b-epoch-two",
		]);
		expect(epochTwo.roomId).toBe((epochTwo.authority as Readonly<Record<string, unknown>>).anchorDigest);
		expect(epochTwo.latchedAcl).toMatchObject({ currentEpoch: 2, nextEpoch: 3 });
		expect(
			isD110cBSuccessorAuthority(
				await page.evaluate(
					({ databaseName: selected, epoch }) =>
						window.phase6aCreatorSuccessorProduct.rawAuthorityAtEpoch(selected, epoch),
					{ databaseName, epoch: 2 }
				),
				2
			)
		).toBe(true);
		expect(await page.evaluate(() => window.phase6aCreatorSuccessorProduct.d110cBSnapshot())).toEqual({
			activationCount: 2,
			closeBindCount: 2,
			closeBindFailureCount: 0,
			predecessorDeactivateCount: 1,
		});
		if (browserName === "chromium") expect(await heldTsDrpLocks(page)).toEqual(epochOneLocks);
		const closeTwo = await page.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
		expect(closeTwo).toMatchObject({ epoch: 2, successorEpoch: 3 });
		const pendingEpochThree = await snapshot(page);
		expect(pendingEpochThree.authority).toEqual(epochTwo.authority);
		expect(pendingEpochThree.accepted).toEqual(epochTwo.accepted);
		if (browserName === "chromium") expect(await heldTsDrpLocks(page)).toEqual(epochOneLocks);

		const closeBindFailureName = "d110c-b-close-bind-failure";
		await page.evaluate((name) => window.phase6aCreatorSuccessorProduct.openDirectCreator(name), closeBindFailureName);
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.configureLifetime({ rejectCloseBind: true }));
		await page.evaluate((name) => window.phase6aCreatorSuccessorProduct.sealDirectCreator(name), closeBindFailureName);
		await page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.beginDirectAdoption(name),
			closeBindFailureName
		);
		const closeBindFailure = await page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.waitForDirectAdoption(name),
			closeBindFailureName
		);
		const closeBindFailureState = await page.evaluate(
			(name) => window.phase6aCreatorSuccessorProduct.directCreatorState(name),
			closeBindFailureName
		);
		expect(closeBindFailure).toMatchObject({ detail: "D110C_B_CLOSE_REBIND_FAILED", status: "rejected" });
		expect(isD110cBSuccessorAuthority(closeBindFailureState.authority, 1)).toBe(true);
		expect(closeBindFailureState.status).toMatchObject({
			closeAuthority: "unavailable",
			continuity: "stalled",
			lifecycle: "active",
		});
		expect(await page.evaluate(() => window.phase6aCreatorSuccessorProduct.d110cBSnapshot())).toEqual({
			activationCount: 1,
			closeBindCount: 1,
			closeBindFailureCount: 1,
			predecessorDeactivateCount: 1,
		});
		if (browserName === "chromium") {
			const closeBindFailureLocks = await heldTsDrpLocks(page);
			expect(closeBindFailureLocks).toHaveLength(2);
			expect(closeBindFailureLocks).toContain(epochOneLocks[0]);
			expect(closeBindFailureLocks.filter((name) => name !== epochOneLocks[0])).toHaveLength(1);
		}
		await expect(
			page.evaluate((name) => window.phase6aCreatorSuccessorProduct.sealDirectCreator(name), closeBindFailureName)
		).rejects.toThrow("D110C_B_CLOSE_REBIND_FAILED");
		await page.evaluate((name) => window.phase6aCreatorSuccessorProduct.closeDirectCreator(name), closeBindFailureName);
		if (browserName === "chromium") expect(await heldTsDrpLocks(page)).toEqual(epochOneLocks);
		expect(await Promise.all(retainedPages.map(snapshot))).toEqual(retainedBefore);
		process.stdout.write("D110C_B_PRODUCT_HOT_LOOP_COMPLETE\n");
	} finally {
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.close()).catch(() => undefined);
		await page
			.evaluate((prefix) => window.phase6aCreatorSuccessorProduct.deleteDatabases(prefix), databaseName)
			.catch(() => undefined);
		await isolatedContext.close();
		await server.close();
	}
});

interface D110c0cChildMessage {
	readonly kind: "checkpoint" | "child-error" | "recovery";
	readonly message?: string;
	readonly result?: Readonly<Record<string, unknown>>;
}

function d110c0cRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("D110C_0C fixture record is invalid");
	}
	return value as Readonly<Record<string, unknown>>;
}

function d110c0cArray(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError("D110C_0C fixture array is invalid");
	return value;
}

function d110c0cKillGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function buildD110c0cChild(): Promise<Readonly<{ readonly directory: string; readonly path: string }>> {
	const directory = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".d110c-0c-child-"));
	const path = join(directory, "phase-6b-durable-pending-recovery-child.js");
	await build({
		bundle: true,
		entryPoints: [resolve(import.meta.dirname, "process/phase-6b-durable-pending-recovery-child.ts")],
		format: "esm",
		outfile: path,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	return Object.freeze({ directory, path });
}

function runD110c0cStage(
	childPath: string,
	input: Readonly<{
		readonly name: string;
		readonly ordering: "new-ahe" | "old-ahe";
		readonly profileDirectory: string;
		readonly url: string;
	}>
): Promise<Readonly<Record<string, unknown>>> {
	return new Promise((resolvePromise, reject) => {
		const encoded = Buffer.from(JSON.stringify({ ...input, mode: "stage" })).toString("base64url");
		const child = spawn(process.execPath, [childPath, encoded], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let checkpoint: Readonly<Record<string, unknown>> | undefined;
		let killed = false;
		let killedPids: readonly number[] = [];
		let stderr = "";
		let stdout = "";
		const timeout = setTimeout(() => {
			if (child.pid !== undefined) d110c0cKillGroup(child.pid);
			reject(new Error(`D110C_0C stage timeout: ${stdout}\n${stderr}`));
		}, 120_000);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (value: string) => (stdout += value));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: D110c0cChildMessage) => {
			try {
				if (message.kind === "child-error") throw new TypeError(message.message ?? "D110C_0C child failed");
				if (message.kind !== "checkpoint" || message.result === undefined || child.pid === undefined) return;
				checkpoint = message.result;
				const owned = processClosure(captureProcessForest(), child.pid);
				if (owned.length < 2) throw new TypeError("D110C_0C browser process forest is empty");
				killed = true;
				killedPids = Object.freeze(owned.map(({ pid }) => pid));
				const groups = [...new Set(owned.map(({ pgid }) => pgid))].filter((pgid) => pgid > 0 && pgid !== child.pid);
				for (const pgid of groups) d110c0cKillGroup(pgid);
				d110c0cKillGroup(child.pid);
			} catch (error) {
				if (child.pid !== undefined) d110c0cKillGroup(child.pid);
				reject(error);
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (!killed || checkpoint === undefined || code !== null || signal !== "SIGKILL") {
				reject(
					new Error(
						`D110C_0C expected staged browser SIGKILL, got ${String(code)}/${String(signal)}: ${stdout}\n${stderr}`
					)
				);
				return;
			}
			const deadline = Date.now() + 10_000;
			const poll = (): void => {
				const live = new Set(captureProcessForest().map(({ pid }) => pid));
				if (killedPids.every((pid) => !live.has(pid))) resolvePromise(checkpoint as Readonly<Record<string, unknown>>);
				else if (Date.now() >= deadline) reject(new Error("D110C_0C browser process forest survived SIGKILL"));
				else setTimeout(poll, 25);
			};
			poll();
		});
	});
}

function runD110c0cRecovery(
	childPath: string,
	input: Readonly<{ readonly name: string; readonly profileDirectory: string; readonly url: string }>
): Promise<Readonly<Record<string, unknown>>> {
	return new Promise((resolvePromise, reject) => {
		const encoded = Buffer.from(JSON.stringify({ ...input, mode: "recover" })).toString("base64url");
		const child = spawn(process.execPath, [childPath, encoded], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let observed: Readonly<Record<string, unknown>> | undefined;
		let stderr = "";
		let stdout = "";
		const terminate = (): void => {
			if (child.pid === undefined) return;
			const owned = processClosure(captureProcessForest(), child.pid);
			const groups = [...new Set(owned.map(({ pgid }) => pgid))].filter((pgid) => pgid > 0);
			for (const pgid of groups) d110c0cKillGroup(pgid);
			d110c0cKillGroup(child.pid);
		};
		const timeout = setTimeout(() => {
			terminate();
			reject(new Error(`D110C_0C recovery timeout: ${stdout}\n${stderr}`));
		}, 120_000);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (value: string) => (stdout += value));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: D110c0cChildMessage) => {
			if (message.kind === "recovery") observed = message.result;
			if (message.kind === "child-error") {
				terminate();
				reject(new TypeError(message.message ?? "D110C_0C child failed"));
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0 || signal !== null || observed === undefined) {
				reject(new Error(`D110C_0C recovery child failed ${String(code)}/${String(signal)}: ${stdout}\n${stderr}`));
			} else {
				resolvePromise(observed);
			}
		});
	});
}

test("D.110c-0c resumes a genuine epoch-3 pending adoption after both process-death orderings", async ({
	browserName: _browserName,
}, testInfo) => {
	const token = "D110C_0C_PENDING_EPOCH3_RESUME_MISSING";
	const postCommitToken = "D110C_0C_EPOCH3_COLD_REOPEN_BLOCKED";
	const server = await startProductBrowserServer(
		new URL("./assets/phase-6a-creator-successor-product-entry.ts", import.meta.url).pathname
	);
	const child = await buildD110c0cChild();
	const profiles: string[] = [];
	const causalEvidence: Array<Readonly<Record<string, unknown>>> = [];
	try {
		for (const ordering of ["old-ahe", "new-ahe"] as const) {
			const name = `d110c-0c-${ordering}`;
			const profileDirectory = mkdtempSync(join(tmpdir(), `${name}-`));
			profiles.push(profileDirectory);
			const staged = await runD110c0cStage(child.path, {
				name,
				ordering,
				profileDirectory,
				url: server.origin,
			});
			const floor = d110c0cRecord(staged.floor);
			const floorState = d110c0cRecord(floor.state);
			const stableHead = d110c0cRecord(floorState.stable);
			const pending = d110c0cRecord(floorState.pending);
			const nextHead = d110c0cRecord(pending.next);
			expect(stableHead.epoch).toBe(2);
			expect(nextHead.epoch).toBe(3);
			expect(pending.previous).toEqual(stableHead);
			expect(floor.fault).toBe("none");
			expect(d110c0cRecord(d110c0cRecord(staged.stable).authority).epoch).toBe(2);
			expect(d110c0cRecord(d110c0cRecord(staged.after).authority).epoch).toBe(2);
			expect(d110c0cRecord(staged.stable).projection).toEqual(d110c0cRecord(staged.after).projection);
			expect(d110c0cRecord(staged.stable).acl).toEqual(d110c0cRecord(staged.after).acl);
			expect(d110c0cRecord(staged.close)).toMatchObject({ epoch: 2, successorEpoch: 3 });
			const operations = d110c0cArray(floor.events).map((event) => d110c0cRecord(event).operation);
			expect(operations).toEqual([
				"create",
				"begin",
				"commit",
				"begin",
				"commit",
				"begin",
				...(ordering === "new-ahe" ? ["commit-fault"] : []),
			]);
			const generations = d110c0cArray(d110c0cRecord(staged.ahe).generations).map(d110c0cRecord);
			const closure = generations.flatMap((generation) => d110c0cArray(generation.closure).map(d110c0cRecord));
			expect(closure).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ currentEpoch: 2, kind: "drp-anchor-trust-state" }),
					expect.objectContaining({ currentEpoch: 3, kind: "drp-anchor-trust-state" }),
					expect.objectContaining({ epoch: 2, kind: "drp-hard-epoch-cut" }),
					expect.objectContaining({ epoch: 2, kind: "drp-seal-qc" }),
					expect.objectContaining({ epoch: 3, kind: "v3-live-generation-2" }),
				])
			);

			const recovered = await runD110c0cRecovery(child.path, {
				name,
				profileDirectory,
				url: server.origin,
			});
			expect(recovered.floorBefore).toEqual(staged.floor);
			expect(recovered.aheBefore).toEqual(staged.ahe);
			expect(d110c0cRecord(recovered.snapshotScope).epoch).toBe(2);
			const recovery = d110c0cRecord(recovered.recovery);
			expect(recovery.callCount).toBe(1);
			const evidenceRow = Object.freeze({ ordering, recovered, staged });
			causalEvidence.push(evidenceRow);
			await testInfo.attach(`d110c-0c-causal-evidence-${ordering}`, {
				body: Buffer.from(JSON.stringify(evidenceRow)),
				contentType: "application/json",
			});
			if (recovered.detail !== "fulfilled") {
				if (recovery.resultKind === "active-new") {
					const committed = d110c0cRecord(d110c0cRecord(recovered.floorAfter).state);
					expect(committed.pending).toBeNull();
					expect(d110c0cRecord(committed.stable).epoch).toBe(3);
					if (ordering === "old-ahe") {
						const beforeAhe = d110c0cRecord(recovered.aheBefore);
						const afterAhe = d110c0cRecord(recovered.aheAfter);
						const beforeHead = d110c0cRecord(beforeAhe.activeHead);
						const afterHead = d110c0cRecord(afterAhe.activeHead);
						expect(afterHead.revision).toBe(Number(beforeHead.revision) + 1);
						const expectedGenerations = d110c0cArray(beforeAhe.generations).map((entry) => {
							const generation = d110c0cRecord(entry);
							return generation.generationId === beforeHead.generationId
								? { ...generation, state: "Superseded" }
								: generation.generationId === afterHead.generationId
									? { ...generation, state: "Adopted" }
									: generation;
						});
						expect(afterAhe).toEqual({ ...beforeAhe, activeHead: afterHead, generations: expectedGenerations });
					} else {
						expect(recovered.aheAfter).toEqual(recovered.aheBefore);
					}
					expect.soft(recovered.detail, postCommitToken).toBe("fulfilled");
					continue;
				}
				expect(recovered.detail).toBe("D110C_FLOOR_RECOVERY_UNAVAILABLE");
				expect(recovery).toEqual({ callCount: 1, resultKind: "pending-missing", swapHeadCount: 0 });
				expect(recovered.floorAfter).toEqual(recovered.floorBefore);
				expect(recovered.aheAfter).toEqual(recovered.aheBefore);
				expect(recovered.reopened).toBeNull();
				expect.soft(recovered.detail, token).toBe("fulfilled");
				continue;
			}
			const committed = d110c0cRecord(d110c0cRecord(recovered.floorAfter).state);
			expect(committed.pending).toBeNull();
			expect(d110c0cRecord(committed.stable).epoch).toBe(3);
			expect(recovery).toEqual({
				callCount: 1,
				resultKind: "active-new",
				swapHeadCount: ordering === "old-ahe" ? 1 : 0,
			});
			const reopened = d110c0cRecord(recovered.reopened);
			expect(d110c0cRecord(reopened.authority).epoch).toBe(3);
			const accepted = d110c0cArray(d110c0cRecord(reopened.projection).accepted).map(d110c0cRecord);
			expect(accepted.map(({ text }) => text)).toEqual([
				"d110c-0c-epoch-zero",
				"d110c-0c-epoch-one",
				"d110c-0c-epoch-two",
				"d110c-0c-post-restart",
			]);
		}
		await testInfo.attach("d110c-0c-causal-evidence", {
			body: Buffer.from(JSON.stringify(causalEvidence)),
			contentType: "application/json",
		});
	} finally {
		for (const profile of profiles) rmSync(profile, { force: true, recursive: true });
		rmSync(child.directory, { force: true, recursive: true });
		await server.close();
	}
});
