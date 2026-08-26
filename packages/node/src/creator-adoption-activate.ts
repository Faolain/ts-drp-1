import { hashDomain } from "@ts-drp/canonical";

import "./creator-adoption.js";
import "./v3-live.js";
import {
	consumePreparedCreatorSuccessorAdoption,
	type PreparedCreatorSuccessorAdoptionMaterial,
} from "./internal/creator-adoption-intent.js";
import {
	consumeCreatorSuccessorLive,
	consumeCreatorSuccessorReopen,
	type CreatorSuccessorLiveMaterial,
	type CreatorSuccessorRuntimeBindings,
} from "./internal/creator-successor-live.js";

const HOT_KEYS = Object.freeze(["capability", "handle", "messageQueueManager", "networkNode", "onAdmittedVertex"]);
const COLD_KEYS = Object.freeze([
	"authenticationProfile",
	"catalog",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"issuanceStore",
	"liveJournalStore",
	"messageQueueManager",
	"networkNode",
	"onAdmittedVertex",
	"pinnedGenesisAnchorDigest",
	"snapshotDeclaration",
	"snapshotStore",
	"store",
]);

type PlainRecord = Record<string, unknown>;
type Failure = Readonly<{ readonly detail: string; readonly kind: string; readonly ok: false }>;

interface HeldLock {
	release(): Promise<void>;
}

interface ActiveOwner {
	readonly bindings: CreatorSuccessorRuntimeBindings;
	readonly handle: object;
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

function stableTopic(material: CreatorSuccessorLiveMaterial): string {
	const encoder = new TextEncoder();
	const digest = hashDomain(
		"ts-drp/live-topic/v3",
		encoder.encode(material.successor.trust.objectId),
		encoder.encode(material.pinnedGenesisAnchorDigest)
	);
	return `drp/v3/1/${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sameBindings(left: CreatorSuccessorRuntimeBindings, right: CreatorSuccessorRuntimeBindings): boolean {
	return (
		left.messageQueueManager === right.messageQueueManager &&
		left.networkNode === right.networkNode &&
		left.onAdmittedVertex === right.onAdmittedVertex
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
	if (typeof window === "undefined" || window !== globalThis || typeof navigator === "undefined") return undefined;
	const locks = Reflect.get(navigator, "locks");
	return locks !== null && typeof locks === "object" && typeof Reflect.get(locks, "request") === "function"
		? (locks as ReturnType<typeof browserLockManager>)
		: undefined;
}

async function acquireBrowserLock(topic: string): Promise<HeldLock | Failure | undefined> {
	if (typeof window === "undefined" || window !== globalThis) return undefined;
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
	const topic = stableTopic(material);
	const existing = activeOwners.get(topic);
	if (existing !== undefined) {
		return sameBindings(existing.bindings, bindings)
			? success(material, existing.handle)
			: failure("authority-unavailable", "creator successor already has a conflicting active owner");
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
	let active = true;
	const wrapped = Object.freeze({
		...rawHandle,
		deactivate: async (): Promise<void> => {
			if (!active) return;
			active = false;
			await Promise.resolve(rawHandle.deactivate());
			activeOwners.delete(topic);
			await lock?.release();
		},
	});
	activeOwners.set(topic, Object.freeze({ bindings, handle: wrapped }));
	return success(material, wrapped);
}

/**
 * Activates one freshly committed in-process successor capability.
 * @param input - Exact hot activation capability and runtime bindings.
 * @returns Active successor custody or a typed fail-closed result.
 */
export async function activateCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	const captured = capture(input, HOT_KEYS);
	if (captured === undefined) return failure("malformed-input", "creator successor activation input is invalid");
	const bindings = runtimeBindings(captured);
	if (bindings === undefined) return failure("malformed-input", "creator successor runtime bindings are invalid");
	const prepared = consumePreparedCreatorSuccessorAdoption(captured.capability, captured.handle) as
		| PreparedCreatorSuccessorAdoptionMaterial
		| undefined;
	if (prepared === undefined) return failure("capability-unavailable", "creator successor capability is unavailable");
	return activateMaterial(prepared.activation, bindings);
}

/**
 * Reconstructs and activates the already-adopted durable successor.
 * @param input - Exact cold-reopen carriers, stores, and runtime bindings.
 * @returns Active successor custody or a typed fail-closed result.
 */
export async function reopenCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	const captured = capture(input, COLD_KEYS);
	if (captured === undefined) return failure("malformed-input", "creator successor reopen input is invalid");
	const bindings = runtimeBindings(captured);
	if (bindings === undefined) return failure("malformed-input", "creator successor runtime bindings are invalid");
	const reopened = await consumeCreatorSuccessorReopen(captured as never);
	if (!reopened.ok) return failure(reopened.kind, reopened.detail);
	return activateMaterial(reopened.material, bindings);
}
