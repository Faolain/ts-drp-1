import { createHash } from "node:crypto";

export const D108E1_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-infrastructure-contract.ts",
	"tests/phase-6a-creator-successor-infrastructure-red.test.ts",
	"tests/phase-6a-creator-successor-activation-red.test.ts",
	"packages/storage-node/tests/phase-6a-creator-successor-activation-death-red.test.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
	"tests/phase-6a-creator-successor-product-red.test.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
] as const);

export const D108E1_GREEN_PATHS = Object.freeze([
	"tests/fixtures/shared/workspace-package-subprocess.mjs",
	"tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-activation-child.mjs",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation-global-setup.ts",
	"packages/storage-browser/playwright.phase-6a-creator-successor-activation.config.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
] as const);

interface SnapshotReadObservation {
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
	readonly observedBodySha256: string;
	readonly observedByteLength: number;
	readonly readInvocationOrdinal: number;
	readonly source: string;
}

export interface D108e1ExpectedSnapshotRead {
	readonly bodySha256: string;
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
}

function exactRead(
	value: unknown,
	index: number,
	expected: D108e1ExpectedSnapshotRead
): value is SnapshotReadObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	return (
		Reflect.ownKeys(record).length === 7 &&
		record.byteLength === record.observedByteLength &&
		record.byteLength === expected.byteLength &&
		record.digest === expected.digest &&
		record.index === index &&
		record.index === expected.index &&
		record.observedBodySha256 === expected.bodySha256 &&
		record.readInvocationOrdinal === index + 1 &&
		record.source === "verification-quarantine-port"
	);
}

/**
 * Derives the parent-held declaration and body oracle for one packed child carrier.
 * @param material - Packed durable material sent to the fresh child.
 * @returns Exact declared metadata plus the SHA-256 of every transferred body.
 */
export function d108e1ExpectedSnapshotReads(material: unknown): readonly D108e1ExpectedSnapshotRead[] {
	if (material === null || typeof material !== "object" || Array.isArray(material)) {
		throw new TypeError("D.108e1 packed material is invalid");
	}
	const snapshot = (material as Readonly<Record<string, unknown>>).snapshot;
	if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		throw new TypeError("D.108e1 packed snapshot is invalid");
	}
	const snapshotRecord = snapshot as Readonly<Record<string, unknown>>;
	const declaration = snapshotRecord.declaration;
	if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
		throw new TypeError("D.108e1 packed declaration is invalid");
	}
	const descriptors = (declaration as Readonly<Record<string, unknown>>).chunks;
	const bodies = snapshotRecord.chunks;
	if (!Array.isArray(descriptors) || !Array.isArray(bodies) || descriptors.length !== bodies.length) {
		throw new TypeError("D.108e1 packed snapshot chunks are invalid");
	}
	return Object.freeze(
		descriptors.map((descriptor, index) => {
			if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
				throw new TypeError(`D.108e1 descriptor ${index} is invalid`);
			}
			const record = descriptor as Readonly<Record<string, unknown>>;
			const body = bodies[index];
			if (
				body === null ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				typeof (body as Readonly<Record<string, unknown>>).bytesBase64 !== "string"
			) {
				throw new TypeError(`D.108e1 body ${index} is invalid`);
			}
			const bytes = Buffer.from((body as Readonly<Record<string, string>>).bytesBase64, "base64");
			if (
				record.index !== index ||
				typeof record.digest !== "string" ||
				!/^[0-9a-f]{64}$/u.test(record.digest) ||
				typeof record.byteLength !== "number" ||
				!Number.isSafeInteger(record.byteLength) ||
				record.byteLength !== bytes.byteLength
			) {
				throw new TypeError(`D.108e1 descriptor ${index} does not match its body`);
			}
			return Object.freeze({
				bodySha256: createHash("sha256").update(bytes).digest("hex"),
				byteLength: record.byteLength,
				digest: record.digest,
				index,
			});
		})
	);
}

/**
 * Validates direct successful port-read evidence without consulting child source.
 * @param value - Candidate fresh-process telemetry.
 * @param expectedReads - Parent-derived declaration and transferred-body oracle.
 * @returns Whether each declared read settled before completion and activation.
 */
export function isD108e1DirectSnapshotTelemetry(
	value: unknown,
	expectedReads: readonly D108e1ExpectedSnapshotRead[]
): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		Reflect.ownKeys(record).length !== 6 ||
		record.completeAfterReads !== true ||
		record.completeBeforeSubscribe !== true ||
		typeof record.declaredChunkCount !== "number" ||
		!Number.isSafeInteger(record.declaredChunkCount) ||
		record.declaredChunkCount <= 0 ||
		!Array.isArray(record.reads) ||
		record.reads.length !== record.declaredChunkCount ||
		record.reads.length !== expectedReads.length ||
		record.directReadInvocationCount !== record.reads.length ||
		record.telemetrySource !== "awaited-port-read"
	) {
		return false;
	}
	return record.reads.every((read, index) => exactRead(read, index, expectedReads[index]));
}
