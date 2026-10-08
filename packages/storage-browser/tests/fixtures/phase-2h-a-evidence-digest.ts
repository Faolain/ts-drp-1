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

const MAX_EVIDENCE_DEPTH = 512;
const MAX_EVIDENCE_NODES = 100_000;

function boundedAcyclicEvidence(value: unknown): boolean {
	const active = new WeakSet<object>();
	let nodes = 0;
	const stack: Array<Readonly<{ depth: number; entering: boolean; value: unknown }>> = [
		{ depth: 0, entering: true, value },
	];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (frame === undefined) return false;
		if (typeof frame.value !== "object" || frame.value === null) continue;
		if (!frame.entering) {
			active.delete(frame.value);
			continue;
		}
		if (frame.depth > MAX_EVIDENCE_DEPTH || ++nodes > MAX_EVIDENCE_NODES || active.has(frame.value)) return false;
		active.add(frame.value);
		stack.push({ depth: frame.depth, entering: false, value: frame.value });
		const children =
			frame.value instanceof Uint8Array ? [] : Array.isArray(frame.value) ? frame.value : Object.values(frame.value);
		for (let index = children.length - 1; index >= 0; index--)
			stack.push({ depth: frame.depth + 1, entering: true, value: children[index] });
	}
	return true;
}

/**
 * Serializes untrusted evidence only when traversal is bounded and acyclic.
 * @param value - Candidate evidence graph.
 * @returns Stable JSON, or null for a hostile graph.
 */
export function phase2hBoundedStableEvidenceJson(value: unknown): string | null {
	try {
		if (!boundedAcyclicEvidence(value)) return null;
		return phase2hStableEvidenceJson(value);
	} catch {
		return null;
	}
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
