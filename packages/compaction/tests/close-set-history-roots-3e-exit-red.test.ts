import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as compaction from "../src/index.js";
import {
	type AccumulatorSnapshot,
	type CloseSetHistoryCommitment,
	type CloseSetHistoryCommitmentInput,
	type CloseSetHistoryEntry,
	CompactMerkleAccumulator,
	type EpochVertex,
	type deriveCloseSetHistoryCommitment as exportedDeriveCloseSetHistoryCommitment,
	LinearizationError,
} from "../src/index.js";

interface ExpectedCloseSetHistoryCommitmentInput {
	readonly authenticatedCanonicalPreimageByteLengths: ReadonlyMap<string, number>;
	readonly exactCanonicalEpochAnchorPreimageBytes: Uint8Array;
	readonly frontier: readonly string[];
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly previousHistorySnapshot: AccumulatorSnapshot;
	readonly vertices: ReadonlyMap<string, EpochVertex>;
}

interface ExpectedCloseSetHistoryEntry {
	readonly authenticatedCanonicalPreimageByteLength: number;
	readonly exactCanonicalHistoryLeafBytes: Uint8Array;
	readonly ordinal: number;
	readonly vertexHash: string;
}

interface ExpectedCloseSetHistoryCommitment {
	readonly anchorHash: string;
	readonly closeSetCount: number;
	readonly closeSetEntries: readonly ExpectedCloseSetHistoryEntry[];
	readonly closeSetOrder: readonly string[];
	readonly closeSetRoot: string;
	readonly historyRoot: string;
	readonly historySize: number;
	readonly historySnapshot: AccumulatorSnapshot;
}

type DeriveCloseSetHistoryCommitment = (input: CloseSetHistoryCommitmentInput) => Promise<CloseSetHistoryCommitment>;

const candidate = Reflect.get(
	compaction as unknown as Readonly<Record<string, unknown>>,
	"deriveCloseSetHistoryCommitment"
);
const derive = candidate as DeriveCloseSetHistoryCommitment;

const HISTORY_LEAF_CANONICAL_HEX =
	"080605046b696e6405106472702d686973746f72792d6c656166050565706f6368030e05076f7264696e616c030005086f626a6563744964050e6f626a6563743a686973746f7279050a76657274657848617368054033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330333033303330050d70726f746f636f6c4d616a6f720306";
const OBJECT_ID = "object:history";
const EPOCH = 7;
const VERTEX_A = "30".repeat(32);
const VERTEX_B = "31".repeat(32);
const VERTEX_C = "32".repeat(32);
const EMPTY_ROOT = sha256Hex(new Uint8Array());

function bytesFromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256(...parts: readonly Uint8Array[]): Uint8Array {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return new Uint8Array(hash.digest());
}

function sha256Hex(...parts: readonly Uint8Array[]): string {
	return hex(sha256(...parts));
}

function leafHash(value: Uint8Array): Uint8Array {
	return sha256(Uint8Array.of(0), value);
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
	return sha256(Uint8Array.of(1), left, right);
}

function referenceRoot(values: readonly Uint8Array[]): string {
	if (values.length === 0) return EMPTY_ROOT;
	const range = (start: number, length: number): Uint8Array => {
		if (length === 1) return leafHash(values[start] as Uint8Array);
		const split = 2 ** Math.floor(Math.log2(length - 1));
		return nodeHash(range(start, split), range(start + split, length - split));
	};
	return hex(range(0, values.length));
}

function historyLeaf(vertexHash: string, ordinal: number, objectId = OBJECT_ID, epoch = EPOCH): Uint8Array {
	return encodeCanonical({
		epoch,
		kind: "drp-history-leaf",
		objectId,
		ordinal,
		protocolMajor: 3,
		vertexHash,
	});
}

function anchorBytes(
	input: {
		readonly epoch?: number;
		readonly historyRoot?: string;
		readonly historySize?: number;
		readonly objectId?: string;
	} = {}
): Uint8Array {
	return encodeCanonical({
		aclDigest: "07".repeat(32),
		archiveIndexRoot: EMPTY_ROOT,
		blueprintDigest: "0a".repeat(32),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "05".repeat(32),
		epoch: input.epoch ?? EPOCH,
		historyRoot: input.historyRoot ?? EMPTY_ROOT,
		historySize: input.historySize ?? 0,
		kind: "drp-epoch-anchor",
		objectId: input.objectId ?? OBJECT_ID,
		parametersDigest: "0c".repeat(32),
		previousAnchor: "04".repeat(32),
		profileDigest: "0d".repeat(32),
		protocolMajor: 3,
		signerSetDigest: "0b".repeat(32),
		stateDigest: "06".repeat(32),
	});
}

function anchorHash(bytes: Uint8Array): string {
	return hex(hashDomain("ts-drp/epoch-anchor/v3", bytes));
}

function decodeCanonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("invalid test record");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function anchorVertex(hash: string, objectId = OBJECT_ID, epoch = EPOCH): EpochVertex {
	return { dependencies: [], epoch, hash, kind: "drp-epoch-anchor", objectId };
}

function vertex(
	hash: string,
	anchor: string,
	dependencies: string[],
	objectId = OBJECT_ID,
	epoch = EPOCH
): EpochVertex {
	return { anchor, dependencies, epoch, hash, kind: "drp-vertex", objectId };
}

function baseInput(): CloseSetHistoryCommitmentInput {
	const exactCanonicalEpochAnchorPreimageBytes = anchorBytes();
	const anchor = anchorHash(exactCanonicalEpochAnchorPreimageBytes);
	return {
		authenticatedCanonicalPreimageByteLengths: new Map([[VERTEX_A, 91]]),
		exactCanonicalEpochAnchorPreimageBytes,
		frontier: [VERTEX_A],
		maxEpochBytes: 1024,
		maxEpochVertices: 8,
		previousHistorySnapshot: new CompactMerkleAccumulator().snapshot(),
		vertices: new Map([
			[anchor, anchorVertex(anchor)],
			[VERTEX_A, vertex(VERTEX_A, anchor, [anchor])],
		]),
	};
}

function maximumSnapshot(): AccumulatorSnapshot {
	return {
		peaks: Array.from({ length: 53 }, (_, index) => new Uint8Array(32).fill(index + 1)),
		size: Number.MAX_SAFE_INTEGER,
	};
}

function inputFor(
	exactCanonicalEpochAnchorPreimageBytes: Uint8Array,
	ordinaryVertices: readonly EpochVertex[],
	frontier: readonly string[],
	charges: ReadonlyMap<string, number>,
	previousHistorySnapshot: AccumulatorSnapshot = new CompactMerkleAccumulator().snapshot()
): CloseSetHistoryCommitmentInput {
	const anchor = anchorHash(exactCanonicalEpochAnchorPreimageBytes);
	return {
		authenticatedCanonicalPreimageByteLengths: charges,
		exactCanonicalEpochAnchorPreimageBytes,
		frontier,
		maxEpochBytes: 4096,
		maxEpochVertices: 16,
		previousHistorySnapshot,
		vertices: new Map([
			[anchor, anchorVertex(anchor, ordinaryVertices[0]?.objectId ?? OBJECT_ID, ordinaryVertices[0]?.epoch ?? EPOCH)],
			...ordinaryVertices.map((entry) => [entry.hash, entry] as const),
		]),
	};
}

function emptyCloseInputForSnapshot(
	previousHistorySnapshot: AccumulatorSnapshot,
	historyRoot: string
): CloseSetHistoryCommitmentInput {
	const exactCanonicalEpochAnchorPreimageBytes = anchorBytes({
		historyRoot,
		historySize: previousHistorySnapshot.size,
	});
	const anchor = anchorHash(exactCanonicalEpochAnchorPreimageBytes);
	return {
		authenticatedCanonicalPreimageByteLengths: new Map(),
		exactCanonicalEpochAnchorPreimageBytes,
		frontier: [anchor],
		maxEpochBytes: 4096,
		maxEpochVertices: 16,
		previousHistorySnapshot,
		vertices: new Map([[anchor, anchorVertex(anchor)]]),
	};
}

function resizableArrayBuffer(byteLength: number): ArrayBuffer | undefined {
	try {
		const Constructor = ArrayBuffer as unknown as new (
			length: number,
			options: Readonly<{ readonly maxByteLength: number }>
		) => ArrayBuffer;
		const backing = new Constructor(byteLength, { maxByteLength: byteLength * 2 });
		return Reflect.get(backing, "resizable") === true ? backing : undefined;
	} catch {
		return undefined;
	}
}

function errorCode(error: unknown): unknown {
	return error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}

describe("D.93.56 Phase 3 exit-a close-set and history-root derivation RED", () => {
	it("pins the frozen history-leaf vector and an independent RFC 9162 reference", () => {
		const literal = bytesFromHex(HISTORY_LEAF_CANONICAL_HEX);
		expect(historyLeaf(VERTEX_A, 0)).toEqual(literal);
		expect(referenceRoot([literal])).toBe(sha256Hex(Uint8Array.of(0), literal));
		expect(referenceRoot([])).toBe(EMPTY_ROOT);
		const threeLeaves = [literal, historyLeaf(VERTEX_B, 1), historyLeaf(VERTEX_C, 2)];
		expect(referenceRoot(threeLeaves)).toBe(
			hex(
				nodeHash(
					nodeHash(leafHash(threeLeaves[0] as Uint8Array), leafHash(threeLeaves[1] as Uint8Array)),
					leafHash(threeLeaves[2] as Uint8Array)
				)
			)
		);
	});

	it("fails RED only because the package-owned derivation is absent", () => {
		expectTypeOf<CloseSetHistoryCommitmentInput>().toEqualTypeOf<ExpectedCloseSetHistoryCommitmentInput>();
		expectTypeOf<CloseSetHistoryEntry>().toEqualTypeOf<ExpectedCloseSetHistoryEntry>();
		expectTypeOf<CloseSetHistoryCommitment>().toEqualTypeOf<ExpectedCloseSetHistoryCommitment>();
		expectTypeOf<typeof exportedDeriveCloseSetHistoryCommitment>().toEqualTypeOf<DeriveCloseSetHistoryCommitment>();
		expect(candidate, "PHASE_3_EXIT_A_HISTORY_DERIVATION_ABSENT").toBeTypeOf("function");
	});
});

describe.skipIf(typeof candidate !== "function")("D.93.56 close-set derivation GREEN contract", () => {
	it("derives the literal one-leaf close and returns detached evidence", async () => {
		const input = baseInput();
		const result = await derive(input);
		const literal = bytesFromHex(HISTORY_LEAF_CANONICAL_HEX);
		const expectedRoot = referenceRoot([literal]);

		expect(result).toMatchObject({
			anchorHash: anchorHash(input.exactCanonicalEpochAnchorPreimageBytes),
			closeSetCount: 1,
			closeSetOrder: [VERTEX_A],
			closeSetRoot: expectedRoot,
			historyRoot: expectedRoot,
			historySize: 1,
		});
		expect(result.closeSetEntries).toEqual([
			{
				authenticatedCanonicalPreimageByteLength: 91,
				exactCanonicalHistoryLeafBytes: literal,
				ordinal: 0,
				vertexHash: VERTEX_A,
			},
		]);
		const rootBeforeMutation = result.historyRoot;
		result.closeSetEntries[0]?.exactCanonicalHistoryLeafBytes.fill(0xff);
		result.historySnapshot.peaks[0]?.fill(0xff);
		const repeated = await derive(baseInput());
		expect(repeated.historyRoot).toBe(rootBeforeMutation);
	});

	it("is insertion-order independent and admits proper-subset, competing and multi-member closes", async () => {
		const bytes = anchorBytes();
		const anchor = anchorHash(bytes);
		const entries = [
			[anchor, anchorVertex(anchor)],
			[VERTEX_A, vertex(VERTEX_A, anchor, [anchor])],
			[VERTEX_B, vertex(VERTEX_B, anchor, [anchor])],
			[VERTEX_C, vertex(VERTEX_C, anchor, [VERTEX_A])],
		] as const;
		const make = (
			reverse: boolean,
			frontier: readonly string[],
			charges: ReadonlyMap<string, number>
		): CloseSetHistoryCommitmentInput => ({
			authenticatedCanonicalPreimageByteLengths: charges,
			exactCanonicalEpochAnchorPreimageBytes: bytes,
			frontier,
			maxEpochBytes: 1024,
			maxEpochVertices: 8,
			previousHistorySnapshot: new CompactMerkleAccumulator().snapshot(),
			vertices: new Map(reverse ? [...entries].reverse() : entries),
		});
		const allCharges = new Map([
			[VERTEX_A, 91],
			[VERTEX_B, 92],
			[VERTEX_C, 93],
		]);
		const [forward, reverse] = await Promise.all([
			derive(make(false, [VERTEX_B, VERTEX_C], allCharges)),
			derive(make(true, [VERTEX_C, VERTEX_B], allCharges)),
		]);
		const leafA = historyLeaf(VERTEX_A, 0);
		const leafB = historyLeaf(VERTEX_B, 1);
		const leafC = historyLeaf(VERTEX_C, 2);
		expect(forward.closeSetOrder).toEqual([VERTEX_A, VERTEX_B, VERTEX_C]);
		expect(forward.closeSetRoot).toBe(referenceRoot([leafA, leafB, leafC]));
		expect(reverse).toEqual(forward);

		const [candidateA, candidateB] = await Promise.all([
			derive(make(false, [VERTEX_A], new Map([[VERTEX_A, 91]]))),
			derive(make(false, [VERTEX_B], new Map([[VERTEX_B, 92]]))),
		]);
		expect(candidateA.closeSetOrder).toEqual([VERTEX_A]);
		expect(candidateB.closeSetOrder).toEqual([VERTEX_B]);
		expect(candidateA.closeSetRoot).not.toBe(candidateB.closeSetRoot);
	});

	it("supports the anchor-only empty close and anchor-bound next-epoch continuity", async () => {
		const emptyInput = baseInput();
		const firstAnchor = anchorHash(emptyInput.exactCanonicalEpochAnchorPreimageBytes);
		const empty = await derive({
			...emptyInput,
			authenticatedCanonicalPreimageByteLengths: new Map(),
			frontier: [firstAnchor],
		});
		expect(empty).toMatchObject({ closeSetCount: 0, closeSetOrder: [], closeSetRoot: EMPTY_ROOT });
		expect(empty.historyRoot).toBe(EMPTY_ROOT);
		expect(empty.historySize).toBe(0);
		expect(empty.historySnapshot).not.toBe(emptyInput.previousHistorySnapshot);
		const emptyInputSnapshot = structuredClone(emptyInput.previousHistorySnapshot);
		empty.historySnapshot.peaks.push(new Uint8Array(32).fill(0xff));
		expect(emptyInput.previousHistorySnapshot).toEqual(emptyInputSnapshot);

		const first = await derive(baseInput());
		const secondAnchorBytes = anchorBytes({ epoch: EPOCH + 1, historyRoot: first.historyRoot, historySize: 1 });
		const secondAnchor = anchorHash(secondAnchorBytes);
		const retainedEmpty = await derive({
			authenticatedCanonicalPreimageByteLengths: new Map(),
			exactCanonicalEpochAnchorPreimageBytes: secondAnchorBytes,
			frontier: [secondAnchor],
			maxEpochBytes: 1024,
			maxEpochVertices: 8,
			previousHistorySnapshot: first.historySnapshot,
			vertices: new Map([[secondAnchor, anchorVertex(secondAnchor, OBJECT_ID, EPOCH + 1)]]),
		});
		expect(retainedEmpty).toMatchObject({
			closeSetCount: 0,
			closeSetOrder: [],
			closeSetRoot: EMPTY_ROOT,
			historyRoot: first.historyRoot,
			historySize: 1,
		});
		expect(retainedEmpty.historySnapshot).toEqual(first.historySnapshot);
		expect(retainedEmpty.historySnapshot).not.toBe(first.historySnapshot);
		expect(retainedEmpty.historySnapshot.peaks[0]).not.toBe(first.historySnapshot.peaks[0]);
		const second = await derive({
			authenticatedCanonicalPreimageByteLengths: new Map([[VERTEX_B, 92]]),
			exactCanonicalEpochAnchorPreimageBytes: secondAnchorBytes,
			frontier: [VERTEX_B],
			maxEpochBytes: 1024,
			maxEpochVertices: 8,
			previousHistorySnapshot: first.historySnapshot,
			vertices: new Map([
				[secondAnchor, anchorVertex(secondAnchor, OBJECT_ID, EPOCH + 1)],
				[VERTEX_B, vertex(VERTEX_B, secondAnchor, [secondAnchor], OBJECT_ID, EPOCH + 1)],
			]),
		});
		expect(second).toMatchObject({ historySize: 2 });
		expect(second.closeSetRoot).toBe(referenceRoot([historyLeaf(VERTEX_B, 1, OBJECT_ID, EPOCH + 1)]));
		expect(second.historyRoot).toBe(
			referenceRoot([historyLeaf(VERTEX_A, 0), historyLeaf(VERTEX_B, 1, OBJECT_ID, EPOCH + 1)])
		);
		expect(second.closeSetRoot).not.toBe(second.historyRoot);
		expect(second.historySnapshot).not.toBe(first.historySnapshot);
		expect(second.historySnapshot.peaks[0]).not.toBe(first.historySnapshot.peaks[0]);

		await expect(derive({ ...baseInput(), previousHistorySnapshot: first.historySnapshot })).rejects.toSatisfy(
			(error: unknown) => errorCode(error) === "INVALID_ANCHOR"
		);
	});

	it("rejects mixed anchor, graph, frontier, charge and capacity evidence by semantic class", async () => {
		const valid = baseInput();
		const validAnchor = anchorHash(valid.exactCanonicalEpochAnchorPreimageBytes);
		const foreignBytes = anchorBytes({ objectId: "object:foreign" });
		const updatedHistoryBytes = anchorBytes({ historyRoot: "ab".repeat(32), historySize: 1 });
		const selfConsistentMalformedAnchor = (
			replacement: Readonly<Record<string, unknown>>
		): CloseSetHistoryCommitmentInput => {
			const exactCanonicalEpochAnchorPreimageBytes = encodeCanonical({
				...decodeCanonicalRecord(anchorBytes()),
				...replacement,
			});
			const anchor = anchorHash(exactCanonicalEpochAnchorPreimageBytes);
			return inputFor(
				exactCanonicalEpochAnchorPreimageBytes,
				[vertex(VERTEX_A, anchor, [anchor])],
				[VERTEX_A],
				new Map([[VERTEX_A, 91]])
			);
		};
		const cases: ReadonlyArray<readonly [string, CloseSetHistoryCommitmentInput, string]> = [
			[
				"mixed anchor bytes and graph",
				{ ...valid, exactCanonicalEpochAnchorPreimageBytes: foreignBytes },
				"INVALID_ANCHOR",
			],
			[
				"same anchor fields updated without matching graph",
				{ ...valid, exactCanonicalEpochAnchorPreimageBytes: updatedHistoryBytes },
				"INVALID_ANCHOR",
			],
			["extra canonical anchor field", selfConsistentMalformedAnchor({ extra: true }), "INVALID_ANCHOR"],
			["self-consistent wrong protocol major", selfConsistentMalformedAnchor({ protocolMajor: 4 }), "INVALID_ANCHOR"],
			[
				"self-consistent wrong crypto suite",
				selfConsistentMalformedAnchor({ cryptoSuiteId: "ed25519-sha256-v4" }),
				"INVALID_ANCHOR",
			],
			[
				"self-consistent malformed digest",
				selfConsistentMalformedAnchor({ aclDigest: "g".repeat(64) }),
				"INVALID_ANCHOR",
			],
			["self-consistent invalid history size", selfConsistentMalformedAnchor({ historySize: -1 }), "INVALID_ANCHOR"],
			["missing charge", { ...valid, authenticatedCanonicalPreimageByteLengths: new Map() }, "INVALID_BYTE_CHARGES"],
			[
				"extra charge",
				{
					...valid,
					authenticatedCanonicalPreimageByteLengths: new Map([
						[VERTEX_A, 91],
						[VERTEX_B, 92],
					]),
				},
				"INVALID_BYTE_CHARGES",
			],
			[
				"anchor charge",
				{
					...valid,
					authenticatedCanonicalPreimageByteLengths: new Map([
						[validAnchor, 1],
						[VERTEX_A, 91],
					]),
				},
				"INVALID_BYTE_CHARGES",
			],
			[
				"zero charge",
				{ ...valid, authenticatedCanonicalPreimageByteLengths: new Map([[VERTEX_A, 0]]) },
				"INVALID_BYTE_CHARGES",
			],
			[
				"negative charge",
				{ ...valid, authenticatedCanonicalPreimageByteLengths: new Map([[VERTEX_A, -1]]) },
				"INVALID_BYTE_CHARGES",
			],
			[
				"fractional charge",
				{ ...valid, authenticatedCanonicalPreimageByteLengths: new Map([[VERTEX_A, 1.5]]) },
				"INVALID_BYTE_CHARGES",
			],
			[
				"unsafe charge",
				{
					...valid,
					authenticatedCanonicalPreimageByteLengths: new Map([[VERTEX_A, Number.MAX_SAFE_INTEGER + 1]]),
				},
				"INVALID_BYTE_CHARGES",
			],
			["vertex capacity", { ...valid, maxEpochVertices: 1 }, "EPOCH_CAPACITY_EXCEEDED"],
			["byte capacity", { ...valid, maxEpochBytes: 90 }, "EPOCH_CAPACITY_EXCEEDED"],
			["empty frontier", { ...valid, frontier: [] }, "TYPE_ERROR"],
			["duplicate frontier", { ...valid, frontier: [VERTEX_A, VERTEX_A] }, "TYPE_ERROR"],
			["foreign frontier", { ...valid, frontier: [VERTEX_B] }, "MISSING_VERTEX"],
			[
				"related distinct frontier",
				{
					...valid,
					authenticatedCanonicalPreimageByteLengths: new Map([
						[VERTEX_A, 91],
						[VERTEX_C, 93],
					]),
					frontier: [VERTEX_A, VERTEX_C],
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor)],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [validAnchor])],
						[VERTEX_C, vertex(VERTEX_C, validAnchor, [VERTEX_A])],
					]),
				},
				"CAUSALITY_VIOLATION",
			],
			[
				"graph anchor has the wrong object",
				{
					...valid,
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor, "object:wrong")],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [validAnchor], "object:wrong")],
					]),
				},
				"INVALID_ANCHOR",
			],
			[
				"graph anchor has the wrong epoch",
				{
					...valid,
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor, OBJECT_ID, EPOCH + 1)],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [validAnchor], OBJECT_ID, EPOCH + 1)],
					]),
				},
				"INVALID_ANCHOR",
			],
			[
				"wrong epoch",
				{
					...valid,
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor)],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [validAnchor], OBJECT_ID, EPOCH + 1)],
					]),
				},
				"WRONG_EPOCH",
			],
			[
				"wrong object",
				{
					...valid,
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor)],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [validAnchor], "object:wrong")],
					]),
				},
				"WRONG_EPOCH",
			],
			[
				"missing dependency",
				{
					...valid,
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor)],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [VERTEX_B])],
					]),
				},
				"MISSING_DEPENDENCY",
			],
			[
				"cycle",
				{
					...valid,
					authenticatedCanonicalPreimageByteLengths: new Map([
						[VERTEX_A, 91],
						[VERTEX_B, 92],
					]),
					frontier: [VERTEX_A],
					vertices: new Map([
						[validAnchor, anchorVertex(validAnchor)],
						[VERTEX_A, vertex(VERTEX_A, validAnchor, [VERTEX_B])],
						[VERTEX_B, vertex(VERTEX_B, validAnchor, [VERTEX_A])],
					]),
				},
				"CYCLE",
			],
		];
		for (const [label, input, code] of cases) {
			await expect(derive(input), label).rejects.toSatisfy((error: unknown) =>
				code === "TYPE_ERROR"
					? error instanceof TypeError
					: error instanceof LinearizationError && errorCode(error) === code
			);
		}
	});

	it("rejects stale snapshots, invalid bounds and safe-integer history overflow", async () => {
		const stale = new CompactMerkleAccumulator();
		stale.append(Uint8Array.of(0x41));
		await expect(derive({ ...baseInput(), previousHistorySnapshot: stale.snapshot() })).rejects.toSatisfy(
			(error: unknown) => error instanceof LinearizationError && errorCode(error) === "INVALID_ANCHOR"
		);
		await expect(
			derive({
				...baseInput(),
				previousHistorySnapshot: { peaks: [bytesFromHex(EMPTY_ROOT)], size: 1 },
			})
		).rejects.toSatisfy(
			(error: unknown) => error instanceof LinearizationError && errorCode(error) === "INVALID_ANCHOR"
		);

		for (const input of [
			{ ...baseInput(), maxEpochBytes: 0 },
			{ ...baseInput(), maxEpochBytes: -1 },
			{ ...baseInput(), maxEpochVertices: 0 },
			{ ...baseInput(), maxEpochVertices: 1.5 },
			{ ...baseInput(), maxEpochBytes: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			await expect(derive(input)).rejects.toBeInstanceOf(RangeError);
		}

		const previousHistorySnapshot = maximumSnapshot();
		const accumulator = CompactMerkleAccumulator.fromSnapshot(previousHistorySnapshot);
		const overflowAnchorBytes = anchorBytes({
			historyRoot: hex(accumulator.root()),
			historySize: Number.MAX_SAFE_INTEGER,
		});
		const overflowAnchor = anchorHash(overflowAnchorBytes);
		await expect(
			derive(
				inputFor(
					overflowAnchorBytes,
					[vertex(VERTEX_A, overflowAnchor, [overflowAnchor])],
					[VERTEX_A],
					new Map([[VERTEX_A, 91]]),
					previousHistorySnapshot
				)
			)
		).rejects.toBeInstanceOf(RangeError);
	});

	it("rejects non-ordinary structures and captures inputs before asynchronous work", async () => {
		const valid = baseInput();
		const validAnchor = anchorHash(valid.exactCanonicalEpochAnchorPreimageBytes);
		const accessorVertex = Object.defineProperty({ ...vertex(VERTEX_A, validAnchor, [validAnchor]) }, "objectId", {
			enumerable: true,
			get: () => OBJECT_ID,
		}) as EpochVertex;
		const foreignDependencies = Object.assign(Object.create(Array.prototype) as string[], {
			0: validAnchor,
			length: 1,
		});
		const offsetBacking = new ArrayBuffer(valid.exactCanonicalEpochAnchorPreimageBytes.byteLength + 1);
		const offsetBytes = new Uint8Array(offsetBacking, 1);
		offsetBytes.set(valid.exactCanonicalEpochAnchorPreimageBytes);
		const foreignVertices = new Map(valid.vertices);
		Object.setPrototypeOf(foreignVertices, Object.create(Map.prototype));
		const foreignCharges = new Map(valid.authenticatedCanonicalPreimageByteLengths);
		Object.setPrototypeOf(foreignCharges, Object.create(Map.prototype));
		const foreignFrontier = [VERTEX_A];
		Object.setPrototypeOf(foreignFrontier, Object.create(Array.prototype));
		const foreignVertex = { ...vertex(VERTEX_A, validAnchor, [validAnchor]) };
		Object.setPrototypeOf(foreignVertex, Object.create(Object.prototype));
		const foreignPeaks: Array<Uint8Array | null> = [];
		Object.setPrototypeOf(foreignPeaks, Object.create(Array.prototype));
		const accessorSnapshot = Object.defineProperty({ peaks: [], size: 0 }, "size", {
			enumerable: true,
			get: () => 0,
		});
		const foreignSnapshot = { peaks: [], size: 0 };
		Object.setPrototypeOf(foreignSnapshot, Object.create(Object.prototype));
		const hostileInputs: CloseSetHistoryCommitmentInput[] = [
			{
				...valid,
				vertices: Object.create(Map.prototype) as ReadonlyMap<string, EpochVertex>,
			},
			{
				...valid,
				authenticatedCanonicalPreimageByteLengths: Object.create(Map.prototype) as ReadonlyMap<string, number>,
			},
			{ ...valid, vertices: foreignVertices },
			{ ...valid, authenticatedCanonicalPreimageByteLengths: foreignCharges },
			{
				...valid,
				frontier: Object.assign(Object.create(Array.prototype) as string[], { 0: VERTEX_A, length: 1 }),
			},
			{ ...valid, frontier: foreignFrontier },
			{ ...valid, exactCanonicalEpochAnchorPreimageBytes: offsetBytes },
			{
				...valid,
				vertices: new Map([
					[validAnchor, anchorVertex(validAnchor)],
					[VERTEX_A, accessorVertex],
				]),
			},
			{
				...valid,
				vertices: new Map([
					[validAnchor, anchorVertex(validAnchor)],
					[VERTEX_A, foreignVertex],
				]),
			},
			{
				...valid,
				vertices: new Map([
					[validAnchor, anchorVertex(validAnchor)],
					[VERTEX_A, vertex(VERTEX_A, validAnchor, foreignDependencies)],
				]),
			},
			{
				...valid,
				previousHistorySnapshot: {
					peaks: Object.create(Array.prototype) as Array<Uint8Array | null>,
					size: 0,
				},
			},
			{ ...valid, previousHistorySnapshot: { peaks: foreignPeaks, size: 0 } },
			{
				...valid,
				previousHistorySnapshot: {} as AccumulatorSnapshot,
			},
			{
				...valid,
				previousHistorySnapshot: { extra: true, peaks: [], size: 0 } as unknown as AccumulatorSnapshot,
			},
			{
				...valid,
				previousHistorySnapshot: accessorSnapshot as AccumulatorSnapshot,
			},
			{
				...valid,
				previousHistorySnapshot: foreignSnapshot as AccumulatorSnapshot,
			},
		];
		if (typeof SharedArrayBuffer !== "undefined") {
			const sharedAnchorBytes = new Uint8Array(
				new SharedArrayBuffer(valid.exactCanonicalEpochAnchorPreimageBytes.byteLength)
			);
			sharedAnchorBytes.set(valid.exactCanonicalEpochAnchorPreimageBytes);
			const sharedAnchor = anchorHash(sharedAnchorBytes);
			hostileInputs.push(
				inputFor(
					sharedAnchorBytes,
					[vertex(VERTEX_A, sharedAnchor, [sharedAnchor])],
					[VERTEX_A],
					new Map([[VERTEX_A, 91]])
				)
			);
			const sharedPeak = new Uint8Array(new SharedArrayBuffer(32));
			sharedPeak.fill(0x41);
			hostileInputs.push(emptyCloseInputForSnapshot({ peaks: [sharedPeak], size: 1 }, hex(sharedPeak)));
		}
		const resizableAnchorBacking = resizableArrayBuffer(valid.exactCanonicalEpochAnchorPreimageBytes.byteLength);
		if (resizableAnchorBacking !== undefined) {
			const resizableAnchorBytes = new Uint8Array(resizableAnchorBacking);
			resizableAnchorBytes.set(valid.exactCanonicalEpochAnchorPreimageBytes);
			const resizableAnchor = anchorHash(resizableAnchorBytes);
			hostileInputs.push(
				inputFor(
					resizableAnchorBytes,
					[vertex(VERTEX_A, resizableAnchor, [resizableAnchor])],
					[VERTEX_A],
					new Map([[VERTEX_A, 91]])
				)
			);
		}
		const resizablePeakBacking = resizableArrayBuffer(32);
		if (resizablePeakBacking !== undefined) {
			const resizablePeak = new Uint8Array(resizablePeakBacking);
			resizablePeak.fill(0x42);
			hostileInputs.push(emptyCloseInputForSnapshot({ peaks: [resizablePeak], size: 1 }, hex(resizablePeak)));
		}
		const detachedAnchorBacking = new ArrayBuffer(valid.exactCanonicalEpochAnchorPreimageBytes.byteLength);
		const detachedAnchorBytes = new Uint8Array(detachedAnchorBacking);
		detachedAnchorBytes.set(valid.exactCanonicalEpochAnchorPreimageBytes);
		const detachedAnchor = anchorHash(detachedAnchorBytes);
		const detachedAnchorInput = inputFor(
			detachedAnchorBytes,
			[vertex(VERTEX_A, detachedAnchor, [detachedAnchor])],
			[VERTEX_A],
			new Map([[VERTEX_A, 91]])
		);
		structuredClone(detachedAnchorBacking, { transfer: [detachedAnchorBacking] });
		hostileInputs.push(detachedAnchorInput);
		const detachedPeakBacking = new ArrayBuffer(32);
		const detachedPeak = new Uint8Array(detachedPeakBacking);
		detachedPeak.fill(0x43);
		const detachedPeakInput = emptyCloseInputForSnapshot({ peaks: [detachedPeak], size: 1 }, hex(detachedPeak));
		structuredClone(detachedPeakBacking, { transfer: [detachedPeakBacking] });
		hostileInputs.push(detachedPeakInput);
		for (const input of hostileInputs) await expect(derive(input)).rejects.toBeInstanceOf(TypeError);

		const first = await derive(baseInput());
		const secondAnchorBytes = anchorBytes({ epoch: EPOCH + 1, historyRoot: first.historyRoot, historySize: 1 });
		const secondAnchor = anchorHash(secondAnchorBytes);
		const dependencies = [secondAnchor];
		const secondVertex = vertex(VERTEX_B, secondAnchor, dependencies, OBJECT_ID, EPOCH + 1);
		const frontier = [VERTEX_B];
		const charges = new Map([[VERTEX_B, 92]]);
		const vertices = new Map<string, EpochVertex>([
			[secondAnchor, anchorVertex(secondAnchor, OBJECT_ID, EPOCH + 1)],
			[VERTEX_B, secondVertex],
		]);
		const mutable: CloseSetHistoryCommitmentInput = {
			authenticatedCanonicalPreimageByteLengths: charges,
			exactCanonicalEpochAnchorPreimageBytes: secondAnchorBytes,
			frontier,
			maxEpochBytes: 1024,
			maxEpochVertices: 8,
			previousHistorySnapshot: first.historySnapshot,
			vertices,
		};
		const pending = derive(mutable);
		(mutable as { maxEpochBytes: number }).maxEpochBytes = 1;
		(mutable as { maxEpochVertices: number }).maxEpochVertices = 1;
		(first.historySnapshot as { size: number }).size = 0;
		secondAnchorBytes.fill(0xff);
		frontier[0] = VERTEX_C;
		charges.set(VERTEX_B, 999);
		(secondVertex as { objectId: string }).objectId = "object:mutated";
		(secondVertex as { hash: string }).hash = VERTEX_C;
		dependencies[0] = VERTEX_C;
		vertices.delete(VERTEX_B);
		first.historySnapshot.peaks[0]?.fill(0xee);
		const captured = await pending;
		expect(captured.closeSetEntries[0]?.authenticatedCanonicalPreimageByteLength).toBe(92);
		expect(captured.closeSetOrder).toEqual([VERTEX_B]);
		expect(captured.historySize).toBe(2);
	});

	it("keeps byte length as manifest evidence rather than a second Merkle identity", async () => {
		const first = await derive(baseInput());
		const changed = baseInput();
		(changed.authenticatedCanonicalPreimageByteLengths as Map<string, number>).set(VERTEX_A, 92);
		const second = await derive(changed);
		expect(second.closeSetEntries[0]?.authenticatedCanonicalPreimageByteLength).toBe(92);
		expect(second.closeSetRoot).toBe(first.closeSetRoot);
		expect(second.historyRoot).toBe(first.historyRoot);
	});
});
