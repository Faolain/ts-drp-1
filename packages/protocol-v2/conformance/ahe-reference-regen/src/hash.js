/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */

import { createHash } from "node:crypto";

import { joinBytes } from "./bytes.js";

const utf8 = new TextEncoder();
const prefix = Uint8Array.of(0x44, 0x52, 0x50, 0x00);

function sizedInteger(value, width) {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid frame length");
	const result = new Uint8Array(width);
	const view = new DataView(result.buffer);
	if (width === 4) {
		if (value > 0xffff_ffff) throw new RangeError("frame length exceeds u32");
		view.setUint32(0, value, false);
	} else {
		view.setBigUint64(0, BigInt(value), false);
	}
	return result;
}

export function hashDomain(domain, ...parts) {
	if (typeof domain !== "string") throw new TypeError("domain must be a string");
	const domainBytes = utf8.encode(domain);
	const frames = [prefix, sizedInteger(domainBytes.byteLength, 4), domainBytes];
	for (const part of parts) {
		if (!(part instanceof Uint8Array)) throw new TypeError("hash part must be bytes");
		frames.push(sizedInteger(part.byteLength, 8), part);
	}
	return new Uint8Array(createHash("sha256").update(joinBytes(frames)).digest());
}
