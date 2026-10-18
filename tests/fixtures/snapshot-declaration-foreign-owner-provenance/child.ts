import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { observeGraph } from "./graph.js";
import type * as Canonical from "../../../packages/canonical/dist/src/index.js";
import type * as Protocol from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";

const boundary = process.argv[2];
assert.ok(boundary === "protocol-text-decode" || boundary === "protocol-canonical-reencode");
const canonicalUrl = new URL("../../../packages/canonical/dist/src/index.js", import.meta.url);
const foreignUrl = new URL(canonicalUrl);
foreignUrl.searchParams.set("foreign-owner-negative", "actual-second-esm-realization");
const protocolUrl = new URL("../../../packages/protocol-v3/dist/src/snapshot-transfer.js", import.meta.url);
const resolved = JSON.parse(
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'console.log(JSON.stringify({canonical:import.meta.resolve("@ts-drp/canonical"),protocol:import.meta.resolve("@ts-drp/protocol-v3/snapshot-transfer")}))',
		],
		{ cwd: new URL("../../../packages/protocol-v3/", import.meta.url), encoding: "utf8", timeout: 10000 }
	)
) as { canonical: string; protocol: string };
assert.equal(resolved.canonical, canonicalUrl.href);
assert.equal(resolved.protocol, protocolUrl.href);
const finishGraph =
	process.argv[3] === "graph" ? observeGraph([canonicalUrl.href, foreignUrl.href, protocolUrl.href]) : undefined;
// A genuine second evaluation of the exact built ESM file, before interception.
const foreign = (await import(foreignUrl.href)) as typeof Canonical;
const NativeDecoder = globalThis.TextDecoder;
const NativeEncoder = globalThis.TextEncoder;
const nativeDecode = NativeDecoder.prototype.decode;
const nativeEncode = NativeEncoder.prototype.encode;
let armed = false;
let sentinel: unknown;
let phase = "import";
let nextInstance = 0;
let injections = 0;
const events: {
	phase: string;
	method: string;
	instance: number;
	stack: string;
	injected: boolean;
	nativePrototype: boolean;
}[] = [];

/**
 * Observe the captured native method and inject only at the real decodeRecord call edge.
 * @param method - Selected native conversion method.
 * @param instance - Captured native receiver identity.
 * @param stack - Real product call stack.
 * @param nativePrototype - Whether native internal-slot receiver prototype is preserved.
 */
function reach(method: string, instance: number, stack: string, nativePrototype: boolean): void {
	if (
		!stack.includes("decodeRecord") ||
		!(boundary === "protocol-text-decode" ? stack.includes("decodeCanonical") : stack.includes("encodeCanonical"))
	)
		return;
	if (phase === "setup" || phase === "import") return;
	const injected = armed;
	if (!events.some((item) => item.phase === phase && item.method === method))
		events.push({ phase, method, instance, stack, injected, nativePrototype });
	if (injected) {
		armed = false;
		injections++;
		throw sentinel;
	}
}

globalThis.TextDecoder = new Proxy(NativeDecoder, {
	construct(target, args, newTarget): TextDecoder {
		const value = Reflect.construct(target, args, newTarget) as TextDecoder;
		const instance = ++nextInstance;
		Object.defineProperty(value, "decode", {
			configurable: true,
			value: function (this: TextDecoder, ...args: Parameters<TextDecoder["decode"]>): string {
				if (boundary === "protocol-text-decode")
					reach(
						"TextDecoder.decode",
						instance,
						new Error("native method reach").stack ?? "",
						Object.getPrototypeOf(this) === NativeDecoder.prototype
					);
				return Reflect.apply(nativeDecode, this, args) as string;
			},
		});
		return value;
	},
});
globalThis.TextEncoder = new Proxy(NativeEncoder, {
	construct(target, args, newTarget): TextEncoder {
		const value = Reflect.construct(target, args, newTarget) as TextEncoder;
		const instance = ++nextInstance;
		Object.defineProperty(value, "encode", {
			configurable: true,
			value: function (this: TextEncoder, ...args: Parameters<TextEncoder["encode"]>): Uint8Array {
				if (boundary === "protocol-canonical-reencode")
					reach(
						"TextEncoder.encode",
						instance,
						new Error("native method reach").stack ?? "",
						Object.getPrototypeOf(this) === NativeEncoder.prototype
					);
				return Reflect.apply(nativeEncode, this, args) as Uint8Array;
			},
		});
		return value;
	},
});

try {
	const owner = (await import(canonicalUrl.href)) as typeof Canonical;
	const protocol = (await import(protocolUrl.href)) as typeof Protocol;
	globalThis.TextDecoder = NativeDecoder;
	globalThis.TextEncoder = NativeEncoder;
	assert.notEqual(owner, foreign);
	assert.notEqual(owner.decodeCanonical, foreign.decodeCanonical);
	assert.notEqual(owner.CanonicalDecodingError, foreign.CanonicalDecodingError);
	assert.notEqual(owner.CanonicalEncodingError, foreign.CanonicalEncodingError);
	assert.equal(foreign.decodeCanonical(foreign.encodeCanonical("actual foreign codec")), "actual foreign codec");
	phase = "setup";
	const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
	const encoded = protocol.encodeSnapshotTransfer({
		objectId: "foreign-owner-negative",
		epoch: 1,
		schemaVersion: 1,
		anchor: "a".repeat(64),
		aclDigest: "b".repeat(64),
		stateDigest: "c".repeat(64),
		exactCanonicalPayloadBytes: owner.encodeCanonical({ ready: true }),
		profile,
	});
	const input = {
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		expectedManifestDigest: encoded.manifestDigest,
		profile,
	};
	const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
	const before = hash(input.exactCanonicalManifestBytes);
	const action = (): Protocol.DecodedSnapshotManifest => protocol.decodeSnapshotManifest(input);
	phase = "valid-control";
	assert.deepEqual(action().exactCanonicalManifestBytes, input.exactCanonicalManifestBytes);
	assert.ok(events.some((item) => item.phase === phase && !item.injected));
	phase = "natural-owner-control";
	const malformed = Uint8Array.of(5, 1, 255);
	const malformedDigest = Array.from(owner.hashDomain("ts-drp/snapshot-manifest/v3", malformed), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	assert.throws(
		() =>
			protocol.decodeSnapshotManifest({
				exactCanonicalManifestBytes: malformed,
				expectedManifestDigest: malformedDigest,
				profile,
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(Reflect.get(error, "code"), "manifest-noncanonical");
			assert.ok(error.cause instanceof owner.CanonicalDecodingError);
			assert.equal(Object.getPrototypeOf(error.cause), owner.CanonicalDecodingError.prototype);
			assert.equal(error.cause instanceof foreign.CanonicalDecodingError, false);
			return true;
		}
	);
	const cases = [
		["foreign-decoding", new foreign.CanonicalDecodingError("genuine foreign decoding class"), false],
		["foreign-encoding", new foreign.CanonicalEncodingError("genuine foreign encoding class"), false],
		[
			"shaped-decoding",
			Object.assign(new TypeError("code-shaped native ancestry"), { code: "CANONICAL_DECODING" }),
			false,
		],
		[
			"shaped-encoding",
			Object.assign(new TypeError("code-shaped native ancestry"), { code: "CANONICAL_ENCODING" }),
			false,
		],
		["owner-decoding", new owner.CanonicalDecodingError("same-owner decoding control"), true],
		["owner-encoding", new owner.CanonicalEncodingError("same-owner encoding control"), true],
	] as const;
	const results = [];
	for (const [name, value, positive] of cases) {
		sentinel = value;
		const exactOwner = value instanceof owner.CanonicalDecodingError || value instanceof owner.CanonicalEncodingError;
		assert.equal(exactOwner, positive);
		assert.ok(value instanceof TypeError);
		phase = `${name}:fault`;
		const prior = injections;
		armed = true;
		let error: unknown;
		try {
			action();
		} catch (caught) {
			error = caught;
		} finally {
			armed = false;
		}
		assert.equal(injections, prior + 1, "the exact captured native method must be reached once");
		assert.ok(error instanceof Error);
		let causeIncludesSentinel = false;
		let current: unknown = error;
		const seen = new Set<unknown>();
		const chain = [];
		while (current && typeof current === "object" && !seen.has(current)) {
			seen.add(current);
			causeIncludesSentinel ||= current === value;
			chain.push({
				name: Reflect.get(current, "name"),
				code: Reflect.get(current, "code"),
				exactSentinel: current === value,
			});
			current = Reflect.get(current, "cause");
		}
		const expectedCode = positive
			? boundary === "protocol-text-decode"
				? "manifest-noncanonical"
				: "manifest-invalid"
			: "manifest-processing-failed";
		const code: unknown = Reflect.get(error, "code");
		const passes = code === expectedCode && (positive || causeIncludesSentinel);
		phase = `${name}:retry`;
		assert.deepEqual(action().exactCanonicalManifestBytes, input.exactCanonicalManifestBytes);
		assert.ok(events.some((item) => item.phase === phase && !item.injected));
		assert.equal(hash(input.exactCanonicalManifestBytes), before);
		results.push({
			name,
			positive,
			code,
			expectedCode,
			causeIncludesSentinel,
			passes,
			exactOwner,
			foreignClass: value instanceof foreign.CanonicalDecodingError || value instanceof foreign.CanonicalEncodingError,
			typeError: value instanceof TypeError,
			canonicalCode: value.code,
			sharedBrand: Reflect.get(value, Symbol.for("@ts-drp/errors/DRPError")) === true,
			chain,
		});
	}
	assert.ok(events.every((item) => item.nativePrototype));
	const controlsPass = results.filter((item) => item.positive).every((item) => item.passes);
	console.log(
		JSON.stringify(
			{
				boundary,
				graph: finishGraph?.() ?? null,
				bindings: {
					...resolved,
					foreign: foreignUrl.href,
					sameFileDifferentEsmIdentity: true,
					canonicalSha256: hash(readFileSync(fileURLToPath(canonicalUrl))),
					protocolSha256: hash(readFileSync(fileURLToPath(protocolUrl))),
				},
				controls: {
					validNativeDelegation: true,
					capturedMethodReached: true,
					nativePrototype: true,
					naturalSameOwnerError: true,
					distinctGenuineForeignRealization: true,
					validRetries: true,
					unchangedInput: true,
					authorizedOwnerCodes: controlsPass,
				},
				events,
				results,
			},
			null,
			2
		)
	);
	process.exitCode = !controlsPass ? 2 : results.some((item) => !item.positive && !item.passes) ? 1 : 0;
} finally {
	globalThis.TextDecoder = NativeDecoder;
	globalThis.TextEncoder = NativeEncoder;
}
