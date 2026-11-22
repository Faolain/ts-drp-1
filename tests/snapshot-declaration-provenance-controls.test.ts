import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
	STRING_READER_FAILURES,
	stringCases,
	stringWire,
} from "./fixtures/snapshot-declaration-provenance/canonical-controls.js";
import type * as CanonicalModule from "../packages/canonical/dist/src/index.js";

type Canonical = typeof CanonicalModule;
const anchor = new URL("../packages/protocol-v3/", import.meta.url);
const resolved = execFileSync(
	process.execPath,
	["--input-type=module", "--eval", 'process.stdout.write(import.meta.resolve("@ts-drp/canonical"))'],
	{
		cwd: anchor,
		encoding: "utf8",
		timeout: 10000,
	}
).trim();
const expected = new URL("../packages/canonical/dist/src/index.js", import.meta.url).href;
assert.equal(resolved, expected, "unmodified package export from the actual protocol dependency graph");
const canonical = (await import(resolved)) as Canonical;
console.log(
	JSON.stringify({
		binding: resolved,
		sha256: createHash("sha256")
			.update(readFileSync(fileURLToPath(resolved)))
			.digest("hex"),
		classBinding: "CanonicalDecodingError from the same imported namespace as decodeCanonical",
		oracle: "unmodified native fatal TextDecoder; default BOM behavior",
	})
);

/**
 * Assert the actual invoked codec owns a deterministic error.
 * @param bytes - Canonical wire bytes.
 * @param message - Exact historical message.
 */
function rejects(bytes: Uint8Array, message: string): void {
	assert.throws(
		() => canonical.decodeCanonical(bytes),
		(error: unknown) => {
			assert.ok(error instanceof canonical.CanonicalDecodingError);
			assert.equal(Object.getPrototypeOf(error), canonical.CanonicalDecodingError.prototype);
			assert.equal(error.code, "CANONICAL_DECODING");
			assert.equal(error.message, message);
			return true;
		}
	);
}

/**
 * Compare actual product decoding with a separate native fatal call.
 * @param bytes - Raw STRING payload.
 * @returns Whether native UTF-8 validation accepted it.
 */
function compare(bytes: Uint8Array): boolean {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		assert.ok(error instanceof TypeError, "ordinary native malformed UTF-8 rejection");
		rejects(stringWire(bytes), "invalid UTF-8 string");
		return false;
	}
	assert.equal(canonical.decodeCanonical(stringWire(bytes)), text);
	return true;
}

for (const item of stringCases()) {
	test(`canonical UTF-8 compatibility: ${item.id}`, () => {
		compare(item.bytes);
	});
}
for (const item of STRING_READER_FAILURES) {
	test(`canonical STRING boundary message: ${item.id}`, () => {
		rejects(Uint8Array.from(item.bytes), item.message);
	});
}
test("all 256 one-byte and 65536 two-byte payloads execute independently of historical vector guards", () => {
	let accepted = 0;
	let rejected = 0;
	for (let first = 0; first < 256; first++) {
		if (compare(Uint8Array.of(first))) accepted++;
		else rejected++;
		for (let second = 0; second < 256; second++) {
			if (compare(Uint8Array.of(first, second))) accepted++;
			else rejected++;
		}
	}
	assert.equal(accepted + rejected, 65792);
	assert.ok(accepted > 0 && rejected > 0);
	console.log(JSON.stringify({ exhaustivePayloads: 65792, accepted, rejected }));
});
test("leading BOM is stripped once, not an interior BOM or a valid replacement character", () => {
	assert.equal(canonical.decodeCanonical(stringWire(Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 65))), "\ufeffA");
	assert.equal(canonical.decodeCanonical(stringWire(Uint8Array.of(65, 0xef, 0xbb, 0xbf))), "A\ufeff");
	assert.equal(canonical.decodeCanonical(stringWire(Uint8Array.of(0xef, 0xbf, 0xbd))), "\ufffd");
});
test("ordinary encoding rejects lone surrogates with its same-module domain class", () => {
	for (const value of ["\ud800", "\udfff", "A\ud800B"]) {
		assert.throws(
			() => canonical.encodeCanonical(value),
			(error: unknown) => {
				assert.ok(error instanceof canonical.CanonicalEncodingError);
				assert.equal(Object.getPrototypeOf(error), canonical.CanonicalEncodingError.prototype);
				assert.equal(error.code, "CANONICAL_ENCODING");
				assert.equal(error.message, "string contains an unpaired surrogate");
				return true;
			}
		);
	}
});
test("malformed STRING rejection does not contaminate a subsequent ordinary decode", () => {
	for (let index = 0; index < 8; index++) {
		rejects(stringWire(Uint8Array.of(0xf0, 0x9f)), "invalid UTF-8 string");
		assert.equal(canonical.decodeCanonical(canonical.encodeCanonical("ready 😀 �")), "ready 😀 �");
	}
});
