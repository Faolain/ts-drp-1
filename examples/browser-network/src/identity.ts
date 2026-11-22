export interface BrowserIdentityLease {
	release(): void;
	readonly seed: string;
}

export interface BrowserIdentityStorage {
	readonly lockPrefix: string;
	readonly seedKey: string;
}

function seedForSlot(storage: BrowserIdentityStorage, slot: number): string {
	const key = slot === 0 ? storage.seedKey : `${storage.seedKey}:${slot}`;
	const existing = localStorage.getItem(key);
	if (existing !== null && /^[0-9a-f]{64}$/u.test(existing)) return existing;
	const seedBytes = new Uint8Array(32);
	crypto.getRandomValues(seedBytes);
	const seed = Array.from(seedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	localStorage.setItem(key, seed);
	return seed;
}

/**
 * Acquire a durable browser author slot without sharing a live key across tabs.
 * Web Locks own uniqueness; local storage owns only the stable seed. The caller
 * must retain the lease until its node/signing work has joined or the document
 * terminates. Missing custody or exhausted capacity refuses, never falls back
 * to a random author that cannot recover its durable work.
 * @param storage - The application's durable namespace, preserved across reloads.
 * @returns A stable seed and its browser-owned live lease.
 */
export async function acquireBrowserIdentity(storage: BrowserIdentityStorage): Promise<BrowserIdentityLease> {
	if (navigator.locks === undefined) throw new Error("v3 browser identity locks are unavailable");
	const captured = Object.freeze({ lockPrefix: storage.lockPrefix, seedKey: storage.seedKey });
	if (captured.lockPrefix.length === 0 || captured.seedKey.length === 0) {
		throw new TypeError("v3 browser identity namespace is empty");
	}
	// Reclamation grace only: uniqueness is supplied by Web Locks.
	await new Promise((resolve) => setTimeout(resolve, 100));
	for (let slot = 0; slot < 64; slot += 1) {
		const lease = await acquireIdentitySlot(captured, slot);
		if (lease !== undefined) return lease;
	}
	throw new Error("v3 browser identity capacity is exhausted");
}

async function acquireIdentitySlot(
	storage: BrowserIdentityStorage,
	slot: number
): Promise<BrowserIdentityLease | undefined> {
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
		`${storage.lockPrefix}:${slot}`,
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
		seed = seedForSlot(storage, slot);
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
