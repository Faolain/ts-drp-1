/* eslint-disable @typescript-eslint/explicit-function-return-type -- Count seams keep native signatures. */
// Deterministic cost counters for performance budgets (measurement only; every seam forwards unchanged).
//
// SQLite: patches node:sqlite DatabaseSync.prototype.exec and StatementSync.prototype run/get/all/iterate
// (never `prepare`, so the storage layer's prepared-statement cache stays active). Each call bumps one key:
//   sql.<KEYWORD>             statement by its first SQL keyword (sql.SELECT, sql.PRAGMA, sql.INSERT, ...)
//   sql.beginRead/beginWrite  BEGIN / BEGIN IMMEDIATE|EXCLUSIVE through exec
//   sql.commitRead/commitWrite, sql.rollbackRead/rollbackWrite
//                             transaction ends through exec, by the mode the same connection began with
//   sql.stmt.<BEGIN|COMMIT|ROLLBACK|END>  a transaction statement through a prepared statement (no connection)
// Canonical codec: `countingCanonical` builds the module replacement for
//   vi.mock("@ts-drp/canonical", (importOriginal) => countingCanonical(importOriginal, (key) => slot.bump(key)))
// (the mock must be declared in the test file; use a vi.hoisted slot, since modules encode at import time).
// It counts canonical.encode and canonical.decode from every importer of the package entry (the codec's own
// internal recursion is one call).
//
// Call sites: pass `onCall` to receive each key with a stack summary (`callSite()`), for attribution.

export type CountKeyListener = (key: string) => void;

const keyword = (sql: unknown) => (typeof sql === "string" ? (/^\s*([A-Za-z]+)/u.exec(sql)?.[1] ?? "?").toUpperCase() : "?");

/**
 * Installs the SQLite count seams.
 * @param bump - Receives one key per counted call (see the module comment).
 * @returns Restores the original prototype methods.
 */
export async function installSqliteCountSeams(bump: CountKeyListener): Promise<() => void> {
	const sqlite = (await import("node:sqlite")) as unknown as Record<string, { prototype: Record<string, unknown> }>;
	const restores: (() => void)[] = [];
	// Open write transactions per connection, so a ROLLBACK can be told from a read rollback.
	const writing = new WeakSet<object>();
	const patch = (target: Record<string, unknown> | undefined, method: string, label: (self: object, args: unknown[]) => string) => {
		const original = target?.[method];
		if (target === undefined || typeof original !== "function") return;
		target[method] = function (this: object, ...args: unknown[]) {
			bump(label(this, args));
			return (original as (...values: unknown[]) => unknown).apply(this, args);
		};
		restores.push(() => {
			target[method] = original;
		});
	};
	const transactionKey = (self: object, word: string, sql: string): string => {
		if (word === "BEGIN") {
			if (/IMMEDIATE|EXCLUSIVE/iu.test(sql)) {
				writing.add(self);
				return "sql.beginWrite";
			}
			writing.delete(self);
			return "sql.beginRead";
		}
		if (word === "ROLLBACK" || word === "COMMIT" || word === "END") {
			const write = writing.has(self);
			writing.delete(self);
			return `sql.${word === "ROLLBACK" ? "rollback" : "commit"}${write ? "Write" : "Read"}`;
		}
		return `sql.${word}`;
	};
	patch(sqlite.DatabaseSync?.prototype, "exec", (self, args) => {
		const sql = String(args[0] ?? "");
		return transactionKey(self, keyword(sql), sql);
	});
	for (const method of ["run", "get", "all", "iterate"])
		patch(sqlite.StatementSync?.prototype, method, (self) => {
			const word = keyword(String((self as { sourceSQL?: string }).sourceSQL ?? ""));
			return ["BEGIN", "ROLLBACK", "COMMIT", "END"].includes(word) ? `sql.stmt.${word}` : `sql.${word}`;
		});
	return () => {
		for (const restore of restores.splice(0).reverse()) restore();
	};
}

/**
 * The @ts-drp/canonical module replacement for vi.mock, counting encodes and decodes.
 * @param importOriginal - vi.mock's importOriginal.
 * @param bump - Receives canonical.encode / canonical.decode per call.
 * @returns The original module with counted encodeCanonical and decodeCanonical.
 */
export async function countingCanonical(
	importOriginal: <T>() => Promise<T>,
	bump: CountKeyListener
): Promise<typeof import("@ts-drp/canonical")> {
	const original = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {
		...original,
		encodeCanonical: (...args: Parameters<typeof original.encodeCanonical>) => {
			bump("canonical.encode");
			return original.encodeCanonical(...args);
		},
		decodeCanonical: (...args: Parameters<typeof original.decodeCanonical>) => {
			bump("canonical.decode");
			return original.decodeCanonical(...args);
		},
	};
}

const relevant = /\/packages\/([^/]+)\/(?:src|dist\/src)\/(.+?)\.(?:ts|js):(\d+)/u;
/**
 * A stack summary of the current call: up to `depth` frames inside packages/, innermost first,
 * as `function@package/path:line`, joined by " < ".
 * @param depth - Frames to keep.
 * @returns The summary.
 */
export function callSite(depth = 14): string {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 60;
	const stack = new Error().stack ?? "";
	Error.stackTraceLimit = limit;
	const frames: string[] = [];
	for (const line of stack.split("\n").slice(2)) {
		const match = relevant.exec(line);
		if (match === null) continue;
		const fn = /at (?:async )?([^\s(]+)/u.exec(line)?.[1] ?? "?";
		frames.push(`${fn}@${match[1]}/${match[2]}:${match[3]}`);
		if (frames.length >= depth) break;
	}
	return frames.join(" < ");
}
