import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import * as blueprintsRoot from "../packages/blueprints/src/index.js";
import { CanonicalDecodingError, CanonicalEncodingError } from "../packages/canonical/src/index.js";
import { CausalityIndex, LinearizationError, linearizeEpoch } from "../packages/compaction/src/index.js";
import {
	AdoptionCommitExhaustedError,
	ApplyInvariantError,
	isObjectACLDeterministicError,
	ObjectACLDeterministicError,
	RootACLMutationError,
} from "../packages/object/src/index.js";
import {
	EmptyQuorumCertificateError,
	MixedQuorumCertificateError,
	UnsupportedProfileError,
} from "../packages/protocol-v2/src/index.js";
import * as typesRoot from "../packages/types/src/index.js";
import {
	DRPValidationError,
	InvalidDependenciesError,
	InvalidHashError,
	InvalidTimestampError,
	VertexValidationError,
} from "../packages/validation/src/index.js";

interface ErrorRoot {
	DRPError: new (code: string, message?: string, options?: ErrorOptions) => Error & { readonly code: string };
	DRP_ERROR_CODES: readonly string[];
	isDRPError(value: unknown): boolean;
}

const errorRootSpecifier = "@ts-drp/errors";
const duplicateProbeSpecifier = "./fixtures/phase-0l-errors-probe.js";
const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");
const OBJECT_ACL_DETERMINISTIC_ERROR = Symbol.for("@ts-drp/object/ObjectACLDeterministicError");

async function loadErrorRoot(): Promise<ErrorRoot> {
	return (await import(errorRootSpecifier)) as ErrorRoot;
}

async function loadDuplicateProbe(): Promise<ErrorRoot> {
	return (await import(duplicateProbeSpecifier)) as ErrorRoot;
}

function capture(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected action to throw");
}

function runtimeErrorExports(module: object): string[] {
	return Object.keys(module)
		.filter((name) => name.endsWith("Error") || name.startsWith("isDRPError"))
		.sort();
}

describe("Phase 0l @ts-drp/errors public root RED", () => {
	it("publishes the zero-workspace-dependency package with the exact root map", () => {
		const manifestUrl = new URL("../packages/errors/package.json", import.meta.url);

		expect(existsSync(manifestUrl), "the eighth public package root must exist").toBe(true);
		if (!existsSync(manifestUrl)) return;
		const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
			name?: string;
		};
		expect(manifest.name).toBe("@ts-drp/errors");
		expect(manifest.exports).toEqual({
			".": {
				import: "./dist/src/index.js",
				types: "./dist/src/index.d.ts",
			},
		});
		expect(manifest.dependencies ?? {}).toEqual({});
	});

	it("exports only the frozen registry, coded base, and cross-copy recognizer at runtime", async () => {
		const errors = await loadErrorRoot();

		expect(Object.keys(errors).sort()).toEqual(["DRPError", "DRP_ERROR_CODES", "isDRPError"]);
		expect(Object.isFrozen(errors.DRP_ERROR_CODES)).toBe(true);
		expect(errors.DRP_ERROR_CODES.length).toBeGreaterThan(0);
		expect(new Set(errors.DRP_ERROR_CODES).size).toBe(errors.DRP_ERROR_CODES.length);
		expect(errors.DRP_ERROR_CODES.every((code) => typeof code === "string" && code.length > 0)).toBe(true);
	});

	it("recognizes a genuinely re-evaluated duplicate module but rejects a code-only impostor", async () => {
		const first = await loadErrorRoot();
		vi.resetModules();
		const second = await loadErrorRoot();
		const code = first.DRP_ERROR_CODES[0] as string;
		const foreign = new second.DRPError(code, "foreign copy");

		expect(first.DRPError).not.toBe(second.DRPError);
		expect(first.isDRPError(foreign)).toBe(true);
		expect(first.isDRPError({ code })).toBe(false);
	});

	it("proves the duplicate-module oracle with a compliant test-only module", async () => {
		const first = await loadDuplicateProbe();
		vi.resetModules();
		const second = await loadDuplicateProbe();
		const foreign = new second.DRPError("PROBE_ERROR");

		expect(first.DRPError).not.toBe(second.DRPError);
		expect(first.isDRPError(foreign)).toBe(true);
		expect(first.isDRPError({ code: "PROBE_ERROR" })).toBe(false);
	});

	it.each([
		["CanonicalDecodingError", new CanonicalDecodingError(), "CANONICAL_DECODING"],
		["CanonicalEncodingError", new CanonicalEncodingError(), "CANONICAL_ENCODING"],
		["LinearizationError", new LinearizationError("INVALID_VERTEX", "invalid vertex"), "INVALID_VERTEX"],
		["EmptyQuorumCertificateError", new EmptyQuorumCertificateError(), "EMPTY_QC"],
		["MixedQuorumCertificateError", new MixedQuorumCertificateError(), "MIXED_QC"],
		["UnsupportedProfileError", new UnsupportedProfileError("unknown", "unknown"), "UNSUPPORTED_PROFILE"],
		["DRPValidationError", new DRPValidationError({ message: "invalid schema" } as never), "DRP_VALIDATION"],
		["InvalidDependenciesError", new InvalidDependenciesError(), "INVALID_DEPENDENCIES"],
		["InvalidHashError", new InvalidHashError(), "INVALID_HASH"],
		["InvalidTimestampError", new InvalidTimestampError(), "INVALID_TIMESTAMP"],
		["VertexValidationError", new VertexValidationError(new Error("graph access")), "VERTEX_VALIDATION_FAILED"],
		["AdoptionCommitExhaustedError", new AdoptionCommitExhaustedError("vertex-hash", 3), "ADOPTION_COMMIT_EXHAUSTED"],
		["ApplyInvariantError", new ApplyInvariantError([], "apply invariant"), "APPLY_INVARIANT"],
		["ObjectACLDeterministicError", new ObjectACLDeterministicError(), "OBJECT_ACL_DETERMINISTIC"],
		["RootACLMutationError", new RootACLMutationError("root ACL"), "ROOT_ACL_MUTATION_FORBIDDEN"],
	] as const)("catalogues and recognizes %s with its exact public code", async (_name, error, code) => {
		const errors = await loadErrorRoot();

		expect(error).toMatchObject({ code });
		expect(errors.DRP_ERROR_CODES).toContain(code);
		expect(errors.isDRPError(error)).toBe(true);
	});

	it("rejects code-only, unknown-code, and hostile generic recognizer inputs", async () => {
		const errors = await loadErrorRoot();
		const code = errors.DRP_ERROR_CODES[0] as string;
		const unknownCode = { [DRP_ERROR_BRAND]: true, code: "NOT_A_DRP_ERROR_CODE" };
		const hostile = new Proxy(
			{},
			{
				get(): never {
					throw new Error("hostile accessor");
				},
			}
		);

		expect(errors.isDRPError({ code })).toBe(false);
		expect(errors.isDRPError(unknownCode)).toBe(false);
		expect(() => errors.isDRPError(hostile)).not.toThrow();
		expect(errors.isDRPError(hostile)).toBe(false);
	});

	it("keeps the object ACL recognizer distinct from the generic taxonomy recognizer", async () => {
		const errors = await loadErrorRoot();
		const aclOnly = { [OBJECT_ACL_DETERMINISTIC_ERROR]: true };
		const genericOnly = {
			[DRP_ERROR_BRAND]: true,
			code: "OBJECT_ACL_DETERMINISTIC",
		};
		const hostile = new Proxy(
			{},
			{
				get(): never {
					throw new Error("hostile ACL accessor");
				},
			}
		);

		expect(isObjectACLDeterministicError(new ObjectACLDeterministicError())).toBe(true);
		expect(isObjectACLDeterministicError(aclOnly)).toBe(true);
		expect(errors.isDRPError(aclOnly)).toBe(false);
		expect(errors.isDRPError(genericOnly)).toBe(true);
		expect(isObjectACLDeterministicError(genericOnly)).toBe(false);
		expect(() => isObjectACLDeterministicError(hostile)).not.toThrow();
		expect(isObjectACLDeterministicError(hostile)).toBe(false);
	});
});

describe("Phase 0l exclusion and no-taxonomy controls", () => {
	it("leaves package-authored programmer misuse TypeError and RangeError unbranded", async () => {
		const errors = await loadErrorRoot();
		const typeError = capture(() => linearizeEpoch(null as never));
		const rangeError = capture(() => new CausalityIndex(new Map(), undefined, { maxEpochVertices: 0 }));

		expect(typeError).toBeInstanceOf(TypeError);
		expect(rangeError).toBeInstanceOf(RangeError);
		expect(errors.isDRPError(typeError)).toBe(false);
		expect(errors.isDRPError(rangeError)).toBe(false);
	});

	it("allows a caller to propagate an already branded value without claiming provenance", async () => {
		const errors = await loadErrorRoot();
		const branded = new errors.DRPError(errors.DRP_ERROR_CODES[0] as string, "caller-owned");
		const callback = (): never => {
			throw branded;
		};

		expect(capture(callback)).toBe(branded);
		expect(errors.isDRPError(branded)).toBe(true);
	});

	it("keeps blueprints and types free of intentional runtime error classes", () => {
		expect(runtimeErrorExports(blueprintsRoot)).toEqual([]);
		expect(runtimeErrorExports(typesRoot)).toEqual([]);
	});
});

describe("Phase 0l declared subpath reachability controls", () => {
	it("retains all four declared validation runtime entry points", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../packages/validation/package.json", import.meta.url), "utf8")
		) as {
			exports: Record<string, { import: string; types: string }>;
		};

		expect(Object.keys(manifest.exports).sort()).toEqual([".", "./errors", "./message", "./vertex"]);
		expect(manifest.exports).toEqual({
			".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
			"./errors": { import: "./dist/src/errors.js", types: "./dist/src/errors.d.ts" },
			"./message": { import: "./dist/src/schemas/message.js", types: "./dist/src/schemas/message.d.ts" },
			"./vertex": { import: "./dist/src/vertex.js", types: "./dist/src/vertex.d.ts" },
		});
	});
});
