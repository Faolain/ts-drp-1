import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	captureRoomHead,
	captureRoomHeadFence,
	captureRoomHeadImage,
	captureRoomHeadScope,
	captureRoomHeadState,
	type NativeReadReservation,
	ROOM_HEAD_IMAGE_LIMITS,
	type RoomHeadAuthority,
	type RoomHeadControl,
	type RoomHeadFenceCommitment,
	roomHeadFields,
	type RoomHeadImage,
	roomHeadImageDigest,
	type RoomHeadInitialization,
	type RoomHeadResult,
	roomHeadRetirementChange,
	type RoomHeadRetirementObservation,
	type RoomHeadScope,
	sameRoomHeadValue,
} from "@ts-drp/storage";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { createRecoverableFinalitySigner, retireRecoverableFinalitySigner } from "@ts-drp/keychain/finality";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { SqliteNativeReadReservationOwner } from "./internal/native-read-reservation.js";
import type { LocalSessionLifetime } from "./internal/local-session-lifetime.js";
import { acquireSnapshotDependencyLock } from "./internal/snapshot-dependency-lock.js";
import { consumeLocalSessionCleanupReceipt, resolveLocalSessionPreparedTerminal } from "./internal/local-session-catalog.js";
import { cachedStatement } from "./internal/sqlite-statement-cache.js";
import { resolveOwnedLocalSessionTerminalAdmission } from "@ts-drp/node/v3-room";

const SCHEMA =
	"CREATE TABLE room_head (id INTEGER PRIMARY KEY CHECK(id = 1), image BLOB NOT NULL CHECK(length(image) <= 16384)) STRICT";
const GENESIS_SCHEMA = "CREATE TABLE room_genesis_creation (id INTEGER PRIMARY KEY CHECK(id = 1), binding BLOB NOT NULL CHECK(length(binding) = 32)) STRICT";
const ACCOUNT_SCHEMA = Object.freeze([
	"CREATE TABLE room_session_policy(id INTEGER PRIMARY KEY CHECK(id=1),identity BLOB NOT NULL CHECK(length(identity)=32),slots INTEGER NOT NULL,store_scopes INTEGER NOT NULL,handles INTEGER NOT NULL,setup TEXT NOT NULL CHECK(setup IN ('initializing','ready'))) STRICT",
	"CREATE TABLE room_session_slots(slot INTEGER PRIMARY KEY,incarnation INTEGER NOT NULL CHECK(incarnation>=0),status TEXT NOT NULL CHECK(status IN ('free','reserved','active','retiring')),owner BLOB CHECK(owner IS NULL OR length(owner)=32),seed BLOB CHECK(seed IS NULL OR length(seed)=32),public_key BLOB CHECK(public_key IS NULL OR length(public_key)=32),terminal BLOB CHECK(terminal IS NULL OR length(terminal)=32)) STRICT",
	"CREATE TABLE room_session_heads(slot INTEGER NOT NULL,incarnation INTEGER NOT NULL,scope BLOB NOT NULL CHECK(length(scope)=32),image BLOB NOT NULL CHECK(length(image)<=16384),genesis BLOB CHECK(genesis IS NULL OR length(genesis)=32),root BLOB CHECK(root IS NULL OR length(root)=32),PRIMARY KEY(slot,scope)) STRICT",
]);
export interface NodeDisposableSessionProfile { readonly slots: number; readonly storeScopes: number; readonly handles: number; }
export interface NodeDisposableSessionSelector { readonly slot: number; readonly incarnation: number; }
declare const accountLeaseBrand: unique symbol;
export interface NodeDisposableSessionAccountLease { readonly [accountLeaseBrand]: true; }
type AccountLeaseFacts = {
	readonly authority: NodeRoomHeadAuthority; readonly filename: string; readonly selector: NodeDisposableSessionSelector;
	readonly owner: Uint8Array; readonly profile: NodeDisposableSessionProfile;
	readonly identity: Uint8Array; readonly initialization: RoomHeadInitialization;
	check(allowRetiring?: boolean): void; bindKey(publicKey: Uint8Array): void; assertBound(): void;
	assertUnfenced(): void; acquireUnfencedRecoveryReservation(): Promise<NativeReadReservation>;
	bindRoot(scope: RoomHeadScope, digest: Uint8Array): void;
	fence(admission: unknown, nativePreparation: unknown): void;
	terminalDigest(): Uint8Array;
	beginCleanup(): void; checkCleanup(): void;
	complete(receipt: unknown): void; release(): void;
};
const accountLeases = new WeakMap<NodeDisposableSessionAccountLease, AccountLeaseFacts>();
const accountKeys = new WeakMap<NodeDisposableSessionAccountLease, (lifetime: LocalSessionLifetime) => ReturnType<typeof createRecoverableFinalitySigner>>();
const accountOwners = new WeakMap<NodeRoomHeadAuthority, {
	describe(input: Readonly<{ directory: string; profile: NodeDisposableSessionProfile }>): Readonly<{ identity: Uint8Array; owner: Uint8Array }>;
	acquire(input: Readonly<{ kind: "create" | "reopen" | "resume-terminal"; directory: string; profile: NodeDisposableSessionProfile; selector?: NodeDisposableSessionSelector }>): NodeDisposableSessionAccountLease;
}>();
export function describeNodeDisposableSessionAccount(authority: NodeRoomHeadAuthority,
	input: Readonly<{ directory: string; profile: NodeDisposableSessionProfile }>): Readonly<{ identity: Uint8Array; owner: Uint8Array }> {
	const owner = accountOwners.get(authority);
	if (owner === undefined) throw new TypeError("DISPOSABLE_SESSION_ACCOUNT_PROVIDER_REQUIRED");
	return owner.describe(input);
}
/** Consumer of the original native account provider, never a structural grant. */
export function acquireNodeDisposableSessionAccount(authority: NodeRoomHeadAuthority,
	input: Readonly<{ kind: "create" | "reopen" | "resume-terminal"; directory: string; profile: NodeDisposableSessionProfile; selector?: NodeDisposableSessionSelector }>): NodeDisposableSessionAccountLease {
	const owner = accountOwners.get(authority);
	if (owner === undefined) throw new TypeError("DISPOSABLE_SESSION_ACCOUNT_PROVIDER_REQUIRED");
	return owner.acquire(input);
}
/** Internal native consumer. The returned mechanics confer no portable authority. */
export function resolveNodeDisposableSessionAccount(lease: unknown): AccountLeaseFacts {
	const facts = lease !== null && typeof lease === "object" ? accountLeases.get(lease as NodeDisposableSessionAccountLease) : undefined;
	if (facts === undefined) throw new TypeError("UNTRUSTED_DISPOSABLE_SESSION_ACCOUNT_LEASE");
	return facts;
}
/** Same original floor implementation, indexed by the genuine independent slot.
 * No new per-room file, alternate adapter or portable authority is created. */
export function openNodeDisposableSessionRoomHead(lease: NodeDisposableSessionAccountLease, lifetime: LocalSessionLifetime): NodeRoomHeadAuthority {
	const facts = resolveNodeDisposableSessionAccount(lease);
	return createNodeRoomHeadAuthority({ filename: facts.filename, initialization: facts.initialization,
		disposableSessionProfile: facts.profile }, lifetime, lease);
}
/** Original recoverable-key custody; never exports the account-owned seed. */
export function acquireNodeDisposableSessionSigning(lease: NodeDisposableSessionAccountLease, lifetime: LocalSessionLifetime): ReturnType<typeof createRecoverableFinalitySigner> {
	const acquire = accountKeys.get(lease);
	if (acquire === undefined) throw new TypeError("UNTRUSTED_DISPOSABLE_SESSION_ACCOUNT_LEASE");
	return acquire(lifetime);
}
type GenesisCreation = Readonly<{ scope: RoomHeadScope; bindingDigest: Uint8Array }>;
type GenesisOwner = { run<T>(input: GenesisCreation, action: () => Promise<T>): Promise<T> };
const genesisOwners = new WeakMap<RoomHeadAuthority, GenesisOwner>();

/** Existing account-selected native provider only. Its retained identity and
 * explicit creation act are account premises, never inferred from null/epoch0. */
export function withNodeRoomGenesisCreation<T>(authority: RoomHeadAuthority, input: GenesisCreation, action: () => Promise<T>): Promise<T> {
	const owner = genesisOwners.get(authority);
	if (owner === undefined) throw new TypeError("ROOM_GENESIS_ACCOUNT_PROVIDER_REQUIRED");
	return owner.run(input, action);
}
const conflict = (): RoomHeadResult => Object.freeze({ ok: false, reason: "conflict" });

export interface NodeRoomHeadOptions {
	readonly filename: string;
	readonly initialization: RoomHeadInitialization;
	readonly disposableSessionProfile?: NodeDisposableSessionProfile;
}
export interface NodeRoomHeadAuthority extends RoomHeadAuthority {
	acquireNativeReadReservation(input: Readonly<{ scope: RoomHeadScope }>): Promise<NativeReadReservation>;
	readRetirementImage(
		input: Readonly<{ scope: RoomHeadScope }>
	): Promise<Pick<RoomHeadRetirementObservation, "scope" | "state" | "control" | "imageDigest" | "metadataBytes">>;
	acquireRetirementControl(input: Readonly<{ scope: RoomHeadScope }>): Promise<RoomHeadRetirementObservation>;
	close(): Promise<void>;
	inspectDisposableSessions(): readonly Readonly<NodeDisposableSessionSelector & { status: "free" | "reserved" | "active" | "retiring" }>[];
}

/**
 * Opens a host-selected SQLite floor. Native persistence is not an independent
 * freshness authority; initialization is an explicit host custody decision.
 * @param options - Exact native filename and create/migrate/reopen mode.
 * @returns Mechanical floor CAS and native exclusion under the shared floor law.
 */
export function createNodeRoomHeadAuthority(options: NodeRoomHeadOptions, session?: LocalSessionLifetime,
	accountLease?: NodeDisposableSessionAccountLease): NodeRoomHeadAuthority {
	session?.assertCurrent();
	const account = accountLease === undefined ? undefined : resolveNodeDisposableSessionAccount(accountLease);
	const o = roomHeadFields(options, Object.hasOwn(options, "disposableSessionProfile") ? ["filename", "initialization", "disposableSessionProfile"] : ["filename", "initialization"]);
	const profile = o.disposableSessionProfile === undefined ? undefined : roomHeadFields(o.disposableSessionProfile, ["slots", "storeScopes", "handles"]) as unknown as NodeDisposableSessionProfile;
	if (profile !== undefined && (![profile.slots, profile.storeScopes, profile.handles].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(profile.slots * profile.storeScopes))) throw new TypeError("INVALID_LOCAL_SESSION_CAPACITY_PROFILE");
	account?.check();
	if (typeof o.filename !== "string" || o.filename.length === 0 || o.filename.includes("\0"))
		throw new TypeError("ROOM_HEAD_INVALID_DATABASE");
	if (profile !== undefined && Buffer.byteLength(o.filename) > ROOM_HEAD_IMAGE_LIMITS.maxBytes) throw new TypeError("ROOM_HEAD_INVALID_DATABASE");
	if (o.initialization === null || typeof o.initialization !== "object")
		throw new TypeError("ROOM_HEAD_INVALID_INITIALIZATION");
	const init = roomHeadFields(
		o.initialization,
		Reflect.ownKeys(o.initialization).includes("head") ? ["kind", "head"] : ["kind"]
	);
	let initialization: RoomHeadInitialization;
	if (init.kind === "migrate") {
		const fields = roomHeadFields(o.initialization, ["kind", "head"]),
			head = roomHeadFields(fields.head, ["currentAnchorDigest", "epoch", "objectId"]),
			scope = captureRoomHeadScope({ objectId: head.objectId, pinnedGenesisAnchorDigest: head.currentAnchorDigest });
		initialization = Object.freeze({ kind: "migrate", head: captureRoomHead(fields.head, scope) });
	} else if (init.kind === "create" || init.kind === "reopen") {
		roomHeadFields(o.initialization, ["kind"]);
		initialization = Object.freeze({ kind: init.kind });
	} else throw new TypeError("ROOM_HEAD_INVALID_INITIALIZATION");
	const filename = resolve(o.filename),
		uri = pathToFileURL(filename);
	if (account !== undefined && (filename !== account.filename || profile === undefined || profile.slots !== account.profile.slots || profile.storeScopes !== account.profile.storeScopes || profile.handles !== account.profile.handles)) throw new Error("DISPOSABLE_SESSION_ACCOUNT_PROFILE_MISMATCH");
	const existed = existsSync(filename);
	// Native rw open fails if absent; reopen never creates either a file or schema.
	uri.searchParams.set("mode", initialization.kind === "reopen" ? "rw" : "rwc");
	const database = new DatabaseSync(uri.href, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
	try {
		database.exec("PRAGMA busy_timeout=1000");
		if (initialization.kind !== "reopen") {
			database.exec("BEGIN IMMEDIATE");
			try {
				const schema = cachedStatement(database, "SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 3").all();
				if (schema.length === 0) {
					if (profile !== undefined && existed) throw new Error("DISPOSABLE_SESSION_ACCOUNT_LOST");
					database.exec(SCHEMA);
					if (profile !== undefined) {
						for (const ddl of ACCOUNT_SCHEMA) database.exec(ddl);
						cachedStatement(database, "INSERT INTO room_session_policy VALUES(1,?,?,?,?,'initializing')").run(randomBytes(32), profile.slots, profile.storeScopes, profile.handles);
						for (let slot = 0; slot < profile.slots; slot++) cachedStatement(database, "INSERT INTO room_session_slots(slot,incarnation,status) VALUES(?,0,'free')").run(slot);
					}
				}
				database.exec("COMMIT");
			} catch (cause) {
				database.exec("ROLLBACK");
				throw cause;
			}
		}
		const schemaBytes = Math.max(Buffer.byteLength(SCHEMA), Buffer.byteLength(GENESIS_SCHEMA), ...ACCOUNT_SCHEMA.map(ddl => Buffer.byteLength(ddl)));
		const expected = profile === undefined ? [SCHEMA] : [SCHEMA, ...ACCOUNT_SCHEMA];
		const schema = cachedStatement(database, `SELECT CASE WHEN typeof(type)='text' AND length(CAST(type AS BLOB))<=16 THEN type ELSE NULL END AS type,CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=32 THEN name ELSE NULL END AS name,CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=${schemaBytes} THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT ${expected.length + 2}`).all();
		if (
			(schema.length !== expected.length && schema.length !== expected.length + 1) ||
			expected.some(ddl => !schema.some(row => row.type === "table" && row.sql === ddl)) ||
			(schema.length === expected.length + 1 && !schema.some(row => row.type === "table" && row.name === "room_genesis_creation" && row.sql === GENESIS_SCHEMA))
		)
			throw new Error("ROOM_HEAD_UNSUPPORTED_SCHEMA");
		if (initialization.kind !== "reopen") database.exec("PRAGMA journal_mode=WAL");
		if (cachedStatement(database, "PRAGMA journal_mode").get()?.journal_mode !== "wal")
			throw new Error("ROOM_HEAD_UNSUPPORTED_DURABILITY");
		database.exec("PRAGMA synchronous=FULL");
	} catch (cause) {
		database.close();
		throw cause;
	}
	const reservations = new SqliteNativeReadReservationOwner(filename, session);
	let closed = false,
		closing: Promise<void> | undefined, genesisJoined: Promise<void> | undefined;
	const ensureOpen = (): void => {
		session?.assertCurrent();
		account?.check();
		if (closed) throw new Error("ROOM_HEAD_CLOSED");
	};
	const close = (): Promise<void> => {
		closed = true;
		reservations.revoke();
		return (closing ??= (async (): Promise<void> => {
			try {
				await genesisJoined; // Original entered genesis/signing turn, not caller-only join.
				await reservations.close();
			} finally {
				database.close();
			}
			session?.closedOwner(authority);
		})());
	};
	const scopeDigest = (scope: RoomHeadScope): Uint8Array => hashDomain("ts-drp/disposable-room-head-scope/v1", encodeCanonical(scope, ROOM_HEAD_IMAGE_LIMITS));
	function load(scope?: RoomHeadScope): RoomHeadImage | null {
		if (account !== undefined) {
			if (scope === undefined) throw new Error("DISPOSABLE_SESSION_EXACT_SCOPE_REQUIRED");
			const row = cachedStatement(database, "SELECT incarnation, CASE WHEN typeof(image)='blob' AND length(image)<=16384 THEN image ELSE NULL END AS image FROM room_session_heads WHERE slot=? AND scope=?").get(account.selector.slot, scopeDigest(scope));
			if (row === undefined) return null;
			if (row.incarnation !== account.selector.incarnation || !(row.image instanceof Uint8Array)) throw new Error("DISPOSABLE_SESSION_ROOM_HEAD_LOST");
			const image = captureRoomHeadImage(row.image);
			if (!sameRoomHeadValue(image.scope, scope)) throw new Error("DISPOSABLE_SESSION_ROOM_HEAD_CONFLICT");
			return image;
		}
		const rows = cachedStatement(database, "SELECT id, length(image) AS bytes FROM room_head LIMIT 2").all();
		if (rows.length === 0) return null;
		if (
			rows.length !== 1 ||
			rows[0]?.id !== 1 ||
			typeof rows[0]?.bytes !== "number" ||
			rows[0].bytes > ROOM_HEAD_IMAGE_LIMITS.maxBytes
		)
			throw new Error("ROOM_HEAD_UNEXPECTED_ROWS");
		return captureRoomHeadImage(cachedStatement(database, "SELECT image FROM room_head WHERE id=1").get()?.image);
	}
	function save(image: RoomHeadImage): void {
		if (account !== undefined) {
			const key = scopeDigest(image.scope), before = cachedStatement(database, "SELECT 1 FROM room_session_heads WHERE slot=? AND scope=?").get(account.selector.slot, key);
			if (before === undefined && Number(cachedStatement(database, "SELECT count(*) AS n FROM room_session_heads WHERE slot=?").get(account.selector.slot)?.n) >= account.profile.storeScopes) throw new Error("LOCAL_SESSION_STORE_SCOPE_CAPACITY");
			cachedStatement(database, "INSERT INTO room_session_heads(slot,incarnation,scope,image) VALUES(?,?,?,?) ON CONFLICT(slot,scope) DO UPDATE SET image=excluded.image WHERE room_session_heads.incarnation=excluded.incarnation").run(account.selector.slot, account.selector.incarnation, key, encodeCanonical(image, ROOM_HEAD_IMAGE_LIMITS));
			return;
		}
		cachedStatement(database, "INSERT INTO room_head(id,image) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET image=excluded.image")
			.run(encodeCanonical(image, ROOM_HEAD_IMAGE_LIMITS));
	}
	function transact<T>(write: boolean, action: () => T): T {
		ensureOpen();
		database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			ensureOpen(); // Native admission may have waited behind an independent fence writer.
			const result = action();
			database.exec("COMMIT");
			ensureOpen();
			return result;
		} catch (cause) {
			try {
				database.exec("ROLLBACK");
			} catch {
				/* Preserve the original native failure. */
			}
			throw cause;
		}
	}
	function inputScope(
		input: unknown,
		keys: readonly string[]
	): { r: Readonly<Record<string, unknown>>; scope: RoomHeadScope } {
		const r = roomHeadFields(input, keys);
		return { r, scope: captureRoomHeadScope(r.scope) };
	}
	// SQLite commits synchronously; async delivery converts native failures to the port's Promise refusal.
	// eslint-disable-next-line @typescript-eslint/require-await
	async function apply(kind: "create" | "migrate" | "begin" | "commit", input: unknown): Promise<RoomHeadResult> {
		const { r, scope } = inputScope(
			input,
			kind === "begin" ? ["scope", "expected", "next"] : kind === "commit" ? ["scope", "expected"] : ["scope", "stable"]
		);
		const supplied =
			kind === "create" || kind === "migrate"
				? captureRoomHead(r.stable, scope)
				: captureRoomHeadState(r.expected, scope);
		const next = kind === "begin" ? captureRoomHead(r.next, scope) : undefined;
		return transact(true, () => {
			const old = load(scope);
			if (old !== null && !sameRoomHeadValue(old.scope, scope)) return conflict();
			if (kind === "create" || kind === "migrate") {
				if (initialization.kind !== kind) return conflict();
				const state = captureRoomHeadState({ stable: supplied, pending: null }, scope);
				if (kind === "create" && state.stable.epoch !== 0) return conflict();
				if (initialization.kind === "migrate" && !sameRoomHeadValue(initialization.head, state.stable))
					return conflict();
				if (old !== null) return sameRoomHeadValue(old.state, state) ? { ok: true, state: old.state } : conflict();
				save({
					version: 1,
					scope,
					state,
					control: { incarnation: randomBytes(32).toString("hex"), revision: 0, active: null, completed: null },
				});
				return { ok: true, state };
			}
			if (old === null || old.control.active !== null || !sameRoomHeadValue(old.state, supplied)) return conflict();
			const state =
				kind === "begin"
					? old.state.pending === null
						? captureRoomHeadState({ stable: old.state.stable, pending: { previous: old.state.stable, next } }, scope)
						: undefined
					: old.state.pending === null
						? undefined
						: captureRoomHeadState({ stable: old.state.pending.next, pending: null }, scope);
			if (state === undefined) return conflict();
			if (old.control.revision === Number.MAX_SAFE_INTEGER) throw new Error("ROOM_HEAD_REVISION_EXHAUSTED");
			save({ ...old, state, control: { ...old.control, revision: old.control.revision + 1 } });
			return { ok: true, state };
		});
	}
	async function reserve(input: unknown): Promise<NativeReadReservation> {
		inputScope(input, ["scope"]);
		ensureOpen();
		return reservations.acquire();
	}
	const authority: NodeRoomHeadAuthority = {
		initialization,
		// eslint-disable-next-line @typescript-eslint/require-await
		read: async (input) => {
			const { scope } = inputScope(input, ["scope"]);
			return transact(false, () => {
				const image = load(scope);
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
		// eslint-disable-next-line @typescript-eslint/require-await
		readRetirementImage: async (input) => {
			const { scope } = inputScope(input, ["scope"]);
			return transact(false, () => {
				const image = load(scope);
				if (image === null || !sameRoomHeadValue(image.scope, scope)) throw new Error("ROOM_HEAD_CONTROL_CONFLICT");
				return Object.freeze({
					scope: image.scope,
					state: image.state,
					control: image.control,
					imageDigest: roomHeadImageDigest(image),
					metadataBytes: encodeCanonical(image, ROOM_HEAD_IMAGE_LIMITS).byteLength,
				});
			});
		},
		acquireRetirementControl: async (input) => {
			const { scope } = inputScope(input, ["scope"]),
				held = await reserve(input);
			let original: RoomHeadImage;
			try {
				original = transact(false, () => {
					const image = load(scope);
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
				consumed = false,
				join: Promise<void> | undefined;
			const release = (): Promise<void> => {
				released = true;
				return (join ??= held.release());
			};
			async function change(
				kind: "prepare" | "abort" | "commit" | "fence",
				value: RoomHeadFenceCommitment
			): Promise<RoomHeadControl> {
				if (released || consumed) throw new Error("ROOM_HEAD_OBSERVATION_RELEASED");
				const commitment = captureRoomHeadFence(value);
				consumed = true;
				await release();
				return transact(true, () => {
					const now = load(scope);
					if (now === null || !sameRoomHeadValue(now, original)) throw new Error("ROOM_HEAD_CONTROL_STALE");
					// Slice 14b step A: prepare then commit one decision's labels in this one transaction.
					const next =
						kind === "fence"
							? roomHeadRetirementChange(roomHeadRetirementChange(now, "prepare", commitment), "commit", commitment)
							: roomHeadRetirementChange(now, kind, commitment);
					save(next);
					return next.control;
				});
			}
			return Object.freeze({
				scope,
				state: original.state,
				control: original.control,
				imageDigest: roomHeadImageDigest(original),
				metadataBytes: encodeCanonical(original, ROOM_HEAD_IMAGE_LIMITS).byteLength,
				prepareFence: (value: RoomHeadFenceCommitment) => change("prepare", value),
				abortPrepared: (value: RoomHeadFenceCommitment) => change("abort", value),
				commitPrepared: (value: RoomHeadFenceCommitment) => change("commit", value),
				fenceDecision: (value: RoomHeadFenceCommitment) => change("fence", value),
				release,
			});
		},
		close,
		inspectDisposableSessions: () => {
			if (profile === undefined || account !== undefined) throw new Error("DISPOSABLE_SESSION_ACCOUNT_PROVIDER_REQUIRED");
			return transact(false, () => cachedStatement(database, "SELECT slot,incarnation,CASE WHEN typeof(status)='text' AND length(CAST(status AS BLOB))<=8 THEN status ELSE NULL END AS status FROM room_session_slots ORDER BY slot LIMIT ?").all(profile.slots + 1).map(row => Object.freeze({ slot: Number(row.slot), incarnation: Number(row.incarnation), status: row.status as "free" | "reserved" | "active" | "retiring" })));
		},
	};
	if (profile !== undefined && account === undefined) {
		const lockFile = (slot: number): string => `${filename}.session-${slot}.sqlite`;
		let providerIdentity: Uint8Array | undefined;
		const projection = "CASE WHEN typeof(slot)='integer' THEN slot ELSE NULL END AS slot,CASE WHEN typeof(incarnation)='integer' THEN incarnation ELSE NULL END AS incarnation,CASE WHEN typeof(status)='text' AND length(CAST(status AS BLOB))<=8 THEN status ELSE NULL END AS status,CASE WHEN typeof(owner)='blob' AND length(owner)=32 THEN owner ELSE NULL END AS owner,CASE WHEN typeof(public_key)='blob' AND length(public_key)=32 THEN public_key ELSE NULL END AS public_key,CASE WHEN typeof(terminal)='blob' AND length(terminal)=32 THEN terminal ELSE NULL END AS terminal";
		const exactBytes = (value: unknown, label: string): Uint8Array => {
			if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError(label);
			return Uint8Array.from(value);
		};
		const validate = (): void => {
			const p = cachedStatement(database, "SELECT CASE WHEN typeof(identity)='blob' AND length(identity)=32 THEN identity ELSE NULL END AS identity,CASE WHEN typeof(slots)='integer' THEN slots ELSE NULL END AS slots,CASE WHEN typeof(store_scopes)='integer' THEN store_scopes ELSE NULL END AS store_scopes,CASE WHEN typeof(handles)='integer' THEN handles ELSE NULL END AS handles,CASE WHEN typeof(setup)='text' AND length(CAST(setup AS BLOB))<=12 THEN setup ELSE NULL END AS setup FROM room_session_policy WHERE id=1").get();
			if (!(p?.identity instanceof Uint8Array) || p.slots !== profile.slots || p.store_scopes !== profile.storeScopes || p.handles !== profile.handles ||
				!["initializing", "ready"].includes(String(p.setup)) || cachedStatement(database, "SELECT count(*) AS n FROM room_session_policy").get()?.n !== 1 || cachedStatement(database, "SELECT count(*) AS n FROM room_session_slots").get()?.n !== profile.slots) throw new Error("DISPOSABLE_SESSION_ACCOUNT_POLICY_LOST");
			if (providerIdentity !== undefined && !Buffer.from(p.identity).equals(providerIdentity)) throw new Error("DISPOSABLE_SESSION_ACCOUNT_IDENTITY_CHANGED");
			providerIdentity ??= Uint8Array.from(p.identity);
			const rows = cachedStatement(database, `SELECT ${projection} FROM room_session_slots ORDER BY slot LIMIT ?`).all(profile.slots + 1);
			if (rows.length !== profile.slots || rows.some((row, slot) => row.slot !== slot || !Number.isSafeInteger(row.incarnation) || Number(row.incarnation) < 0 ||
				!["free", "reserved", "active", "retiring"].includes(String(row.status)) || (row.status !== "free" && (row.incarnation === 0 || !(row.owner instanceof Uint8Array))) ||
				(row.status !== "free" && !(row.public_key instanceof Uint8Array)) || (row.status === "retiring" && !(row.terminal instanceof Uint8Array)) ||
				(row.status === "free" && (row.public_key !== null || ((row.owner === null) !== (row.terminal === null)))))) throw new Error("DISPOSABLE_SESSION_ACCOUNT_STATE_LOST");
			if (Number(cachedStatement(database, "SELECT count(*) AS n FROM room_session_heads").get()?.n) > profile.slots * profile.storeScopes ||
				cachedStatement(database, "SELECT 1 FROM room_session_heads AS h LEFT JOIN room_session_slots AS s ON s.slot=h.slot WHERE s.slot IS NULL OR s.status='free' OR h.incarnation<>s.incarnation OR typeof(h.scope)<>'blob' OR length(h.scope)<>32 OR typeof(h.image)<>'blob' OR length(h.image)>16384 OR (h.genesis IS NOT NULL AND (typeof(h.genesis)<>'blob' OR length(h.genesis)<>32)) OR (h.root IS NOT NULL AND (typeof(h.root)<>'blob' OR length(h.root)<>32)) LIMIT 1").get() ||
				cachedStatement(database, "SELECT 1 FROM room_session_heads GROUP BY slot HAVING count(*)>? LIMIT 1").get(profile.storeScopes)) throw new Error("DISPOSABLE_SESSION_ACCOUNT_HEAD_STATE_LOST");
			if (cachedStatement(database, "SELECT 1 FROM room_session_slots WHERE (status='free' AND seed IS NOT NULL) OR (status IN ('reserved','active') AND (typeof(seed)<>'blob' OR length(seed)<>32)) OR (seed IS NOT NULL AND (typeof(seed)<>'blob' OR length(seed)<>32)) LIMIT 1").get()) throw new Error("DISPOSABLE_SESSION_ACCOUNT_KEY_STATE_LOST");
			if (p.setup === "initializing") {
				if (rows.some(row => row.incarnation !== 0 || row.status !== "free") || cachedStatement(database, "SELECT 1 FROM room_session_heads LIMIT 1").get()) throw new Error("DISPOSABLE_SESSION_ACCOUNT_SETUP_POISONED");
				for (let slot = 0; slot < profile.slots; slot++) acquireSnapshotDependencyLock(lockFile(slot), "exclusive", true).release();
				cachedStatement(database, "UPDATE room_session_policy SET setup='ready' WHERE id=1 AND setup='initializing'").run();
			} else for (let slot = 0; slot < profile.slots; slot++) if (!existsSync(lockFile(slot))) throw new Error("DISPOSABLE_SESSION_ACCOUNT_COORDINATION_LOST");
		};
		transact(true, validate); // Committed initializing intent precedes exact coord installation.
		const describe = (input: Readonly<{ directory: string; profile: NodeDisposableSessionProfile }>): Readonly<{ identity: Uint8Array; owner: Uint8Array }> => {
			const fields = roomHeadFields(input, ["directory", "profile"]), configured = roomHeadFields(fields.profile, ["slots", "storeScopes", "handles"]);
			if (configured.slots !== profile.slots || configured.storeScopes !== profile.storeScopes || configured.handles !== profile.handles) throw new Error("DISPOSABLE_SESSION_ACCOUNT_PROFILE_MISMATCH");
			if (typeof fields.directory !== "string" || !fields.directory || Buffer.byteLength(fields.directory) > ROOM_HEAD_IMAGE_LIMITS.maxBytes) throw new TypeError("DISPOSABLE_SESSION_LOCAL_DIRECTORY_INVALID");
			const directory = realpathSync(fields.directory), actual = realpathSync(filename), stat = lstatSync(actual);
			if (!stat.isFile() || stat.nlink !== 1 || actual === directory || actual.startsWith(`${directory}/`)) throw new Error("DISPOSABLE_SESSION_INDEPENDENT_ACCOUNT_REQUIRED");
			transact(false, validate);
			return Object.freeze({ identity: Uint8Array.from(providerIdentity!), owner: hashDomain("ts-drp/disposable-session-native-directory/v1", encodeCanonical(directory, ROOM_HEAD_IMAGE_LIMITS)) });
		};
		accountOwners.set(authority, { describe, acquire: input => {
			const fields = roomHeadFields(input, input.kind === "create" ? ["kind", "directory", "profile"] : ["kind", "directory", "profile", "selector"]);
			if (!["create", "reopen", "resume-terminal"].includes(String(fields.kind))) throw new TypeError("INVALID_LOCAL_SESSION_ACQUISITION");
			const { owner } = describe({ directory: fields.directory as string, profile: fields.profile as NodeDisposableSessionProfile });
			let selector: NodeDisposableSessionSelector;
			if (fields.kind !== "create") {
				const captured = roomHeadFields(fields.selector, ["slot", "incarnation"]);
				if (!Number.isSafeInteger(captured.slot) || Number(captured.slot) < 0 || Number(captured.slot) >= profile.slots || !Number.isSafeInteger(captured.incarnation) || Number(captured.incarnation) < 1) throw new TypeError("INVALID_LOCAL_SESSION_SELECTOR");
				selector = Object.freeze({ slot: Number(captured.slot), incarnation: Number(captured.incarnation) });
			} else selector = transact(true, () => {
				validate();
				const free = cachedStatement(database, `SELECT ${projection} FROM room_session_slots WHERE status='free' ORDER BY slot LIMIT 1`).get();
				if (free === undefined) throw new Error("LOCAL_SESSION_CAPACITY");
				if (!Number.isSafeInteger(free.incarnation) || free.incarnation === Number.MAX_SAFE_INTEGER) throw new Error("LOCAL_SESSION_INCARNATION_EXHAUSTED");
				const exclusive = acquireSnapshotDependencyLock(lockFile(Number(free.slot)), "exclusive");
				try {
					const next = Object.freeze({ slot: Number(free.slot), incarnation: Number(free.incarnation) + 1 });
					const seed = randomBytes(32), encoded = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
					try {
						const key = createPrivateKey({ key: encoded, format: "der", type: "pkcs8" });
						const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
						cachedStatement(database, "UPDATE room_session_slots SET incarnation=?,status='reserved',owner=?,seed=?,public_key=?,terminal=NULL WHERE slot=? AND status='free'").run(next.incarnation, owner, seed, publicKey, next.slot);
					} finally { seed.fill(0); encoded.fill(0); }
					return next;
				} finally { exclusive.release(); }
			});
			const held = acquireSnapshotDependencyLock(lockFile(selector.slot), "shared");
			let released = false;
			let cleanupLock: ReturnType<typeof acquireSnapshotDependencyLock> | undefined;
			const row = (allowRetiring = false): Record<string, unknown> => {
				ensureOpen(); validate();
				const current = cachedStatement(database, `SELECT ${projection} FROM room_session_slots WHERE slot=?`).get(selector.slot);
				if (current?.incarnation !== selector.incarnation || !(current.owner instanceof Uint8Array) || !Buffer.from(current.owner).equals(owner) ||
					!(allowRetiring ? ["reserved", "active", "retiring", ...(fields.kind === "resume-terminal" ? ["free"] : [])] : ["reserved", "active"]).includes(String(current.status))) throw new Error("DISPOSABLE_SESSION_INDEPENDENT_INCARNATION_REVOKED");
				return current;
			};
			const check = (allowRetiring = false): void => { if (released) throw new Error("DISPOSABLE_SESSION_ACCOUNT_LEASE_RELEASED"); (cleanupLock ?? held).check(); transact(false, () => { row(allowRetiring); }); };
			const assertUnfenced = (): void => {
				check(); transact(false, () => { if (row().terminal !== null) throw new Error("DISPOSABLE_SESSION_TERMINAL_ALREADY_ACKNOWLEDGED"); });
			};
			try { check(fields.kind === "resume-terminal"); if (fields.kind === "resume-terminal" && transact(false, () => row(true).terminal) === null) throw new Error("DISPOSABLE_SESSION_TERMINAL_INTENT_REQUIRED"); } catch (primary) { held.release(); throw primary; }
			const token = Object.freeze({}) as NodeDisposableSessionAccountLease;
			accountKeys.set(token, async lifetime => {
				check();
				const seed = transact(false, () => {
					row(); const captured = cachedStatement(database, "SELECT CASE WHEN typeof(seed)='blob' AND length(seed)=32 THEN seed ELSE NULL END AS seed FROM room_session_slots WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
					if (!(captured?.seed instanceof Uint8Array)) throw new Error("DISPOSABLE_SESSION_ACCOUNT_KEY_STATE_LOST");
					return Uint8Array.from(captured.seed);
				});
				let signing: Awaited<ReturnType<typeof createRecoverableFinalitySigner>> | undefined;
				try {
					signing = await createRecoverableFinalitySigner({ seed }, lifetime);
					check();
					const expected = transact(false, () => row().public_key);
					if (!(expected instanceof Uint8Array) || !Buffer.from(expected).equals(signing.publicKey)) throw new Error("DISPOSABLE_SESSION_ACCOUNT_KEY_STATE_LOST");
					return signing;
				} catch (primary) {
					try { if (signing !== undefined) await retireRecoverableFinalitySigner({ signer: signing.signer }); }
					catch (cleanup) { throw new AggregateError([primary, cleanup], "disposable account signing acquisition and custody retirement failed", { cause: primary }); }
					throw primary;
				} finally { seed.fill(0); }
			});
			accountLeases.set(token, {
				authority, filename, selector, owner, profile, identity: Uint8Array.from(providerIdentity!), initialization: Object.freeze({ kind: fields.kind === "create" ? "create" : "reopen" }),
				check,
				assertUnfenced,
				acquireUnfencedRecoveryReservation: async () => {
					assertUnfenced();
					const original = await reservations.acquire(); // Real BEGIN IMMEDIATE excludes the independent fence writer.
					try {
						await original.check(); assertUnfenced();
						return Object.freeze({ check: async (): Promise<void> => { await original.check(); assertUnfenced(); }, release: original.release });
					} catch (primary) {
						try { await original.release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "unfenced account recovery acquisition and native release failed", { cause: primary }); }
						throw primary;
					}
				},
				bindKey: bytes => { const publicKey = exactBytes(bytes, "DISPOSABLE_SESSION_PUBLIC_KEY_INVALID"); transact(true, () => {
					const current = row(); if (!(current.public_key instanceof Uint8Array) || !Buffer.from(current.public_key).equals(publicKey)) throw new Error("DISPOSABLE_SESSION_OWNED_KEY_CONFLICT");
				}); },
				assertBound: () => { check(); transact(false, () => { const current = row();
					if (current.status !== "active" || !(current.public_key instanceof Uint8Array) || !cachedStatement(database, "SELECT 1 FROM room_session_heads WHERE slot=? AND incarnation=? AND root IS NOT NULL LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("DISPOSABLE_SESSION_AUTHENTICATED_ROOT_REQUIRED");
				}); },
				bindRoot: (scope, bytes) => { const root = exactBytes(bytes, "DISPOSABLE_SESSION_ROOT_INVALID"); transact(true, () => {
					const current = row(), key = scopeDigest(scope), entry = cachedStatement(database, "SELECT CASE WHEN typeof(root)='blob' AND length(root)=32 THEN root ELSE NULL END AS root FROM room_session_heads WHERE slot=? AND incarnation=? AND scope=?").get(selector.slot, selector.incarnation, key);
					if (!(current.public_key instanceof Uint8Array) || entry === undefined || (entry.root !== null && !Buffer.from(entry.root as Uint8Array).equals(root))) throw new Error("DISPOSABLE_SESSION_ROOT_BINDING_CONFLICT");
					cachedStatement(database, "UPDATE room_session_heads SET root=? WHERE slot=? AND incarnation=? AND scope=?").run(root, selector.slot, selector.incarnation, key);
					cachedStatement(database, "UPDATE room_session_slots SET status='active' WHERE slot=? AND incarnation=?").run(selector.slot, selector.incarnation);
				}); },
				fence: (admission, nativePreparation) => {
					const source = resolveOwnedLocalSessionTerminalAdmission(admission), native = resolveLocalSessionPreparedTerminal(nativePreparation);
					if ((source === undefined && !native.empty) || (native.empty && admission !== undefined) || native.admission !== admission || native.authority !== authority || native.selector.slot !== selector.slot || native.selector.incarnation !== selector.incarnation || !Buffer.from(native.identity).equals(providerIdentity!) || !Buffer.from(native.owner).equals(owner)) throw new TypeError("UNTRUSTED_DISPOSABLE_SESSION_TERMINAL_ADMISSION");
					const digest = exactBytes(native.digest, "DISPOSABLE_SESSION_TERMINAL_INVALID"), expected = source === undefined ? undefined : captureRoomHeadImage(encodeCanonical({ version: 1, scope: source.floorImage.scope, state: source.floorImage.state, control: source.floorImage.control }, ROOM_HEAD_IMAGE_LIMITS));
					if (source !== undefined && roomHeadImageDigest(expected!) !== source.floorImage.imageDigest) throw new Error("DISPOSABLE_SESSION_TERMINAL_FLOOR_STALE");
					transact(true, () => {
					const current = row(true); if (current.terminal !== null && !Buffer.from(current.terminal as Uint8Array).equals(digest)) throw new Error("DISPOSABLE_SESSION_TERMINAL_INTENT_CONFLICT");
					if (!(current.public_key instanceof Uint8Array) || Buffer.from(current.public_key).toString("hex") !== native.author || (source !== undefined && (source.selector.slot !== selector.slot || source.selector.incarnation !== selector.incarnation))) throw new Error("DISPOSABLE_SESSION_TERMINAL_SOURCE_MISMATCH");
					if (native.empty) {
						if (current.status !== "reserved" || cachedStatement(database, "SELECT 1 FROM room_session_heads WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
					} else {
						const stored = cachedStatement(database, "SELECT CASE WHEN typeof(image)='blob' AND length(image)<=16384 THEN image ELSE NULL END AS image FROM room_session_heads WHERE slot=? AND incarnation=? AND scope=?").get(selector.slot, selector.incarnation, scopeDigest(expected!.scope));
						if (!(stored?.image instanceof Uint8Array) || !sameRoomHeadValue(captureRoomHeadImage(stored.image), expected) || cachedStatement(database, "SELECT count(*) AS n FROM room_session_heads WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation)?.n !== 1) throw new Error("DISPOSABLE_SESSION_TERMINAL_FLOOR_STALE");
					}
					cachedStatement(database, "UPDATE room_session_slots SET status='retiring',terminal=? WHERE slot=? AND incarnation=?").run(digest, selector.slot, selector.incarnation);
				}); },
				terminalDigest: () => { check(true); return exactBytes(transact(false, () => row(true).terminal), "DISPOSABLE_SESSION_TERMINAL_INTENT_REQUIRED"); },
				beginCleanup: () => {
					check(true);
					if (cleanupLock !== undefined) return;
					const current = transact(false, () => row(true));
					if (!["retiring", "free"].includes(String(current.status)) || !(current.terminal instanceof Uint8Array)) throw new Error("DISPOSABLE_SESSION_TERMINAL_INTENT_REQUIRED");
					held.release();
					try { cleanupLock = acquireSnapshotDependencyLock(lockFile(selector.slot), "exclusive"); check(true); }
					catch (primary) { released = true; if (cleanupLock !== undefined) try { cleanupLock.release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "disposable cleanup exclusion and release failed", { cause: primary }); } throw primary; }
				},
				checkCleanup: () => { if (cleanupLock === undefined) throw new Error("DISPOSABLE_SESSION_JOINED_NATIVE_EXCLUSION_REQUIRED"); check(true); },
				complete: receipt => {
					const completed = consumeLocalSessionCleanupReceipt(receipt);
					if (completed.authority !== authority || completed.selector.slot !== selector.slot || completed.selector.incarnation !== selector.incarnation || !Buffer.from(completed.identity).equals(providerIdentity!) || !Buffer.from(completed.owner).equals(owner)) throw new Error("DISPOSABLE_SESSION_NATIVE_COMPLETION_MISMATCH");
					// All original independent account leases must release first. The
					// same native lock excludes separate hosts/processes; crash releases
					// occupancy without a stale durable alias counter/tombstone.
					if (cleanupLock === undefined) throw new Error("DISPOSABLE_SESSION_JOINED_NATIVE_EXCLUSION_REQUIRED");
					check(true);
					transact(true, () => {
						const current = row(true);
						if (!(current.terminal instanceof Uint8Array) || !Buffer.from(current.terminal).equals(completed.digest) || !["retiring", "free"].includes(String(current.status))) throw new Error("DISPOSABLE_SESSION_NATIVE_COMPLETION_MISMATCH");
						if (current.status === "free") return; // Exact last-incarnation retry only.
						cachedStatement(database, "DELETE FROM room_session_heads WHERE slot=? AND incarnation=?").run(selector.slot, selector.incarnation);
						cachedStatement(database, "UPDATE room_session_slots SET status='free',seed=NULL,public_key=NULL WHERE slot=? AND incarnation=? AND status='retiring'").run(selector.slot, selector.incarnation);
					});
				},
				release: () => { if (released) return; (cleanupLock ?? held).release(); released = true; },
			});
			return token;
		} });
	}
	genesisOwners.set(authority, { run: async <T>(input: GenesisCreation, action: () => Promise<T>): Promise<T> => {
		ensureOpen();
		if (session !== undefined && account === undefined) throw new TypeError("ROOM_GENESIS_EXTERNAL_ACCOUNT_PROVIDER_REQUIRED");
		if (genesisJoined !== undefined) throw new Error("ROOM_GENESIS_CREATION_BUSY");
		const fields = roomHeadFields(input, ["scope", "bindingDigest"]), scope = captureRoomHeadScope(fields.scope);
		if (!(fields.bindingDigest instanceof Uint8Array) || fields.bindingDigest.byteLength !== 32) throw new TypeError("ROOM_GENESIS_BINDING_INVALID");
		const binding = Uint8Array.from(fields.bindingDigest);
		let join!: () => void;
		genesisJoined = new Promise<void>(resolve => { join = resolve; }); // Single bounded turn before awaits.
		let held: NativeReadReservation | undefined, failed = false, primary: unknown, result!: T;
		const readBinding = (): Uint8Array | undefined => {
			if (account !== undefined) {
				const row = cachedStatement(database, "SELECT CASE WHEN genesis IS NULL THEN 0 WHEN typeof(genesis)='blob' AND length(genesis)=32 THEN 1 ELSE -1 END AS valid, CASE WHEN typeof(genesis)='blob' AND length(genesis)=32 THEN genesis ELSE NULL END AS binding FROM room_session_heads WHERE slot=? AND incarnation=? AND scope=?").get(account.selector.slot, account.selector.incarnation, scopeDigest(scope));
				if (row?.valid === -1) throw new Error("ROOM_GENESIS_RESERVATION_LOST");
				return row?.valid === 1 ? Uint8Array.from(row.binding as Uint8Array) : undefined;
			}
			const exists = cachedStatement(database, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room_genesis_creation'").get();
			if (exists === undefined) return undefined;
			const rows = cachedStatement(database, "SELECT id, CASE WHEN typeof(binding)='blob' AND length(binding)=32 THEN binding ELSE NULL END AS binding FROM room_genesis_creation LIMIT 2").all();
			if (rows.length !== 1 || rows[0]?.id !== 1 || !(rows[0]?.binding instanceof Uint8Array)) throw new Error("ROOM_GENESIS_RESERVATION_LOST");
			return Uint8Array.from(rows[0].binding);
		};
		const exact = (): void => {
			const old = load(scope), recorded = readBinding();
			if (old === null || !sameRoomHeadValue(old.scope, scope) || old.state.pending !== null || old.state.stable.epoch !== 0 ||
				old.state.stable.currentAnchorDigest !== scope.pinnedGenesisAnchorDigest || old.control.revision !== 0 || old.control.active !== null || old.control.completed !== null ||
				recorded === undefined || !Buffer.from(recorded).equals(binding)) throw new Error("ROOM_GENESIS_CREATION_CONFLICT");
		};
		try {
			transact(true, () => {
				const old = load(scope), recorded = readBinding();
				if (recorded !== undefined) { exact(); return; } // Exact interrupted continuation, including provider reopen.
				if (initialization.kind !== "create" || old !== null) throw new Error("ROOM_GENESIS_NEW_ACCOUNT_CREATION_REQUIRED");
				// A durable reservation, not an authenticated accepted room. It never
				// expires or becomes unseen after abort; external account custody retains it.
				if (account === undefined) {
					database.exec(GENESIS_SCHEMA);
					cachedStatement(database, "INSERT INTO room_genesis_creation(id,binding) VALUES(1,?)").run(binding);
				}
				save({ version: 1, scope, state: { stable: { objectId: scope.objectId, epoch: 0, currentAnchorDigest: scope.pinnedGenesisAnchorDigest }, pending: null },
					control: { incarnation: randomBytes(32).toString("hex"), revision: 0, active: null, completed: null } });
				if (account !== undefined) cachedStatement(database, "UPDATE room_session_heads SET genesis=? WHERE slot=? AND incarnation=? AND scope=? AND genesis IS NULL").run(binding, account.selector.slot, account.selector.incarnation, scopeDigest(scope));
			});
			held = await reservations.acquire();
			await held.check(); transact(false, exact);
			result = await action();
			await held.check(); transact(false, exact);
		} catch (cause) { failed = true; primary = cause; }
		finally {
			try { await held?.release(); } catch (cleanup) {
				if (failed) primary = new AggregateError([primary, cleanup], "genesis creation and joined native release failed", { cause: primary });
				else { failed = true; primary = cleanup; }
			}
			genesisJoined = undefined; join();
		}
		if (failed) throw primary;
		ensureOpen();
		return result;
	} });
	return Object.freeze(authority);
}
