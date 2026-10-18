import { snapshotQuarantineContract, snapshotRetirementContract } from "@ts-drp/storage/snapshot-transfer";
import { AHE_BOUNDED_READ_LIMITS, ROOM_HEAD_IMAGE_LIMITS } from "@ts-drp/storage";
import { createSigningStorageCodec } from "@ts-drp/seal/internal/storage-port";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { resolveOwnedLocalSessionTerminalAdmission } from "@ts-drp/node/v3-room";
import { describeNodeDisposableSessionAccount, resolveNodeDisposableSessionAccount, type NodeDisposableSessionAccountLease, type NodeRoomHeadAuthority } from "../room-head.js";
import { assertNativeLocalSessionFileBinding, enforceNativeLocalSessionFile, type LocalSessionLifetime } from "./local-session-lifetime.js";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireSnapshotDependencyLock } from "./snapshot-dependency-lock.js";
import { sqliteFilename } from "./sqlite-filename.js";

export interface LocalSessionSelector { readonly slot: number; readonly incarnation: number; }
export interface LocalSessionObservation extends LocalSessionSelector { readonly status: "active" | "retiring" | "free"; }
export type SessionStoreFamily = "ahe" | "issuance" | "journal" | "snapshots" | "signing" | "room-head";
const SCHEMA = Object.freeze([
	"CREATE TABLE local_session_policy(id INTEGER PRIMARY KEY CHECK(id=1),slots INTEGER NOT NULL,store_scopes INTEGER NOT NULL,handles INTEGER NOT NULL,setup TEXT NOT NULL CHECK(setup IN ('initializing','ready'))) STRICT",
	"CREATE TABLE local_session_slots(slot INTEGER PRIMARY KEY,incarnation INTEGER NOT NULL CHECK(incarnation>=0),status TEXT NOT NULL CHECK(status IN ('active','retiring','free')),key_retired INTEGER NOT NULL CHECK(key_retired IN (0,1))) STRICT",
	"CREATE TABLE local_session_files(slot INTEGER NOT NULL,incarnation INTEGER NOT NULL,family TEXT NOT NULL,digest TEXT NOT NULL,installed INTEGER NOT NULL CHECK(installed IN (0,1)),PRIMARY KEY(slot,incarnation,family,digest)) STRICT",
	"CREATE TABLE local_session_keys(slot INTEGER PRIMARY KEY,incarnation INTEGER NOT NULL,seed BLOB NOT NULL CHECK(length(seed)=32),public_key BLOB CHECK(public_key IS NULL OR length(public_key)=32),room_binding BLOB CHECK(room_binding IS NULL OR length(room_binding)=32),genesis_binding BLOB CHECK(genesis_binding IS NULL OR length(genesis_binding)=32)) STRICT",
]);
const ACCOUNT_SCHEMA = "CREATE TABLE local_session_account(id INTEGER PRIMARY KEY CHECK(id=1),identity BLOB NOT NULL CHECK(length(identity)=32),owner BLOB NOT NULL CHECK(length(owner)=32)) STRICT";
const ACCOUNT_KEY_SCHEMA = SCHEMA[3]!.replace("seed BLOB NOT NULL CHECK(length(seed)=32)", "seed BLOB CHECK(seed IS NULL)");
const TERMINAL_SCHEMA = `CREATE TABLE local_session_terminal(slot INTEGER PRIMARY KEY,incarnation INTEGER NOT NULL,frame BLOB NOT NULL CHECK(length(frame)<=${AHE_BOUNDED_READ_LIMITS.maxUnionBytes})) STRICT`;
const terminalLimits = { maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes, maxDepth: 64, maxItems: 65_536 };
type NativePreparedTerminal = Readonly<{
	admission: unknown; authority: NodeRoomHeadAuthority; selector: LocalSessionSelector;
	identity: Uint8Array; owner: Uint8Array; frame: Uint8Array; digest: Uint8Array;
	empty: boolean; author: string;
	check(): void;
}>;
const preparedTerminals = new WeakMap<object, NativePreparedTerminal>();
export function resolveLocalSessionPreparedTerminal(value: unknown): NativePreparedTerminal {
	const facts = value !== null && typeof value === "object" ? preparedTerminals.get(value) : undefined;
	if (facts === undefined) throw new TypeError("UNTRUSTED_LOCAL_SESSION_TERMINAL_PREPARATION");
	facts.check();
	return Object.freeze({ ...facts, identity: Uint8Array.from(facts.identity), owner: Uint8Array.from(facts.owner), digest: Uint8Array.from(facts.digest), frame: Uint8Array.from(facts.frame) });
}
type NativeCleanupFacts = Omit<NativePreparedTerminal, "admission" | "frame" | "empty" | "author" | "check">;
const cleanupReceipts = new WeakMap<object, { facts: NativeCleanupFacts; check(): void }>();
/** Actual native readback only; never a caller callback or deletion grant. */
export function consumeLocalSessionCleanupReceipt(value: unknown): NativeCleanupFacts {
	const receipt = value !== null && typeof value === "object" ? cleanupReceipts.get(value) : undefined;
	if (receipt === undefined) throw new TypeError("UNTRUSTED_LOCAL_SESSION_CLEANUP_RECEIPT");
	receipt.check(); cleanupReceipts.delete(value as object); return receipt.facts;
}
const families: readonly SessionStoreFamily[] = ["ahe", "issuance", "journal", "snapshots", "signing", "room-head"];
const schemaBytes = Math.max(...SCHEMA.map((ddl) => Buffer.byteLength(ddl)));
const slotProjection = "CASE WHEN typeof(slot)='integer' THEN slot ELSE NULL END AS slot,CASE WHEN typeof(incarnation)='integer' THEN incarnation ELSE NULL END AS incarnation,CASE WHEN typeof(status)='text' AND length(CAST(status AS BLOB))<=8 THEN status ELSE NULL END AS status";
const fileProjection = "CASE WHEN typeof(family)='text' AND length(CAST(family AS BLOB))<=9 AND family IN ('ahe','issuance','journal','snapshots','signing','room-head') THEN family ELSE NULL END AS family,CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 AND digest NOT GLOB '*[^0-9a-f]*' THEN digest ELSE NULL END AS digest";

/** Finite slot identities and exact owned-file declarations; no wire authority. */
export class LocalSessionCatalog {
	#initialized = false;
	readonly #catalogExisted: boolean;
	readonly #accountIdentity?: Readonly<{ identity: Uint8Array; owner: Uint8Array }>;
	readonly #handleIndexes = new WeakMap<object, number>();
	constructor(readonly directory: string, readonly slots: number, readonly storeScopes: number, readonly handles: number,
		readonly account?: NodeRoomHeadAuthority) {
		if (!Number.isSafeInteger(slots) || slots < 1 || !Number.isSafeInteger(storeScopes) || storeScopes < 1 ||
			!Number.isSafeInteger(slots * storeScopes) || !Number.isSafeInteger(handles) || handles < 1) throw new TypeError("INVALID_LOCAL_SESSION_CAPACITY_PROFILE");
		const custodyDirectory = lstatSync(directory);
		if (!custodyDirectory.isDirectory() || custodyDirectory.isSymbolicLink() || (custodyDirectory.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && custodyDirectory.uid !== process.getuid())) throw new Error("LOCAL_SESSION_PRIVATE_DIRECTORY_REQUIRED");
		if (account !== undefined) this.#accountIdentity = describeNodeDisposableSessionAccount(account, { directory, profile: { slots, storeScopes, handles } });
		this.#catalogExisted = existsSync(join(directory, ".r11-local-sessions.sqlite"));
		this.#transaction(true, () => undefined); this.#initialized = true;
	}
	#lockFile(slot: number): string { return join(this.directory, `.r11-local-slot-${slot}.sqlite`); }
	#handleFile(slot: number): string { return join(this.directory, `.r11-local-handle-${slot}.sqlite`); }
	#transaction<T>(write: boolean, action: (database: DatabaseSync) => T): T {
		const expectedSchema = this.account === undefined ? SCHEMA : [...SCHEMA.slice(0, 3), ACCOUNT_KEY_SCHEMA, ACCOUNT_SCHEMA, TERMINAL_SCHEMA];
		if (this.account !== undefined) {
			const actual = describeNodeDisposableSessionAccount(this.account, { directory: this.directory, profile: { slots: this.slots, storeScopes: this.storeScopes, handles: this.handles } });
			if (!Buffer.from(actual.identity).equals(this.#accountIdentity!.identity) || !Buffer.from(actual.owner).equals(this.#accountIdentity!.owner)) throw new Error("LOCAL_SESSION_ACCOUNT_IDENTITY_CHANGED");
		}
		const catalogFilename = join(this.directory, ".r11-local-sessions.sqlite");
		if (this.#initialized || this.#catalogExisted) {
			const stat = lstatSync(catalogFilename);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
				(typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("LOCAL_SESSION_PRIVATE_CATALOG_REQUIRED");
		}
		const database = new DatabaseSync(sqliteFilename(catalogFilename, this.#initialized ? "reopen" : "create"));
		let active = false;
		try {
			// The containing directory is private before any key row is created.
			// This is OS custody, not encryption or forensic erasure evidence.
			if (!this.#initialized && !this.#catalogExisted) chmodSync(catalogFilename, 0o600);
			database.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
			if (!this.#initialized) database.exec("PRAGMA journal_mode=WAL");
			else if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") throw new Error("LOCAL_SESSION_CATALOG_DURABILITY_LOST");
			database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN"); active = true;
			const schema = database.prepare(`SELECT CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=32 THEN name ELSE NULL END AS name,CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=${schemaBytes} THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT ${expectedSchema.length + 1}`).all();
			if (!schema.length) {
				if (this.#initialized || this.#catalogExisted) throw new Error("LOCAL_SESSION_CATALOG_LOST");
				// Missing/empty catalog beside a preexisting stable lease file is
				// storage loss, not permission to reset incarnation safety memory.
				for (let slot = 0; slot < this.slots; slot++) if (existsSync(this.#lockFile(slot))) throw new Error("LOCAL_SESSION_CATALOG_LOST");
				for (let handle = 0; handle < this.handles; handle++) if (existsSync(this.#handleFile(handle))) throw new Error("LOCAL_SESSION_CATALOG_LOST");
				for (const ddl of expectedSchema) database.exec(ddl);
				if (this.#accountIdentity !== undefined) database.prepare("INSERT INTO local_session_account VALUES(1,?,?)").run(this.#accountIdentity.identity, this.#accountIdentity.owner);
				database.prepare("INSERT INTO local_session_policy VALUES(1,?,?,?,'initializing')").run(this.slots, this.storeScopes, this.handles);
				for (let slot = 0; slot < this.slots; slot++) {
					database.prepare("INSERT INTO local_session_slots VALUES(?,0,'free',1)").run(slot);
				}
				// Commit the exact finite installation intent BEFORE any coordination
				// file is created. A crash during their installation can resume from
				// this genuine catalog state, not from filenames or an empty database.
				database.exec("COMMIT"); active = false;
				database.exec("BEGIN IMMEDIATE"); active = true;
			} else if (schema.length !== expectedSchema.length || expectedSchema.some((ddl) => !schema.some((row) => row.sql === ddl))) throw new Error("LOCAL_SESSION_CATALOG_POISONED");
			if (this.#accountIdentity !== undefined) {
				const identity = database.prepare("SELECT id,CASE WHEN typeof(identity)='blob' AND length(identity)=32 THEN identity ELSE NULL END AS identity,CASE WHEN typeof(owner)='blob' AND length(owner)=32 THEN owner ELSE NULL END AS owner FROM local_session_account LIMIT 2").all();
				if (identity.length !== 1 || identity[0]?.id !== 1 || !(identity[0].identity instanceof Uint8Array) || !(identity[0].owner instanceof Uint8Array) || !Buffer.from(identity[0].identity).equals(this.#accountIdentity.identity) || !Buffer.from(identity[0].owner).equals(this.#accountIdentity.owner)) throw new Error("LOCAL_SESSION_ACCOUNT_IDENTITY_CHANGED");
				if (Number(database.prepare("SELECT count(*) AS n FROM local_session_terminal").get()?.n) > this.slots || database.prepare(`SELECT 1 FROM local_session_terminal AS t LEFT JOIN local_session_slots AS s ON s.slot=t.slot WHERE s.slot IS NULL OR t.incarnation<>s.incarnation OR typeof(t.frame)<>'blob' OR length(t.frame)>${terminalLimits.maxBytes} LIMIT 1`).get()) throw new Error("LOCAL_SESSION_TERMINAL_INTENT_POISONED");
			}
			const policy = database.prepare("SELECT CASE WHEN typeof(id)='integer' THEN id ELSE NULL END AS id,CASE WHEN typeof(slots)='integer' THEN slots ELSE NULL END AS slots,CASE WHEN typeof(store_scopes)='integer' THEN store_scopes ELSE NULL END AS store_scopes,CASE WHEN typeof(handles)='integer' THEN handles ELSE NULL END AS handles,CASE WHEN typeof(setup)='text' AND length(CAST(setup AS BLOB))<=12 THEN setup ELSE NULL END AS setup FROM local_session_policy LIMIT 2").all();
			if (policy.length !== 1 || policy[0]?.id !== 1 || policy[0]?.slots !== this.slots || policy[0]?.store_scopes !== this.storeScopes || policy[0]?.handles !== this.handles ||
				!["initializing", "ready"].includes(String(policy[0]?.setup)) ||
				database.prepare("SELECT count(*) AS n FROM local_session_slots").get()?.n !== this.slots) throw new Error("LOCAL_SESSION_CATALOG_POLICY_OR_STATE_MISMATCH");
			const slots = database.prepare(`SELECT ${slotProjection} FROM local_session_slots ORDER BY slot LIMIT ?`).all(this.slots + 1);
			if (slots.length !== this.slots || slots.some((row, slot) => row.slot !== slot || !Number.isSafeInteger(row.incarnation) ||
				Number(row.incarnation) < 0 || !["active", "retiring", "free"].includes(String(row.status)) ||
				(row.status !== "free" && row.incarnation === 0))) throw new Error("LOCAL_SESSION_CATALOG_POISONED");
			if (Number(database.prepare("SELECT count(*) AS n FROM local_session_files").get()?.n) > this.slots * this.storeScopes ||
				database.prepare("SELECT 1 FROM local_session_files AS f LEFT JOIN local_session_slots AS s ON s.slot=f.slot WHERE s.slot IS NULL OR s.incarnation<>f.incarnation OR s.status='free' OR typeof(f.digest)<>'text' OR length(CAST(f.digest AS BLOB))<>64 OR f.digest GLOB '*[^0-9a-f]*' OR typeof(f.family)<>'text' OR length(CAST(f.family AS BLOB))>9 OR f.family NOT IN ('ahe','issuance','journal','snapshots','signing','room-head') LIMIT 1").get())
				throw new Error("LOCAL_SESSION_FILE_DECLARATION_POISONED");
			if (Number(database.prepare("SELECT count(*) AS n FROM local_session_keys").get()?.n) > this.slots ||
				database.prepare(`SELECT 1 FROM local_session_slots AS s LEFT JOIN local_session_keys AS k ON k.slot=s.slot WHERE typeof(s.key_retired)<>'integer' OR s.key_retired NOT IN (0,1) OR (s.status='active' AND s.key_retired<>0) OR (s.status='free' AND s.key_retired<>1) OR (s.key_retired=0 AND (k.slot IS NULL OR k.incarnation<>s.incarnation OR ${this.account === undefined ? "typeof(k.seed)<>'blob' OR length(k.seed)<>32" : "k.seed IS NOT NULL"} OR (k.public_key IS NOT NULL AND (typeof(k.public_key)<>'blob' OR length(k.public_key)<>32)) OR (k.room_binding IS NOT NULL AND (typeof(k.room_binding)<>'blob' OR length(k.room_binding)<>32)))) OR (s.key_retired=1 AND k.slot IS NOT NULL) LIMIT 1`).get() ||
				database.prepare("SELECT 1 FROM local_session_keys AS k LEFT JOIN local_session_slots AS s ON s.slot=k.slot WHERE s.slot IS NULL LIMIT 1").get()) throw new Error("LOCAL_SESSION_OWNED_KEY_STATE_LOST");
			if (database.prepare("SELECT 1 FROM local_session_keys WHERE genesis_binding IS NOT NULL AND (typeof(genesis_binding)<>'blob' OR length(genesis_binding)<>32) LIMIT 1").get()) throw new Error("LOCAL_SESSION_OWNED_KEY_STATE_LOST");
			if (policy[0]?.setup === "initializing") {
				// Installation cannot have admitted a key, lease or store. Never turn
				// mutated/lost active state back into a fresh slot incarnation.
				if (this.#initialized || slots.some(row => row.incarnation !== 0 || row.status !== "free") ||
					database.prepare("SELECT 1 FROM local_session_keys LIMIT 1").get() ||
					database.prepare("SELECT 1 FROM local_session_files LIMIT 1").get()) throw new Error("LOCAL_SESSION_CATALOG_SETUP_POISONED");
				// Existing exact lock files validate; an interrupted empty lock-file
				// installation is completed only under this committed setup intent.
				for (let slot = 0; slot < this.slots; slot++) acquireSnapshotDependencyLock(this.#lockFile(slot), "exclusive", true).release();
				for (let handle = 0; handle < this.handles; handle++) acquireSnapshotDependencyLock(this.#handleFile(handle), "exclusive", true).release();
				database.prepare("UPDATE local_session_policy SET setup='ready' WHERE id=1 AND setup='initializing'").run();
			} else if (!this.#initialized) {
				for (let slot = 0; slot < this.slots; slot++) if (!existsSync(this.#lockFile(slot))) throw new Error("LOCAL_SESSION_COORDINATION_LOST");
				for (let handle = 0; handle < this.handles; handle++) if (!existsSync(this.#handleFile(handle))) throw new Error("LOCAL_SESSION_COORDINATION_LOST");
			}
			const result = action(database); database.exec("COMMIT"); active = false; return result;
		} catch (primary) {
			if (active) try { database.exec("ROLLBACK"); } catch { /* Preserve original failure. */ }
			throw primary;
		} finally { database.close(); }
	}
	capture(selector: LocalSessionSelector): LocalSessionSelector {
		const fields: Record<string, PropertyDescriptor> = selector !== null && typeof selector === "object" ? Object.getOwnPropertyDescriptors(selector) : {};
		if (Reflect.ownKeys(fields).length !== 2 || !fields.slot || !("value" in fields.slot) || !fields.incarnation || !("value" in fields.incarnation)) throw new TypeError("INVALID_LOCAL_SESSION_SELECTOR");
		const slot = fields.slot.value as unknown, incarnation = fields.incarnation.value as unknown;
		if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0 || slot >= this.slots || typeof incarnation !== "number" || !Number.isSafeInteger(incarnation) || incarnation < 1) throw new TypeError("INVALID_LOCAL_SESSION_SELECTOR");
		return Object.freeze({ slot, incarnation });
	}
	#row(database: DatabaseSync, selector: LocalSessionSelector): LocalSessionObservation {
		const row = database.prepare(`SELECT ${slotProjection} FROM local_session_slots WHERE slot=?`).get(selector.slot);
		if (row?.incarnation !== selector.incarnation || !["active", "retiring", "free"].includes(String(row.status))) throw new Error("STALE_OR_CORRUPT_LOCAL_SESSION");
		return row as unknown as LocalSessionObservation;
	}
	inspect(): readonly LocalSessionObservation[] {
		return this.#transaction(false, (database) => Object.freeze(database.prepare(`SELECT ${slotProjection} FROM local_session_slots ORDER BY slot LIMIT ?`).all(this.slots + 1).map((row, slot) => {
			if (row.slot !== slot || !Number.isSafeInteger(row.incarnation) || Number(row.incarnation) < 0 || !["active", "retiring", "free"].includes(String(row.status))) throw new Error("LOCAL_SESSION_CATALOG_POISONED");
			return Object.freeze({ slot, incarnation: Number(row.incarnation), status: row.status as LocalSessionObservation["status"] });
		})));
	}
	assertActive(selector: LocalSessionSelector): void { this.#transaction(false, (database) => { if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED"); }); }
	allocate(): LocalSessionSelector {
		if (this.account !== undefined) throw new Error("LOCAL_SESSION_INDEPENDENT_ACQUISITION_REQUIRED");
		return this.#transaction(true, (database) => {
			const row = database.prepare(`SELECT ${slotProjection} FROM local_session_slots WHERE status='free' ORDER BY slot LIMIT 1`).get();
			if (!row) throw new Error("LOCAL_SESSION_CAPACITY");
			if (!Number.isSafeInteger(row.incarnation) || Number(row.incarnation) < 0 || row.incarnation === Number.MAX_SAFE_INTEGER) throw new Error("LOCAL_SESSION_INCARNATION_EXHAUSTED");
			const selector = Object.freeze({ slot: Number(row.slot), incarnation: Number(row.incarnation) + 1 });
			if (!Number.isSafeInteger(selector.slot) || selector.slot < 0 || selector.slot >= this.slots) throw new Error("LOCAL_SESSION_CATALOG_POISONED");
			const lock = acquireSnapshotDependencyLock(this.#lockFile(selector.slot), "exclusive");
			try {
				if (database.prepare("SELECT 1 FROM local_session_files WHERE slot=? LIMIT 1").get(selector.slot)) throw new Error("LOCAL_SESSION_UNRECLAIMED_FILES");
				const seed = randomBytes(32);
				try { database.prepare("INSERT INTO local_session_keys(slot,incarnation,seed) VALUES(?,?,?)").run(selector.slot, selector.incarnation, seed); }
				finally { seed.fill(0); }
				database.prepare("UPDATE local_session_slots SET incarnation=?,status='active',key_retired=0 WHERE slot=? AND status='free'").run(selector.incarnation, selector.slot);
			} finally { lock.release(); }
			return selector;
		});
	}
	/** Mirror only a genuinely reserved independent incarnation, never infer it
	 * from missing local keys/files or permit restoration to reset account floors. */
	allocateDisposable(lease: NodeDisposableSessionAccountLease): LocalSessionSelector {
		const account = resolveNodeDisposableSessionAccount(lease); account.check();
		if (this.account === undefined || account.authority !== this.account || !Buffer.from(account.identity).equals(this.#accountIdentity!.identity) || !Buffer.from(account.owner).equals(this.#accountIdentity!.owner)) throw new Error("LOCAL_SESSION_ACCOUNT_IDENTITY_CHANGED");
		const selector = this.capture(account.selector);
		return this.#transaction(true, database => {
			const prior = database.prepare(`SELECT ${slotProjection} FROM local_session_slots WHERE slot=?`).get(selector.slot);
			if (prior?.incarnation === selector.incarnation && prior.status === "active") return selector; // Exact interrupted/resumed mirror only.
			if (prior?.status !== "free" || !Number.isSafeInteger(prior.incarnation) || Number(prior.incarnation) >= selector.incarnation || database.prepare("SELECT 1 FROM local_session_files WHERE slot=? LIMIT 1").get(selector.slot)) throw new Error("LOCAL_SESSION_RETAINED_INCARNATION_CONFLICT");
			const held = acquireSnapshotDependencyLock(this.#lockFile(selector.slot), "exclusive");
			try {
				account.check();
				database.prepare("DELETE FROM local_session_terminal WHERE slot=?").run(selector.slot);
				database.prepare("INSERT INTO local_session_keys(slot,incarnation,seed) VALUES(?,?,NULL)").run(selector.slot, selector.incarnation);
				database.prepare("UPDATE local_session_slots SET incarnation=?,status='active',key_retired=0 WHERE slot=? AND status='free'").run(selector.incarnation, selector.slot);
			} finally { held.release(); }
			return selector;
		});
	}
	async prepareDisposableTerminal(selector: LocalSessionSelector, admission: unknown, session: LocalSessionLifetime,
		preparationHandle: ReturnType<typeof acquireSnapshotDependencyLock>): Promise<object> {
		const handleIndex = this.#preparationHandleIndex(preparationHandle);
		const original = resolveOwnedLocalSessionTerminalAdmission(admission);
		if (original === undefined || this.account === undefined || original.selector.slot !== selector.slot || original.selector.incarnation !== selector.incarnation) throw new Error("LOCAL_SESSION_TERMINAL_SOURCE_MISMATCH");
		session.assertOwnedAuthor(original.author);
		await original.check();
		const manifest = this.captureDisposableFileManifest(selector, session, original.objectId);
		session.assertTerminalSourceCoverage(original.sourceObjects, manifest.filter(file => file.installed).map(file => this.#primary(join(this.directory, this.#basename(selector, file.family, file.digest)), file.family)));
		await original.check(); session.assertCurrent();
		const frame = encodeCanonical(["r11-native-terminal-v2", this.#accountIdentity!.identity, this.#accountIdentity!.owner,
			selector.slot, selector.incarnation, original.author, original.bindingDigest, original.exactCanonicalDispositionBytes,
			manifest.map(file => [file.family, file.digest, file.installed, file.controlBytes]), handleIndex], terminalLimits);
		const custodyBytes = manifest.reduce((sum, file) => sum + file.controlBytes, 0);
		if (!Number.isSafeInteger(custodyBytes) || !original.accounting.chargeUnknownEncodedLength(custodyBytes) || !original.accounting.charge(frame)) throw new Error("LOCAL_SESSION_TERMINAL_PROOF_BUDGET");
		const digest = hashDomain("ts-drp/disposable-local-terminal-native-intent/v1", frame);
		this.#transaction(true, database => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			if (database.prepare("SELECT 1 FROM local_session_terminal WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_PENDING");
			const row = database.prepare("SELECT CASE WHEN typeof(public_key)='blob' AND length(public_key)=32 THEN public_key ELSE NULL END AS public_key,CASE WHEN typeof(room_binding)='blob' AND length(room_binding)=32 THEN room_binding ELSE NULL END AS room_binding FROM local_session_keys WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
			if (!(row?.public_key instanceof Uint8Array) || !(row.room_binding instanceof Uint8Array) || Buffer.from(row.public_key).toString("hex") !== original.author || !Buffer.from(row.room_binding).equals(original.bindingDigest)) throw new Error("LOCAL_SESSION_TERMINAL_SOURCE_MISMATCH");
			database.prepare("INSERT INTO local_session_terminal VALUES(?,?,?) ON CONFLICT(slot) DO UPDATE SET incarnation=excluded.incarnation,frame=excluded.frame").run(selector.slot, selector.incarnation, frame);
		});
		const token = Object.freeze({});
		preparedTerminals.set(token, Object.freeze({ admission, authority: this.account, selector, identity: Uint8Array.from(this.#accountIdentity!.identity), owner: Uint8Array.from(this.#accountIdentity!.owner), frame, digest, empty: false, author: original.author,
			check: () => this.#checkLivePreparation(selector, frame, preparationHandle), }));
		return token;
	}
	prepareDisposableEmptyTerminal(selector: LocalSessionSelector, session: LocalSessionLifetime,
		preparationHandle: ReturnType<typeof acquireSnapshotDependencyLock>): object {
		const handleIndex = this.#preparationHandleIndex(preparationHandle);
		if (this.account === undefined) throw new Error("LOCAL_SESSION_INDEPENDENT_ACQUISITION_REQUIRED");
		session.assertCurrent();
		return this.#transaction(true, database => {
			if (this.#row(database, selector).status !== "active" || database.prepare("SELECT 1 FROM local_session_files WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
			if (database.prepare("SELECT 1 FROM local_session_terminal WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_PENDING");
			const key = database.prepare("SELECT CASE WHEN typeof(public_key)='blob' AND length(public_key)=32 THEN public_key ELSE NULL END AS public_key,room_binding IS NULL AS room_unbound,genesis_binding IS NULL AS genesis_unbound FROM local_session_keys WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
			if (!(key?.public_key instanceof Uint8Array) || key.room_unbound !== 1 || key.genesis_unbound !== 1) throw new Error("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
			const author = Buffer.from(key.public_key).toString("hex"); session.assertOwnedAuthor(author);
			const frame = encodeCanonical(["r11-native-terminal-v2", this.#accountIdentity!.identity, this.#accountIdentity!.owner,
				selector.slot, selector.incarnation, author, null, encodeCanonical(["never-bound-exclusive-native-1"], ROOM_HEAD_IMAGE_LIMITS), [], handleIndex], terminalLimits);
			const digest = hashDomain("ts-drp/disposable-local-terminal-native-intent/v1", frame);
			database.prepare("INSERT INTO local_session_terminal VALUES(?,?,?) ON CONFLICT(slot) DO UPDATE SET incarnation=excluded.incarnation,frame=excluded.frame").run(selector.slot, selector.incarnation, frame);
			const token = Object.freeze({});
			preparedTerminals.set(token, Object.freeze({ admission: undefined, authority: this.account!, selector, identity: Uint8Array.from(this.#accountIdentity!.identity), owner: Uint8Array.from(this.#accountIdentity!.owner), frame, digest, empty: true, author,
				check: () => this.#checkLivePreparation(selector, frame, preparationHandle), }));
			return token;
		});
	}
	#preparationHandleIndex(handle: ReturnType<typeof acquireSnapshotDependencyLock>): number {
		const index = this.#handleIndexes.get(handle);
		if (index === undefined) throw new TypeError("GENUINE_LOCAL_SESSION_PREPARATION_HANDLE_REQUIRED");
		handle.check(); return index;
	}
	#checkLivePreparation(selector: LocalSessionSelector, frame: Uint8Array, handle: ReturnType<typeof acquireSnapshotDependencyLock>): void {
		const index = this.#preparationHandleIndex(handle);
		this.#transaction(false, database => {
			if (this.#row(database, selector).status !== "active" || !Buffer.from(this.#terminalFrame(database, selector)).equals(frame) || (decodeCanonical(frame, terminalLimits) as unknown[])[9] !== index) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_CHANGED");
		});
	}
	async recoverAbandonedDisposablePreparation(selector: LocalSessionSelector, lease: NodeDisposableSessionAccountLease): Promise<void> {
		const account = resolveNodeDisposableSessionAccount(lease); account.assertUnfenced();
		if (this.account === undefined || account.authority !== this.account || account.selector.slot !== selector.slot || account.selector.incarnation !== selector.incarnation) throw new Error("LOCAL_SESSION_TERMINAL_SOURCE_MISMATCH");
		const frame = this.#transaction(false, database => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			return database.prepare("SELECT 1 FROM local_session_terminal WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation) ? this.#terminalFrame(database, selector) : undefined;
		});
		if (frame === undefined) return;
		const index = (decodeCanonical(frame, terminalLimits) as unknown[])[9] as number;
		let preparation: ReturnType<typeof acquireSnapshotDependencyLock>;
		try { preparation = acquireSnapshotDependencyLock(this.#handleFile(index), "exclusive"); }
		catch (cause) {
			if (cause instanceof Error && !(cause instanceof AggregateError) && Reflect.get(cause, "errcode") === 5) return; // Still live or conservatively occupied; never erase.
			throw cause;
		}
		try { await this.#clearUnfencedPreparation(selector, lease, frame, preparation); }
		finally { preparation.release(); }
	}
	async abortDisposablePreparation(selector: LocalSessionSelector, lease: NodeDisposableSessionAccountLease,
		preparation: ReturnType<typeof acquireSnapshotDependencyLock>): Promise<void> {
		const index = this.#preparationHandleIndex(preparation);
		const frame = this.#transaction(false, database => {
			if (!database.prepare("SELECT 1 FROM local_session_terminal WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation)) return undefined;
			const captured = this.#terminalFrame(database, selector);
			if ((decodeCanonical(captured, terminalLimits) as unknown[])[9] !== index) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_CHANGED");
			return captured;
		});
		if (frame !== undefined) await this.#clearUnfencedPreparation(selector, lease, frame, preparation);
	}
	async #clearUnfencedPreparation(selector: LocalSessionSelector, lease: NodeDisposableSessionAccountLease,
		frame: Uint8Array, preparation: ReturnType<typeof acquireSnapshotDependencyLock>): Promise<void> {
		const account = resolveNodeDisposableSessionAccount(lease);
		if (account.authority !== this.account || account.selector.slot !== selector.slot || account.selector.incarnation !== selector.incarnation) throw new Error("LOCAL_SESSION_TERMINAL_SOURCE_MISMATCH");
		const readHandle = this.reserveHandle();
		let original: Awaited<ReturnType<typeof account.acquireUnfencedRecoveryReservation>> | undefined, failed = false, primary: unknown;
		try {
			preparation.check();
			original = await account.acquireUnfencedRecoveryReservation();
			await original.check();
			this.#transaction(true, database => {
				preparation.check(); account.assertUnfenced();
				if (this.#row(database, selector).status !== "active" || !Buffer.from(this.#terminalFrame(database, selector)).equals(frame)) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_CHANGED");
				if (database.prepare("DELETE FROM local_session_terminal WHERE slot=? AND incarnation=? AND frame=?").run(selector.slot, selector.incarnation, frame).changes !== 1) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_CHANGED");
			});
			await original.check();
		} catch (cause) { failed = true; primary = cause; }
		try { await original?.release(); readHandle.release(); }
		catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "unfenced preparation recovery and joined native release failed", { cause: primary }); throw cleanup; }
		if (failed) throw primary;
	}
	commitDisposableFence(selector: LocalSessionSelector, accountLease: NodeDisposableSessionAccountLease): void {
		const account = resolveNodeDisposableSessionAccount(accountLease); account.check(true);
		if (account.authority !== this.account || account.selector.slot !== selector.slot || account.selector.incarnation !== selector.incarnation) throw new Error("LOCAL_SESSION_TERMINAL_SOURCE_MISMATCH");
		const expected = account.terminalDigest();
		this.#transaction(true, database => {
			const row = this.#row(database, selector), intent = this.#terminalFrame(database, selector);
			if (!Buffer.from(hashDomain("ts-drp/disposable-local-terminal-native-intent/v1", intent)).equals(expected)) throw new Error("LOCAL_SESSION_TERMINAL_INTENT_MISMATCH");
			if (row.status === "free") return;
			database.prepare("UPDATE local_session_slots SET status='retiring' WHERE slot=? AND incarnation=?").run(selector.slot, selector.incarnation);
		});
	}
	#terminalFrame(database: DatabaseSync, selector: LocalSessionSelector): Uint8Array {
		const row = database.prepare(`SELECT CASE WHEN typeof(frame)='blob' AND length(frame)<=${terminalLimits.maxBytes} THEN frame ELSE NULL END AS frame FROM local_session_terminal WHERE slot=? AND incarnation=?`).get(selector.slot, selector.incarnation);
		if (!(row?.frame instanceof Uint8Array)) throw new Error("LOCAL_SESSION_TERMINAL_INTENT_REQUIRED");
		const frame = Uint8Array.from(row.frame), fields = decodeCanonical(frame, terminalLimits);
		if (!Array.isArray(fields) || fields.length !== 10 || fields[0] !== "r11-native-terminal-v2" || !(fields[1] instanceof Uint8Array) || !(fields[2] instanceof Uint8Array) || !Buffer.from(fields[1]).equals(this.#accountIdentity!.identity) || !Buffer.from(fields[2]).equals(this.#accountIdentity!.owner) || fields[3] !== selector.slot || fields[4] !== selector.incarnation || !Array.isArray(fields[8]) || fields[8].length > this.storeScopes || typeof fields[9] !== "number" || !Number.isSafeInteger(fields[9]) || fields[9] < 0 || fields[9] >= this.handles) throw new Error("LOCAL_SESSION_TERMINAL_INTENT_MISMATCH");
		return frame;
	}
	/** Internal native custody only. Never exposed by a host, lease or SDK API. */
	ownedSeed(selector: LocalSessionSelector): Uint8Array {
		if (this.account !== undefined) throw new Error("LOCAL_SESSION_EXTERNAL_ACCOUNT_KEY_CUSTODY");
		return this.#transaction(false, (database) => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			const row = database.prepare("SELECT CASE WHEN typeof(seed)='blob' AND length(seed)=32 THEN seed ELSE NULL END AS seed FROM local_session_keys WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
			if (!(row?.seed instanceof Uint8Array) || row.seed.byteLength !== 32) throw new Error("LOCAL_SESSION_OWNED_KEY_STATE_LOST");
			return Uint8Array.from(row.seed);
		});
	}
	installOwnedPublicKey(selector: LocalSessionSelector, publicKey: Uint8Array): void {
		if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32) throw new TypeError("LOCAL_SESSION_OWNED_KEY_INVALID");
		this.#transaction(true, (database) => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			const row = database.prepare("SELECT CASE WHEN typeof(public_key)='blob' AND length(public_key)=32 THEN public_key ELSE NULL END AS public_key FROM local_session_keys WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
			if (!row || (row.public_key !== null && !Buffer.from(row.public_key as Uint8Array).equals(publicKey))) throw new Error("LOCAL_SESSION_OWNED_KEY_STATE_LOST");
			database.prepare("UPDATE local_session_keys SET public_key=? WHERE slot=? AND incarnation=?").run(publicKey, selector.slot, selector.incarnation);
		});
	}
	assertOwnedGenesis(selector: LocalSessionSelector, binding: Uint8Array): void { this.#genesisBinding(selector, binding, false); }
	bindOwnedGenesis(selector: LocalSessionSelector, binding: Uint8Array): void { this.#genesisBinding(selector, binding, true); }
	/** Fixed-size exact pre-sign identity binding, not portable authority or freshness. */
	#genesisBinding(selector: LocalSessionSelector, binding: Uint8Array, write: boolean): void {
		if (!(binding instanceof Uint8Array) || binding.byteLength !== 32) throw new TypeError("LOCAL_SESSION_GENESIS_BINDING_INVALID");
		this.#transaction(write, database => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			const row = database.prepare("SELECT room_binding IS NOT NULL AS room_bound,CASE WHEN genesis_binding IS NULL THEN 0 WHEN typeof(genesis_binding)='blob' AND length(genesis_binding)=32 THEN 1 ELSE -1 END AS valid,CASE WHEN typeof(genesis_binding)='blob' AND length(genesis_binding)=32 THEN genesis_binding ELSE NULL END AS binding FROM local_session_keys WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
			if (!row || row.valid === -1 || (row.valid === 0 && row.room_bound === 1) || (row.valid === 1 && !Buffer.from(row.binding as Uint8Array).equals(binding))) throw new Error("LOCAL_SESSION_GENESIS_BINDING_CONFLICT");
			if (write) database.prepare("UPDATE local_session_keys SET genesis_binding=? WHERE slot=? AND incarnation=?").run(binding, selector.slot, selector.incarnation);
		});
	}
	/** Exact authenticated SDK root binding, not portable authority or freshness. */
	bindOwnedRoom(selector: LocalSessionSelector, binding: Uint8Array): void {
		if (!(binding instanceof Uint8Array) || binding.byteLength !== 32) throw new TypeError("LOCAL_SESSION_ROOM_BINDING_INVALID");
		this.#transaction(true, (database) => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			const row = database.prepare("SELECT CASE WHEN typeof(room_binding)='blob' AND length(room_binding)=32 THEN room_binding ELSE NULL END AS room_binding FROM local_session_keys WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation);
			if (!row || (row.room_binding !== null && !Buffer.from(row.room_binding as Uint8Array).equals(binding))) throw new Error("LOCAL_SESSION_ROOM_BINDING_CONFLICT");
			database.prepare("UPDATE local_session_keys SET room_binding=? WHERE slot=? AND incarnation=?").run(binding, selector.slot, selector.incarnation);
		});
	}
	acquire(selector: LocalSessionSelector): ReturnType<typeof acquireSnapshotDependencyLock> {
		const held = acquireSnapshotDependencyLock(this.#lockFile(selector.slot), "shared");
		try { this.assertActive(selector); return held; } catch (primary) { held.release(); throw primary; }
	}
	/** Bounded live custody, not durable occupancy: native crash releases the lock. */
	reserveHandle(selector?: LocalSessionSelector, excludePreparation = false): ReturnType<typeof acquireSnapshotDependencyLock> {
		if (selector) this.assertActive(selector);
		const preparationIndex = selector && excludePreparation && this.account !== undefined ? this.#transaction(false, database =>
			database.prepare("SELECT 1 FROM local_session_terminal WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation)
				? (decodeCanonical(this.#terminalFrame(database, selector), terminalLimits) as unknown[])[9] as number : -1) : -1;
		for (let handle = 0; handle < this.handles; handle++) {
			if (handle === preparationIndex) continue; // A fresh reopen must not occupy its own orphan-detection handle.
			let held: ReturnType<typeof acquireSnapshotDependencyLock>;
			try { held = acquireSnapshotDependencyLock(this.#handleFile(handle), "exclusive"); }
			catch (cause) {
				// Only exact native SQLITE_BUSY means this capacity slot is occupied.
				// Poisoned/missing files and failed acquisition cleanup must propagate.
				if (cause instanceof Error && !(cause instanceof AggregateError) && Reflect.get(cause, "errcode") === 5) continue;
				throw cause;
			}
			try { if (selector) this.assertActive(selector); this.#handleIndexes.set(held, handle); return held; }
			catch (primary) {
				try { held.release(); }
				catch (cleanup) { throw new AggregateError([primary, cleanup], "local handle admission and release failed", { cause: primary }); }
				throw primary;
			}
		}
		throw new Error("LOCAL_SESSION_HANDLE_CAPACITY");
	}
	fence(selector: LocalSessionSelector): void {
		this.#transaction(true, (database) => {
			if (this.#row(database, selector).status === "free") throw new Error("LOCAL_SESSION_ALREADY_RETIRED");
			// Refusal is pre-effect: without protocol disposition, ordinary close /
			// exact reopen must remain usable rather than strand durable obligations.
			if (database.prepare("SELECT 1 FROM local_session_files WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation))
				throw new Error("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
			database.prepare("UPDATE local_session_slots SET status='retiring' WHERE slot=? AND incarnation=?").run(selector.slot, selector.incarnation);
		});
	}
	#basename(selector: LocalSessionSelector, family: SessionStoreFamily, digest: string): string {
		if (!families.includes(family) || !/^[0-9a-f]{64}$/u.test(digest)) throw new Error("LOCAL_SESSION_FILE_DECLARATION_POISONED");
		return `.r11-s${selector.slot}-i${selector.incarnation}-${family}-${digest}.sqlite`;
	}
	#primary(base: string, family: SessionStoreFamily): string {
		return `${base}${family === "issuance" ? ".drp-issuance-v1.sqlite" : family === "journal" ? ".drp-live-journal-v1.sqlite" : family === "snapshots" ? ".drp-snapshot-quarantine-v1.sqlite" : ""}`;
	}
	#exists(filename: string): boolean {
		try { lstatSync(filename); return true; }
		catch (cause) { if (typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ENOENT") return false; throw cause; }
	}
	declare(selector: LocalSessionSelector, family: SessionStoreFamily, name: string, requireExisting = false): Readonly<{ filename: string; initialization: "create" | "reopen"; digest: string }> {
		if (typeof name !== "string" || !name || name.includes("\0") || Buffer.byteLength(name) > ROOM_HEAD_IMAGE_LIMITS.maxBytes) throw new TypeError("INVALID_LOCAL_STORAGE_IDENTITY");
		const digest = createHash("sha256").update(JSON.stringify([family, name])).digest("hex");
		return this.#transaction(true, (database) => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			const before = database.prepare("SELECT installed FROM local_session_files WHERE slot=? AND incarnation=? AND family=? AND digest=?").get(selector.slot, selector.incarnation, family, digest);
			if (!before) {
				if (this.account !== undefined && database.prepare("SELECT 1 FROM local_session_terminal WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("LOCAL_SESSION_TERMINAL_PREPARATION_PENDING");
				if (requireExisting) throw new Error("LOCAL_SESSION_RETAINED_STORE_MISSING");
				const count = Number(database.prepare("SELECT count(*) AS n FROM local_session_files WHERE slot=?").get(selector.slot)?.n);
				if (count >= this.storeScopes) throw new Error("LOCAL_SESSION_STORE_SCOPE_CAPACITY");
				const primary = this.#primary(join(this.directory, this.#basename(selector, family, digest)), family);
				if (["", "-wal", "-shm", "-journal"].some((suffix) => this.#exists(`${primary}${suffix}`))) throw new Error("LOCAL_SESSION_UNDECLARED_EXISTING_BYTES");
				database.prepare("INSERT INTO local_session_files VALUES(?,?,?,?,0)").run(selector.slot, selector.incarnation, family, digest);
			}
			return Object.freeze({ filename: join(this.directory, this.#basename(selector, family, digest)), digest, initialization: before?.installed === 1 ? "reopen" : "create" });
		});
	}
	installed(selector: LocalSessionSelector, family: SessionStoreFamily, digest: string): void {
		this.#transaction(true, (database) => {
			if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
			if (database.prepare("UPDATE local_session_files SET installed=1 WHERE slot=? AND incarnation=? AND family=? AND digest=?").run(selector.slot, selector.incarnation, family, digest).changes !== 1) throw new Error("LOCAL_SESSION_FILE_DECLARATION_LOST");
		});
	}
	/** Whole-file coverage check, not deletion eligibility. The original protocol
	 * owner still authenticates and charges every protected source/dependency. */
	captureDisposableFileManifest(selector: LocalSessionSelector, session: LocalSessionLifetime, objectId: string):
		readonly Readonly<{ family: SessionStoreFamily; digest: string; installed: boolean; controlBytes: number }>[] {
		if (this.account === undefined || typeof objectId !== "string" || !objectId || Buffer.byteLength(objectId) > ROOM_HEAD_IMAGE_LIMITS.maxBytes) throw new TypeError("LOCAL_SESSION_TERMINAL_OBJECT_INVALID");
		const result: Readonly<{ family: SessionStoreFamily; digest: string; installed: boolean; controlBytes: number }>[] = [];
		const objectTables: Readonly<Record<Exclude<SessionStoreFamily, "room-head">, readonly string[]>> = {
			ahe: ["objects", "generations", "promotions", "retirement_controls"],
			issuance: ["lineages", "issued_records", "issuance_outbox", "settlement_plans", "retirement_controls"],
			journal: ["scopes", "accepted_entries", "retirement_controls"],
			snapshots: ["snapshot_scopes_v2", "snapshot_chunks_v2", "snapshot_retirement_controls", "snapshot_dependency_slots"],
			signing: ["signing_rows"],
		};
		let afterFamily = "", afterDigest = "";
		while (true) {
			session.assertCurrent();
			const batch = this.#transaction(false, database => {
				if (this.#row(database, selector).status !== "active") throw new Error("LOCAL_SESSION_REVOKED");
				return database.prepare(`SELECT ${fileProjection},installed FROM local_session_files WHERE slot=? AND incarnation=? AND (family,digest)>(?,?) ORDER BY family,digest LIMIT 16`).all(selector.slot, selector.incarnation, afterFamily, afterDigest);
			});
			if (!batch.length) break;
			for (const entry of batch) {
				const family = entry.family as SessionStoreFamily, digest = String(entry.digest);
				if (family === "room-head") throw new Error("DISPOSABLE_SESSION_OWNED_ACCOUNT_FLOOR_DECLARATION");
				const primary = this.#primary(join(this.directory, this.#basename(selector, family, digest)), family);
				let controlBytes = 0;
				if (!this.#exists(primary)) {
					if (entry.installed !== 0 || ["-wal", "-shm", "-journal"].some(suffix => this.#exists(`${primary}${suffix}`))) throw new Error("LOCAL_SESSION_RETAINED_STORE_MISSING");
				} else {
					const stat = lstatSync(primary);
					if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("LOCAL_SESSION_NONEXCLUSIVE_OWNED_FILE");
					session.declareNativeFile(primary, family);
					const release = session.reserveNativeHandle();
					let connection: DatabaseSync | undefined;
					try {
						connection = new DatabaseSync(sqliteFilename(primary, "reopen"));
						enforceNativeLocalSessionFile(connection, primary, session, false);
						const names = connection.prepare("SELECT CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=64 THEN name ELSE NULL END AS name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 16").all();
						const allowed = ["local_session_custody_guard", ...objectTables[family], ...(family === "ahe" ? ["blobs"] : family === "snapshots" ? ["snapshot_owner_v2"] : family === "signing" ? ["signing_meta"] : [])];
						if (names.length >= 16 || names.some(row => typeof row.name !== "string" || !allowed.includes(row.name))) throw new Error("LOCAL_SESSION_UNCLASSIFIED_NATIVE_SCOPE");
						if (entry.installed === 0 && names.some(row => row.name !== "local_session_custody_guard")) throw new Error("LOCAL_SESSION_UNCLASSIFIED_NATIVE_SCOPE");
						for (const table of objectTables[family]) {
							if (!names.some(row => row.name === table)) { if (entry.installed === 1) throw new Error("LOCAL_SESSION_UNCLASSIFIED_NATIVE_SCOPE"); else continue; }
							if (connection.prepare(`SELECT 1 FROM ${table} WHERE ${table === "snapshot_dependency_slots" ? "object_id IS NOT NULL AND " : ""}(typeof(object_id)<>'text' OR object_id<>?) LIMIT 1`).get(objectId)) throw new Error("LOCAL_SESSION_FOREIGN_PROTECTED_SCOPE");
						}
						if (family === "signing" && names.some(row => row.name === "signing_meta")) {
							const key = createSigningStorageCodec(AHE_BOUNDED_READ_LIMITS).keyFor(objectId);
							if (connection.prepare("SELECT 1 FROM signing_meta WHERE key NOT IN ('incarnation',?) LIMIT 1").get(key)) throw new Error("LOCAL_SESSION_FOREIGN_PROTECTED_SCOPE");
						}
						controlBytes = Number(connection.prepare("SELECT length(binding) AS n FROM local_session_custody_guard WHERE id=1").get()?.n);
						if (!Number.isSafeInteger(controlBytes) || controlBytes < 1 || controlBytes > 16_384) throw new Error("DISPOSABLE_SESSION_NATIVE_CUSTODY_POISONED");
						session.assertCurrent();
					} catch (primaryError) {
						try { connection?.close(); } catch (cleanup) { session.fail(cleanup); throw new AggregateError([primaryError, cleanup], "terminal native census and close failed", { cause: primaryError }); }
						connection = undefined;
						try { release(); } catch (cleanup) { throw new AggregateError([primaryError, cleanup], "terminal native census and handle release failed", { cause: primaryError }); }
						throw primaryError;
					} finally { if (connection !== undefined) { try { connection.close(); } catch (cleanup) { session.fail(cleanup); throw cleanup; } release(); } }
				}
				result.push(Object.freeze({ family, digest, installed: entry.installed === 1, controlBytes }));
				if (result.length > this.storeScopes) throw new Error("LOCAL_SESSION_STORE_SCOPE_CAPACITY");
				afterFamily = family; afterDigest = digest;
			}
		}
		session.assertCurrent(); return Object.freeze(result);
	}
	#removePrimary(filename: string): void {
		for (const suffix of ["-wal", "-shm", "-journal", ""]) {
			const selected = `${filename}${suffix}`;
			if (!this.#exists(selected)) continue;
			const stat = lstatSync(selected);
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("LOCAL_SESSION_NONEXCLUSIVE_OWNED_FILE");
			unlinkSync(selected);
		}
	}
	cleanup(selector: LocalSessionSelector, accountLease?: NodeDisposableSessionAccountLease): object | undefined {
		const account = accountLease === undefined ? undefined : resolveNodeDisposableSessionAccount(accountLease);
		if ((this.account === undefined) !== (account === undefined) || (account !== undefined && (account.authority !== this.account || account.selector.slot !== selector.slot || account.selector.incarnation !== selector.incarnation))) throw new Error("LOCAL_SESSION_TERMINAL_SOURCE_MISMATCH");
		account?.checkCleanup();
		const terminalDigest = account?.terminalDigest();
		const exclusive = acquireSnapshotDependencyLock(this.#lockFile(selector.slot), "exclusive");
		try {
			// Exclusive original native custody is held before erasing recoverable
			// owned key material. A crash after this transaction retains retiring
			// intent but can never reopen/sign; recovery finishes exact file cleanup.
			// Logical key retirement is NOT forensic page/WAL/backup zeroization.
			this.#transaction(true, (database) => {
				account?.checkCleanup();
				const row = this.#row(database, selector);
				if (account !== undefined) this.#checkTerminalIntent(database, selector, terminalDigest!);
				if (row.status === "free") return;
				if (row.status !== "retiring") throw new Error("LOCAL_SESSION_NOT_RETIRING");
				// A native file declaration proves mechanical ownership, not lawful
				// cancellation of pending issuance/settlement or promised recovery.
				// No existing room-owner terminal disposition currently covers these
				// families. Fail before retiring the key or deleting any byte, including
				// on restart. An empty never-opened lease can still retire normally.
				if (account === undefined && database.prepare("SELECT 1 FROM local_session_files WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation))
					throw new Error("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
				database.prepare("DELETE FROM local_session_keys WHERE slot=? AND incarnation=?").run(selector.slot, selector.incarnation);
				database.prepare("UPDATE local_session_slots SET key_retired=1 WHERE slot=? AND incarnation=?").run(selector.slot, selector.incarnation);
			});
			let done = false;
			while (!done) this.#transaction(true, (database) => {
				account?.checkCleanup();
				const row = this.#row(database, selector);
				if (row.status === "free") { done = true; return; }
				if (row.status !== "retiring") throw new Error("LOCAL_SESSION_NOT_RETIRING");
				const batch = database.prepare(`SELECT ${fileProjection} FROM local_session_files WHERE slot=? AND incarnation=? ORDER BY family,digest LIMIT 16`).all(selector.slot, selector.incarnation);
				for (const entry of batch) {
					const family = entry.family as SessionStoreFamily, digest = String(entry.digest), base = join(this.directory, this.#basename(selector, family, digest));
					const suffix = family === "issuance" ? ".drp-issuance-v1.sqlite" : family === "journal" ? ".drp-live-journal-v1.sqlite" : family === "snapshots" ? ".drp-snapshot-quarantine-v1.sqlite" : "";
					if (account !== undefined) {
						const fields = this.#checkTerminalIntent(database, selector, terminalDigest!);
						const primary = `${base}${suffix}`;
						if (this.#exists(primary)) {
							const handle = this.reserveHandle();
							let native: DatabaseSync | undefined;
							try { native = new DatabaseSync(sqliteFilename(primary, "reopen")); assertNativeLocalSessionFileBinding(native, encodeCanonical(["r11-native-custody-v1", fields[1], selector.slot, selector.incarnation, fields[2], fields[5], family], { maxBytes: 16_384, maxDepth: 2, maxItems: 16 })); }
							catch (primaryError) {
								try { native?.close(); } catch (cleanup) { throw new AggregateError([primaryError, cleanup], "terminal guard readback and close failed", { cause: primaryError }); }
								native = undefined; try { handle.release(); } catch (cleanup) { throw new AggregateError([primaryError, cleanup], "terminal guard readback and handle release failed", { cause: primaryError }); } throw primaryError;
							} finally { if (native !== undefined) { native.close(); handle.release(); } }
						}
					}
					if (family === "snapshots") {
						// Default recovery policy only. Coordinate allocation may survive a
						// rolled-back row, so use the original finite mechanical slot range.
						const count = snapshotQuarantineContract.defaultRecoveryLimits.maxRecoveryScopes + snapshotRetirementContract.maxScopes;
						for (let slot = 0; slot < count; slot++) {
							const filename = `${base}${suffix}.dependency-${slot}.sqlite`;
							if (!this.#exists(filename)) continue;
							const handle = this.reserveHandle();
							let lock: ReturnType<typeof acquireSnapshotDependencyLock> | undefined;
							try { lock = acquireSnapshotDependencyLock(filename, "exclusive"); this.#removePrimary(filename); }
							finally { try { lock?.release(); } finally { handle.release(); } }
						}
					}
					this.#removePrimary(`${base}${suffix}`);
					database.prepare("DELETE FROM local_session_files WHERE slot=? AND incarnation=? AND family=? AND digest=?").run(selector.slot, selector.incarnation, family, digest);
				}
				if (!batch.length) { database.prepare("UPDATE local_session_slots SET status='free' WHERE slot=? AND incarnation=? AND status='retiring'").run(selector.slot, selector.incarnation); done = true; }
			});
			if (account !== undefined) {
				const check = (): void => this.#transaction(false, database => {
					account.checkCleanup(); this.#checkTerminalIntent(database, selector, terminalDigest!);
					if (this.#row(database, selector).status !== "free" || database.prepare("SELECT key_retired FROM local_session_slots WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation)?.key_retired !== 1 || database.prepare("SELECT 1 FROM local_session_files WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation) || database.prepare("SELECT 1 FROM local_session_keys WHERE slot=? AND incarnation=? LIMIT 1").get(selector.slot, selector.incarnation)) throw new Error("LOCAL_SESSION_NATIVE_CLEANUP_INCOMPLETE");
				});
				check(); const receipt = Object.freeze({});
				cleanupReceipts.set(receipt, { check, facts: Object.freeze({ authority: this.account!, selector, identity: Uint8Array.from(this.#accountIdentity!.identity), owner: Uint8Array.from(this.#accountIdentity!.owner), digest: Uint8Array.from(terminalDigest!) }) });
				return receipt;
			}
			return undefined;
		} finally { exclusive.release(); }
	}
	#checkTerminalIntent(database: DatabaseSync, selector: LocalSessionSelector, digest: Uint8Array): unknown[] {
		const frame = this.#terminalFrame(database, selector);
		if (!Buffer.from(hashDomain("ts-drp/disposable-local-terminal-native-intent/v1", frame)).equals(digest)) throw new Error("LOCAL_SESSION_TERMINAL_INTENT_MISMATCH");
		const fields = decodeCanonical(frame, terminalLimits) as unknown[], manifest = fields[8] as unknown[];
		if (typeof fields[5] !== "string" || !/^[0-9a-f]{64}$/u.test(fields[5]) || !(fields[7] instanceof Uint8Array)) throw new Error("LOCAL_SESSION_TERMINAL_INTENT_MISMATCH");
		if (database.prepare("SELECT count(*) AS n FROM local_session_files WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation)!.n as number > manifest.length) throw new Error("LOCAL_SESSION_TERMINAL_MANIFEST_MISMATCH");
		for (const file of database.prepare(`SELECT ${fileProjection},installed FROM local_session_files WHERE slot=? AND incarnation=?`).iterate(selector.slot, selector.incarnation)) {
			if (!manifest.some(row => Array.isArray(row) && row.length === 4 && row[0] === file.family && row[1] === file.digest && row[2] === (file.installed === 1))) throw new Error("LOCAL_SESSION_TERMINAL_MANIFEST_MISMATCH");
		}
		return fields;
	}
}
