import "./creator-adoption.js";
import "./v3-live.js";
import {
	consumePreparedCreatorSuccessorAdoption,
	type PreparedCreatorSuccessorAdoptionMaterial,
} from "./internal/creator-adoption-intent.js";
import { captureCreatorExpectedRoomHead, sameCreatorRoomHead } from "./internal/creator-room-head.js";
import {
	consumeCreatorSuccessorHandleAlias,
	consumeCreatorSuccessorLive,
	consumeCreatorSuccessorReopen,
	type CreatorSuccessorLiveMaterial,
	type CreatorSuccessorRuntimeBindings,
} from "./internal/creator-successor-live.js";
import { deriveV3StableTopic } from "./internal/v3-topic.js";

const HOT_KEYS = Object.freeze([
	"capability",
	"expectedRoomHead",
	"handle",
	"messageQueueManager",
	"networkNode",
	"onAdmittedVertex",
]);
const COLD_KEYS = Object.freeze([
	"authenticationProfile",
	"author",
	"catalog",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"expectedRoomHead",
	"issuanceStore",
	"liveJournalStore",
	"messageQueueManager",
	"networkNode",
	"onAdmittedVertex",
	"pinnedGenesisAnchorDigest",
	"signRegisteredVertexDigest",
	"snapshotDeclaration",
	"snapshotStore",
	"store",
]);

type PlainRecord = Record<string, unknown>;
type Failure = Readonly<{ readonly detail: string; readonly kind: string; readonly ok: false }>;

interface HeldLock {
	release(): Promise<void>;
}

interface ActiveHead {
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
}

interface ActiveOwner {
	readonly bindings: CreatorSuccessorRuntimeBindings;
	handle: object;
	readonly head: ActiveHead;
	readonly lock: HeldLock | undefined;
	replacementInFlight: boolean;
	replacementSettled: Promise<void> | undefined;
	resolveReplacement: (() => void) | undefined;
	retirementRequested: boolean;
	readonly token: object;
	readonly topic: string;
}

const activeOwners = new Map<string, ActiveOwner>();

function failure(kind: string, detail: string): Failure {
	return Object.freeze({ detail, kind, ok: false as const });
}

function capture(value: unknown, keys: readonly string[]): PlainRecord | undefined {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
			return undefined;
		}
		const actual = Reflect.ownKeys(value);
		if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
			return undefined;
		}
		const output: PlainRecord = Object.create(null) as PlainRecord;
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			output[key] = descriptor.value;
		}
		return output;
	} catch {
		return undefined;
	}
}

function runtimeBindings(input: PlainRecord): CreatorSuccessorRuntimeBindings | undefined {
	return input.messageQueueManager !== null &&
		typeof input.messageQueueManager === "object" &&
		input.networkNode !== null &&
		typeof input.networkNode === "object" &&
		typeof input.onAdmittedVertex === "function"
		? (Object.freeze({
				messageQueueManager: input.messageQueueManager,
				networkNode: input.networkNode,
				onAdmittedVertex: input.onAdmittedVertex,
			}) as CreatorSuccessorRuntimeBindings)
		: undefined;
}

function sameBindings(left: CreatorSuccessorRuntimeBindings, right: CreatorSuccessorRuntimeBindings): boolean {
	return (
		left.messageQueueManager === right.messageQueueManager &&
		left.networkNode === right.networkNode &&
		left.onAdmittedVertex === right.onAdmittedVertex
	);
}

function activeHead(value: unknown): ActiveHead | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const trust = value as Readonly<Record<string, unknown>>;
	return typeof trust.currentAnchorDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(trust.currentAnchorDigest) &&
		typeof trust.currentEpoch === "number" &&
		Number.isSafeInteger(trust.currentEpoch) &&
		trust.currentEpoch >= 0 &&
		typeof trust.genesisAnchorDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(trust.genesisAnchorDigest) &&
		typeof trust.objectId === "string"
		? Object.freeze({
				anchorDigest: trust.currentAnchorDigest,
				epoch: trust.currentEpoch,
				genesisAnchorDigest: trust.genesisAnchorDigest,
				objectId: trust.objectId,
			})
		: undefined;
}

function sameActiveHead(left: ActiveHead, right: ActiveHead): boolean {
	return (
		left.anchorDigest === right.anchorDigest &&
		left.epoch === right.epoch &&
		left.genesisAnchorDigest === right.genesisAnchorDigest &&
		left.objectId === right.objectId
	);
}

function transitionHeads(
	material: CreatorSuccessorLiveMaterial
): Readonly<{ readonly predecessor: ActiveHead; readonly successor: ActiveHead }> | undefined {
	const predecessor = activeHead(material.predecessor.trust);
	const successor = activeHead(material.successor.trust);
	return predecessor !== undefined &&
		successor !== undefined &&
		predecessor.objectId === successor.objectId &&
		predecessor.genesisAnchorDigest === successor.genesisAnchorDigest &&
		predecessor.genesisAnchorDigest === material.pinnedGenesisAnchorDigest &&
		successor.epoch === predecessor.epoch + 1 &&
		material.predecessor.head.objectId === predecessor.objectId &&
		material.successor.head.objectId === successor.objectId
		? Object.freeze({ predecessor, successor })
		: undefined;
}

function beginReplacement(owner: ActiveOwner): void {
	owner.replacementInFlight = true;
	owner.replacementSettled = new Promise<void>((resolve) => {
		owner.resolveReplacement = resolve;
	});
}

function finishReplacement(owner: ActiveOwner): void {
	owner.replacementInFlight = false;
	const resolve = owner.resolveReplacement;
	owner.resolveReplacement = undefined;
	owner.replacementSettled = undefined;
	resolve?.();
}

function currentOwner(owner: ActiveOwner): boolean {
	return activeOwners.get(owner.topic)?.token === owner.token;
}

async function deactivateOwner(owner: ActiveOwner): Promise<void> {
	const deactivate = Reflect.get(owner.handle, "deactivate");
	try {
		if (typeof deactivate === "function") await Reflect.apply(deactivate, owner.handle, []);
	} finally {
		if (currentOwner(owner)) {
			activeOwners.delete(owner.topic);
			await owner.lock?.release();
		}
	}
}

async function abandonOwner(owner: ActiveOwner): Promise<void> {
	owner.retirementRequested = true;
	finishReplacement(owner);
	await deactivateOwner(owner);
}

async function ignoreCleanupFailure(task: Promise<void>): Promise<void> {
	await task.catch(() => undefined);
}

function deactivateRawHandle(handle: Readonly<{ deactivate(): void | Promise<void> }>): Promise<void> {
	return Promise.resolve().then(() => handle.deactivate());
}

function failureMayFollowTransfer(result: Readonly<{ readonly detail: string; readonly kind: string }>): boolean {
	if (result.kind === "source-unavailable") return true;
	if (result.kind !== "internal-invariant") return false;
	return !["creator predecessor recovery custody failed", "creator successor live owner is unavailable"].includes(
		result.detail
	);
}

function wrapOwner(
	topic: string,
	rawHandle: Record<string, unknown> & Readonly<{ deactivate(): void | Promise<void> }>,
	bindings: CreatorSuccessorRuntimeBindings,
	head: ActiveHead,
	lock: HeldLock | undefined
): ActiveOwner {
	const token = Object.freeze({});
	let rawDeactivation: Promise<void> | undefined;
	let wrapperDeactivation: Promise<void> | undefined;
	const owner: ActiveOwner = {
		bindings,
		handle: rawHandle,
		head,
		lock,
		replacementInFlight: false,
		replacementSettled: undefined,
		resolveReplacement: undefined,
		retirementRequested: false,
		token,
		topic,
	};
	const deactivateRaw = (): Promise<void> => {
		rawDeactivation ??= Promise.resolve().then(() => rawHandle.deactivate());
		return rawDeactivation;
	};
	const wrapped = Object.freeze({
		...rawHandle,
		deactivate: (): Promise<void> => {
			wrapperDeactivation ??= (async (): Promise<void> => {
				if (owner.replacementInFlight) {
					owner.retirementRequested = true;
					await owner.replacementSettled;
				}
				try {
					await deactivateRaw();
				} finally {
					if (currentOwner(owner)) {
						activeOwners.delete(topic);
						await lock?.release();
					}
				}
			})();
			return wrapperDeactivation;
		},
	});
	owner.handle = wrapped;
	return owner;
}

function browserLockRealm(): boolean {
	if (typeof window !== "undefined" && window === globalThis) return true;
	return (
		typeof navigator !== "undefined" &&
		Reflect.get(globalThis, "document") === undefined &&
		typeof Reflect.get(globalThis, "location") === "object" &&
		typeof Reflect.get(globalThis, "postMessage") === "function"
	);
}

function browserLockManager():
	| Readonly<{
			request(
				name: string,
				options: Readonly<{ readonly ifAvailable: true; readonly mode: "exclusive" }>,
				callback: (lock: object | null) => Promise<void>
			): Promise<void>;
	  }>
	| undefined {
	if (typeof navigator === "undefined") return undefined;
	const locks = Reflect.get(navigator, "locks");
	return locks !== null && typeof locks === "object" && typeof Reflect.get(locks, "request") === "function"
		? (locks as ReturnType<typeof browserLockManager>)
		: undefined;
}

async function acquireBrowserLock(topic: string): Promise<HeldLock | Failure | undefined> {
	if (!browserLockRealm()) return undefined;
	const locks = browserLockManager();
	if (locks === undefined) return failure("authority-unavailable", "browser writer lock authority is unavailable");
	let settleAcquired: ((value: boolean) => void) | undefined;
	let releaseLock: (() => void) | undefined;
	const acquired = new Promise<boolean>((resolve) => (settleAcquired = resolve));
	const release = new Promise<void>((resolve) => (releaseLock = resolve));
	let request: Promise<void>;
	try {
		request = Promise.resolve(
			locks.request(`ts-drp:${topic}`, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
				settleAcquired?.(lock !== null);
				if (lock !== null) await release;
			})
		);
	} catch {
		return failure("authority-unavailable", "browser writer lock request failed");
	}
	const owns = await Promise.race([
		acquired,
		request.then(
			() => false,
			() => false
		),
	]);
	if (!owns) return failure("authority-unavailable", "browser writer lock is held elsewhere");
	let released = false;
	return Object.freeze({
		release: async (): Promise<void> => {
			if (released) return;
			released = true;
			releaseLock?.();
			await request.catch(() => undefined);
		},
	});
}

function success(
	material: CreatorSuccessorLiveMaterial,
	handle: object
): Readonly<{
	readonly handle: object;
	readonly lifecycle: "active";
	readonly ok: true;
	readonly recovery: "active-new";
	readonly trust: object;
}> {
	return Object.freeze({
		handle,
		lifecycle: "active" as const,
		ok: true as const,
		recovery: "active-new" as const,
		trust: Object.freeze({ ...material.successor.trust }),
	});
}

async function activateMaterial(
	material: CreatorSuccessorLiveMaterial,
	bindings: CreatorSuccessorRuntimeBindings
): Promise<Readonly<Record<string, unknown>>> {
	const heads = transitionHeads(material);
	if (heads === undefined) return failure("chain-invalid", "creator successor authority transition is invalid");
	const topic = deriveV3StableTopic(material.successor.trust.objectId, material.pinnedGenesisAnchorDigest);
	const existing = activeOwners.get(topic);
	if (existing !== undefined) {
		if (!sameBindings(existing.bindings, bindings)) {
			return failure("authority-unavailable", "creator successor already has a conflicting active owner");
		}
		if (existing.replacementInFlight) {
			return failure("authority-unavailable", "creator successor replacement is already active");
		}
		if (sameActiveHead(existing.head, heads.successor)) return success(material, existing.handle);
		if (!sameActiveHead(existing.head, heads.predecessor)) {
			return heads.predecessor.objectId === existing.head.objectId &&
				heads.predecessor.genesisAnchorDigest === existing.head.genesisAnchorDigest &&
				heads.predecessor.epoch < existing.head.epoch
				? failure("stale-head", "creator successor predecessor is stale")
				: failure("chain-invalid", "creator successor predecessor differs from the active owner");
		}
		beginReplacement(existing);
		const activated = await consumeCreatorSuccessorLive(material, bindings);
		if (!activated.ok) {
			if (failureMayFollowTransfer(activated)) await ignoreCleanupFailure(abandonOwner(existing));
			else {
				const retire = existing.retirementRequested;
				finishReplacement(existing);
				if (retire) await ignoreCleanupFailure(deactivateOwner(existing));
			}
			return failure(activated.kind, activated.detail);
		}
		const rawHandle = activated.handle as Record<string, unknown> &
			Readonly<{
				deactivate(): void | Promise<void>;
			}>;
		const replacement = wrapOwner(topic, rawHandle, bindings, heads.successor, existing.lock);
		if (!consumeCreatorSuccessorHandleAlias(rawHandle, replacement.handle)) {
			await ignoreCleanupFailure(deactivateRawHandle(rawHandle));
			await ignoreCleanupFailure(abandonOwner(existing));
			return failure("internal-invariant", "creator successor handle identity is unavailable");
		}
		if (!currentOwner(existing) || existing.retirementRequested) {
			await ignoreCleanupFailure(deactivateRawHandle(rawHandle));
			await ignoreCleanupFailure(abandonOwner(existing));
			return failure("authority-unavailable", "creator successor active ownership changed during replacement");
		}
		activeOwners.set(topic, replacement);
		finishReplacement(existing);
		return success(material, replacement.handle);
	}
	const held = await acquireBrowserLock(topic);
	if (held !== undefined && "ok" in held && held.ok === false) return held;
	const lock = held as HeldLock | undefined;
	const activated = await consumeCreatorSuccessorLive(material, bindings);
	if (!activated.ok) {
		await lock?.release();
		return failure(activated.kind, activated.detail);
	}
	const rawHandle = activated.handle as Record<string, unknown> & Readonly<{ deactivate(): void | Promise<void> }>;
	const owner = wrapOwner(topic, rawHandle, bindings, heads.successor, lock);
	if (!consumeCreatorSuccessorHandleAlias(rawHandle, owner.handle)) {
		try {
			await Promise.resolve(rawHandle.deactivate());
		} catch {
			// Continue to release the sole writer lock and return a typed failure.
		}
		await lock?.release();
		return failure("internal-invariant", "creator successor handle identity is unavailable");
	}
	activeOwners.set(topic, owner);
	return success(material, owner.handle);
}

/**
 * Activates one freshly committed in-process successor capability.
 * @param input - Exact hot activation capability and runtime bindings.
 * @returns Active successor custody or a typed fail-closed result.
 */
export async function activateCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	const captured = capture(input, HOT_KEYS);
	if (captured === undefined) return failure("malformed-input", "creator successor activation input is invalid");
	const expectedRoomHead = captureCreatorExpectedRoomHead(captured.expectedRoomHead);
	if (expectedRoomHead === undefined) return failure("D110C_FLOOR_INVALID", "creator room-head floor is invalid");
	const bindings = runtimeBindings(captured);
	if (bindings === undefined) return failure("malformed-input", "creator successor runtime bindings are invalid");
	const prepared = consumePreparedCreatorSuccessorAdoption(captured.capability, captured.handle) as
		| PreparedCreatorSuccessorAdoptionMaterial
		| undefined;
	if (prepared === undefined) return failure("capability-unavailable", "creator successor capability is unavailable");
	if (!sameCreatorRoomHead(expectedRoomHead, prepared.activation.successor.trust)) {
		return failure("D110C_FLOOR_MISMATCH", "creator successor differs from the authenticated room-head floor");
	}
	return activateMaterial(prepared.activation, bindings);
}

/**
 * Reconstructs and activates the already-adopted durable successor.
 * @param input - Exact cold-reopen carriers, stores, and runtime bindings.
 * @returns Active successor custody or a typed fail-closed result.
 */
export async function reopenCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	if (
		input !== null &&
		typeof input === "object" &&
		Object.getPrototypeOf(input) === Object.prototype &&
		!("expectedRoomHead" in input)
	) {
		return failure(
			"D110C_FLOOR_MIGRATION_REQUIRED",
			"creator successor reopen requires an authenticated room-head floor"
		);
	}
	const captured = capture(input, COLD_KEYS);
	if (captured === undefined) return failure("malformed-input", "creator successor reopen input is invalid");
	const expectedRoomHead = captureCreatorExpectedRoomHead(captured.expectedRoomHead);
	if (expectedRoomHead === undefined) return failure("D110C_FLOOR_INVALID", "creator room-head floor is invalid");
	if (captured.authenticationProfile !== "creator-only") {
		return failure("malformed-input", "creator successor authentication profile is invalid");
	}
	if (typeof captured.author !== "string" || typeof captured.signRegisteredVertexDigest !== "function") {
		return failure("malformed-input", "creator successor local author input is invalid");
	}
	const bindings = runtimeBindings(captured);
	if (bindings === undefined) return failure("malformed-input", "creator successor runtime bindings are invalid");
	const reopened = await consumeCreatorSuccessorReopen(captured as never);
	if (!reopened.ok) return failure(reopened.kind, reopened.detail);
	if (!sameCreatorRoomHead(expectedRoomHead, reopened.material.successor.trust)) {
		return failure("D110C_FLOOR_MISMATCH", "creator successor differs from the authenticated room-head floor");
	}
	return activateMaterial(reopened.material, bindings);
}
