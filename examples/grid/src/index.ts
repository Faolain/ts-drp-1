import { DRPNode } from "@ts-drp/node";
import { enableTracing } from "@ts-drp/tracer";

import { env } from "./env";
import { createModularGridNetwork, type ModularGridNetworkSession } from "./modular-network";
import { isModularNetworkEnv, getNetworkConfigFromEnv as selectNetworkConfigFromEnv } from "./network-config";
import { enableUIControls, renderNetwork, renderZone } from "./render";
import { createV3ZoneApi, type V3ZoneApi } from "./v3-zone";

interface GridNetworkSession {
	readonly node: DRPNode;
	snapshot(): Readonly<{ readonly peerId: string }>;
	stop(): Promise<void>;
}

let applicationInterval: ReturnType<typeof setInterval> | undefined;

interface BrowserIdentityLease {
	release(): void;
	readonly seed: string;
}

const IDENTITY_LOCK_PREFIX = "ts-drp:grid:v3-zone:identity-slot";
const IDENTITY_SEED_KEY = "ts-drp:grid:v3-zone:identity-seed";

/**
 * Get the selected network config.
 * @returns The environment-selected network configuration.
 */
export function getNetworkConfigFromEnv(): ReturnType<typeof selectNetworkConfigFromEnv> {
	return selectNetworkConfigFromEnv(env, window.location.origin);
}

function seedForSlot(slot: number): string {
	const key = slot === 0 ? IDENTITY_SEED_KEY : `${IDENTITY_SEED_KEY}:${slot}`;
	const existing = localStorage.getItem(key);
	if (existing !== null && /^[0-9a-f]{64}$/u.test(existing)) return existing;
	const seedBytes = new Uint8Array(32);
	crypto.getRandomValues(seedBytes);
	const seed = Array.from(seedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	localStorage.setItem(key, seed);
	return seed;
}

async function stableBrowserIdentity(): Promise<BrowserIdentityLease> {
	if (navigator.locks === undefined) throw new Error("v3 zone browser identity locks are unavailable");
	// Let a just-closed document release its browser-owned lease before selecting
	// the lowest available durable slot. Uniqueness itself comes from Web Locks,
	// not from this reclamation grace period.
	await new Promise((resolve) => setTimeout(resolve, 100));
	for (let slot = 0; slot < 64; slot += 1) {
		const lease = await acquireIdentitySlot(slot);
		if (lease !== undefined) return lease;
	}
	throw new Error("v3 zone browser identity capacity is exhausted");
}

async function acquireIdentitySlot(slot: number): Promise<BrowserIdentityLease | undefined> {
	let releaseLock: (() => void) | undefined;
	let settleAvailability: ((available: boolean) => void) | undefined;
	let rejectAvailability: ((error: unknown) => void) | undefined;
	const availability = new Promise<boolean>((resolve, reject) => {
		settleAvailability = resolve;
		rejectAvailability = reject;
	});
	const hold = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	const request = navigator.locks.request(
		`${IDENTITY_LOCK_PREFIX}:${slot}`,
		{ ifAvailable: true, mode: "exclusive" },
		async (lock) => {
			settleAvailability?.(lock !== null);
			if (lock !== null) await hold;
		}
	);
	void request.catch((error: unknown) => rejectAvailability?.(error));
	if (!(await availability)) {
		await request;
		return undefined;
	}
	let seed: string;
	try {
		seed = seedForSlot(slot);
	} catch (error) {
		releaseLock?.();
		await request.catch(() => undefined);
		throw error;
	}
	let released = false;
	return Object.freeze({
		release(): void {
			if (released) return;
			released = true;
			releaseLock?.();
			void request.catch(() => undefined);
		},
		seed,
	});
}

function bindControls(zone: V3ZoneApi): void {
	const createButton = document.getElementById("createGrid");
	const joinButton = document.getElementById("joinGrid");
	const gridInput = document.getElementById("gridInput");
	const enrollmentInput = document.getElementById("zoneMemberEnrollment");
	const copyButton = document.getElementById("copyGridId");
	if (
		!(createButton instanceof HTMLButtonElement) ||
		!(joinButton instanceof HTMLButtonElement) ||
		!(gridInput instanceof HTMLInputElement) ||
		!(enrollmentInput instanceof HTMLInputElement) ||
		!(copyButton instanceof HTMLButtonElement)
	) {
		throw new TypeError("v3 zone controls are unavailable");
	}
	createButton.addEventListener("click", () => {
		void zone.create(enrollmentInput.value).catch((error: unknown) => console.error("Failed to create v3 zone", error));
	});
	joinButton.addEventListener("click", () => {
		void zone.join(gridInput.value).catch((error: unknown) => console.error("Failed to join v3 zone", error));
	});
	gridInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") joinButton.click();
	});
	document.addEventListener("keydown", (event) => {
		if (
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			event.target instanceof HTMLSelectElement ||
			!zone.snapshot().ready
		) {
			return;
		}
		if (event.key === "w") zone.move(0, 1);
		if (event.key === "a") zone.move(-1, 0);
		if (event.key === "s") zone.move(0, -1);
		if (event.key === "d") zone.move(1, 0);
	});
	copyButton.addEventListener("click", () => {
		void navigator.clipboard.writeText(zone.snapshot().invite);
	});
}

async function main(): Promise<void> {
	if (env.enableTracing) enableTracing();
	const identity = await stableBrowserIdentity();
	const target = window as typeof window & {
		__TS_DRP_GRID_SESSION__?: GridNetworkSession;
		__TS_DRP_V3_ZONE__?: V3ZoneApi;
	};
	let session: GridNetworkSession | undefined;
	let unloadHandler: (() => void) | undefined;
	let zone: V3ZoneApi | undefined;
	try {
		const selected = getNetworkConfigFromEnv();
		const config: ReturnType<typeof selectNetworkConfigFromEnv> = {
			...selected,
			keychain_config: { ...selected.keychain_config, private_key_seed: identity.seed },
		};
		const modularSession = isModularNetworkEnv(env) ? createModularGridNetwork(config, env) : undefined;
		const node = modularSession?.node ?? new DRPNode(config);
		session = modularSession ?? {
			node,
			snapshot: (): Readonly<{ peerId: string }> => Object.freeze({ peerId: node.networkNode.peerId }),
			stop: (): Promise<void> => node.stop(),
		};
		await node.start();
		zone = createV3ZoneApi(node, renderZone);
		target.__TS_DRP_GRID_SESSION__ = session;
		target.__TS_DRP_V3_ZONE__ = zone;
		window.dispatchEvent(new CustomEvent("ts-drp:grid-ready", { detail: session.snapshot() }));
		bindControls(zone);
		applicationInterval = setInterval(() => renderNetwork(node), env.renderInfoInterval);
		renderNetwork(node);
		renderZone(zone.snapshot());
		unloadHandler = (): void => {
			if (applicationInterval !== undefined) clearInterval(applicationInterval);
			applicationInterval = undefined;
			// The document owns the Web Lock until termination. Releasing it here
			// would let a replacement page reuse this identity while teardown is pending.
			void zone?.close().catch((error: unknown) => console.error("Failed to close v3 zone", error));
			void session?.stop().catch((error: unknown) => console.error("Failed to stop grid session", error));
		};
		window.addEventListener("beforeunload", unloadHandler, { once: true });
		await node.networkNode.isDialable(() => {
			enableUIControls();
			console.log("Started v3 zone node", import.meta.env);
		});
	} catch (error) {
		delete target.__TS_DRP_GRID_SESSION__;
		delete target.__TS_DRP_V3_ZONE__;
		if (unloadHandler !== undefined) window.removeEventListener("beforeunload", unloadHandler);
		if (applicationInterval !== undefined) clearInterval(applicationInterval);
		applicationInterval = undefined;
		await zone?.close().catch(() => undefined);
		await session?.stop().catch(() => undefined);
		identity.release();
		throw error;
	}
}

void main();

export type { ModularGridNetworkSession };
