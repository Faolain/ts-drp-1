import { describe, expect, it, vi } from "vitest";
import { CanonicalDecodingError, decodeCanonical, encodeCanonical } from "../src/index.ts";

describe("bounded streaming UTF-8 lifetime", () => {
	const split = "a".repeat(4095) + "💠" + "b".repeat(4100);
	it("resets multibyte streaming and BOM handling across successful decodes", () => {
		for (let index = 0; index < 3; index++) {
			expect(decodeCanonical(encodeCanonical(split))).toBe(split);
			// Preserve the frozen decoder's native default: strip one initial BOM.
			expect(decodeCanonical(encodeCanonical("\uFEFFok"))).toBe("ok");
			expect(decodeCanonical(encodeCanonical("plain"))).toBe("plain");
			expect(decodeCanonical(encodeCanonical(""))).toBe("");
		}
	});
	it("discards partial state after invalid UTF-8 and preserves resource refusal", () => {
		const malformed = new Uint8Array(4100);
		malformed.set([0x05, 0x81, 0x20]); // String payload4097 bytes.
		malformed.fill(0x61, 3, 4098);
		malformed[4098] = 0xc3;
		malformed[4099] = 0x28;
		expect(() => decodeCanonical(malformed)).toThrow(CanonicalDecodingError);
		expect(decodeCanonical(encodeCanonical(split))).toBe(split);
		expect(() => decodeCanonical(encodeCanonical(split), { maxBytes: 4096 })).toThrow(CanonicalDecodingError);
		expect(decodeCanonical(encodeCanonical("after refusal"))).toBe("after refusal");
	});
	it("does not share an entered converter with a reentrant decode", () => {
		const native = TextDecoder.prototype.decode;
		let entered = false;
		const hook = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
			this: TextDecoder,
			input,
			options
		) {
			if (!entered && options?.stream && input instanceof Uint8Array && input[0] === 0x9f) {
				entered = true;
				expect(decodeCanonical(encodeCanonical("nested"))).toBe("nested");
			}
			return Reflect.apply(native, this, [input, options]);
		});
		try {
			expect(decodeCanonical(encodeCanonical(split))).toBe(split);
			expect(entered).toBe(true);
			expect(decodeCanonical(encodeCanonical(split))).toBe(split);
		} finally {
			hook.mockRestore();
		}
	});
});
