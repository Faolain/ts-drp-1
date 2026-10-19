import { type CanonicalLimits, decodeCanonical } from "@ts-drp/canonical";
import { decodeCanonicalExactness } from "@ts-drp/canonical/exact";

const VIEW_OVERRIDES = ["buffer", "byteLength", "byteOffset", "length"] as const;

/**
 * Decodes exactly like `decodeCanonical` (same value, errors and limits) and
 * reports whether that one decode already proves the default-limit re-encode
 * reproduces the input. `exact: false` means unknown: callers keep their
 * original re-encode comparison. Views whose length or backing could be
 * intercepted always report `false`, so their comparison also still runs.
 * @param bytes - Candidate canonical bytes.
 * @param limits - Optional decode limit overrides, as passed to `decodeCanonical`.
 * @returns The decoded value and whether the comparison may be skipped.
 */
export function decodeCanonicalWithExactness(
	bytes: Uint8Array,
	limits?: Partial<CanonicalLimits>
): Readonly<{ value: unknown; exact: boolean }> {
	if (
		bytes instanceof Uint8Array &&
		Object.getPrototypeOf(bytes) === Uint8Array.prototype &&
		!VIEW_OVERRIDES.some((name) => Object.hasOwn(bytes, name)) &&
		bytes.buffer instanceof ArrayBuffer
	)
		return decodeCanonicalExactness(bytes, limits);
	return { value: decodeCanonical(bytes, limits), exact: false };
}
