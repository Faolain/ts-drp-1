import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	CODEC_BOUNDARIES,
	type CodecBoundary,
	type ProvenanceEvent,
	type ProvenanceResult,
	THROWN_VALUES,
	type ThrownValue,
} from "./codec-provenance-cases.js";
import type * as CanonicalModule from "../../../packages/canonical/dist/src/index.js";
import type * as ProtocolModule from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";

const boundary = process.argv[2] as CodecBoundary;
const thrownValue = process.argv[3] as ThrownValue;
assert.ok(CODEC_BOUNDARIES.includes(boundary));
assert.ok(THROWN_VALUES.includes(thrownValue));
const resolutions = execFileSync(
	process.execPath,
	[
		"--input-type=module",
		"--eval",
		'console.log(JSON.stringify({canonical:import.meta.resolve("@ts-drp/canonical"),protocol:import.meta.resolve("@ts-drp/protocol-v3/snapshot-transfer")}))',
	],
	{ cwd: new URL("../../../packages/protocol-v3/", import.meta.url), encoding: "utf8", timeout: 10000 }
);
const urls = JSON.parse(resolutions) as { canonical: string; protocol: string };
assert.equal(urls.canonical, new URL("../../../packages/canonical/dist/src/index.js", import.meta.url).href);
assert.equal(
	urls.protocol,
	new URL("../../../packages/protocol-v3/dist/src/snapshot-transfer.js", import.meta.url).href
);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bindings = {
	...urls,
	canonicalSha256: digest(readFileSync(fileURLToPath(urls.canonical))),
	protocolSha256: digest(readFileSync(fileURLToPath(urls.protocol))),
};
const NativeDecoder = globalThis.TextDecoder;
const NativeEncoder = globalThis.TextEncoder;
const NativeBytes = globalThis.Uint8Array;
const nativeDecode = NativeDecoder.prototype.decode;
const nativeEncode = NativeEncoder.prototype.encode;
const sentinel: unknown =
	thrownValue === "range-error"
		? new RangeError("controlled local conversion failure")
		: thrownValue === "misleading-type-error"
			? new TypeError("invalid UTF-8 string: controlled processing failure")
			: Object.freeze({
					code: "manifest-invalid",
					message: "invalid UTF-8 string",
					marker: "controlled non-Error processing value",
				});
let phase = "module-import";
let armed = false;
let injections = 0;
const events: ProvenanceEvent[] = [];

/**
 * Record the selected real processing call and optionally throw one sentinel.
 * @param kind - Native call boundary.
 * @param stack - Actual call stack.
 */
function reach(kind: string, stack: string): void {
	if (!["control", "fault", "recovery"].includes(phase)) return;
	const injected = armed;
	if (!events.some((event) => event.phase === phase && event.kind === kind))
		events.push({ phase, kind, stack, injected });
	if (injected) {
		armed = false;
		injections++;
		throw sentinel;
	}
}

// Constructor proxies delegate to native constructors and preserve native
// prototypes/internal slots. Only an instance method is wrapped, before the
// product captures it. Setup and positive controls always delegate normally.
globalThis.TextDecoder = new Proxy(NativeDecoder, {
	construct(target, args, newTarget): TextDecoder {
		const instance = Reflect.construct(target, args, newTarget) as TextDecoder;
		assert.equal(Object.getPrototypeOf(instance), NativeDecoder.prototype);
		Object.defineProperty(instance, "decode", {
			configurable: true,
			writable: true,
			value: function (this: TextDecoder, ...args: Parameters<TextDecoder["decode"]>): string {
				if (boundary.endsWith("text-decode")) {
					const stack = new Error("selected native text decode").stack ?? "";
					if (stack.includes("decodeCanonical")) reach("TextDecoder.decode", stack);
				}
				return Reflect.apply(nativeDecode, this, args) as string;
			},
		});
		return instance;
	},
});
globalThis.TextEncoder = new Proxy(NativeEncoder, {
	construct(target, args, newTarget): TextEncoder {
		const instance = Reflect.construct(target, args, newTarget) as TextEncoder;
		assert.equal(Object.getPrototypeOf(instance), NativeEncoder.prototype);
		Object.defineProperty(instance, "encode", {
			configurable: true,
			writable: true,
			value: function (this: TextEncoder, ...args: Parameters<TextEncoder["encode"]>): Uint8Array {
				if (boundary === "protocol-canonical-reencode") {
					const stack = new Error("selected native re-encode").stack ?? "";
					if (stack.includes("encodeCanonical") && stack.includes("decodeRecord"))
						reach("TextEncoder.encode during decodeRecord", stack);
				}
				return Reflect.apply(nativeEncode, this, args) as Uint8Array;
			},
		});
		return instance;
	},
});
globalThis.Uint8Array = new Proxy(NativeBytes, {
	construct(target, args, newTarget): Uint8Array {
		if (boundary.endsWith("input-copy") && args.length === 1 && args[0] instanceof NativeBytes) {
			const stack = new Error("selected native canonical copy").stack ?? "";
			if (stack.includes("decodeCanonical")) reach("Uint8Array canonical input copy", stack);
		}
		if (boundary === "protocol-owned-allocation" && args.length === 1 && typeof args[0] === "number") {
			const stack = new Error("selected native protocol allocation").stack ?? "";
			if (stack.includes("copyExactCarrier")) reach("Uint8Array copyExactCarrier allocation", stack);
		}
		return Reflect.construct(target, args, newTarget) as Uint8Array;
	},
});

let report: ProvenanceResult;
try {
	const canonical = (await import(urls.canonical)) as typeof CanonicalModule;
	const protocol = (await import(urls.protocol)) as typeof ProtocolModule;
	phase = "setup";
	assert.equal(globalThis.Uint8Array.prototype, NativeBytes.prototype);
	assert.equal(Object.getPrototypeOf(new globalThis.Uint8Array(1)), NativeBytes.prototype);
	assert.equal(globalThis.TextDecoder.prototype, NativeDecoder.prototype);
	assert.equal(globalThis.TextEncoder.prototype, NativeEncoder.prototype);
	const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
	const encoded = protocol.encodeSnapshotTransfer({
		objectId: "local-codec-provenance",
		epoch: 1,
		schemaVersion: 1,
		anchor: "a".repeat(64),
		stateDigest: "b".repeat(64),
		aclDigest: "c".repeat(64),
		exactCanonicalPayloadBytes: canonical.encodeCanonical({ ready: true }),
		profile,
	});
	const canonicalInput = canonical.encodeCanonical("local-codec-ready 😀");
	const manifestInput = {
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		expectedManifestDigest: encoded.manifestDigest,
		profile,
	};
	const before = [digest(canonicalInput), digest(encoded.exactCanonicalManifestBytes)];
	const action = (): unknown =>
		boundary.startsWith("canonical-")
			? canonical.decodeCanonical(canonicalInput)
			: protocol.decodeSnapshotManifest(manifestInput);
	phase = "control";
	const valid = action();
	if (boundary.startsWith("canonical-")) assert.equal(valid, "local-codec-ready 😀");
	else
		assert.deepEqual(
			(valid as ProtocolModule.DecodedSnapshotManifest).exactCanonicalManifestBytes,
			encoded.exactCanonicalManifestBytes
		);
	assert.ok(
		events.some((event) => event.phase === "control"),
		"no-fault intended method was actually reached"
	);
	phase = "deterministic-control";
	const invalid = NativeBytes.of(5, 1, 255);
	assert.throws(
		() => canonical.decodeCanonical(invalid),
		(error: unknown) => {
			assert.ok(error instanceof canonical.CanonicalDecodingError);
			assert.equal(Object.getPrototypeOf(error), canonical.CanonicalDecodingError.prototype);
			assert.equal(error.code, "CANONICAL_DECODING");
			assert.equal(error.message, "invalid UTF-8 string");
			return true;
		}
	);
	const invalidDigest = Array.from(canonical.hashDomain("ts-drp/snapshot-manifest/v3", invalid), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	assert.throws(
		() =>
			protocol.decodeSnapshotManifest({
				exactCanonicalManifestBytes: invalid,
				expectedManifestDigest: invalidDigest,
				profile,
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(Reflect.get(error, "code"), "manifest-noncanonical");
			assert.ok(
				error.cause instanceof canonical.CanonicalDecodingError,
				"protocol invoked this exact canonical module"
			);
			assert.equal(Object.getPrototypeOf(error.cause), canonical.CanonicalDecodingError.prototype);
			return true;
		}
	);
	phase = "fault";
	armed = true;
	let threw = false;
	let failure: unknown;
	try {
		action();
	} catch (error) {
		threw = true;
		failure = error;
	} finally {
		armed = false;
	}
	assert.equal(injections, 1, "one selected processing call threw the sentinel");
	assert.ok(
		events.some((event) => event.phase === "fault" && event.injected),
		"selected runtime binding reached"
	);
	phase = "recovery";
	assert.deepEqual(action(), valid, "unarmed retry still accepts the same input");
	assert.deepEqual(
		[digest(canonicalInput), digest(encoded.exactCanonicalManifestBytes)],
		before,
		"input bytes unchanged"
	);
	assert.equal(digest(readFileSync(fileURLToPath(urls.canonical))), bindings.canonicalSha256);
	assert.equal(digest(readFileSync(fileURLToPath(urls.protocol))), bindings.protocolSha256);
	const chain: ProvenanceResult["observed"]["chain"] = [];
	let current: unknown = failure;
	for (let index = 0; index < 8 && current !== undefined; index++) {
		const object =
			current !== null && (typeof current === "object" || typeof current === "function") ? current : undefined;
		const field = (name: string): string | null =>
			object !== undefined && typeof Reflect.get(object, name) === "string"
				? (Reflect.get(object, name) as string)
				: null;
		chain.push({
			name: field("name"),
			code: field("code"),
			message: field("message"),
			isSentinel: current === sentinel,
		});
		current = object === undefined ? undefined : Reflect.get(object, "cause");
	}
	report = {
		boundary,
		thrownValue,
		bindings,
		controls: {
			importSucceeded: true,
			unarmedValid: true,
			recoveryValid: true,
			inputUnchanged: true,
			sameModuleDomainError: true,
			nativePrototypesPreserved: true,
		},
		events,
		injections,
		observed: {
			threw,
			isExactSentinel: failure === sentinel,
			code: chain[0]?.code ?? null,
			causeIncludesSentinel: chain.some((item) => item.isSentinel),
			chain,
		},
	};
} finally {
	armed = false;
	globalThis.TextDecoder = NativeDecoder;
	globalThis.TextEncoder = NativeEncoder;
	globalThis.Uint8Array = NativeBytes;
}
console.log(JSON.stringify(report));
