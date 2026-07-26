import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sourceEntryPath, sourceExists } from "./contract.js";

describe("Phase 0b source owner", () => {
	it("requires the missing compaction implementation as the only RED trigger", () => {
		const packageDocument = JSON.parse(
			readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
		) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
			name?: string;
			scripts?: Record<string, string>;
			types?: string;
		};

		expect(packageDocument.name).toBe("@ts-drp/compaction");
		expect(packageDocument.dependencies?.["@ts-drp/canonical"]).toBe("0.11.0");
		expect(packageDocument.exports).toHaveProperty(".");
		expect(packageDocument.types).toBe("./dist/src/index.d.ts");
		expect(packageDocument.scripts?.test).toBe("vitest run");
		expect(sourceExists, `Phase 0b requires the sole production owner at ${sourceEntryPath}`).toBe(true);
	});
});
