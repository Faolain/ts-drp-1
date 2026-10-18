import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { auditIdbOwnership, PACKAGE_DIRECTORY } from "./fixtures/idb-ownership-checker.js";
import * as phase2dSchema from "../src/internal/schema-idb.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Phase 2d2a production IDB ownership", () => {
	it("governs the real adapter and retires the obsolete schema mutation probe", () => {
		const config = fs.readFileSync(path.join(PACKAGE_DIRECTORY, "tsconfig.json"), "utf8");
		expect(config).toContain('"playwright.phase-2d2a-idb-adapter.config.ts"');
		expect(Reflect.has(phase2dSchema, "testOnlyAttemptStrictMutation")).toBe(false);
		expect(auditIdbOwnership()).toEqual([]);
	}, 60_000);

	it("fails closed on hidden transaction modes and unsupported raw calls", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2d2a-owner-"));
		temporaryDirectories.push(directory);
		const source = path.join(directory, "adapter-owner.ts");
		const allowed = new Map([[source, ["transaction", "objectStore", "get", "add", "put"]]]);
		fs.writeFileSync(
			source,
			"function mutate(database: IDBDatabase, mode: IDBTransactionMode): void { database.transaction('x', mode); }\n",
			"utf8"
		);
		expect(auditIdbOwnership({ ownerMethods: allowed, rootNames: [source] })).toEqual([
			expect.stringContaining("unsupported IDB transaction mode"),
		]);

		fs.writeFileSync(
			source,
			"function mutate(database: IDBDatabase): void { const mode = 'readwrite' as const; database.transaction('x', mode); }\n",
			"utf8"
		);
		expect(auditIdbOwnership({ ownerMethods: allowed, rootNames: [source] })).toEqual([
			expect.stringContaining("readwrite IDB transaction does not request strict durability"),
		]);

		fs.writeFileSync(source, "function mutate(store: IDBObjectStore): void { store.delete('x'); }\n", "utf8");
		expect(auditIdbOwnership({ ownerMethods: allowed, rootNames: [source] })).toEqual([
			expect.stringContaining("IDB call delete is not allowed for owner"),
		]);
	}, 60_000);
});
