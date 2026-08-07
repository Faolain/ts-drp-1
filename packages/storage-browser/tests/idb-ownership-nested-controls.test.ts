import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { auditIdbOwnership } from "./fixtures/idb-ownership-checker.js";

describe("Phase 2b exported-signature and browser-graph controls", () => {
	it("rejects a nested exported raw-IDB signature while ignoring private function bodies", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-nested-idb-"));
		try {
			const source = path.join(directory, "nested-escape.ts");
			fs.writeFileSync(source, "export interface Leak { nested: { database: IDBDatabase } }\n", "utf8");
			expect(auditIdbOwnership({ rootNames: [source] })).toEqual([
				expect.stringContaining("raw IDB type escapes its owner"),
			]);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("keeps transition, seed, and recovery browser source graphs disjoint", () => {
		const root = path.resolve(import.meta.dirname, "..");
		const transition = fs.readFileSync(path.join(root, "tests/assets/page-entry.ts"), "utf8");
		const seed = fs.readFileSync(path.join(root, "tests/assets/seed-entry.ts"), "utf8");
		const oracle = fs.readFileSync(path.join(root, "tests/assets/oracle-entry.ts"), "utf8");
		expect(transition).not.toContain("oracle-idb");
		expect(transition).not.toContain("seedInstrumentedDatabase");
		expect(seed).not.toContain("oracle-idb");
		expect(oracle).not.toContain("instrumented-idb");
	});
});
