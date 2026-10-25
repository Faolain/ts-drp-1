import type { NativeReadReservation } from "@ts-drp/storage";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { enforceNativeLocalSessionFile, type LocalSessionLifetime } from "./local-session-lifetime.js";
import { cachedStatement } from "./sqlite-statement-cache.js";

/**
 * Captures a mechanical object selector without executing getters.
 * @param input - The untrusted closed selector.
 * @returns The finite object identifier; never protocol authority.
 */
export function captureSqliteReadReservationObject(input: unknown): string {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("INVALID_ARGUMENT");
	const prototype = Object.getPrototypeOf(input),
		keys = Reflect.ownKeys(input),
		field = Object.getOwnPropertyDescriptor(input, "objectId");
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		keys.length !== 1 ||
		keys[0] !== "objectId" ||
		field === undefined ||
		!("value" in field) ||
		!field.enumerable ||
		typeof field.value !== "string" ||
		field.value.length === 0 ||
		field.value.includes("\0")
	)
		throw new TypeError("INVALID_ARGUMENT");
	return field.value;
}

/**
 * SQLite WAL readers do not exclude writers. This no-change transaction holds
 * SQLite's native writer reservation; it grants no application authority.
 */
export class SqliteNativeReadReservationOwner {
	#held?: NativeReadReservation;
	#closed = false;
	#close?: Promise<void>;
	#heldJoin?: Promise<void>;
	/**
	 * Opens reservations only over an already installed native owner.
	 * @param filename - Original owner database path.
	 */
	constructor(private readonly filename: string, private readonly session?: LocalSessionLifetime) {}

	/** Original live exclusion identity only. It carries no admitted rows,
	 * protocol authority or permission to reuse facts after release/revocation. */
	current(): NativeReadReservation | undefined {
		this.session?.assertCurrent();
		return this.#closed ? undefined : this.#held;
	}

	/**
	 * Acquires actual native exclusion, without any row or schema mutation.
	 * @returns A revocable capability whose release joins rollback and close.
	 */
	async acquire(custodySession: LocalSessionLifetime | undefined = this.session): Promise<NativeReadReservation> {
		this.session?.assertCurrent();
		if (this.#closed) throw new Error("STORE_CLOSED");
		if (this.#held !== undefined) throw new Error("NATIVE_READ_RESERVATION_BUSY");
		const joined = this.session?.enter();
		let releaseHandle: (() => void) | undefined;
		try { releaseHandle = this.session?.reserveNativeHandle(); }
		catch (primary) { joined?.(); throw primary; }
		const uri = pathToFileURL(resolve(this.filename));
		uri.searchParams.set("mode", "rw"); // Never recreate a lost native store.
		let acquired: DatabaseSync | undefined;
		try { acquired = new DatabaseSync(uri.href, {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
		}); enforceNativeLocalSessionFile(acquired, this.filename, custodySession, false); } catch (primary) {
			try { acquired?.close(); } catch (cleanup) { this.session?.fail(cleanup); throw new AggregateError([primary, cleanup], "native read open and native close failed", { cause: primary }); }
			try { releaseHandle?.(); joined?.(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "native read open and handle release failed", { cause: primary }); }
			throw primary;
		}
		const database = acquired;
		let active = false,
			released = false;
		let resolveJoin!: () => void, rejectJoin!: (cause: unknown) => void;
		this.#heldJoin = new Promise<void>((resolve, reject) => { resolveJoin = resolve; rejectJoin = reject; });
		void this.#heldJoin.catch(() => undefined);
		let terminal: Promise<void> | undefined;
		const release = (): Promise<void> => {
			released = true;
			return (terminal ??= new Promise<void>((resolve, reject) => {
				const failures: unknown[] = [];
				if (active)
					try {
						database.exec("ROLLBACK");
						active = false;
					} catch (cause) {
						failures.push(cause);
					}
				try {
					database.close();
				} catch (cause) {
					failures.push(cause);
				}
				if (this.#held === held) this.#held = undefined;
				if (!failures.length) try { releaseHandle?.(); } catch (cause) { failures.push(cause); }
				if (!failures.length) joined?.();
				if (failures.length) {
					const cause = failures.length === 1 ? failures[0] : new AggregateError(failures, "native read reservation release failed", { cause: failures[0] });
					this.session?.fail(cause); rejectJoin(cause); reject(cause);
				} else { resolveJoin(); resolve(); }
			}));
		};
		const held = Object.freeze({
			// Native check executes synchronously; the port preserves Promise rejection.
			// eslint-disable-next-line @typescript-eslint/require-await
			check: async (): Promise<void> => {
				this.session?.assertCurrent();
				if (released || this.#closed) throw new Error("NATIVE_READ_RESERVATION_RELEASED");
				if (!active) throw new Error("NATIVE_READ_RESERVATION_LOST");
				cachedStatement(database, "SELECT name FROM sqlite_schema LIMIT 1").get();
			},
			release,
		});
		this.#held = held;
		try {
			database.exec("PRAGMA busy_timeout=1000");
			database.exec("BEGIN IMMEDIATE");
			active = true;
			await held.check();
			this.session?.assertCurrent();
			if (this.#closed || released) throw new Error("NATIVE_READ_RESERVATION_RELEASED");
			return held;
		} catch (primary) {
			try {
				await release();
			} catch (cleanup) {
				throw new AggregateError([primary, cleanup], "native read reservation acquisition failed", { cause: primary });
			}
			throw primary;
		}
	}

	/** Revokes new acquisitions and successful checks immediately, retaining exclusion. */
	revoke(): void {
		this.#closed = true;
	}

	/**
	 * Joins the original capability after its owning native work has joined.
	 * @returns The stable joined terminal, preserving native cleanup failures.
	 */
	close(): Promise<void> {
		this.revoke();
		return (this.#close ??= this.session ? this.#heldJoin ?? Promise.resolve() : this.#held?.release() ?? Promise.resolve());
	}
}
