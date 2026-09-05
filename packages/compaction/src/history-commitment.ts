import { decodeCanonical, deepCloneCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { buildMerkleTree, CompactMerkleAccumulator } from "./ct-merkle.js";
import { CausalityIndex, LinearizationError, topologicalOrder } from "./linearize.js";
import type { AccumulatorSnapshot, EpochVertex } from "./types.js";

const DIGEST = /^[0-9a-f]{64}$/u;
const INPUT_KEYS = Object.freeze([
	"authenticatedCanonicalPreimageByteLengths",
	"exactCanonicalEpochAnchorPreimageBytes",
	"frontier",
	"maxEpochBytes",
	"maxEpochVertices",
	"previousHistorySnapshot",
	"vertices",
]);
const ANCHOR_KEYS = Object.freeze([
	"aclDigest",
	"archiveIndexRoot",
	"blueprintDigest",
	"cryptoSuiteId",
	"cutDigest",
	"epoch",
	"historyRoot",
	"historySize",
	"kind",
	"objectId",
	"parametersDigest",
	"previousAnchor",
	"profileDigest",
	"protocolMajor",
	"signerSetDigest",
	"stateDigest",
]);
const ANCHOR_VERTEX_KEYS = Object.freeze(["dependencies", "epoch", "hash", "kind", "objectId"]);
const ORDINARY_VERTEX_KEYS = Object.freeze(["anchor", "dependencies", "epoch", "hash", "kind", "objectId"]);
const ORDINARY_VERTEX_WITH_OPERATION_KEYS = Object.freeze([...ORDINARY_VERTEX_KEYS, "operation"]);
const SNAPSHOT_KEYS = Object.freeze(["peaks", "size"]);
const ACTIVE_CRYPTO_SUITES = new Set(["ed25519-sha256-v3", "ed25519-seal-v3"]);

const INTRINSIC_ARRAY_BUFFER = ArrayBuffer;
const INTRINSIC_ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const INTRINSIC_MAP_PROTOTYPE = Map.prototype;
const INTRINSIC_ARRAY_PROTOTYPE = Array.prototype;
const INTRINSIC_OBJECT_PROTOTYPE = Object.prototype;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const INTRINSIC_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_MAP_ENTRIES = Function.prototype.call.bind(Map.prototype.entries) as (
	map: unknown
) => MapIterator<[unknown, unknown]>;
const INTRINSIC_MAP_ITERATOR_NEXT = Function.prototype.call.bind(INTRINSIC_MAP_ENTRIES(new Map()).next) as (
	iterator: MapIterator<[unknown, unknown]>
) => IteratorResult<[unknown, unknown]>;
const INTRINSIC_TYPED_ARRAY_PROTOTYPE = INTRINSIC_GET_PROTOTYPE_OF(INTRINSIC_UINT8_ARRAY_PROTOTYPE) as object;

function requiredGetter(prototype: object, property: string): (this: unknown) => unknown {
	const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
	if (getter === undefined) throw new TypeError(`required intrinsic getter is unavailable: ${property}`);
	return getter;
}

const INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH = requiredGetter(INTRINSIC_ARRAY_BUFFER_PROTOTYPE, "byteLength");
const INTRINSIC_ARRAY_BUFFER_RESIZABLE = Object.getOwnPropertyDescriptor(
	INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
	"resizable"
)?.get;
const INTRINSIC_TYPED_ARRAY_BUFFER = requiredGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "buffer");
const INTRINSIC_TYPED_ARRAY_BYTE_LENGTH = requiredGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "byteLength");
const INTRINSIC_TYPED_ARRAY_BYTE_OFFSET = requiredGetter(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "byteOffset");

/** Authenticated caller evidence required to derive one close-set and append-only history commitment. */
export interface CloseSetHistoryCommitmentInput {
	readonly authenticatedCanonicalPreimageByteLengths: ReadonlyMap<string, number>;
	readonly exactCanonicalEpochAnchorPreimageBytes: Uint8Array;
	readonly frontier: readonly string[];
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly previousHistorySnapshot: AccumulatorSnapshot;
	readonly vertices: ReadonlyMap<string, EpochVertex>;
}

/** One ordered close-set member and its manifest evidence. */
export interface CloseSetHistoryEntry {
	readonly authenticatedCanonicalPreimageByteLength: number;
	readonly exactCanonicalHistoryLeafBytes: Uint8Array;
	readonly ordinal: number;
	readonly vertexHash: string;
}

/** Membership and append-only history commitments for one candidate close. */
export interface CloseSetHistoryCommitment {
	readonly anchorHash: string;
	readonly closeSetCount: number;
	readonly closeSetEntries: readonly CloseSetHistoryEntry[];
	readonly closeSetOrder: readonly string[];
	readonly closeSetRoot: string;
	readonly historyRoot: string;
	readonly historySize: number;
	readonly historySnapshot: AccumulatorSnapshot;
}

interface CapturedAnchor {
	readonly epoch: number;
	readonly historyRoot: string;
	readonly historySize: number;
	readonly objectId: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index++) {
		difference |= (left[index] as number) ^ (right[index] as number);
	}
	return difference === 0;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactDataRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${name} must be an ordinary record`);
	}
	const prototype = INTRINSIC_GET_PROTOTYPE_OF(value);
	if (prototype !== null && prototype !== INTRINSIC_OBJECT_PROTOTYPE) {
		throw new TypeError(`${name} must be a plain or null-prototype record`);
	}
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		throw new TypeError(`${name} fields are invalid`);
	}
	const output: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			throw new TypeError(`${name}.${key} must be an own enumerable data property`);
		}
		output[key] = descriptor.value;
	}
	return output;
}

function exactDenseArray(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value) || INTRINSIC_GET_PROTOTYPE_OF(value) !== INTRINSIC_ARRAY_PROTOTYPE) {
		throw new TypeError(`${name} must be an ordinary array`);
	}
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== value.length + 1 || ownKeys[value.length] !== "length") {
		throw new TypeError(`${name} must be a dense array`);
	}
	const output: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		if (ownKeys[index] !== String(index)) throw new TypeError(`${name} must be a dense array`);
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			throw new TypeError(`${name} entries must be own enumerable data properties`);
		}
		output.push(descriptor.value);
	}
	return output;
}

function exactBytes(value: unknown, name: string, expectedLength?: number): Uint8Array {
	let backing: unknown;
	let backingByteLength: unknown;
	let byteLength: unknown;
	let byteOffset: unknown;
	let resizable = false;
	try {
		backing = Reflect.apply(INTRINSIC_TYPED_ARRAY_BUFFER, value, []);
		backingByteLength = Reflect.apply(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH, backing, []);
		byteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH, value, []);
		byteOffset = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET, value, []);
		if (INTRINSIC_ARRAY_BUFFER_RESIZABLE !== undefined) {
			resizable = Reflect.apply(INTRINSIC_ARRAY_BUFFER_RESIZABLE, backing, []) === true;
		}
	} catch {
		throw new TypeError(`${name} must be a detached ordinary Uint8Array`);
	}
	if (
		INTRINSIC_GET_PROTOTYPE_OF(value) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE ||
		!(backing instanceof INTRINSIC_ARRAY_BUFFER) ||
		INTRINSIC_GET_PROTOTYPE_OF(backing) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
		resizable ||
		byteOffset !== 0 ||
		typeof byteLength !== "number" ||
		byteLength !== backingByteLength ||
		(expectedLength !== undefined && byteLength !== expectedLength)
	) {
		throw new TypeError(`${name} must be a detached ordinary Uint8Array`);
	}
	return new INTRINSIC_UINT8_ARRAY(backing as ArrayBuffer, 0, byteLength).slice();
}

function exactMapEntries(value: unknown, name: string): [unknown, unknown][] {
	if (INTRINSIC_GET_PROTOTYPE_OF(value) !== INTRINSIC_MAP_PROTOTYPE) {
		throw new TypeError(`${name} must be an ordinary Map`);
	}
	let iterator: MapIterator<[unknown, unknown]>;
	try {
		iterator = INTRINSIC_MAP_ENTRIES(value);
	} catch {
		throw new TypeError(`${name} must be an ordinary Map`);
	}
	const entries: [unknown, unknown][] = [];
	while (true) {
		const result = INTRINSIC_MAP_ITERATOR_NEXT(iterator);
		if (result.done) return entries;
		entries.push(result.value);
	}
}

function assertDigest(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !DIGEST.test(value)) {
		throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
	}
}

function invalidAnchor(message: string): never {
	throw new LinearizationError("INVALID_ANCHOR", message);
}

function invalidCharges(message: string): never {
	throw new LinearizationError("INVALID_BYTE_CHARGES", message);
}

function captureAnchor(bytes: Uint8Array): CapturedAnchor {
	let decoded: unknown;
	try {
		decoded = decodeCanonical(bytes, { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
		if (!sameBytes(encodeCanonical(decoded), bytes)) invalidAnchor("epoch anchor preimage is not canonical");
	} catch (error) {
		if (error instanceof LinearizationError) throw error;
		invalidAnchor("epoch anchor preimage is invalid");
	}
	let anchor: Record<string, unknown>;
	try {
		anchor = exactDataRecord(decoded, ANCHOR_KEYS, "epoch anchor");
	} catch {
		invalidAnchor("epoch anchor schema is invalid");
	}
	for (const field of [
		"aclDigest",
		"archiveIndexRoot",
		"blueprintDigest",
		"cutDigest",
		"historyRoot",
		"parametersDigest",
		"previousAnchor",
		"profileDigest",
		"signerSetDigest",
		"stateDigest",
	]) {
		if (typeof anchor[field] !== "string" || !DIGEST.test(anchor[field] as string)) {
			invalidAnchor(`epoch anchor ${field} is invalid`);
		}
	}
	if (
		anchor.kind !== "drp-epoch-anchor" ||
		anchor.protocolMajor !== 3 ||
		typeof anchor.objectId !== "string" ||
		anchor.objectId.length === 0 ||
		anchor.objectId.length > 1024 ||
		!Number.isSafeInteger(anchor.epoch) ||
		(anchor.epoch as number) < 0 ||
		!Number.isSafeInteger(anchor.historySize) ||
		(anchor.historySize as number) < 0 ||
		typeof anchor.cryptoSuiteId !== "string" ||
		!ACTIVE_CRYPTO_SUITES.has(anchor.cryptoSuiteId)
	) {
		invalidAnchor("epoch anchor fields are invalid");
	}
	return {
		epoch: anchor.epoch as number,
		historyRoot: anchor.historyRoot as string,
		historySize: anchor.historySize as number,
		objectId: anchor.objectId,
	};
}

function captureVertex(value: unknown, name: string): EpochVertex {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${name} must be an ordinary vertex record`);
	}
	const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
	if (kindDescriptor === undefined || !("value" in kindDescriptor)) {
		throw new TypeError(`${name}.kind must be an own data property`);
	}
	const keys =
		kindDescriptor.value === "drp-epoch-anchor"
			? ANCHOR_VERTEX_KEYS
			: Object.hasOwn(value, "operation")
				? ORDINARY_VERTEX_WITH_OPERATION_KEYS
				: ORDINARY_VERTEX_KEYS;
	const record = exactDataRecord(value, keys, name);
	const dependencies = exactDenseArray(record.dependencies, `${name}.dependencies`).map((dependency) => {
		assertDigest(dependency, `${name} dependency`);
		return dependency;
	});
	assertDigest(record.hash, `${name}.hash`);
	if (typeof record.objectId !== "string" || !Number.isSafeInteger(record.epoch) || (record.epoch as number) < 0) {
		throw new TypeError(`${name} identity is invalid`);
	}
	const output: EpochVertex = {
		dependencies,
		epoch: record.epoch as number,
		hash: record.hash,
		kind: record.kind as EpochVertex["kind"],
		objectId: record.objectId,
	};
	if (record.kind === "drp-vertex") {
		assertDigest(record.anchor, `${name}.anchor`);
		output.anchor = record.anchor;
		if (Object.hasOwn(record, "operation")) {
			output.operation = deepCloneCanonical(record.operation) as NonNullable<EpochVertex["operation"]>;
		}
	} else if (record.kind !== "drp-epoch-anchor") {
		throw new TypeError(`${name}.kind is invalid`);
	}
	return output;
}

function captureVertices(value: unknown): Map<string, EpochVertex> {
	const entries = exactMapEntries(value, "vertices");
	const vertices = new Map<string, EpochVertex>();
	for (const [key, vertex] of entries) {
		assertDigest(key, "vertex map key");
		if (vertices.has(key)) throw new TypeError("vertices contains a duplicate key");
		vertices.set(key, captureVertex(vertex, `vertex ${key}`));
	}
	return vertices;
}

function captureCharges(value: unknown): Map<string, number> {
	const entries = exactMapEntries(value, "authenticatedCanonicalPreimageByteLengths");
	const charges = new Map<string, number>();
	for (const [key, charge] of entries) {
		if (typeof key !== "string" || typeof charge !== "number") invalidCharges("byte charge entry is invalid");
		if (charges.has(key)) invalidCharges("byte charge key is duplicated");
		charges.set(key, charge);
	}
	return charges;
}

function captureSnapshot(value: unknown): AccumulatorSnapshot {
	const record = exactDataRecord(value, SNAPSHOT_KEYS, "previousHistorySnapshot");
	if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) {
		throw new RangeError("previous history size is invalid");
	}
	const peaks = exactDenseArray(record.peaks, "previousHistorySnapshot.peaks").map((peak, index) =>
		peak === null ? null : exactBytes(peak, `previousHistorySnapshot.peaks[${index}]`, 32)
	);
	return { peaks, size: record.size as number };
}

function captureInput(input: CloseSetHistoryCommitmentInput): {
	readonly anchorBytes: Uint8Array;
	readonly charges: Map<string, number>;
	readonly frontier: string[];
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly previousHistorySnapshot: AccumulatorSnapshot;
	readonly vertices: Map<string, EpochVertex>;
} {
	const record = exactDataRecord(input, INPUT_KEYS, "close-set history input");
	if (!Number.isSafeInteger(record.maxEpochBytes) || (record.maxEpochBytes as number) < 1) {
		throw new RangeError("maxEpochBytes must be a positive safe integer");
	}
	if (!Number.isSafeInteger(record.maxEpochVertices) || (record.maxEpochVertices as number) < 1) {
		throw new RangeError("maxEpochVertices must be a positive safe integer");
	}
	const frontier = exactDenseArray(record.frontier, "frontier").map((hash) => {
		assertDigest(hash, "frontier member");
		return hash;
	});
	if (frontier.length === 0 || new Set(frontier).size !== frontier.length) {
		throw new TypeError("frontier must be nonempty and duplicate-free");
	}
	return {
		anchorBytes: exactBytes(record.exactCanonicalEpochAnchorPreimageBytes, "exact epoch anchor preimage"),
		charges: captureCharges(record.authenticatedCanonicalPreimageByteLengths),
		frontier,
		maxEpochBytes: record.maxEpochBytes as number,
		maxEpochVertices: record.maxEpochVertices as number,
		previousHistorySnapshot: captureSnapshot(record.previousHistorySnapshot),
		vertices: captureVertices(record.vertices),
	};
}

/**
 * Derives one deterministic close-set membership root and append-only history extension.
 * @param input - Closed authenticated anchor, graph, byte-census and prior-history evidence.
 * @returns Detached commitment and accumulator evidence.
 */
export async function deriveCloseSetHistoryCommitment(
	input: CloseSetHistoryCommitmentInput
): Promise<CloseSetHistoryCommitment> {
	const captured = captureInput(input);
	const anchor = captureAnchor(captured.anchorBytes);
	const anchorHash = hex(hashDomain("ts-drp/epoch-anchor/v3", captured.anchorBytes));
	const graphAnchor = captured.vertices.get(anchorHash);
	if (
		graphAnchor?.kind !== "drp-epoch-anchor" ||
		graphAnchor.objectId !== anchor.objectId ||
		graphAnchor.epoch !== anchor.epoch
	) {
		invalidAnchor("graph anchor does not match the authenticated preimage");
	}
	const order = topologicalOrder(captured.vertices, anchorHash);
	if (captured.vertices.size > captured.maxEpochVertices) {
		throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "active graph exceeds maxEpochVertices");
	}
	const causality = new CausalityIndex(captured.vertices, order);
	if (
		captured.frontier.includes(anchorHash) &&
		(captured.frontier.length !== 1 || captured.frontier[0] !== anchorHash)
	) {
		throw new TypeError("the anchor is only valid as the sole empty frontier member");
	}
	for (const member of captured.frontier) {
		if (!captured.vertices.has(member)) {
			throw new LinearizationError("MISSING_VERTEX", `frontier member ${member} is missing`);
		}
		if (member !== anchorHash && captured.vertices.get(member)?.kind !== "drp-vertex") {
			throw new TypeError("nonempty frontier members must be ordinary vertices");
		}
	}
	for (let left = 0; left < captured.frontier.length; left++) {
		for (let right = left + 1; right < captured.frontier.length; right++) {
			if (causality.areRelated(captured.frontier[left] as string, captured.frontier[right] as string)) {
				throw new LinearizationError("CAUSALITY_VIOLATION", "distinct frontier members must be unrelated");
			}
		}
	}
	const closed = new Set<string>();
	const pending = [...captured.frontier];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		if (current === anchorHash || closed.has(current)) continue;
		closed.add(current);
		for (const dependency of (captured.vertices.get(current) as EpochVertex).dependencies) pending.push(dependency);
	}
	const closeSetOrder = order.filter((hash) => closed.has(hash));
	if (captured.charges.size !== closeSetOrder.length) invalidCharges("byte charge keyset differs from the close set");
	let totalBytes = 0;
	for (const hash of closeSetOrder) {
		const charge = captured.charges.get(hash);
		if (!Number.isSafeInteger(charge) || (charge as number) < 1) invalidCharges(`invalid byte charge for ${hash}`);
		if ((charge as number) > Number.MAX_SAFE_INTEGER - totalBytes) invalidCharges("byte charge sum is unsafe");
		totalBytes += charge as number;
	}
	for (const key of captured.charges.keys())
		if (!closed.has(key)) invalidCharges("byte charge keyset differs from the close set");
	if (totalBytes > captured.maxEpochBytes) {
		throw new LinearizationError("EPOCH_CAPACITY_EXCEEDED", "close set exceeds maxEpochBytes");
	}
	if (closeSetOrder.length > Number.MAX_SAFE_INTEGER - anchor.historySize) {
		throw new RangeError("history size exceeds the safe-integer range");
	}
	let previousAccumulator: CompactMerkleAccumulator;
	try {
		previousAccumulator = CompactMerkleAccumulator.fromSnapshot(captured.previousHistorySnapshot);
	} catch (error) {
		if (error instanceof RangeError) throw error;
		throw new TypeError("previous history snapshot is invalid", { cause: error });
	}
	if (previousAccumulator.size !== anchor.historySize || hex(previousAccumulator.root()) !== anchor.historyRoot) {
		invalidAnchor("previous history snapshot does not match the authenticated anchor");
	}
	const closeSetEntries = closeSetOrder.map(
		(vertexHash, index): CloseSetHistoryEntry => ({
			authenticatedCanonicalPreimageByteLength: captured.charges.get(vertexHash) as number,
			exactCanonicalHistoryLeafBytes: encodeCanonical({
				epoch: anchor.epoch,
				kind: "drp-history-leaf",
				objectId: anchor.objectId,
				ordinal: anchor.historySize + index,
				protocolMajor: 3,
				vertexHash,
			}),
			ordinal: anchor.historySize + index,
			vertexHash,
		})
	);
	const closeSetTree = await buildMerkleTree(closeSetEntries.map((entry) => entry.exactCanonicalHistoryLeafBytes));
	await previousAccumulator.appendMany(closeSetEntries.map((entry) => entry.exactCanonicalHistoryLeafBytes));
	return Object.freeze({
		anchorHash,
		closeSetCount: closeSetEntries.length,
		closeSetEntries: Object.freeze(
			closeSetEntries.map((entry) =>
				Object.freeze({
					...entry,
					exactCanonicalHistoryLeafBytes: new Uint8Array(entry.exactCanonicalHistoryLeafBytes),
				})
			)
		),
		closeSetOrder: Object.freeze([...closeSetOrder]),
		closeSetRoot: hex(closeSetTree.root),
		historyRoot: hex(previousAccumulator.root()),
		historySize: previousAccumulator.size,
		historySnapshot: previousAccumulator.snapshot(),
	});
}
