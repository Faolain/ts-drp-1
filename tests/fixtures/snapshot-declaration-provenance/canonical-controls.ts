export interface StringCase {
	id: string;
	bytes: Uint8Array;
}

/**
 * Frame a STRING payload without using the product encoder.
 * @param bytes - Raw UTF-8 payload.
 * @param length - Declared payload length, optionally deliberately truncated.
 * @returns Canonical STRING wire bytes.
 */
export function stringWire(bytes: Uint8Array, length = bytes.length): Uint8Array {
	const prefix = [5];
	do {
		const byte = length % 128;
		length = Math.floor(length / 128);
		prefix.push(byte | (length > 0 ? 128 : 0));
	} while (length > 0);
	return Uint8Array.from([...prefix, ...bytes]);
}

/**
 * Ordinary raw-byte inputs, independent of the product parser/encoder.
 * @returns Named UTF-8 acceptance and text cases.
 */
export function stringCases(): StringCase[] {
	const raw: [string, number[]][] = [
		["empty", []],
		["nul-ascii-del", [0, 65, 127]],
		["two-byte-min", [0xc2, 0x80]],
		["two-byte-max", [0xdf, 0xbf]],
		["three-byte-min", [0xe0, 0xa0, 0x80]],
		["before-surrogates", [0xed, 0x9f, 0xbf]],
		["after-surrogates", [0xee, 0x80, 0x80]],
		["legitimate-replacement", [0xef, 0xbf, 0xbd]],
		["four-byte-min", [0xf0, 0x90, 0x80, 0x80]],
		["unicode-max", [0xf4, 0x8f, 0xbf, 0xbf]],
		["leading-bom-only", [0xef, 0xbb, 0xbf]],
		["leading-bom", [0xef, 0xbb, 0xbf, 65]],
		["interior-bom", [65, 0xef, 0xbb, 0xbf, 66]],
		["repeated-bom", [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 65]],
		["stray-continuation", [0x80]],
		["invalid-lead", [0xff]],
		["overlong-two", [0xc0, 0xaf]],
		["overlong-three", [0xe0, 0x80, 0xaf]],
		["overlong-four", [0xf0, 0x80, 0x80, 0xaf]],
		["high-surrogate", [0xed, 0xa0, 0x80]],
		["low-surrogate", [0xed, 0xbf, 0xbf]],
		["above-unicode", [0xf4, 0x90, 0x80, 0x80]],
		["invalid-five-byte", [0xf8, 0x88, 0x80, 0x80, 0x80]],
		["truncated-two", [0xc2]],
		["truncated-three", [0xe2, 0x82]],
		["truncated-four", [0xf0, 0x9f, 0x98]],
		["ascii-in-sequence", [0xe2, 65, 0xac]],
		["valid-replacement-then-invalid", [0xef, 0xbf, 0xbd, 0xff]],
	];
	const result = raw.map(([id, bytes]) => ({ id, bytes: Uint8Array.from(bytes) }));
	for (const offset of [4093, 4094, 4095, 4096, 8191]) {
		for (const [name, tail] of raw) {
			result.push({
				id: `offset-${offset}:${name}`,
				bytes: Uint8Array.from([...Array<number>(offset).fill(65), ...tail]),
			});
		}
	}
	return result;
}

export const STRING_READER_FAILURES = [
	{ id: "missing-length", bytes: [5], message: "truncated canonical value" },
	{ id: "unfinished-length", bytes: [5, 128], message: "truncated canonical value" },
	{ id: "nonminimal-length", bytes: [5, 128, 0], message: "non-minimal varuint" },
	{ id: "too-wide-length", bytes: [5, ...Array<number>(9).fill(128), 1], message: "varuint exceeds safe range" },
	{ id: "missing-payload", bytes: [5, 1], message: "invalid UTF-8 string" },
	{ id: "short-ascii-payload", bytes: [5, 2, 65], message: "invalid UTF-8 string" },
	{ id: "short-multibyte-payload", bytes: [5, 3, 0xc2, 0x80], message: "invalid UTF-8 string" },
	{ id: "malformed-payload", bytes: [5, 1, 0xff], message: "invalid UTF-8 string" },
] as const;
