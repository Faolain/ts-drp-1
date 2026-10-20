import { encodeCanonical } from "@ts-drp/canonical";
import {
	captureRoomHeadImage as captureImage,
	captureRoomHead,
	captureRoomHeadFence,
	captureRoomHeadScope,
	captureRoomHeadState,
	type RoomHeadImage as Image,
	roomHeadImageDigest as imageDigest,
	ROOM_HEAD_IMAGE_LIMITS as LIMITS,
	type NativeReadReservation,
	type RoomHeadAuthority,
	type RoomHeadControl,
	roomHeadDigest,
	type RoomHeadFenceCommitment,
	roomHeadFields,
	type RoomHeadInitialization,
	type RoomHeadResult,
	roomHeadRetirementChange,
	type RoomHeadRetirementObservation,
	type RoomHeadScope,
	type RoomHeadState,
	sameRoomHeadValue,
} from "@ts-drp/storage";
import {
	captureRoomHeadRetirementFences,
	captureRoomRetirementFenceRequest,
	encodeRoomHeadRetirementFences,
	roomHeadRetirementFenceChange,
} from "@ts-drp/storage/room-head";

import {
	isNativeReadReservationTransaction,
	nativeReadonlyTransaction,
	nativeReadReservationCheck,
	NativeReadReservationOwner,
	runNativeReservedRead,
} from "./internal/native-read-reservation.js";

const STORE = "floor",
	KEY = "record",
	FENCES = "retirementFences";
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.addEventListener("success", () => resolve(r.result), { once: true });
		r.addEventListener("error", () => reject(r.error), { once: true });
	});
}
function terminal(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.addEventListener("complete", () => resolve(), { once: true });
		tx.addEventListener("abort", () => reject(tx.error ?? new Error("ROOM_HEAD_ABORTED")), { once: true });
	});
}
function nextControl(control: RoomHeadControl, update: Partial<RoomHeadControl>): RoomHeadControl {
	if (control.revision === Number.MAX_SAFE_INTEGER) throw new Error("ROOM_HEAD_REVISION_EXHAUSTED");
	return Object.freeze({ ...control, ...update, revision: control.revision + 1 });
}
function randomIncarnation(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return hex(bytes);
}
const conflict = (): RoomHeadResult => Object.freeze({ ok: false, reason: "conflict" });

/** The host explicitly chooses this origin's custody/freshness boundary. This is not independent anti-rollback storage. */
export interface BrowserRoomHeadOptions {
	readonly databaseName: string;
	readonly initialization: RoomHeadInitialization;
	/**
	 * Opt in to the version-2 floor with per-owner retirement fences (slice 14c).
	 * Without it the floor opens at version 1 exactly as before.
	 */
	readonly retirementFences?: true;
}
export interface BrowserRoomHeadAuthority extends RoomHeadAuthority {
	acquireNativeReadReservation(input: Readonly<{ scope: RoomHeadScope }>): Promise<NativeReadReservation>;
	readRetirementImage(
		input: Readonly<{ scope: RoomHeadScope }>
	): Promise<Pick<RoomHeadRetirementObservation, "scope" | "state" | "control" | "imageDigest" | "metadataBytes">>;
	acquireRetirementControl(input: Readonly<{ scope: RoomHeadScope }>): Promise<RoomHeadRetirementObservation>;
	close(): Promise<void>;
}
/**
 * One captured fence record. Declared structurally here so the packed declarations
 * reference only root `@ts-drp/storage` names; it matches `RoomHeadRetirementFences`.
 */
export interface BrowserRoomHeadRetirementFenceRecord {
	readonly version: 1;
	readonly scope: RoomHeadScope;
	readonly revision: number;
	readonly owners: readonly (readonly [
		"ahe" | "issuance" | "journal" | "signing" | "snapshot",
		Readonly<{ base: string; target: string; through: number }>,
	])[];
}
/** Present only on a floor opened with `retirementFences: true`. Fences record expectations, never authority. */
export interface BrowserRoomHeadRetirementFences {
	fenceRetirement(
		input: Readonly<{
			scope: RoomHeadScope;
			owners: readonly Readonly<{ owner: string; through: number; base: string; target: string }>[];
		}>
	): Promise<BrowserRoomHeadRetirementFenceRecord>;
	readRetirementFences(input: Readonly<{ scope: RoomHeadScope }>): Promise<BrowserRoomHeadRetirementFenceRecord | null>;
}
/**
 * Open a host-selected IndexedDB floor without inventing freshness authority.
 * @param options - Explicit native database and create/migrate/reopen mode.
 * @returns A strict mechanical host-floor participant. Reopen never creates a missing database.
 */
export async function createBrowserRoomHeadAuthority(
	options: BrowserRoomHeadOptions & Readonly<{ retirementFences: true }>
): Promise<BrowserRoomHeadAuthority & BrowserRoomHeadRetirementFences>;
export async function createBrowserRoomHeadAuthority(
	options: BrowserRoomHeadOptions
): Promise<BrowserRoomHeadAuthority>;
export async function createBrowserRoomHeadAuthority(
	options: BrowserRoomHeadOptions
): Promise<BrowserRoomHeadAuthority> {
	const optionKeys =
		options !== null && typeof options === "object" && Reflect.ownKeys(options).includes("retirementFences")
			? ["databaseName", "initialization", "retirementFences"]
			: ["databaseName", "initialization"];
	const o = roomHeadFields(options, optionKeys);
	if (optionKeys.length === 3 && o.retirementFences !== true) throw new TypeError("ROOM_HEAD_INVALID_OPTIONS");
	const fenced = optionKeys.length === 3;
	if (
		typeof o.databaseName !== "string" ||
		o.databaseName.length === 0 ||
		o.databaseName.length > 512 ||
		o.databaseName.includes("\0")
	)
		throw new TypeError("ROOM_HEAD_INVALID_DATABASE");
	if (o.initialization === null || typeof o.initialization !== "object")
		throw new TypeError("ROOM_HEAD_INVALID_INITIALIZATION");
	const init = roomHeadFields(
		o.initialization,
		Reflect.ownKeys(o.initialization).includes("head") ? ["kind", "head"] : ["kind"]
	);
	if (init.kind !== "create" && init.kind !== "reopen" && init.kind !== "migrate")
		throw new TypeError("ROOM_HEAD_INVALID_INITIALIZATION");
	let initialization: RoomHeadInitialization;
	if (init.kind === "migrate") {
		const fields = roomHeadFields(o.initialization, ["kind", "head"]),
			head = roomHeadFields(fields.head, ["currentAnchorDigest", "epoch", "objectId"]);
		const scope = captureRoomHeadScope({
			objectId: head.objectId,
			pinnedGenesisAnchorDigest: roomHeadDigest(head.currentAnchorDigest),
		});
		initialization = Object.freeze({ kind: "migrate", head: captureRoomHead(fields.head, scope) });
	} else {
		roomHeadFields(o.initialization, ["kind"]);
		initialization = Object.freeze({ kind: init.kind });
	}
	const r = indexedDB.open(o.databaseName, fenced ? 2 : 1);
	r.addEventListener("upgradeneeded", (event) => {
		const oldVersion = event.oldVersion;
		if (oldVersion === 0) {
			if (initialization.kind === "reopen") r.transaction?.abort();
			else {
				r.result.createObjectStore(STORE);
				if (fenced) r.result.createObjectStore(FENCES);
			}
		} else if (
			fenced &&
			oldVersion === 1 &&
			r.result.objectStoreNames.length === 1 &&
			r.result.objectStoreNames.contains(STORE)
		) {
			// Version 2 adds only the fence store; the version-1 floor is kept byte for byte.
			r.result.createObjectStore(FENCES);
		} else r.transaction?.abort();
	});
	const database = await request(r);
	const stores = fenced ? [STORE, FENCES] : [STORE];
	if (
		database.objectStoreNames.length !== stores.length ||
		stores.some((name) => !database.objectStoreNames.contains(name))
	) {
		database.close();
		throw new Error("ROOM_HEAD_UNSUPPORTED_SCHEMA");
	}
	const catalog = database.transaction(stores, "readonly");
	if (
		stores.some((name) => {
			const schema = catalog.objectStore(name);
			return schema.keyPath !== null || schema.autoIncrement || schema.indexNames.length !== 0;
		})
	) {
		database.close();
		throw new Error("ROOM_HEAD_UNSUPPORTED_SCHEMA");
	}
	const reservations = new NativeReadReservationOwner(database);
	let closed = false;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closed = true;
		return (closing ??= (async (): Promise<void> => {
			try {
				await reservations.close();
			} finally {
				database.close();
			}
		})());
	};
	database.addEventListener("versionchange", () => {
		void close().catch(() => undefined);
	});
	const ensureOpen = (): void => {
		if (closed) throw new Error("ROOM_HEAD_CLOSED");
	};
	async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
		return transactOver(mode, [STORE], (tx) => action(tx.objectStore(STORE)));
	}
	async function transactOver<T>(
		mode: IDBTransactionMode,
		names: string[],
		action: (tx: IDBTransaction) => Promise<T>
	): Promise<T> {
		ensureOpen();
		const operation = async (): Promise<T> => {
			const tx =
				mode === "readonly"
					? nativeReadonlyTransaction(database, names)
					: database.transaction(names, "readwrite", { durability: "strict" });
			// The fence store is new; its writes refuse unless the engine reports strict durability.
			if (mode === "readwrite" && names.includes(FENCES) && tx.durability !== "strict") {
				tx.abort();
				throw new Error("ROOM_HEAD_DURABILITY_UNAVAILABLE");
			}
			const held = isNativeReadReservationTransaction(tx),
				done = held ? undefined : terminal(tx);
			void done?.catch(() => undefined);
			try {
				const result = await action(tx);
				if (held) await nativeReadReservationCheck(tx);
				else await done;
				ensureOpen();
				return result;
			} catch (cause) {
				if (!held) {
					try {
						tx.abort();
					} catch {
						/* terminal already settled */
					}
					await done?.catch(() => undefined);
				}
				throw cause;
			}
		};
		return mode === "readonly" ? runNativeReservedRead(database, operation) : operation();
	}
	async function load(store: IDBObjectStore): Promise<Image | null> {
		const bytes = await request(store.get(KEY)),
			count = await request(store.count());
		if ((bytes !== undefined && count !== 1) || (bytes === undefined && count > 2))
			throw new Error("ROOM_HEAD_UNEXPECTED_ROWS");
		return bytes === undefined ? null : captureImage(bytes);
	}
	async function save(store: IDBObjectStore, image: Image): Promise<void> {
		await request(store.put(encodeCanonical(image, LIMITS), KEY));
	}
	function inputScope(
		input: unknown,
		keys: readonly string[]
	): { r: Readonly<Record<string, unknown>>; scope: RoomHeadScope } {
		const r = roomHeadFields(input, keys);
		return { r, scope: captureRoomHeadScope(r.scope) };
	}
	async function apply(kind: "create" | "migrate" | "begin" | "commit", input: unknown): Promise<RoomHeadResult> {
		const { r: i, scope } = inputScope(
			input,
			kind === "begin" ? ["scope", "expected", "next"] : kind === "commit" ? ["scope", "expected"] : ["scope", "stable"]
		);
		const supplied =
			kind === "create" || kind === "migrate"
				? captureRoomHead(i.stable, scope)
				: captureRoomHeadState(i.expected, scope);
		const next = kind === "begin" ? captureRoomHead(i.next, scope) : undefined;
		return transact("readwrite", async (store) => {
			const old = await load(store);
			if (old !== null && !sameRoomHeadValue(old.scope, scope)) return conflict();
			if (kind === "create" || kind === "migrate") {
				if (initialization.kind !== kind) return conflict();
				const state = captureRoomHeadState({ stable: supplied, pending: null }, scope);
				if (kind === "create" && state.stable.epoch !== 0) return conflict();
				if (kind === "migrate" && !sameRoomHeadValue((initialization as { head: unknown }).head, state.stable))
					return conflict();
				if (old !== null) return sameRoomHeadValue(old.state, state) ? { ok: true, state: old.state } : conflict();
				// Explicit migration alone may consume the original fixture's scope/state pair. Reopen never creates it.
				const keys = await request(store.getAllKeys(undefined, 3));
				if (keys.length !== 0 && (keys.length !== 2 || !keys.includes("scope") || !keys.includes("state")))
					throw new Error("ROOM_HEAD_UNEXPECTED_ROWS");
				const legacyScope = await request(store.get("scope")),
					legacyState = await request(store.get("state"));
				if (legacyScope !== undefined || legacyState !== undefined) {
					if (
						kind !== "migrate" ||
						!sameRoomHeadValue(captureRoomHeadScope(legacyScope), scope) ||
						!sameRoomHeadValue(captureRoomHeadState(legacyState, scope), state)
					)
						return conflict();
				}
				const image: Image = {
					version: 1,
					scope,
					state,
					control: { incarnation: randomIncarnation(), revision: 0, active: null, completed: null },
				};
				await save(store, image);
				await request(store.delete("scope"));
				await request(store.delete("state"));
				return { ok: true, state };
			}
			if (old === null || old.control.active !== null || !sameRoomHeadValue(old.state, supplied)) return conflict();
			let state: RoomHeadState;
			if (kind === "begin") {
				if (old.state.pending !== null) return conflict();
				state = captureRoomHeadState(
					{ stable: old.state.stable, pending: { previous: old.state.stable, next } },
					scope
				);
			} else {
				if (old.state.pending === null) return conflict();
				state = captureRoomHeadState({ stable: old.state.pending.next, pending: null }, scope);
			}
			await save(store, { ...old, state, control: nextControl(old.control, {}) });
			return { ok: true, state };
		});
	}
	async function reserve(input: unknown): Promise<NativeReadReservation> {
		const { scope } = inputScope(input, ["scope"]);
		ensureOpen();
		return reservations.acquire({ objectId: scope.objectId });
	}
	const authority: BrowserRoomHeadAuthority = {
		initialization,
		read: async (input): Promise<RoomHeadResult> => {
			const { scope } = inputScope(input, ["scope"]);
			return transact("readonly", async (store) => {
				const image = await load(store);
				return image !== null && !sameRoomHeadValue(image.scope, scope)
					? conflict()
					: { ok: true, state: image?.state ?? null };
			});
		},
		create: (input) => apply("create", input),
		migrate: (input) => apply("migrate", input),
		begin: (input) => apply("begin", input),
		commit: (input) => apply("commit", input),
		acquireNativeReadReservation: reserve,
		readRetirementImage: async (input) => {
			const { scope } = inputScope(input, ["scope"]);
			return transact("readonly", async (store) => {
				const original = await load(store);
				if (original === null || !sameRoomHeadValue(original.scope, scope))
					throw new Error("ROOM_HEAD_CONTROL_CONFLICT");
				return Object.freeze({
					scope: original.scope,
					state: original.state,
					control: original.control,
					imageDigest: imageDigest(original),
					metadataBytes: encodeCanonical(original, LIMITS).byteLength,
				});
			});
		},
		acquireRetirementControl: async (input): Promise<RoomHeadRetirementObservation> => {
			const { scope } = inputScope(input, ["scope"]),
				held = await reserve(input);
			let original: Image;
			try {
				original = await transact("readonly", async (store) => {
					const image = await load(store);
					if (image === null || !sameRoomHeadValue(image.scope, scope)) throw new Error("ROOM_HEAD_CONTROL_CONFLICT");
					return image;
				});
			} catch (cause) {
				try {
					await held.release();
				} catch (cleanup) {
					throw new AggregateError([cause, cleanup], "native floor capture and release failed", { cause });
				}
				throw cause;
			}
			let released = false,
				consumed = false;
			let join: Promise<void> | undefined;
			const release = (): Promise<void> => {
				released = true;
				return (join ??= held.release());
			};
			async function change(
				kind: "prepare" | "abort" | "commit",
				value: RoomHeadFenceCommitment
			): Promise<RoomHeadControl> {
				if (consumed || released) throw new Error("ROOM_HEAD_OBSERVATION_RELEASED");
				const commitment = captureRoomHeadFence(value);
				consumed = true;
				// Join original admitted reads and revoke new reads before any native write. Fresh exact CAS closes the gap.
				await release();
				return transact("readwrite", async (store) => {
					const now = await load(store);
					if (now === null || !sameRoomHeadValue(now, original)) throw new Error("ROOM_HEAD_CONTROL_STALE");
					const next = roomHeadRetirementChange(now, kind, commitment);
					await save(store, next);
					return next.control;
				});
			}
			const observation: RoomHeadRetirementObservation = {
				scope,
				state: original.state,
				control: original.control,
				imageDigest: imageDigest(original),
				metadataBytes: encodeCanonical(original, LIMITS).byteLength,
				prepareFence: (value) => change("prepare", value),
				abortPrepared: (value) => change("abort", value),
				commitPrepared: (value) => change("commit", value),
				release,
			};
			return Object.freeze(observation);
		},
		close,
	};
	if (!fenced) return Object.freeze(authority);
	const fences: BrowserRoomHeadRetirementFences = {
		fenceRetirement: async (input) => {
			const fenceRequest = captureRoomRetirementFenceRequest(input);
			return transactOver("readwrite", [STORE, FENCES], async (tx) => {
				const image = await load(tx.objectStore(STORE));
				if (image === null) throw new Error("ROOM_HEAD_CONTROL_CONFLICT");
				const fenceStore = tx.objectStore(FENCES);
				const stored: unknown = await request(fenceStore.get(fenceRequest.scope.objectId));
				const next = roomHeadRetirementFenceChange(stored, image, fenceRequest);
				if (stored !== undefined && next.revision === captureRoomHeadRetirementFences(stored, image.scope).revision)
					return next;
				await request(fenceStore.put(encodeRoomHeadRetirementFences(next), fenceRequest.scope.objectId));
				return next;
			});
		},
		readRetirementFences: async (input) => {
			const { scope } = inputScope(input, ["scope"]);
			return transactOver("readonly", [STORE, FENCES], async (tx) => {
				const image = await load(tx.objectStore(STORE));
				if (image === null || !sameRoomHeadValue(image.scope, scope)) throw new Error("ROOM_HEAD_CONTROL_CONFLICT");
				const stored: unknown = await request(tx.objectStore(FENCES).get(scope.objectId));
				return stored === undefined ? null : captureRoomHeadRetirementFences(stored, image.scope);
			});
		},
	};
	return Object.freeze({ ...authority, ...fences });
}
