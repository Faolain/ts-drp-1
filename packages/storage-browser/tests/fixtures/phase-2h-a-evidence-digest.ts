import { createHash } from "node:crypto";

function stableEvidenceValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { bytes: [...value] };
	if (Array.isArray(value)) return value.map((entry) => stableEvidenceValue(entry));
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, stableEvidenceValue(record[key])])
		);
	}
	return value;
}

/**
 * Serializes evidence with recursive key ordering and byte-array custody.
 * @param value - Evidence image or source-owned case value.
 * @returns Stable UTF-8 JSON preimage text.
 */
export function phase2hStableEvidenceJson(value: unknown): string {
	const encoded = JSON.stringify(stableEvidenceValue(value));
	if (encoded === undefined) throw new TypeError("Phase 2h evidence cannot be represented as stable JSON");
	return encoded;
}

/**
 * Computes the one test-evidence image checksum used by every scenario.
 * @param value - Evidence image.
 * @returns Lowercase SHA-256 over the stable UTF-8 JSON preimage.
 */
export function phase2hEvidenceImageDigest(value: unknown): string {
	return createHash("sha256").update(phase2hStableEvidenceJson(value), "utf8").digest("hex");
}
