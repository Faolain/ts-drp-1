import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

// This is the existing seal record ceiling, not a new native resource policy.
const SEAL_RECORD_MAX_BYTES = 65_536;
const digestHex = /^[0-9a-f]{64}$/u;
const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const safeInteger = (value: unknown, minimum = 0): value is number =>
 typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const plainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
 value !== null && typeof value === "object" && !Array.isArray(value) &&
 [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value: object, keys: readonly string[]): boolean =>
 Reflect.ownKeys(value).length === keys.length &&
 Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key));
function copyBytes(value: unknown, _expectedLength: undefined, maximumLength: number): Uint8Array | undefined {
 // Inputs here have already passed canonical capture; these are decoded private carriers.
 return value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= maximumLength
  ? Uint8Array.from(value) : undefined;
}
function decodeCanonicalValue(bytes: Uint8Array): unknown {
 const value = decodeCanonical(bytes, { maxBytes: SEAL_RECORD_MAX_BYTES, maxDepth: 16, maxItems: 16_384 });
 if (compareBytes(encodeCanonical(value, { maxBytes: SEAL_RECORD_MAX_BYTES, maxDepth: 16, maxItems: 16_384 }), bytes) !== 0)
  throw new TypeError("noncanonical archive binding carrier");
 return value;
}

/**
 * Creator-certified source-to-index binding, not a storage capability or an availability claim.
 * The original Node source owner must derive these exact descriptors from authenticated source
 * bytes and independently compute the append before requesting a Cut signature. Recipients
 * authenticate this binding through the original creator Cut/QC and anchor chain; paging still
 * verifies actual segment bytes and Merkle inclusion against the certified target root.
 */
export interface CreatorArchiveAppendBinding {
	readonly kind: "closed-epoch-archive-append";
	readonly version: 1;
	readonly objectId: string;
	readonly sourceEpoch: number;
	readonly sourceAnchorDigest: string;
	readonly sourceCloseSetRoot: string;
	readonly sourceHistoryRoot: string;
	readonly previousHistorySize: number;
	readonly historySize: number;
	readonly previousArchiveIndexRoot: string;
	readonly targetArchiveIndexRoot: string;
	readonly previousIndexSize: number;
	readonly indexSize: number;
	readonly segments: readonly Readonly<{
		exactCanonicalDescriptorBytes: Uint8Array;
		exactCanonicalIndexEntryBytes: Uint8Array;
	}>[];
}

export function captureCreatorArchiveAppendBinding(value: unknown): CreatorArchiveAppendBinding | undefined {
	try {
		const bytes = encodeCanonical(value, { maxBytes: SEAL_RECORD_MAX_BYTES, maxDepth: 16, maxItems: 16_384 });
		const captured = decodeCanonical(bytes, { maxBytes: SEAL_RECORD_MAX_BYTES, maxDepth: 16, maxItems: 16_384 });
		if (!plainRecord(captured) || !exactKeys(captured, ["kind", "version", "objectId", "sourceEpoch",
			"sourceAnchorDigest", "sourceCloseSetRoot", "sourceHistoryRoot", "previousHistorySize", "historySize",
			"previousArchiveIndexRoot", "targetArchiveIndexRoot", "previousIndexSize", "indexSize", "segments"]) ||
			captured.kind !== "closed-epoch-archive-append" || captured.version !== 1 ||
			typeof captured.objectId !== "string" || captured.objectId.length < 1 || captured.objectId.length > 1024 ||
			!safeInteger(captured.sourceEpoch) || !safeInteger(captured.previousHistorySize) ||
			!safeInteger(captured.historySize, 1) || !safeInteger(captured.previousIndexSize) ||
			!safeInteger(captured.indexSize, 1) || !Array.isArray(captured.segments) || captured.segments.length < 1 ||
			captured.indexSize !== captured.previousIndexSize + captured.segments.length) return undefined;
		for (const field of ["sourceAnchorDigest", "sourceCloseSetRoot", "sourceHistoryRoot",
			"previousArchiveIndexRoot", "targetArchiveIndexRoot"])
			if (typeof captured[field] !== "string" || !digestHex.test(captured[field] as string)) return undefined;
		let nextOrdinal = captured.previousHistorySize;
		const identities = new Set<string>();
		for (const segment of captured.segments) {
			if (!plainRecord(segment) || !exactKeys(segment, ["exactCanonicalDescriptorBytes", "exactCanonicalIndexEntryBytes"]))
				return undefined;
			const descriptorBytes = copyBytes(segment.exactCanonicalDescriptorBytes, undefined, SEAL_RECORD_MAX_BYTES);
			const entryBytes = copyBytes(segment.exactCanonicalIndexEntryBytes, undefined, 4096);
			if (descriptorBytes === undefined || entryBytes === undefined) return undefined;
			const descriptor = decodeCanonicalValue(descriptorBytes), entry = decodeCanonicalValue(entryBytes);
			if (!plainRecord(descriptor) || !exactKeys(descriptor, ["kind", "protocolMajor", "encodingVersion", "schemaVersion",
				"objectId", "epoch", "startOrdinal", "endOrdinal", "recordCount", "payloadDigest", "totalBytes", "chunks"]) ||
				!plainRecord(entry) || !exactKeys(entry, ["objectId", "startOrdinal", "endOrdinal", "recordCount", "segmentDigest", "payloadDigest"]) ||
				descriptor.kind !== "drp-archive-segment" || descriptor.protocolMajor !== 3 ||
				descriptor.encodingVersion !== "drp-canonical-profile-1" || descriptor.schemaVersion !== 1 ||
				descriptor.objectId !== captured.objectId || descriptor.epoch !== captured.sourceEpoch ||
				descriptor.startOrdinal !== nextOrdinal || !safeInteger(descriptor.recordCount, 1) ||
				!safeInteger(descriptor.endOrdinal) || descriptor.endOrdinal !== nextOrdinal + descriptor.recordCount - 1 ||
				!safeInteger(descriptor.totalBytes, 1) || !Array.isArray(descriptor.chunks) || descriptor.chunks.length < 1 ||
				typeof descriptor.payloadDigest !== "string" || !digestHex.test(descriptor.payloadDigest)) return undefined;
			let chunkBytes = 0;
			for (const [index, chunk] of descriptor.chunks.entries()) {
				if (!plainRecord(chunk) || !exactKeys(chunk, ["index", "digest", "byteLength"]) || chunk.index !== index ||
					typeof chunk.digest !== "string" || !digestHex.test(chunk.digest) || !safeInteger(chunk.byteLength, 1)) return undefined;
				chunkBytes += chunk.byteLength;
				if (!safeInteger(chunkBytes)) return undefined;
			}
			const segmentDigest = hex(hashDomain("ts-drp/archive-segment/v3", descriptorBytes));
			if (identities.has(segmentDigest) || chunkBytes !== descriptor.totalBytes || entry.segmentDigest !== segmentDigest ||
				["objectId", "startOrdinal", "endOrdinal", "recordCount", "payloadDigest"].some(field => entry[field] !== descriptor[field]))
				return undefined;
			identities.add(segmentDigest);
			nextOrdinal += descriptor.recordCount;
			if (!safeInteger(nextOrdinal)) return undefined;
		}
		return nextOrdinal === captured.historySize ? captured as unknown as CreatorArchiveAppendBinding : undefined;
	} catch { return undefined; }
}

export function archiveAppendMatchesCut(value: unknown, cut: Readonly<Record<string, unknown>>, previousRoot?: unknown): boolean {
	const binding = captureCreatorArchiveAppendBinding(value);
	return binding !== undefined && binding.objectId === cut.objectId && binding.sourceEpoch === cut.epoch &&
		binding.sourceAnchorDigest === cut.previousAnchor && binding.sourceCloseSetRoot === cut.closeSetRoot &&
		binding.sourceHistoryRoot === cut.historyRoot && binding.previousHistorySize === cut.previousHistorySize &&
		binding.historySize === cut.historySize && binding.historySize - binding.previousHistorySize === cut.closeSetCount &&
		binding.targetArchiveIndexRoot === cut.archiveIndexRoot &&
		(previousRoot === undefined || binding.previousArchiveIndexRoot === previousRoot);
}


