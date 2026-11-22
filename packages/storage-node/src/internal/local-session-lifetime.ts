import { compareBytes, encodeCanonical } from "@ts-drp/canonical";
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { resolveNodeDisposableSessionAccount, type NodeDisposableSessionAccountLease } from "../room-head.js";
import { configuredStatement } from "./sqlite-statement-cache.js";

const CUSTODY_TABLE = "local_session_custody_guard";
const CUSTODY_SCHEMA = "CREATE TABLE local_session_custody_guard(id INTEGER PRIMARY KEY CHECK(id=1),binding BLOB NOT NULL CHECK(length(binding)<=16384)) STRICT";
const guardedDatabases = new WeakSet<DatabaseSync>();
/** Exact bounded mechanical guard read. It grants no native port or deletion. */
export function assertNativeLocalSessionFileBinding(database: DatabaseSync, expected: Uint8Array): void {
	const schema = configuredStatement(database, "SELECT CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=512 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE name=?").get(CUSTODY_TABLE);
	if (schema?.sql !== CUSTODY_SCHEMA) throw new Error("DISPOSABLE_SESSION_NATIVE_CUSTODY_POISONED");
	const rows = configuredStatement(database, "SELECT id, CASE WHEN typeof(binding)='blob' AND length(binding)<=16384 THEN binding ELSE NULL END AS binding FROM local_session_custody_guard LIMIT 2").all();
	if (rows.length !== 1 || rows[0]?.id !== 1 || !(rows[0].binding instanceof Uint8Array) || compareBytes(rows[0].binding, expected) !== 0) throw new Error("DISPOSABLE_SESSION_NATIVE_CUSTODY_MISMATCH");
}
/** Existing native owners call this before schema/data effects. Persisted
 * disposable custody cannot be bypassed by reopening an unguarded raw alias. */
export function enforceNativeLocalSessionFile(database: DatabaseSync, filename: string,
	session: LocalSessionLifetime | undefined, create: boolean): void {
	const schema = configuredStatement(database, "SELECT CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=512 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE name=?").get(CUSTODY_TABLE);
	const expected = session?.captureNativeFileBinding(filename);
	if (schema === undefined && expected === undefined) return; // Ordinary/persistent stores unchanged.
	if (expected === undefined) throw new Error("DISPOSABLE_SESSION_NATIVE_CUSTODY_REQUIRED");
	if (schema === undefined) {
		if (!create) throw new Error("DISPOSABLE_SESSION_NATIVE_CUSTODY_LOST");
		database.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
		try {
			if (configuredStatement(database, "SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) throw new Error("DISPOSABLE_SESSION_UNBOUND_NATIVE_BYTES");
			database.exec(CUSTODY_SCHEMA);
			configuredStatement(database, "INSERT INTO local_session_custody_guard VALUES(1,?)").run(expected);
			session!.assertCurrent(); database.exec("COMMIT");
		} catch (primary) { try { database.exec("ROLLBACK"); } catch { /* Preserve original. */ } throw primary; }
	} else {
		assertNativeLocalSessionFileBinding(database, expected);
	}
	session!.assertCurrent(); guardedDatabases.add(database);
}
/** Exact admitted custody metadata is not a second product data schema. Raw
 * aliases never reach this filtering path: enforcement above rejects them. */
export function nativeLocalSessionSchemaRows<T extends Record<string, unknown>>(database: DatabaseSync, rows: readonly T[]): readonly T[] {
	return guardedDatabases.has(database) ? rows.filter(row => row.name !== CUSTODY_TABLE) : rows;
}
export function nativeLocalSessionSchemaExtraRows(database: DatabaseSync): number { return guardedDatabases.has(database) ? 1 : 0; }

/** Local native-custody lifetime; never protocol, room or signing authority. */
export class LocalSessionLifetime {
	#revoked = false;
	readonly #admitted = new Set<Promise<void>>();
	readonly #owners = new Map<{ close(): Promise<void> }, () => void>();
	#failed = false;
	#failure: unknown;
	#rejectFailure!: (cause: unknown) => void;
	readonly #failureJoined = new Promise<never>((_resolve, reject) => { this.#rejectFailure = reject; });
	#ownedAuthor?: string;
	readonly #operationSignatures = new Map<string, number>();
	readonly #genesisSignatures = new Map<string, number>();
	readonly #selectionSignatures = new Map<string, number>();
	readonly #sourceExpirySignatures = new Map<string, number>();
	readonly #possessionSignatures = new Map<string, number>();
	readonly #transportSignatures = new Map<string, number>();
	readonly #nativeFiles = new Map<string, string>();
	readonly #nativeOwnerFiles = new Map<object, Readonly<{ filename: string; aliases: readonly object[] }>>();
	constructor(private readonly currency: () => void, private readonly reserve: () => { release(): void },
		private readonly accountLease?: NodeDisposableSessionAccountLease) { void this.#failureJoined.catch(() => undefined); }
	assertCurrent(): void {
		if (this.#revoked) throw new Error("LOCAL_SESSION_REVOKED");
		this.currency();
		if (this.accountLease !== undefined) resolveNodeDisposableSessionAccount(this.accountLease).check();
	}
	declareNativeFile(filename: string, family: string): void {
		this.assertCurrent();
		if (this.accountLease === undefined) return;
		if (typeof filename !== "string" || Buffer.byteLength(filename) > 16_384 || !["ahe", "issuance", "journal", "snapshots", "signing", "room-head"].includes(family)) throw new TypeError("DISPOSABLE_SESSION_NATIVE_DECLARATION_INVALID");
		const account = resolveNodeDisposableSessionAccount(this.accountLease); account.assertBound();
		const key = resolve(filename), prior = this.#nativeFiles.get(key);
		if (prior !== undefined && prior !== family) throw new Error("DISPOSABLE_SESSION_NATIVE_FAMILY_CONFLICT");
		if (prior === undefined && this.#nativeFiles.size >= account.profile.storeScopes) throw new Error("LOCAL_SESSION_STORE_SCOPE_CAPACITY");
		this.#nativeFiles.set(key, family);
	}
	captureNativeFileBinding(filename: string): Uint8Array | undefined {
		if (this.accountLease === undefined) return undefined;
		this.assertCurrent();
		const account = resolveNodeDisposableSessionAccount(this.accountLease);
		// This is the independently retained original provider, not an owned
		// product file. Its exact account schema/currentness is checked by its
		// own native owner; terminal cleanup must never declare or unlink it.
		if (resolve(filename) === resolve(account.filename)) return undefined;
		account.assertBound();
		const family = this.#nativeFiles.get(resolve(filename));
		if (family === undefined || this.#ownedAuthor === undefined) throw new Error("DISPOSABLE_SESSION_NATIVE_DECLARATION_REQUIRED");
		return encodeCanonical(["r11-native-custody-v1", account.identity, account.selector.slot, account.selector.incarnation,
			account.owner, this.#ownedAuthor, family], { maxBytes: 16_384, maxDepth: 2, maxItems: 16 });
	}
	bindOwnedAuthor(author: string): void {
		this.assertCurrent();
		if (!/^[0-9a-f]{64}$/u.test(author) || (this.#ownedAuthor !== undefined && this.#ownedAuthor !== author)) throw new Error("LOCAL_SESSION_OWNED_AUTHOR_CONFLICT");
		this.#ownedAuthor = author;
	}
	assertOwnedAuthor(author: string): void {
		this.assertCurrent();
		if (this.#ownedAuthor === undefined || this.#ownedAuthor !== author) throw new Error("LOCAL_SESSION_BORROWED_SIGNING_FLOOR");
	}
	assertOwnedPublicKey(publicKey: Uint8Array): void {
		if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32) throw new Error("LOCAL_SESSION_BORROWED_SIGNING_FLOOR");
		this.assertOwnedAuthor(Buffer.from(publicKey).toString("hex"));
	}
	async withOwnedOperationSigning<T>(digest: Uint8Array, operation: () => Promise<T>): Promise<T> {
		return this.#withSigningTurn(this.#operationSignatures, digest, "LOCAL_SESSION_OPERATION_DIGEST_INVALID", operation);
	}
	assertOwnedOperationSigning(digest: Uint8Array): void {
		this.assertCurrent();
		if (digest.byteLength !== 32 || !this.#operationSignatures.has(Buffer.from(digest).toString("hex")))
			throw new Error("LOCAL_SESSION_ORIGINAL_OPERATION_ADMISSION_REQUIRED");
	}
	async withOwnedGenesisSigning<T>(digest: Uint8Array, operation: () => Promise<T>): Promise<T> {
		return this.#withSigningTurn(this.#genesisSignatures, digest, "LOCAL_SESSION_GENESIS_DIGEST_INVALID", operation);
	}
	assertOwnedGenesisSigning(digest: Uint8Array): void {
		this.assertCurrent();
		if (digest.byteLength !== 32 || !this.#genesisSignatures.has(Buffer.from(digest).toString("hex"))) throw new Error("LOCAL_SESSION_ACCOUNT_GENESIS_ADMISSION_REQUIRED");
	}
	async withOwnedSelectionSigning<T>(digest: Uint8Array, operation: () => Promise<T>): Promise<T> {
		return this.#withSigningTurn(this.#selectionSignatures, digest, "LOCAL_SESSION_SELECTION_DIGEST_INVALID", operation);
	}
	async withOwnedSourceExpirySigning<T>(digest: Uint8Array, operation: () => Promise<T>): Promise<T> {
		return this.#withSigningTurn(this.#sourceExpirySignatures, digest, "LOCAL_SESSION_SOURCE_EXPIRY_DIGEST_INVALID", operation);
	}
	async withOwnedIdentityChallengeSigning<T>(kind: "possession" | "transport", digest: Uint8Array, operation: () => Promise<T>): Promise<T> {
		return this.#withSigningTurn(kind === "possession" ? this.#possessionSignatures : this.#transportSignatures,
			digest, "LOCAL_SESSION_IDENTITY_CHALLENGE_DIGEST_INVALID", operation);
	}
	async #withSigningTurn<T>(turns: Map<string, number>, digest: Uint8Array, invalid: string, operation: () => Promise<T>): Promise<T> {
		this.assertCurrent();
		if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) throw new Error(invalid);
		const key = Buffer.from(digest).toString("hex");
		turns.set(key, (turns.get(key) ?? 0) + 1);
		try { return await operation(); } finally {
			const count = turns.get(key)!;
			if (count === 1) turns.delete(key); else turns.set(key, count - 1);
		}
	}
	assertOwnedSelectionSigning(digest: Uint8Array): void {
		this.assertCurrent();
		if (digest.byteLength !== 32 || !this.#selectionSignatures.has(Buffer.from(digest).toString("hex"))) throw new Error("LOCAL_SESSION_ORIGINAL_SELECTION_ADMISSION_REQUIRED");
	}
	assertOwnedSourceExpirySigning(digest: Uint8Array): void {
		this.assertCurrent();
		if (digest.byteLength !== 32 || !this.#sourceExpirySignatures.has(Buffer.from(digest).toString("hex")))
			throw new Error("LOCAL_SESSION_ORIGINAL_SOURCE_EXPIRY_ADMISSION_REQUIRED");
	}
	assertOwnedIdentityChallengeSigning(kind: "possession" | "transport", digest: Uint8Array): void {
		this.assertCurrent();
		const turns = kind === "possession" ? this.#possessionSignatures : this.#transportSignatures;
		if (digest.byteLength !== 32 || !turns.has(Buffer.from(digest).toString("hex"))) throw new Error("LOCAL_SESSION_ORIGINAL_IDENTITY_CHALLENGE_ADMISSION_REQUIRED");
	}
	/** Reserve and register before retaining a genuine owned-key signing job. */
	enterOwnedSigning(): () => void {
		const release = this.reserveNativeHandle();
		let finish: () => void;
		try { finish = this.enter(); } catch (primary) {
			try { release(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "owned signing admission and release failed", { cause: primary }); }
			throw primary;
		}
		return (): void => { try { release(); } finally { finish(); } };
	}
	/** Enter before the native acquisition/signature/operation, not after delivery. */
	enter(): () => void {
		this.assertCurrent();
		let finish!: () => void;
		const joined = new Promise<void>((resolve) => { finish = resolve; });
		this.#admitted.add(joined);
		let ended = false;
		return (): void => {
			if (ended) return;
			ended = true;
			this.#admitted.delete(joined);
			finish();
		};
	}
	async run<T>(operation: () => T | Promise<T>): Promise<T> {
		const finish = this.enter();
		try {
			const result = await operation();
			this.assertCurrent(); // Currency is rechecked before successful delivery.
			return result;
		} finally { finish(); }
	}
	revoke(): void { this.#revoked = true; }
	/** Reserve before creating a separately retained native owner/protection. */
	reserveNativeHandle(): () => void {
		this.assertCurrent();
		const held = this.reserve();
		let released = false;
		return (): void => {
			if (released) return;
			try { held.release(); released = true; }
			catch (cause) { this.fail(cause); throw cause; }
		};
	}
	registerOwner(owner: { close(): Promise<void> }, release: () => void, filename?: string): void {
		this.#owners.set(owner, release);
		if (filename !== undefined && this.accountLease !== undefined) {
			const aliases: object[] = [owner], port = Object.getOwnPropertyDescriptor(owner, "store");
			if (port !== undefined && "value" in port && port.value !== null && typeof port.value === "object") aliases.push(port.value as object);
			this.#nativeOwnerFiles.set(owner, Object.freeze({ filename: resolve(filename), aliases: Object.freeze(aliases) }));
		}
	}
	assertTerminalSourceCoverage(sources: readonly object[], filenames: readonly string[]): void {
		this.assertCurrent();
		const admitted = new Set(sources), covered = new Set<string>();
		for (const held of this.#nativeOwnerFiles.values()) if (held.aliases.some(alias => admitted.has(alias))) covered.add(held.filename);
		if (filenames.some(filename => !covered.has(resolve(filename)))) throw new Error("LOCAL_SESSION_UNCLASSIFIED_NATIVE_SOURCE");
	}
	closedOwner(owner: { close(): Promise<void> }): void {
		const release = this.#owners.get(owner);
		if (!release) return;
		release(); // Original owner has already closed and joined its native custody.
		this.#owners.delete(owner);
		this.#nativeOwnerFiles.delete(owner);
	}
	fail(cause: unknown): void {
		if (this.#failed) return;
		this.revoke(); this.#failed = true; this.#failure = cause; this.#rejectFailure(cause);
	}
	/** Revocation comes first. Native handles remain held until their releases join. */
	async join(): Promise<void> {
		this.revoke();
		if (this.#failed) throw this.#failure;
		while (this.#admitted.size) await Promise.race([Promise.all([...this.#admitted]), this.#failureJoined]);
	}
	async closeOwners(): Promise<void> {
		const results = await Promise.allSettled([...this.#owners.keys()].map((owner) => owner.close()));
		const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
		if (failures.length === 1) throw failures[0];
		if (failures.length) throw new AggregateError(failures, "local session native close failed", { cause: failures[0] });
	}
}
