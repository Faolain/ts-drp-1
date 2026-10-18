import "fake-indexeddb/auto";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {describe, expect, it} from "vitest";
import {CanonicalEncodingError, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {createJournalRetirementImageCapture, journalRetirementCanonicalRow, journalRetirementImage,
	journalRetirementImageCountsFit, journalRetirementRowCharge, LIVE_JOURNAL_RETIREMENT_LIMITS} from "@ts-drp/live-journal";

const outcome = (run: () => unknown) => {try {run(); return null;} catch (error) {
	return error instanceof Error ? [error.constructor.name, error.message] : error;
}};
const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
	request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const terminal = (transaction: IDBTransaction): Promise<boolean> => new Promise(resolve => {
	transaction.oncomplete = () => resolve(true); transaction.onabort = () => resolve(false);
	transaction.onerror = () => resolve(false);
});
const stores = ["scopes", "acceptedEntries", "retirementControls"];

function nativeSnapshot(captures: {table: string; row: unknown; key: unknown}[]) {
	const source = readFileSync(new URL("../src/live-journal.ts", import.meta.url), "utf8");
	const ast = ts.createSourceFile("live-journal.ts", source, ts.ScriptTarget.Latest, true);
	const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "retirementSnapshot");
	if (declaration === undefined) throw Error("original retirement snapshot missing");
	const dependencies = {
		needsNativeReadReservationTurn: () => false, nativeReadReservationTransaction: () => undefined,
		isNativeReadReservationTransaction: () => false,
		strictTransaction: (db: IDBDatabase, names: string[], mode: IDBTransactionMode) => db.transaction(names, mode),
		signedTransactionTerminal: terminal, JOURNAL_STORES: stores, IDBKeyRange, requestResult,
		journalRetirementImageCountsFit, CorruptLiveJournalError: class extends Error {}, retirementControl: () => null,
		createJournalRetirementImageCapture: () => {const owner = createJournalRetirementImageCapture(); return {
			append: (table: "scopes" | "acceptedEntries", row: unknown, key?: unknown) => {
				captures.push({table, row, key}); return owner.append(table, row, key);
			}, finish: owner.finish, release: owner.release,
		};},
	};
	return new Function(...Object.keys(dependencies),
		`${ts.transpile(declaration.getText(ast), {target: ts.ScriptTarget.ES2022})};return retirementSnapshot;`)
		(...Object.values(dependencies)) as (database: IDBDatabase, objectId: string, write?: undefined, captureRows?: boolean) => Promise<{
			image: ReturnType<typeof journalRetirementImage>; frames: Uint8Array[]; scopes: unknown[]; rows: unknown[];
		}>;
}

describe("journal native single-capture image ownership", () => {
	it("composes exact SQL and browser frames/images from one detached traversal per ordinary row", () => {
		for (const table of ["accepted_entries", "acceptedEntries"] as const) {
			let traversals = 0;
			const source = Uint8Array.of(1, 3), raw = {payload: source, absent: null};
			const row = new Proxy(raw, {ownKeys(value) {traversals++; return Reflect.ownKeys(value);}});
			const expected = journalRetirementImage([], [raw]), key = ["room", 1, "a", 0];
			const owner = createJournalRetirementImageCapture(), frame = owner.append(table, row, key)!;
			// Original encoder asks once for symbols and once for descriptors.
			expect(traversals).toBe(2);
			expect(frame).toEqual(journalRetirementCanonicalRow(table, key, raw));
			source.fill(99); frame.fill(0);
			expect(owner.finish()).toEqual(expected); expect(traversals).toBe(2);
			expect(() => owner.finish()).toThrow("retirement-released");
			expect(() => owner.append(table, row, key)).toThrow("retirement-released");
			owner.release();
		}
	});
	it("preserves normalized standalone scope charges, RAW accepted NULLs and original object/collection limit semantics", () => {
		const row: Record<string, unknown> = {object_id: "room", next_journal_sequence: 0, closed_membership_bytes: null};
		for (let i = 0; i < 126; i++) row[`field${i}`] = null;
		expect(Object.keys(row)).toHaveLength(129); expect(() => journalRetirementRowCharge(row)).not.toThrow();
		for (const table of ["accepted_entries", "acceptedEntries"] as const) {
			const owner = createJournalRetirementImageCapture(), key = ["room", 0];
			expect(owner.append(table, row, key)).toEqual(journalRetirementCanonicalRow(table, key, row));
			expect(owner.finish()).toEqual(journalRetirementImage([], [row]));
		}
		const owner = createJournalRetirementImageCapture(); owner.append("scopes", row);
		expect(owner.finish()).toEqual(journalRetirementImage([row], []));
		// The frozen encoder bounds Array/Map/Set cardinality, not plain object
		// field count. Do not silently strengthen that public input contract.
		const larger = {...row, overflow: null}, sameLimits = createJournalRetirementImageCapture();
		expect(Object.keys(larger)).toHaveLength(130);
		expect(outcome(() => sameLimits.append("acceptedEntries", larger)))
			.toEqual(outcome(() => journalRetirementRowCharge(larger)));
		expect(sameLimits.finish()).toEqual(journalRetirementImage([], [larger]));
		for (const count of [128, 129]) {
			const collection = {...row, values: new Array(count).fill(null)}, bounded = createJournalRetirementImageCapture();
			expect(outcome(() => bounded.append("acceptedEntries", collection)))
				.toEqual(outcome(() => journalRetirementRowCharge(collection)));
			if (count === 128) expect(bounded.finish()).toEqual(journalRetirementImage([], [collection]));
			else expect(() => bounded.finish()).toThrow("retirement-released");
		}
		const nullPrototype = Object.assign(Object.create(null), {object_id: "room", next_journal_sequence: 0, closed_membership_bytes: null});
		const isolated = createJournalRetirementImageCapture(), expected = journalRetirementImage([], [nullPrototype]);
		isolated.append("acceptedEntries", nullPrototype); nullPrototype.object_id = "mutated";
		expect(isolated.finish()).toEqual(expected);
	});
	it("preserves malformed, row, frame, complete-image and depth refusals and invalidates failed captures", () => {
		const accessor = Object.defineProperty({}, "bad", {enumerable: true, get() {throw Error("must not execute");}});
		class Outside {value = 1;}
		for (const row of [{bad: Infinity}, {bad: "\ud800"}, {payload: new Array(129).fill(null)}, accessor, new Outside(), {[Symbol()]: 1}]) {
			const owner = createJournalRetirementImageCapture();
			expect(outcome(() => owner.append("acceptedEntries", row))).toEqual(outcome(() => journalRetirementRowCharge(row)));
			expect(() => owner.finish()).toThrow("retirement-released");
		}
		let deep: unknown = null; for (let i = 0; i < 14; i++) deep = [deep];
		const owner = createJournalRetirementImageCapture(); owner.append("acceptedEntries", {payload: deep});
		expect(outcome(() => owner.finish())).toEqual(outcome(() => journalRetirementImage([], [{payload: deep}])));
		const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, raw = {payload: new Uint8Array(limit - 200)};
		const overhead = encodeCanonical({scopes: [], rows: [raw]}).byteLength - raw.payload.byteLength;
		const row = {payload: new Uint8Array(limit - overhead + 1)}, bounded = createJournalRetirementImageCapture();
		bounded.append("acceptedEntries", row);
		expect(outcome(() => bounded.finish())).toEqual(outcome(() => journalRetirementImage([], [row])));
		const framed = createJournalRetirementImageCapture();
		expect(() => framed.append("acceptedEntries", {}, [new Uint8Array(limit)])).toThrow("retirement-fenced");
		expect(() => framed.finish()).toThrow("retirement-released");
		expect(() => journalRetirementImage([], [accessor])).toThrow(CanonicalEncodingError);
	});
	it("the original browser cursor path captures each actual native row once and rereads changes on the next transaction", async () => {
		const open = indexedDB.open(`journal-image-single-${crypto.randomUUID()}`, 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore("scopes", {keyPath: ["objectId", "epoch", "anchorDigest"]});
			open.result.createObjectStore("acceptedEntries", {keyPath: ["objectId", "epoch", "anchorDigest", "journalSequence"]});
			open.result.createObjectStore("retirementControls", {keyPath: "objectId"});
		};
		const db = await requestResult(open), objectId = "room";
		try {
			const header = {objectId, epoch: 1, anchorDigest: "a", nextJournalSequence: 2, closedMembership: null};
			const rows = [0, 1].map(journalSequence => ({objectId, epoch: 1, anchorDigest: "a", journalSequence, bytes: Uint8Array.of(journalSequence)}));
			const write = db.transaction(stores, "readwrite"), done = terminal(write);
			write.objectStore("scopes").put(header); for (const row of rows) write.objectStore("acceptedEntries").put(row);
			expect(await done).toBe(true);
			const captures: {table: string; row: unknown; key: unknown}[] = [], snapshot = nativeSnapshot(captures);
			const first = await snapshot(db, objectId, undefined, true);
			expect(captures).toHaveLength(3); expect(first.image).toEqual(journalRetirementImage([header], rows));
			expect(first.frames.map(frame => (decodeCanonical(frame) as unknown[])[0])).toEqual(["scopes", "acceptedEntries", "acceptedEntries"]);
			for (let i = 0; i < first.frames.length; i++) {
				const entry = captures.find(entry => encodeCanonical([entry.table, entry.key, entry.row]).toString() === first.frames[i]!.toString());
				expect(entry).toBeDefined();
			}
			const change = db.transaction(stores, "readwrite"), changed = terminal(change);
			rows[0]!.bytes = Uint8Array.of(9); change.objectStore("acceptedEntries").put(rows[0]); expect(await changed).toBe(true);
			captures.length = 0; const second = await snapshot(db, objectId);
			expect(captures).toHaveLength(3); expect(second.frames).toEqual([]);
			expect(second.image).toEqual(journalRetirementImage([header], rows)); expect(second.image.imageDigest).not.toBe(first.image.imageDigest);
		} finally {db.close();}
	});
});
