import { event } from "./observation.js";
import type { Fault } from "./types.js";
import type {
	V3RoomHeadAuthority,
	V3RoomHeadAuthorityResult,
	V3RoomHeadState,
} from "../../../examples/v3-room/src/index.js";
import { encodeCanonical } from "../../../packages/canonical/dist/src/index.js";

export const floorControl: { fault: Fault; readFault: "none" | "invalid" | "unavailable" } = {
	fault: "none",
	readFault: "none",
};
/**
 *
 * @param value
 */
export function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = (): void => resolve(value.result);
		value.onerror = (): void => reject(value.error);
	});
}
async function open(identity: string): Promise<IDBDatabase> {
	const r = indexedDB.open(identity + "--startup-floor", 1);
	r.onupgradeneeded = (): IDBObjectStore => r.result.createObjectStore("floor");
	return request(r);
}
async function transact<T>(
	identity: string,
	mode: IDBTransactionMode,
	action: (s: IDBObjectStore) => Promise<T>
): Promise<T> {
	const db = await open(identity);
	try {
		const tx = db.transaction("floor", mode, mode === "readwrite" ? { durability: "strict" } : undefined);
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = (): void => resolve();
			tx.onabort = (): void => reject(tx.error);
			tx.onerror = (): void => reject(tx.error);
		});
		try {
			const value = await action(tx.objectStore("floor"));
			await done;
			return value;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				/* Already completed. */
			}
			await done.catch(() => undefined);
			throw error;
		}
	} finally {
		db.close();
	}
}
/**
 *
 * @param identity
 */
export async function state(identity: string): Promise<V3RoomHeadState | null> {
	return transact(
		identity,
		"readonly",
		async (s) => ((await request(s.get("state"))) as V3RoomHeadState | undefined) ?? null
	);
}
/**
 *
 * @param identity
 * @param value
 */
export async function replaceState(identity: string, value: unknown): Promise<void> {
	await transact(identity, "readwrite", async (s) => {
		await request(s.put(value, "state"));
	});
}
function same(a: unknown, b: unknown): boolean {
	const l = encodeCanonical(a),
		r = encodeCanonical(b);
	return l.length === r.length && l.every((v, i) => v === r[i]);
}
/**
 *
 * @param identity
 * @param kind
 */
export function authority(identity: string, kind: "create" | "reopen"): V3RoomHeadAuthority {
	const apply = async (
		operation: "create" | "migrate" | "begin" | "commit" | "read",
		input: Record<string, unknown>
	): Promise<V3RoomHeadAuthorityResult> => {
		event("floor-" + operation);
		if (operation === "read" && floorControl.readFault !== "none") {
			if (floorControl.readFault === "unavailable") return { ok: false, reason: "unavailable" };
			return { ok: true, state: { broken: true } as never };
		}
		if (
			(operation === "begin" && floorControl.fault === "begin-unavailable") ||
			(operation === "commit" && floorControl.fault === "commit-unavailable")
		) {
			floorControl.fault = "none";
			return { ok: false, reason: "unavailable" };
		}
		const selected = await transact(
			identity,
			operation === "read" ? "readonly" : "readwrite",
			async (s): Promise<V3RoomHeadAuthorityResult> => {
				const oldScope = await request(s.get("scope")),
					old = (await request(s.get("state"))) as V3RoomHeadState | undefined;
				if (oldScope !== undefined && !same(oldScope, input.scope)) return { ok: false, reason: "conflict" };
				if (operation === "read") return { ok: true, state: old ?? null };
				let desired: V3RoomHeadState;
				if (operation === "create" || operation === "migrate") {
					desired = { pending: null, stable: input.stable as V3RoomHeadState["stable"] };
					if (old !== undefined && !same(old, desired)) return { ok: false, reason: "conflict" };
				} else {
					if (old === undefined || !same(old, input.expected)) return { ok: false, reason: "conflict" };
					if (operation === "begin")
						desired = {
							pending: { previous: old.stable, next: input.next as V3RoomHeadState["stable"] },
							stable: old.stable,
						};
					else {
						if (old.pending === null) return { ok: false, reason: "conflict" };
						desired = { pending: null, stable: old.pending.next };
					}
				}
				await request(s.put(input.scope, "scope"));
				await request(s.put(desired, "state"));
				return { ok: true, state: structuredClone(desired) };
			}
		);
		if (operation === "commit" && selected.ok) {
			if (floorControl.fault === "commit-lost-response") {
				floorControl.fault = "none";
				throw new Error("STARTUP_COMMIT_RESPONSE_LOST");
			}
			if (floorControl.fault === "reread-unavailable") {
				floorControl.fault = "none";
				floorControl.readFault = "unavailable";
			}
		}
		return selected;
	};
	return Object.freeze({
		initialization: Object.freeze({ kind }),
		create: (input: Parameters<V3RoomHeadAuthority["create"]>[0]) => apply("create", input),
		migrate: (input: Parameters<V3RoomHeadAuthority["migrate"]>[0]) => apply("migrate", input),
		begin: (input: Parameters<V3RoomHeadAuthority["begin"]>[0]) => apply("begin", input),
		commit: (input: Parameters<V3RoomHeadAuthority["commit"]>[0]) => apply("commit", input),
		read: (input: Parameters<V3RoomHeadAuthority["read"]>[0]) => apply("read", input),
	});
}
