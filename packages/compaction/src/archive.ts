import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	digestReceivedVertexPreimage,
	vertexCanonicalBytes,
} from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import type { CreatorArchiveAppendBinding } from "@ts-drp/protocol-v3/creator-close";

import { CompactMerkleAccumulator, verifyInclusion } from "./ct-merkle.js";
import { copyExactByteCarrier } from "./exact-byte-carrier.js";
import { deriveCloseSetHistoryCommitment, type CloseSetHistoryCommitmentInput } from "./history-commitment.js";
import type { AccumulatorSnapshot, InclusionProof } from "./types.js";

const DIGEST = /^[0-9a-f]{64}$/u;
const INDEX_LIMITS = Object.freeze({ maxBytes: 4096, maxDepth: 4, maxItems: 32 });

/** Explicit construction/read ceilings, not a proof budget or a hard-memory target. */
export interface ArchiveLimits {
	readonly maxSegmentBytes: number;
	readonly maxRecordsPerSegment: number;
	readonly chunkBytes: number;
	readonly maxChunks: number;
	readonly maxSegments: number;
}

/** Original source bytes, captured under the existing closed replay authenticator. */
export interface ClosedArchiveSourceRecord {
	readonly vertexDigest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
}

export interface ArchiveChunk {
	readonly index: number;
	readonly digest: string;
	readonly bytes: Uint8Array;
}

/** This is an unsigned content artifact. Only a certified Cut/snapshot authenticates its root. */
export interface ArchiveSegment {
	readonly segmentDigest: string;
	readonly exactCanonicalDescriptorBytes: Uint8Array;
	readonly exactCanonicalIndexEntryBytes: Uint8Array;
	readonly chunks: readonly ArchiveChunk[];
	readonly startOrdinal: number;
	readonly endOrdinal: number;
	readonly recordCount: number;
}

export interface ClosedEpochArchiveInput {
	readonly close: CloseSetHistoryCommitmentInput;
	/** Complete close-set keyset: local-issued AND admitted foreign records, before retirement. */
	readonly sourceRecords: readonly ClosedArchiveSourceRecord[];
	readonly limits: ArchiveLimits;
}

export interface ClosedEpochArchive {
	readonly objectId: string;
	readonly epoch: number;
	readonly sourceAnchorDigest: string;
	readonly closeSetRoot: string;
	readonly historyRoot: string;
	readonly historySize: number;
	readonly segments: readonly ArchiveSegment[];
	/** Exact encoded byte categories. They do not assert native proof charges or peak memory. */
	readonly encodedBytes: Readonly<{
		sourcePreimages: number;
		sourceSignatures: number;
		segmentPayloads: number;
		segmentDescriptors: number;
		indexEntries: number;
	}>;
}

/** Exact byte plan, not authorization, a native preparation receipt or permission to delete. */
export interface ClosedEpochArchiveAppend {
	readonly binding: CreatorArchiveAppendBinding;
	readonly snapshot: AccumulatorSnapshot;
	readonly artifacts: readonly Readonly<{
		ref: Readonly<{ kind: "segment" | "index-entry"; digest: string; byteLength: number }> |
			Readonly<{ kind: "chunk"; digest: string; byteLength: number; startOrdinal: number; chunkIndex: number }>;
		bytes: Uint8Array;
	}>[];
	readonly indexEntries: readonly Readonly<{ kind: "index-entry"; digest: string; byteLength: number }>[];
}

export interface ArchiveRecord {
	readonly ordinal: number;
	readonly vertexDigest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
}

/** Scalar constructor widths. No source bytes/signatures or authority are fabricated.
 * The original authenticated planning owner supplies complete ordered membership.
 * New ordinary admissions may extend this plan; they are not promised up front. */
export function measureArchiveAppendCapacityForSizing(input: Readonly<{
	objectId: string; epoch: number;
	records: readonly Readonly<{ordinal:number;preimageByteLength:number}>[];
	limits: ArchiveLimits;
}>): Readonly<{artifactBytes:number;artifactCount:number;indexEntries:number;maxArtifactBytes:number;
	segments:readonly Readonly<{descriptorByteLength:number;indexEntryByteLength:number}>[]}> {
	const limits = captureLimits(input.limits);
	integer(input.epoch,"archive capacity epoch");
	if (typeof input.objectId !== "string" || input.objectId.length < 1 || input.objectId.length > 1024)
		throw new TypeError("archive capacity object is invalid");
	const countWidth = (n: number): number => { let width = 1; while (n >= 128) { n = Math.floor(n / 128);width++; }return width; };
	let artifactBytes = 0,artifactCount = 0,indexEntries = 0,maxArtifactBytes = 0;
	const segments: Array<{descriptorByteLength:number;indexEntryByteLength:number}> = [];
	let pending: Array<{ordinal:number;width:number}> = [];
	const base = (startOrdinal: number): number => encodeCanonical({kind:"drp-archive-segment-payload",protocolMajor:3,
		schemaVersion:1,objectId:input.objectId,epoch:input.epoch,startOrdinal,records:[]}).byteLength;
	const payloadWidth = (rows: typeof pending): number => rows.length === 0 ? 0 :
		add(base(rows[0]!.ordinal),add(rows.reduce((n,row) => add(n,row.width),0),countWidth(rows.length) - 1));
	const flush = (): void => {
		if (pending.length === 0) return;
		if (++indexEntries > limits.maxSegments) throw new RangeError("archive prospective segment capacity exhausted");
		const payloadBytes = payloadWidth(pending),startOrdinal = pending[0]!.ordinal,endOrdinal = pending.at(-1)!.ordinal;
		const count = Math.ceil(payloadBytes / limits.chunkBytes);
		if (count > limits.maxChunks || payloadBytes > limits.maxSegmentBytes) throw new RangeError(
			`archive prospective chunk capacity exhausted: payloadBytes=${payloadBytes} maxSegmentBytes=${limits.maxSegmentBytes} chunks=${count} maxChunks=${limits.maxChunks}`);
		const chunks = Array.from({length:count},(_,index) => ({index,digest:"0".repeat(64),
			byteLength:Math.min(limits.chunkBytes,payloadBytes - index * limits.chunkBytes)}));
		// Fixed-width digest placeholders are exclusively serializer measurements.
		const descriptorWidth = encodeCanonical({kind:"drp-archive-segment",protocolMajor:3,encodingVersion:"drp-canonical-profile-1",
			schemaVersion:1,objectId:input.objectId,epoch:input.epoch,startOrdinal,endOrdinal,recordCount:pending.length,
			payloadDigest:"0".repeat(64),totalBytes:payloadBytes,chunks},{maxBytes:limits.maxSegmentBytes,maxDepth:8,maxItems:1_000_000}).byteLength;
		const indexWidth = encodeCanonical({objectId:input.objectId,startOrdinal,endOrdinal,recordCount:pending.length,
			segmentDigest:"0".repeat(64),payloadDigest:"0".repeat(64)},INDEX_LIMITS).byteLength;
		artifactBytes = add(artifactBytes,add(payloadBytes,add(descriptorWidth,indexWidth)));
		artifactCount = add(artifactCount,2 + count);
		segments.push(Object.freeze({descriptorByteLength:descriptorWidth,indexEntryByteLength:indexWidth}));
		maxArtifactBytes = Math.max(maxArtifactBytes,descriptorWidth,indexWidth,...chunks.map(chunk => chunk.byteLength));
		pending = [];
	};
	let prior = -1;
	for (const row of input.records) {
		integer(row.ordinal,"archive capacity ordinal");integer(row.preimageByteLength,"archive capacity preimage bytes",1);
		if (prior !== -1 && row.ordinal !== prior + 1) throw new TypeError("archive capacity membership is not contiguous");
		prior = row.ordinal;
		const width = add(encodeCanonical({ordinal:row.ordinal,vertexDigest:"0".repeat(64),exactCanonicalPreimageBytes:new Uint8Array(0),
			detachedSignature:new Uint8Array(0)}).byteLength,add(row.preimageByteLength + countWidth(row.preimageByteLength) - 1,64));
		const next = {ordinal:row.ordinal,width};
		if (pending.length >= limits.maxRecordsPerSegment || (pending.length > 0 && payloadWidth([...pending,next]) > limits.maxSegmentBytes)) flush();
		pending.push(next);
	}
	flush();
	return Object.freeze({artifactBytes,artifactCount,indexEntries,maxArtifactBytes,segments:Object.freeze(segments)});
}

function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new TypeError(`${name} is not a plain record`);
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)))
		throw new TypeError(`${name} fields are invalid`);
	const output: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor?.enumerable !== true || !("value" in descriptor))
			throw new TypeError(`${name} requires data fields`);
		output[key] = descriptor.value;
	}
	return output;
}

function integer(value: unknown, name: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new TypeError(`${name} is not a bounded safe integer`);
	return value;
}

function digest(value: unknown, name: string): string {
	if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} is not a SHA-256 digest`);
	return value;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digestBytes(value: string): Uint8Array {
	return Uint8Array.from(digest(value, "root").match(/../gu) as string[], (part) => Number.parseInt(part, 16));
}

function add(left: number, right: number): number {
	if (right > Number.MAX_SAFE_INTEGER - left) throw new RangeError("archive byte/ordinal sum is unsafe");
	return left + right;
}

function captureLimits(value: ArchiveLimits): ArchiveLimits {
	const input = record(
		value,
		["maxSegmentBytes", "maxRecordsPerSegment", "chunkBytes", "maxChunks", "maxSegments"],
		"archive limits"
	);
	const limits = Object.fromEntries(
		Object.entries(input).map(([key, entry]) => [key, integer(entry, key, 1)])
	) as unknown as ArchiveLimits;
	if (limits.chunkBytes > limits.maxSegmentBytes) throw new TypeError("chunkBytes exceeds maxSegmentBytes");
	return Object.freeze(limits);
}

function canonicalRecord(bytes: Uint8Array, maxBytes: number): Readonly<Record<string, unknown>> {
	const limits = { maxBytes, maxDepth: 128, maxItems: 1_000_000 };
	const value = decodeCanonical(bytes, limits);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		compareBytes(encodeCanonical(value, limits), bytes) !== 0
	)
		throw new TypeError("archive source/descriptor is not canonical");
	return value as Readonly<Record<string, unknown>>;
}

function payloadBytes(
	objectId: string,
	epoch: number,
	records: readonly ArchiveRecord[],
	maxBytes: number
): Uint8Array {
	return encodeCanonical(
		{
			kind: "drp-archive-segment-payload",
			protocolMajor: 3,
			schemaVersion: 1,
			objectId,
			epoch,
			startOrdinal: records[0]?.ordinal ?? 0,
			records,
		},
		{ maxBytes, maxDepth: 128, maxItems: 1_000_000 }
	);
}

function chunkDigest(objectId: string, startOrdinal: number, index: number, bytes: Uint8Array): string {
	return hex(
		hashDomain(
			"ts-drp/archive-chunk/v3",
			encodeCanonical(objectId),
			encodeCanonical(startOrdinal),
			encodeCanonical(index),
			bytes
		)
	);
}

function indexEntry(descriptor: Readonly<Record<string, unknown>>, segmentDigest: string): Uint8Array {
	return encodeCanonical(
		{
			objectId: descriptor.objectId,
			startOrdinal: descriptor.startOrdinal,
			endOrdinal: descriptor.endOrdinal,
			recordCount: descriptor.recordCount,
			segmentDigest,
			payloadDigest: descriptor.payloadDigest,
		},
		INDEX_LIMITS
	);
}

function buildSegment(
	objectId: string,
	epoch: number,
	records: readonly ArchiveRecord[],
	limits: ArchiveLimits
): ArchiveSegment {
	const payload = payloadBytes(objectId, epoch, records, limits.maxSegmentBytes);
	const startOrdinal = records[0]!.ordinal;
	const chunks: ArchiveChunk[] = [];
	for (let offset = 0; offset < payload.byteLength; offset += limits.chunkBytes) {
		if (chunks.length >= limits.maxChunks) throw new RangeError("archive chunk capacity exhausted");
		const bytes = payload.slice(offset, Math.min(payload.byteLength, offset + limits.chunkBytes));
		const index = chunks.length;
		chunks.push(Object.freeze({ index, bytes, digest: chunkDigest(objectId, startOrdinal, index, bytes) }));
	}
	const descriptor = {
		kind: "drp-archive-segment",
		protocolMajor: 3,
		encodingVersion: "drp-canonical-profile-1",
		schemaVersion: 1,
		objectId,
		epoch,
		startOrdinal,
		endOrdinal: records[records.length - 1]!.ordinal,
		recordCount: records.length,
		payloadDigest: hex(hashDomain("ts-drp/archive-payload/v3", payload)),
		totalBytes: payload.byteLength,
		chunks: chunks.map(({ index, digest, bytes }) => ({ index, digest, byteLength: bytes.byteLength })),
	};
	const exactCanonicalDescriptorBytes = encodeCanonical(descriptor, {
		maxBytes: limits.maxSegmentBytes,
		maxDepth: 8,
		maxItems: 1_000_000,
	});
	const segmentDigest = hex(hashDomain("ts-drp/archive-segment/v3", exactCanonicalDescriptorBytes));
	return Object.freeze({
		segmentDigest,
		exactCanonicalDescriptorBytes,
		exactCanonicalIndexEntryBytes: indexEntry(descriptor, segmentDigest),
		chunks: Object.freeze(chunks),
		startOrdinal,
		endOrdinal: descriptor.endOrdinal,
		recordCount: records.length,
	});
}

/**
 * Constructs immutable content-addressed artifacts from one COMPLETE closed epoch.
 * Structural/order/digest/byte-census checks are performed here. Signature, ACL,
 * author/sequence and closed-fold authentication remain with the existing source
 * replay owner: this function does not mint transferable authority or certify a root.
 * Final Cut/QC bytes are deliberately absent, avoiding a root-to-Cut hash cycle.
 */
export async function produceClosedEpochArchive(input: ClosedEpochArchiveInput): Promise<ClosedEpochArchive> {
	const limits = captureLimits(input.limits);
	integer(input.close.maxEpochBytes, "maxEpochBytes", 1);
	integer(input.close.maxEpochVertices, "maxEpochVertices", 1);
	if (
		!Array.isArray(input.sourceRecords) ||
		input.sourceRecords.length > input.close.maxEpochVertices ||
		input.close.vertices.size !== input.sourceRecords.length + 1 ||
		input.close.vertices.size > input.close.maxEpochVertices
	)
		throw new TypeError("archive source keyset/graph exceeds the complete closed graph bound");
	const anchorBytes = copyExactByteCarrier(
		input.close.exactCanonicalEpochAnchorPreimageBytes,
		"archive source anchor",
		{ maxBytes: 65_536 }
	);
	const anchor = canonicalRecord(anchorBytes, 65_536);
	const objectId = anchor.objectId;
	if (typeof objectId !== "string" || objectId.length < 1 || objectId.length > 1024)
		throw new TypeError("archive objectId is invalid");
	const epoch = integer(anchor.epoch, "archive source epoch");
	const sourceAnchorDigest = hex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const sources = new Map<string, ClosedArchiveSourceRecord>();
	let sourcePreimages = 0;
	let sourceSignatures = 0;
	for (const candidate of input.sourceRecords) {
		const source = record(
			candidate,
			["vertexDigest", "exactCanonicalPreimageBytes", "detachedSignature"],
			"archive source record"
		);
		const vertexDigest = digest(source.vertexDigest, "archive source vertex");
		if (sources.has(vertexDigest)) throw new TypeError("duplicate archive source identity");
		const bytes = copyExactByteCarrier(source.exactCanonicalPreimageBytes as Uint8Array, "archive source preimage", {
			maxBytes: input.close.maxEpochBytes - sourcePreimages,
		});
		const signature = copyExactByteCarrier(source.detachedSignature as Uint8Array, "archive source signature", {
			maxBytes: 64,
		});
		if (signature.byteLength !== 64 || hex(digestReceivedVertexPreimage(bytes)) !== vertexDigest)
			throw new TypeError("archive source digest/signature shape mismatch");
		const decoded = canonicalRecord(bytes, input.close.maxEpochBytes);
		if (compareBytes(vertexCanonicalBytes(decoded), bytes) !== 0)
			throw new TypeError("archive source is not an exact registered vertex preimage");
		const vertex = input.close.vertices.get(vertexDigest);
		if (
			vertex === undefined ||
			decoded.kind !== "drp-vertex" ||
			decoded.objectId !== objectId ||
			decoded.epoch !== epoch ||
			decoded.anchor !== sourceAnchorDigest
		)
			throw new TypeError("archive source context differs from the closed fold");
		const projected = {
			kind: decoded.kind,
			objectId: decoded.objectId,
			epoch: decoded.epoch,
			anchor: decoded.anchor,
			dependencies: decoded.dependencies,
			operation: decoded.operation,
		};
		const expected = {
			kind: vertex.kind,
			objectId: vertex.objectId,
			epoch: vertex.epoch,
			anchor: vertex.anchor,
			dependencies: vertex.dependencies,
			operation: vertex.operation,
		};
		if (compareBytes(encodeCanonical(projected), encodeCanonical(expected)) !== 0)
			throw new TypeError("archive source operation/dependencies differ from the closed fold");
		sources.set(vertexDigest, { vertexDigest, exactCanonicalPreimageBytes: bytes, detachedSignature: signature });
		sourcePreimages = add(sourcePreimages, bytes.byteLength);
		sourceSignatures = add(sourceSignatures, signature.byteLength);
	}
	const commitment = await deriveCloseSetHistoryCommitment(input.close);
	if (commitment.anchorHash !== sourceAnchorDigest || sources.size !== commitment.closeSetCount)
		throw new TypeError("archive source keyset differs from complete close membership");
	const ordered: ArchiveRecord[] = commitment.closeSetEntries.map((entry) => {
		const source = sources.get(entry.vertexHash);
		if (
			source === undefined ||
			source.exactCanonicalPreimageBytes.byteLength !== entry.authenticatedCanonicalPreimageByteLength
		)
			throw new TypeError("archive source bytes are missing or disagree with authenticated byte charges");
		return Object.freeze({ ...source, ordinal: entry.ordinal });
	});
	const segments: ArchiveSegment[] = [];
	let pending: ArchiveRecord[] = [];
	let recordBytes = 0;
	// Canonical array count uses a varuint; compute its exact width, not a speculative allowance.
	const countWidth = (count: number): number => {
		let width = 1;
		while (count >= 128) {
			count = Math.floor(count / 128);
			width++;
		}
		return width;
	};
	const flush = (): void => {
		if (pending.length === 0) return;
		if (segments.length >= limits.maxSegments) throw new RangeError("archive segment capacity exhausted");
		segments.push(buildSegment(objectId, epoch, pending, limits));
		pending = [];
		recordBytes = 0;
	};
	for (const entry of ordered) {
		const size = encodeCanonical(entry, {
			maxBytes: limits.maxSegmentBytes,
			maxDepth: 128,
			maxItems: 1_000_000,
		}).byteLength;
		// startOrdinal zero versus actual ordinal can change its varuint length.
		const first = pending[0] ?? entry;
		const firstSize =
			first === entry
				? size
				: encodeCanonical(first, { maxBytes: limits.maxSegmentBytes, maxDepth: 128, maxItems: 1_000_000 }).byteLength;
		const base = payloadBytes(objectId, epoch, [first], limits.maxSegmentBytes).byteLength - firstSize;
		if (
			pending.length >= limits.maxRecordsPerSegment ||
			(pending.length > 0 &&
				add(add(base, add(recordBytes, size)), countWidth(pending.length + 1) - 1) > limits.maxSegmentBytes)
		)
			flush();
		pending.push(entry);
		recordBytes = add(recordBytes, size);
	}
	flush();
	return Object.freeze({
		objectId,
		epoch,
		sourceAnchorDigest,
		closeSetRoot: commitment.closeSetRoot,
		historyRoot: commitment.historyRoot,
		historySize: commitment.historySize,
		segments: Object.freeze(segments),
		encodedBytes: Object.freeze({
			sourcePreimages,
			sourceSignatures,
			segmentPayloads: segments.reduce(
				(sum, segment) =>
					add(
						sum,
						segment.chunks.reduce((total, chunk) => add(total, chunk.bytes.byteLength), 0)
					),
				0
			),
			segmentDescriptors: segments.reduce(
				(sum, segment) => add(sum, segment.exactCanonicalDescriptorBytes.byteLength),
				0
			),
			indexEntries: segments.reduce((sum, segment) => add(sum, segment.exactCanonicalIndexEntryBytes.byteLength), 0),
		}),
	});
}

/** Appends descriptor leaves with O(log history) live accumulator state, not a retained full index. */
export async function appendArchiveIndex(
	input: Readonly<{
		objectId: string;
		expectedPreviousRoot: string;
		previousSnapshot: AccumulatorSnapshot;
		previousEndOrdinal: number;
		/** Last committed leaf, independently proven against the predecessor root. */
		previousLastEntry?: Readonly<{ exactCanonicalEntryBytes: Uint8Array; proof: InclusionProof }>;
		segments: readonly ArchiveSegment[];
		limits: ArchiveLimits;
	}>
): Promise<Readonly<{ root: string; snapshot: AccumulatorSnapshot; appendedEntryBytes: number }>> {
	const limits = captureLimits(input.limits);
	const accumulator = CompactMerkleAccumulator.fromSnapshot(input.previousSnapshot);
	if (hex(accumulator.root()) !== digest(input.expectedPreviousRoot, "previous archive root"))
		throw new TypeError("archive index predecessor root mismatch");
	if (input.previousEndOrdinal !== -1) integer(input.previousEndOrdinal, "previous archive end ordinal");
	if (accumulator.size === 0) {
		if (input.previousEndOrdinal !== -1 || input.previousLastEntry !== undefined)
			throw new TypeError("empty archive index has no previous ordinal/leaf");
	} else {
		const last = input.previousLastEntry;
		if (
			last === undefined ||
			last.proof.treeSize !== accumulator.size ||
			last.proof.leafIndex !== accumulator.size - 1 ||
			!verifyArchiveIndexEntry(last.exactCanonicalEntryBytes, last.proof, input.expectedPreviousRoot)
		)
			throw new TypeError("archive predecessor frontier is missing or unproven");
		const entry = canonicalRecord(last.exactCanonicalEntryBytes, INDEX_LIMITS.maxBytes);
		if (entry.objectId !== input.objectId || entry.endOrdinal !== input.previousEndOrdinal)
			throw new TypeError("archive predecessor frontier is foreign or has an altered ordinal");
	}
	if (input.segments.length > limits.maxSegments) throw new RangeError("archive index append exceeds segment bound");
	let previous = input.previousEndOrdinal;
	let appendedEntryBytes = 0;
	const leaves: Uint8Array[] = [];
	for (const segment of input.segments) {
		readArchiveSegment({
			exactCanonicalDescriptorBytes: segment.exactCanonicalDescriptorBytes,
			expectedSegmentDigest: segment.segmentDigest,
			chunks: new Map(segment.chunks.map((chunk) => [chunk.digest, chunk.bytes])),
			limits,
		});
		const bytes = copyExactByteCarrier(segment.exactCanonicalDescriptorBytes, "archive descriptor", {
			maxBytes: limits.maxSegmentBytes,
		});
		const descriptor = canonicalRecord(bytes, limits.maxSegmentBytes);
		if (
			hex(hashDomain("ts-drp/archive-segment/v3", bytes)) !== segment.segmentDigest ||
			descriptor.objectId !== input.objectId ||
			integer(descriptor.startOrdinal, "archive start ordinal") !== add(previous, 1) ||
			integer(descriptor.endOrdinal, "archive end ordinal") !==
				add(
					integer(descriptor.startOrdinal, "archive start ordinal"),
					integer(descriptor.recordCount, "archive record count", 1) - 1
				)
		)
			throw new TypeError("archive index append is foreign, altered, overlapping or noncontiguous");
		const leaf = indexEntry(descriptor, digest(segment.segmentDigest, "segment digest"));
		if (compareBytes(leaf, segment.exactCanonicalIndexEntryBytes) !== 0)
			throw new TypeError("archive index leaf differs from descriptor");
		previous = integer(descriptor.endOrdinal, "archive end ordinal");
		appendedEntryBytes = add(appendedEntryBytes, leaf.byteLength);
		leaves.push(leaf);
	}
	await accumulator.appendMany(leaves);
	return Object.freeze({ root: hex(accumulator.root()), snapshot: accumulator.snapshot(), appendedEntryBytes });
}

/**
 * Computes one contiguous whole-close append from exact original segment bytes and a
 * predecessor frontier independently checked against the current certified archive root.
 * Source authenticity stays with the original replay/close owner; this helper never mints it.
 */
export async function deriveClosedEpochArchiveAppend(input: Readonly<{
	archive: ClosedEpochArchive;
	expectedPreviousRoot: string;
	previousSnapshot: AccumulatorSnapshot;
	previousEndOrdinal: number;
	previousLastEntry?: Readonly<{ exactCanonicalEntryBytes: Uint8Array; proof: InclusionProof }>;
	limits: ArchiveLimits;
}>): Promise<ClosedEpochArchiveAppend> {
	const limits = captureLimits(input.limits), source = input.archive;
	const expectedPreviousRoot = digest(input.expectedPreviousRoot, "archive append previous root");
	const previousSnapshot = CompactMerkleAccumulator.fromSnapshot(input.previousSnapshot).snapshot();
	const previousEndOrdinal = input.previousEndOrdinal;
	const objectId = source.objectId;
	if (typeof objectId !== "string" || objectId.length < 1 || objectId.length > 1024)
		throw new TypeError("archive append object identity is invalid");
	const epoch = integer(source.epoch, "archive append epoch");
	const sourceAnchorDigest = digest(source.sourceAnchorDigest, "archive append source anchor");
	const sourceCloseSetRoot = digest(source.closeSetRoot, "archive append close set");
	const sourceHistoryRoot = digest(source.historyRoot, "archive append history root");
	const historySize = integer(source.historySize, "archive append history size", 1);
	if (!Array.isArray(source.segments) || source.segments.length < 1 || source.segments.length > limits.maxSegments)
		throw new TypeError("archive append segments are missing or unbounded");
	const segments: ArchiveSegment[] = [];
	const artifacts: Array<ClosedEpochArchiveAppend["artifacts"][number]> = [];
	const indexEntries: Array<ClosedEpochArchiveAppend["indexEntries"][number]> = [];
	const sourceIdentities = new Set<string>();
	let nextOrdinal = add(previousEndOrdinal, 1);
	const previousHistorySize = nextOrdinal;
	for (const sourceSegment of source.segments) {
		const descriptorBytes = copyExactByteCarrier(sourceSegment.exactCanonicalDescriptorBytes, "archive append descriptor", { maxBytes: limits.maxSegmentBytes });
		const entryBytes = copyExactByteCarrier(sourceSegment.exactCanonicalIndexEntryBytes, "archive append entry", { maxBytes: INDEX_LIMITS.maxBytes });
		if (!Array.isArray(sourceSegment.chunks) || sourceSegment.chunks.length < 1 || sourceSegment.chunks.length > limits.maxChunks)
			throw new TypeError("archive append chunks are missing or unbounded");
		const chunks = sourceSegment.chunks.map((chunk: ArchiveChunk) => Object.freeze({ index: chunk.index, digest: chunk.digest,
			bytes: copyExactByteCarrier(chunk.bytes, "archive append chunk", { maxBytes: limits.chunkBytes }) }));
		const rows = readArchiveSegment({ exactCanonicalDescriptorBytes: descriptorBytes,
			expectedSegmentDigest: sourceSegment.segmentDigest, chunks: new Map(chunks.map((chunk: ArchiveChunk) => [chunk.digest, chunk.bytes])), limits });
		const descriptor = canonicalRecord(descriptorBytes, limits.maxSegmentBytes);
		if (descriptor.objectId !== objectId || descriptor.epoch !== epoch || rows.length < 1 || rows[0]!.ordinal !== nextOrdinal ||
			!Array.isArray(descriptor.chunks) || descriptor.chunks.length !== chunks.length ||
			chunks.some((chunk: ArchiveChunk, index: number) => chunk.index !== index))
			throw new TypeError("archive append source is foreign, incomplete or noncontiguous");
		for (const row of rows) {
			const vertex = canonicalRecord(row.exactCanonicalPreimageBytes, limits.maxSegmentBytes);
			if (vertex.anchor !== sourceAnchorDigest || sourceIdentities.has(row.vertexDigest))
				throw new TypeError("archive append has foreign or duplicate original source bytes");
			sourceIdentities.add(row.vertexDigest);
		}
		const segment = Object.freeze({ segmentDigest: sourceSegment.segmentDigest,
			exactCanonicalDescriptorBytes: descriptorBytes, exactCanonicalIndexEntryBytes: entryBytes,
			chunks: Object.freeze(chunks), startOrdinal: rows[0]!.ordinal, endOrdinal: rows[rows.length - 1]!.ordinal, recordCount: rows.length });
		segments.push(segment);
		const segmentRef = Object.freeze({ kind: "segment" as const, digest: segment.segmentDigest, byteLength: descriptorBytes.byteLength });
		const entryRef = Object.freeze({ kind: "index-entry" as const,
			digest: hex(hashDomain("ts-drp-storage/blob/v1", entryBytes)), byteLength: entryBytes.byteLength });
		artifacts.push(Object.freeze({ ref: segmentRef, bytes: descriptorBytes }), Object.freeze({ ref: entryRef, bytes: entryBytes }));
		indexEntries.push(entryRef);
		for (const chunk of chunks) artifacts.push(Object.freeze({ ref: Object.freeze({ kind: "chunk" as const,
			digest: chunk.digest, byteLength: chunk.bytes.byteLength, startOrdinal: segment.startOrdinal, chunkIndex: chunk.index }), bytes: chunk.bytes }));
		nextOrdinal = add(segment.endOrdinal, 1);
	}
	if (nextOrdinal !== historySize) throw new TypeError("archive append does not cover the whole source history range");
	const appended = await appendArchiveIndex({ objectId, expectedPreviousRoot,
		previousSnapshot, previousEndOrdinal,
		...(input.previousLastEntry === undefined ? {} : { previousLastEntry: input.previousLastEntry }), segments, limits });
	return Object.freeze({ binding: Object.freeze({ kind: "closed-epoch-archive-append" as const, version: 1 as const,
		objectId, sourceEpoch: epoch, sourceAnchorDigest, sourceCloseSetRoot, sourceHistoryRoot,
		previousHistorySize, historySize, previousArchiveIndexRoot: expectedPreviousRoot,
		targetArchiveIndexRoot: appended.root, previousIndexSize: previousSnapshot.size, indexSize: appended.snapshot.size,
		segments: Object.freeze(segments.map(segment => Object.freeze({ exactCanonicalDescriptorBytes: segment.exactCanonicalDescriptorBytes,
			exactCanonicalIndexEntryBytes: segment.exactCanonicalIndexEntryBytes }))) }), snapshot: appended.snapshot,
		artifacts: Object.freeze(artifacts), indexEntries: Object.freeze(indexEntries) });
}

/** Verifies an index leaf against a root supplied by the authenticated Cut/snapshot owner. */
export function verifyArchiveIndexEntry(
	exactCanonicalEntryBytes: Uint8Array,
	proof: InclusionProof,
	expectedRoot: string
): boolean {
	try {
		const bytes = copyExactByteCarrier(exactCanonicalEntryBytes, "archive index entry", {
			maxBytes: INDEX_LIMITS.maxBytes,
		});
		const entry = record(
			canonicalRecord(bytes, INDEX_LIMITS.maxBytes),
			["objectId", "startOrdinal", "endOrdinal", "recordCount", "segmentDigest", "payloadDigest"],
			"archive index entry"
		);
		if (
			typeof entry.objectId !== "string" ||
			entry.objectId.length < 1 ||
			entry.objectId.length > 1024 ||
			integer(entry.endOrdinal, "end ordinal") !==
				add(integer(entry.startOrdinal, "start ordinal"), integer(entry.recordCount, "record count", 1) - 1)
		)
			return false;
		digest(entry.segmentDigest, "segment digest");
		digest(entry.payloadDigest, "payload digest");
		return verifyInclusion(bytes, proof, digestBytes(expectedRoot));
	} catch {
		return false;
	}
}

/** Content integrity only. Source signature/ACL/certified-root authentication is still required independently. */
export function readArchiveSegment(
	input: Readonly<{
		exactCanonicalDescriptorBytes: Uint8Array;
		expectedSegmentDigest: string;
		chunks: ReadonlyMap<string, Uint8Array>;
		limits: ArchiveLimits;
	}>
): readonly ArchiveRecord[] {
	const limits = captureLimits(input.limits);
	const bytes = copyExactByteCarrier(input.exactCanonicalDescriptorBytes, "archive descriptor", {
		maxBytes: limits.maxSegmentBytes,
	});
	if (
		hex(hashDomain("ts-drp/archive-segment/v3", bytes)) !==
		digest(input.expectedSegmentDigest, "expected segment digest")
	)
		throw new TypeError("archive descriptor digest mismatch");
	const descriptor = record(
		canonicalRecord(bytes, limits.maxSegmentBytes),
		[
			"kind",
			"protocolMajor",
			"encodingVersion",
			"schemaVersion",
			"objectId",
			"epoch",
			"startOrdinal",
			"endOrdinal",
			"recordCount",
			"payloadDigest",
			"totalBytes",
			"chunks",
		],
		"archive descriptor"
	);
	if (
		descriptor.kind !== "drp-archive-segment" ||
		descriptor.protocolMajor !== 3 ||
		descriptor.encodingVersion !== "drp-canonical-profile-1" ||
		descriptor.schemaVersion !== 1 ||
		typeof descriptor.objectId !== "string" ||
		descriptor.objectId.length < 1 ||
		descriptor.objectId.length > 1024
	)
		throw new TypeError("archive descriptor identity mismatch");
	const start = integer(descriptor.startOrdinal, "start ordinal");
	const count = integer(descriptor.recordCount, "record count", 1);
	const total = integer(descriptor.totalBytes, "payload bytes", 1);
	if (
		count > limits.maxRecordsPerSegment ||
		total > limits.maxSegmentBytes ||
		integer(descriptor.endOrdinal, "end ordinal") !== add(start, count - 1) ||
		!Array.isArray(descriptor.chunks) ||
		descriptor.chunks.length < 1 ||
		descriptor.chunks.length > limits.maxChunks
	)
		throw new TypeError("archive descriptor exceeds bounds");
	const payload = new Uint8Array(total);
	let offset = 0;
	for (const [index, value] of descriptor.chunks.entries()) {
		const chunk = record(value, ["index", "digest", "byteLength"], "archive chunk");
		const length = integer(chunk.byteLength, "chunk byte length", 1);
		const chunkId = digest(chunk.digest, "chunk digest");
		const carrier = input.chunks.get(chunkId);
		if (chunk.index !== index || length > limits.chunkBytes || length > total - offset || carrier === undefined)
			throw new TypeError("archive chunk missing or out of bounds");
		const chunkBytes = copyExactByteCarrier(carrier, "archive chunk bytes", { maxBytes: limits.chunkBytes });
		if (chunkBytes.byteLength !== length || chunkDigest(descriptor.objectId, start, index, chunkBytes) !== chunkId)
			throw new TypeError("archive chunk digest/length mismatch");
		payload.set(chunkBytes, offset);
		offset += length;
	}
	if (
		offset !== total ||
		hex(hashDomain("ts-drp/archive-payload/v3", payload)) !== digest(descriptor.payloadDigest, "payload digest")
	)
		throw new TypeError("archive payload mismatch");
	const decoded = record(
		canonicalRecord(payload, limits.maxSegmentBytes),
		["kind", "protocolMajor", "schemaVersion", "objectId", "epoch", "startOrdinal", "records"],
		"archive payload"
	);
	if (
		decoded.kind !== "drp-archive-segment-payload" ||
		decoded.protocolMajor !== 3 ||
		decoded.schemaVersion !== 1 ||
		decoded.objectId !== descriptor.objectId ||
		decoded.epoch !== integer(descriptor.epoch, "epoch") ||
		decoded.startOrdinal !== start ||
		!Array.isArray(decoded.records) ||
		decoded.records.length !== count
	)
		throw new TypeError("archive payload metadata mismatch");
	return Object.freeze(
		decoded.records.map((value, index) => {
			const entry = record(
				value,
				["ordinal", "vertexDigest", "exactCanonicalPreimageBytes", "detachedSignature"],
				"archive record"
			);
			const original = copyExactByteCarrier(entry.exactCanonicalPreimageBytes as Uint8Array, "archived preimage", {
				maxBytes: limits.maxSegmentBytes,
			});
			const signature = copyExactByteCarrier(entry.detachedSignature as Uint8Array, "archived signature", {
				maxBytes: 64,
			});
			const vertexDigest = digest(entry.vertexDigest, "archived vertex digest");
			const vertex = canonicalRecord(original, limits.maxSegmentBytes);
			if (
				entry.ordinal !== add(start, index) ||
				signature.byteLength !== 64 ||
				hex(digestReceivedVertexPreimage(original)) !== vertexDigest ||
				compareBytes(vertexCanonicalBytes(vertex), original) !== 0 ||
				vertex.kind !== "drp-vertex" ||
				vertex.objectId !== descriptor.objectId ||
				vertex.epoch !== descriptor.epoch
			)
				throw new TypeError("archived original source identity mismatch");
			return Object.freeze({
				ordinal: add(start, index),
				vertexDigest,
				exactCanonicalPreimageBytes: original,
				detachedSignature: signature,
			});
		})
	);
}
