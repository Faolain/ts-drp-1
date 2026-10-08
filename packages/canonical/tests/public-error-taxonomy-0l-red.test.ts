import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as canonical from "../src/index.js";

type ErrorRoot = {
	DRP_ERROR_CODES: readonly string[];
	isDRPError(value: unknown): boolean;
};

const errorRootSpecifier = "@ts-drp/errors";

async function loadErrorRoot(): Promise<ErrorRoot> {
	return (await import(errorRootSpecifier)) as ErrorRoot;
}

function capture(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected action to throw");
}

describe("Phase 0l canonical inline taxonomy RED", () => {
	it.each([
		["encoding", (): Uint8Array => canonical.encodeCanonical(Symbol("outside-domain"))],
		["decoding", (): unknown => canonical.decodeCanonical(Uint8Array.of(0xff))],
	] as const)("brands its %s error with a registered inline code", async (_kind, action) => {
		const errors = await loadErrorRoot();
		const error = capture(action);
		const code = Reflect.get(error as object, "code");

		expect(error).toBeInstanceOf(TypeError);
		expect(typeof code).toBe("string");
		expect(errors.DRP_ERROR_CODES).toContain(code);
		expect(errors.isDRPError(error)).toBe(true);
	});
});

describe("Phase 0l canonical freeze controls", () => {
	it("preserves exactly seven runtime exports and TypeError ancestry", () => {
		expect(Object.keys(canonical).sort()).toEqual([
			"CanonicalDecodingError",
			"CanonicalEncodingError",
			"compareBytes",
			"decodeCanonical",
			"deepCloneCanonical",
			"encodeCanonical",
			"hashDomain",
		]);
		expect(canonical.CanonicalDecodingError.prototype).toBeInstanceOf(TypeError);
		expect(canonical.CanonicalEncodingError.prototype).toBeInstanceOf(TypeError);
	});

	it("adds no @ts-drp/errors dependency to canonical", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};

		expect(manifest.dependencies).not.toHaveProperty("@ts-drp/errors");
	});
});
