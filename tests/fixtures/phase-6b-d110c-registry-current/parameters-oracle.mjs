/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Independent, deliberately bounded grammar. No project codec, registry or hash imports.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function varuint(value) {
	assert.ok(typeof value === "bigint" && value >= 0n);
	const bytes = [];
	do {
		const low = Number(value & 127n);
		value >>= 7n;
		bytes.push(low | (value === 0n ? 0 : 128));
	} while (value !== 0n);
	return Buffer.from(bytes);
}

function keyBytes(key) {
	assert.equal(typeof key, "string", "oracle corpus is ASCII-keyed");
	for (let index = 0; index < key.length; index++) {
		assert.ok(key.charCodeAt(index) <= 0x7f, "oracle corpus is ASCII-keyed");
	}
	const bytes = Buffer.from(key, "ascii");
	return Buffer.concat([Buffer.from([5]), varuint(BigInt(bytes.length)), bytes]);
}

export function parameterBytes(value) {
	assert.equal(Object.getPrototypeOf(value), Object.prototype, "plain object corpus only");
	const entries = Object.entries(value).map(([key, number]) => {
		assert.ok(Number.isSafeInteger(number) && number >= 0, "nonnegative safe integers only");
		return {
			key: keyBytes(key),
			value: Buffer.concat([Buffer.from([3]), varuint(BigInt(number) * 2n)]),
		};
	});
	entries.sort((left, right) => Buffer.compare(left.key, right.key));
	return Buffer.concat([
		Buffer.from([8]),
		varuint(BigInt(entries.length)),
		...entries.flatMap((entry) => [entry.key, entry.value]),
	]);
}

export function parameterFrame(bytes, domain = "ts-drp/parameters/v3") {
	assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array);
	assert.equal(typeof domain, "string");
	const domainBytes = Buffer.from(domain, "utf8");
	const domainLength = Buffer.alloc(4);
	const partLength = Buffer.alloc(8);
	domainLength.writeUInt32BE(domainBytes.length);
	partLength.writeBigUInt64BE(BigInt(bytes.length));
	return Buffer.concat([Buffer.from([68, 82, 80, 0]), domainLength, domainBytes, partLength, bytes]);
}

export function parameterDigest(value, domain = "ts-drp/parameters/v3") {
	return createHash("sha256")
		.update(parameterFrame(parameterBytes(value), domain))
		.digest("hex");
}
