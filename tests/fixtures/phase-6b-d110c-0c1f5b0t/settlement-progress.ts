/* eslint-disable jsdoc/require-jsdoc -- Bounded RED fixture builders are named at their call sites. */
import { encodeCanonical } from "@ts-drp/canonical";

export const PROGRESS_SCOPE = Object.freeze({
	author: "author:settlement-progress-red",
	objectId: "room:settlement-progress-red",
});

export const PROGRESS_DIGEST = new Uint8Array(32).fill(0xa5);

export function legacyEntry(sourceSequence = 7): Readonly<Record<string, unknown>> {
	return Object.freeze({
		disposition: "rebase",
		replacementSequence: null,
		sourceDigest: new Uint8Array(32).fill(0xd1),
		sourceSequence,
	});
}

export function progress(
	intentCount = 3,
	chunks: readonly Readonly<Record<string, unknown>>[] = []
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		chunks: Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk }))),
		intentCount,
		intentDigest: new Uint8Array(PROGRESS_DIGEST),
		version: 1,
	});
}

export function progressEntry(
	replacementProgress: unknown = progress(),
	replacementSequence: number | null = null,
	sourceSequence = 7,
	disposition: "expire" | "manual-review" | "rebase" | "transform" = "rebase"
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		disposition,
		replacementProgress,
		replacementSequence,
		sourceDigest: new Uint8Array(32).fill(0xd1),
		sourceSequence,
	});
}

export function plan(
	entry: Readonly<Record<string, unknown>> = progressEntry(),
	revision = 0
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		entries: Object.freeze([entry]),
		fenceSequence: 4,
		revision,
		scope: PROGRESS_SCOPE,
	});
}

export function progressEffect(
	fromIntent: number,
	throughIntent: number,
	overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		fromIntent,
		intentDigest: new Uint8Array(PROGRESS_DIGEST),
		kind: "replacement",
		sourceSequence: 7,
		throughIntent,
		...overrides,
	});
}

export function legacyEffect(sourceSequence = 7): Readonly<Record<string, unknown>> {
	return Object.freeze({ kind: "replacement", sourceSequence });
}

export function commit(
	authorSequence: number,
	planEffect: Readonly<Record<string, unknown>>,
	logicalTime: number,
	operationCount: number
): Readonly<Record<string, unknown>> {
	const operation =
		operationCount === 1
			? Object.freeze({ action: "add", value: 1 })
			: Object.freeze({
					action: "$drp.application-batch.v1",
					entries: Object.freeze(
						Array.from({ length: operationCount }, (_, index) =>
							Object.freeze({
								logicalTime: logicalTime - operationCount + index + 1,
								operation: { action: "add", value: index },
							})
						)
					),
					version: 1,
				});
	const canonicalPreimageBytes = encodeCanonical({
		author: PROGRESS_SCOPE.author,
		authorSequence,
		epoch: 0,
		kind: "drp-vertex",
		logicalTime,
		objectId: PROGRESS_SCOPE.objectId,
		operation,
		protocolMajor: 3,
	});
	const envelope = Object.freeze({
		canonicalPreimageBytes,
		digest: new Uint8Array(32).fill(authorSequence + 1),
		signature: new Uint8Array(64).fill(authorSequence + 1),
	});
	return Object.freeze({
		authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence, envelope, scope: PROGRESS_SCOPE }),
		outboxEntry: Object.freeze({ authorSequence, envelope, scope: PROGRESS_SCOPE }),
		planEffect,
	});
}

export function snapshot(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(snapshot);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]));
}

export async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

export function code(error: unknown): unknown {
	return error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}
