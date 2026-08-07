import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { auditIdbOwnership } from "./fixtures/idb-ownership-checker.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Phase 2b bounded TypeScript Program ownership checker", () => {
	it("allows only the governed raw-IDB owner modules", () => {
		expect(auditIdbOwnership()).toEqual([]);
	}, 60_000);

	it("rejects a raw IDB call outside either owner", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-idb-checker-"));
		temporaryDirectories.push(directory);
		const source = path.join(directory, "forbidden.ts");
		fs.writeFileSync(source, "export function forbidden(): void { indexedDB.open('x'); }\n", "utf8");
		expect(auditIdbOwnership({ rootNames: [source] })).toEqual([
			expect.stringContaining("raw IDB call open outside an owner"),
		]);
	}, 60_000);

	it("rejects a raw IDB type escaping an owner", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-idb-type-checker-"));
		temporaryDirectories.push(directory);
		const source = path.join(directory, "type-escape.ts");
		fs.writeFileSync(source, "export function leak(database: IDBDatabase): IDBDatabase { return database; }\n", "utf8");
		expect(auditIdbOwnership({ rootNames: [source] })).toEqual([
			expect.stringContaining("raw IDB type escapes its owner"),
		]);
	}, 60_000);

	it("rejects mutation from an injected oracle owner", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-idb-oracle-mutation-"));
		temporaryDirectories.push(directory);
		const source = path.join(directory, "oracle-owner.ts");
		fs.writeFileSync(source, "function mutate(store: IDBObjectStore): void { store.put({}); }\n", "utf8");
		expect(
			auditIdbOwnership({
				rootNames: [source],
				ownerMethods: new Map([[source, ["open", "transaction", "objectStore", "openCursor", "continue", "close"]]]),
			})
		).toEqual([expect.stringContaining("IDB call put is not allowed for owner")]);
	}, 60_000);

	it("rejects unsupported and computed calls from an injected instrumented owner", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-idb-unsupported-"));
		temporaryDirectories.push(directory);
		const unsupported = path.join(directory, "unsupported-owner.ts");
		const computed = path.join(directory, "computed-owner.ts");
		fs.writeFileSync(unsupported, "function read(store: IDBObjectStore): void { store.get('x'); }\n", "utf8");
		fs.writeFileSync(computed, "function read(store: IDBObjectStore): void { store['openCursor'](); }\n", "utf8");
		const allowed = ["open", "transaction", "objectStore", "openCursor", "continue", "put", "commit", "close"];
		expect(auditIdbOwnership({ rootNames: [unsupported], ownerMethods: new Map([[unsupported, allowed]]) })).toEqual([
			expect.stringContaining("IDB call get is not allowed for owner"),
		]);
		expect(auditIdbOwnership({ rootNames: [computed], ownerMethods: new Map([[computed, allowed]]) })).toEqual([
			expect.stringContaining("unsupported computed IDB call"),
		]);
	}, 60_000);
});
