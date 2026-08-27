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
	readonly observedByteLength: number;
	readonly source: string;
}

function exactRead(value: unknown, index: number): value is SnapshotReadObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	return (
		Reflect.ownKeys(record).length === 5 &&
		record.byteLength === record.observedByteLength &&
		typeof record.byteLength === "number" &&
		Number.isSafeInteger(record.byteLength) &&
		record.byteLength > 0 &&
		typeof record.digest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.digest) &&
		record.index === index &&
		record.source === "verification-quarantine-port"
	);
}

/**
 * Validates direct successful port-read evidence without consulting child source.
 * @param value - Candidate fresh-process telemetry.
 * @returns Whether each declared read settled before completion and activation.
 */
export function isD108e1DirectSnapshotTelemetry(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		Reflect.ownKeys(record).length !== 5 ||
		record.completeAfterReads !== true ||
		record.completeBeforeSubscribe !== true ||
		typeof record.declaredChunkCount !== "number" ||
		!Number.isSafeInteger(record.declaredChunkCount) ||
		record.declaredChunkCount <= 0 ||
		!Array.isArray(record.reads) ||
		record.reads.length !== record.declaredChunkCount ||
		record.telemetrySource !== "awaited-port-read"
	) {
		return false;
	}
	return record.reads.every((read, index) => exactRead(read, index));
}
