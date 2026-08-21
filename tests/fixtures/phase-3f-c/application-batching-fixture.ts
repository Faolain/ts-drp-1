import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

export const APPLICATION_BATCH_LIMITS = Object.freeze({
	maxBytes: 65_536,
	maxDepth: 8,
	maxItems: 1_024,
});

export interface ApplicationBatchEntry {
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
}

export interface AcceptedOperationFact {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

function detachedOperation(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(encodeCanonical(operation), APPLICATION_BATCH_LIMITS);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("application batching fixture operation is not canonical");
	}
	return Object.freeze({ ...(decoded as Readonly<Record<string, unknown>>) });
}

/**
 * Builds one immutable captured room request without implementing production validation.
 * @param logicalTime Captured room logical time.
 * @param operation Detached application operation.
 * @returns One immutable batch entry.
 */
export function batchEntry(logicalTime: number, operation: Readonly<Record<string, unknown>>): ApplicationBatchEntry {
	return Object.freeze({ logicalTime, operation: detachedOperation(operation) });
}

/**
 * Returns maximal-count rows for the selected prepared runtime.
 * @param product Shipped application profile.
 * @param count Requested entry count.
 * @returns Immutable application entries.
 */
export function maximalEntries(product: "chat" | "counter" | "zone", count = 16): readonly ApplicationBatchEntry[] {
	return Object.freeze(
		Array.from({ length: count }, (_, index) =>
			batchEntry(
				index + 1,
				product === "chat"
					? Object.freeze({ action: "message", text: `${index}:`.padEnd(256, "m") })
					: product === "zone"
						? Object.freeze({ action: "placeBlock", id: `block-${index}`, kind: "stone", x: index, y: -index })
						: Object.freeze({ action: "add", value: index + 1 })
			)
		)
	);
}

/**
 * Returns fixed fixture data whose genuine node envelope is exactly at, or one byte over, the frozen limit.
 * The test never reconstructs or measures the reserved envelope itself.
 * @param overByOne Whether the genuine node envelope must exceed the byte ceiling by one.
 * @returns Two immutable application entries.
 */
export function byteBoundaryEntries(overByOne: boolean): readonly ApplicationBatchEntry[] {
	return Object.freeze([
		batchEntry(1, Object.freeze({ action: "payload", text: "a".repeat(overByOne ? 65_365 : 65_364) })),
		batchEntry(2, Object.freeze({ action: "payload", text: "b" })),
	]);
}

/**
 * Returns genuine outer-envelope inputs at exactly 1,024 or 1,025 canonical items.
 * @param overByOne Whether the genuine envelope must exceed the item ceiling by one.
 * @returns Two immutable counter operations.
 */
export function itemBoundaryEntries(overByOne: boolean): readonly ApplicationBatchEntry[] {
	return Object.freeze([
		batchEntry(
			1,
			Object.freeze({
				action: "payload",
				data: Object.freeze({
					pad: new Uint32Array(overByOne ? 2 : 1),
					values: Object.freeze(Array.from({ length: 481 }, () => 0)),
				}),
			})
		),
		batchEntry(2, Object.freeze({ action: "payload", text: "b" })),
	]);
}

/**
 * Builds one accepted-operation observation without forging a vertex.
 * @param input Genuine outer-vertex and child-operation facts.
 * @param operationIndex Zero-based child index.
 * @param operationCount Number of children in the genuine vertex.
 * @returns Immutable accepted-operation fact.
 */
export function acceptedOperation(
	input: Omit<AcceptedOperationFact, "operationCount" | "operationIndex">,
	operationIndex: number,
	operationCount: number
): AcceptedOperationFact {
	return Object.freeze({ ...input, operationCount, operationIndex });
}
