import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PHASE_0B_RESOLVER_LAWS_TIMEOUT_MS } from "./test-timeouts.js";

function configTimeout(source: string): number {
	const match = /testTimeout:\s*([\d_]+)/u.exec(source);
	if (match?.[1] === undefined) throw new Error("test config does not declare testTimeout");
	return Number(match[1].replaceAll("_", ""));
}

describe("Phase 0b root-CI timeout contract", () => {
	it("binds the resolver-law property to its package ceiling under the shorter root config", () => {
		const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const rootConfig = readFileSync(`${repositoryRoot}/vite.config.mts`, "utf8");
		const packageConfig = readFileSync(new URL("../vitest.config.mts", import.meta.url), "utf8");
		const propertyTest = readFileSync(new URL("./resolver-laws-property.test.ts", import.meta.url), "utf8");

		expect(configTimeout(packageConfig)).toBe(PHASE_0B_RESOLVER_LAWS_TIMEOUT_MS);
		expect(configTimeout(rootConfig)).toBeLessThan(PHASE_0B_RESOLVER_LAWS_TIMEOUT_MS);
		expect(propertyTest).toMatch(
			/it\(\s*"drives pair and multiple resolution[\s\S]*,\s*PHASE_0B_RESOLVER_LAWS_TIMEOUT_MS\s*\);/u
		);
	});
});
