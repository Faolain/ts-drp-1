import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { type AccumulatorSnapshot, asyncError, loadCompaction, sourceExists } from "./contract.js";

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function sha256(...parts: readonly Uint8Array[]): Uint8Array {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return new Uint8Array(hash.digest());
}

function leafHash(input: Uint8Array): Uint8Array {
	return sha256(Uint8Array.of(0), input);
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
	return sha256(Uint8Array.of(1), left, right);
}

function referenceRoot(inputs: readonly Uint8Array[]): Uint8Array {
	if (inputs.length === 0) return sha256(new Uint8Array());
	const hashRange = (start: number, length: number): Uint8Array => {
		if (length === 1) return leafHash(inputs[start] as Uint8Array);
		const split = 2 ** Math.floor(Math.log2(length - 1));
		return nodeHash(hashRange(start, split), hashRange(start + split, length - split));
	};
	return hashRange(0, inputs.length);
}

function flipFirstByte(input: Uint8Array): Uint8Array {
	const output = new Uint8Array(input);
	output[0] ^= 0x01;
	return output;
}

const fixtures = [
	bytes(),
	bytes(0),
	bytes(1, 2, 3),
	new TextEncoder().encode("phase-0b"),
	Uint8Array.from({ length: 257 }, (_, index) => index & 0xff),
];
const consistencyFixtures = Array.from({ length: 7 }, (_, index) =>
	new TextEncoder().encode(`phase-0b-consistency-${index}`)
);

describe.skipIf(!sourceExists)("Phase 0b RFC 9162-style CT Merkle contract", () => {
	it("pins empty, leaf, node, and arbitrary-size roots to an independent SHA-256 oracle", async () => {
		const module = await loadCompaction();
		expect(module.EMPTY_MERKLE_ROOT).toEqual(sha256(new Uint8Array()));
		for (const input of fixtures) expect(await module.merkleLeafHash(input)).toEqual(leafHash(input));
		expect(await module.merkleNodeHash(leafHash(fixtures[0]), leafHash(fixtures[1]))).toEqual(
			nodeHash(leafHash(fixtures[0]), leafHash(fixtures[1]))
		);

		for (let size = 0; size <= fixtures.length; size++) {
			const inputs = fixtures.slice(0, size);
			const tree = await module.buildMerkleTree(inputs, { batchSize: 2 });
			expect(tree.size).toBe(size);
			expect(tree.root).toEqual(referenceRoot(inputs));
			expect(tree.leafHashes).toEqual(inputs.map(leafHash));
			expect(await tree.hashRange(0, size)).toEqual(tree.root);
		}
	});

	it("generates and verifies every inclusion path and rejects corrupted proofs", async () => {
		const module = await loadCompaction();
		for (let size = 1; size <= fixtures.length; size++) {
			const inputs = fixtures.slice(0, size);
			const tree = await module.buildMerkleTree(inputs);
			for (let index = 0; index < size; index++) {
				const proof = await module.inclusionProof(tree, index);
				expect(await module.verifyInclusion(inputs[index] as Uint8Array, proof, tree.root)).toBe(true);
				expect(await module.verifyInclusion(bytes(99), proof, tree.root)).toBe(false);
				expect(await module.verifyInclusion(inputs[index] as Uint8Array, proof, flipFirstByte(tree.root))).toBe(false);
				if (proof.auditPath.length > 0) {
					const corrupt = {
						...proof,
						auditPath: [flipFirstByte(proof.auditPath[0] as Uint8Array), ...proof.auditPath.slice(1)],
					};
					expect(await module.verifyInclusion(inputs[index] as Uint8Array, corrupt, tree.root)).toBe(false);
				}
			}
		}
	});

	it("rejects cross-index substitution and every truncated or extended inclusion path", async () => {
		const module = await loadCompaction();
		const tree = await module.buildMerkleTree(fixtures);
		for (let index = 0; index < fixtures.length; index++) {
			const proof = await module.inclusionProof(tree, index);
			const otherIndex = (index + 1) % fixtures.length;
			expect(await module.verifyInclusion(fixtures[otherIndex] as Uint8Array, proof, tree.root)).toBe(false);
			expect(
				await module.verifyInclusion(
					fixtures[index] as Uint8Array,
					{ ...proof, auditPath: proof.auditPath.slice(0, -1) },
					tree.root
				)
			).toBe(false);
			expect(
				await module.verifyInclusion(
					fixtures[index] as Uint8Array,
					{ ...proof, auditPath: [...proof.auditPath, new Uint8Array(32)] },
					tree.root
				)
			).toBe(false);
		}
	});

	it("rejects inclusion metadata whose 32-bit alias replays a genuine five-leaf proof", async () => {
		const module = await loadCompaction();
		const tree = await module.buildMerkleTree(fixtures);
		const proof = await module.inclusionProof(tree, 0);
		expect(await module.verifyInclusion(fixtures[0], proof, tree.root)).toBe(true);
		expect(
			await module.verifyInclusion(
				fixtures[0],
				{
					...proof,
					leafIndex: 2 ** 32,
					treeSize: 2 ** 32 + tree.size,
				},
				tree.root
			)
		).toBe(false);
	});

	it("generates and verifies every prefix consistency proof and rejects corruption", async () => {
		const module = await loadCompaction();
		for (let secondSize = 0; secondSize <= fixtures.length; secondSize++) {
			const secondInputs = fixtures.slice(0, secondSize);
			const secondTree = await module.buildMerkleTree(secondInputs);
			for (let firstSize = 0; firstSize <= secondSize; firstSize++) {
				const firstTree = await module.buildMerkleTree(secondInputs.slice(0, firstSize));
				const proof = await module.consistencyProof(secondTree, firstSize);
				expect(await module.verifyConsistency(firstSize, secondSize, firstTree.root, secondTree.root, proof.path)).toBe(
					true
				);
				if (proof.path.length > 0) {
					expect(
						await module.verifyConsistency(firstSize, secondSize, firstTree.root, secondTree.root, [
							flipFirstByte(proof.path[0] as Uint8Array),
							...proof.path.slice(1),
						])
					).toBe(false);
				}
			}
		}
	});

	it("verifies the reachable even fn===sn consistency branch", async () => {
		const module = await loadCompaction();
		const firstSize = 5;
		const secondSize = 6;
		const firstTree = await module.buildMerkleTree(consistencyFixtures.slice(0, firstSize));
		const secondTree = await module.buildMerkleTree(consistencyFixtures.slice(0, secondSize));
		const proof = await module.consistencyProof(secondTree, firstSize);

		expect(await module.verifyConsistency(firstSize, secondSize, firstTree.root, secondTree.root, proof.path)).toBe(
			true
		);
	});

	it("rejects truncated, extended, and wrong-firstSize consistency-proof replays", async () => {
		const module = await loadCompaction();
		const tree = await module.buildMerkleTree(fixtures);
		for (let firstSize = 1; firstSize < fixtures.length; firstSize++) {
			const firstTree = await module.buildMerkleTree(fixtures.slice(0, firstSize));
			const proof = await module.consistencyProof(tree, firstSize);
			expect(
				await module.verifyConsistency(firstSize, fixtures.length, firstTree.root, tree.root, proof.path.slice(0, -1))
			).toBe(false);
			expect(
				await module.verifyConsistency(firstSize, fixtures.length, firstTree.root, tree.root, [
					...proof.path,
					new Uint8Array(32),
				])
			).toBe(false);
		}

		const sizeTwoTree = await module.buildMerkleTree(fixtures.slice(0, 2));
		const sizeThreeTree = await module.buildMerkleTree(fixtures.slice(0, 3));
		const sizeTwoProof = await module.consistencyProof(tree, 2);
		expect(await module.verifyConsistency(3, fixtures.length, sizeThreeTree.root, tree.root, sizeTwoProof.path)).toBe(
			false
		);
		expect(await module.verifyConsistency(3, fixtures.length, sizeTwoTree.root, tree.root, sizeTwoProof.path)).toBe(
			false
		);
	});

	it("rejects consistency metadata whose 32-bit alias replays a genuine one-to-five proof", async () => {
		const module = await loadCompaction();
		const tree = await module.buildMerkleTree(fixtures);
		const firstTree = await module.buildMerkleTree(fixtures.slice(0, 1));
		const proof = await module.consistencyProof(tree, 1);
		expect(await module.verifyConsistency(1, tree.size, firstTree.root, tree.root, proof.path)).toBe(true);
		expect(
			await module.verifyConsistency(2 ** 32 + 1, 2 ** 32 + tree.size, firstTree.root, tree.root, proof.path)
		).toBe(false);
	});

	it("keeps accumulator snapshots isolated and agrees with full-tree roots after every append", async () => {
		const module = await loadCompaction();
		const accumulator = new module.CompactMerkleAccumulator();
		const appended: Uint8Array[] = [];
		expect(accumulator.size).toBe(0);
		const sizeDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(accumulator), "size");
		expect(sizeDescriptor?.get).toBeTypeOf("function");
		expect(sizeDescriptor?.set).toBeUndefined();
		expect(await accumulator.root()).toEqual(module.EMPTY_MERKLE_ROOT);
		for (const fixture of fixtures) {
			appended.push(new Uint8Array(fixture));
			await accumulator.append(fixture);
			expect(accumulator.size).toBe(appended.length);
			expect(await accumulator.root()).toEqual((await module.buildMerkleTree(appended)).root);
		}

		const snapshot = accumulator.snapshot();
		const restored = module.CompactMerkleAccumulator.fromSnapshot(snapshot);
		const restoredRoot = await restored.root();
		snapshot.size = 0;
		snapshot.peaks.forEach((peak) => peak?.fill(0xff));
		expect(await restored.root()).toEqual(restoredRoot);

		const secondSnapshot = restored.snapshot();
		await restored.append(bytes(42));
		expect(secondSnapshot.size).toBe(fixtures.length);
		expect(await module.CompactMerkleAccumulator.fromSnapshot(secondSnapshot).root()).toEqual(restoredRoot);
	});

	it("copies caller-owned leaf bytes and yields only at validated batch boundaries", async () => {
		const module = await loadCompaction();
		const mutable = bytes(1, 2, 3);
		const tree = await module.buildMerkleTree([mutable]);
		const root = new Uint8Array(tree.root);
		mutable.fill(9);
		expect(tree.root).toEqual(root);
		expect(tree.inputs[0]).toEqual(bytes(1, 2, 3));

		const yieldTask = vi.fn();
		await module.buildMerkleTree(fixtures, { batchSize: 2, yieldTask });
		expect(yieldTask).toHaveBeenCalledTimes(2);

		const accumulatorYield = vi.fn();
		await new module.CompactMerkleAccumulator().appendMany(fixtures, {
			batchSize: 2,
			yieldTask: accumulatorYield,
		});
		expect(accumulatorYield).toHaveBeenCalledTimes(2);

		const evenFinalBoundaryYield = vi.fn();
		await new module.CompactMerkleAccumulator().appendMany(fixtures.slice(0, 4), {
			batchSize: 2,
			yieldTask: evenFinalBoundaryYield,
		});
		expect(evenFinalBoundaryYield).toHaveBeenCalledTimes(1);
	});

	it("validates input, index, range, node, batch, proof, and snapshot boundaries", async () => {
		const module = await loadCompaction();
		const invalidBatchSizes = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
		for (const batchSize of invalidBatchSizes) {
			expect(await asyncError(() => module.buildMerkleTree(fixtures, { batchSize }))).toBeInstanceOf(RangeError);
			expect(
				await asyncError(() => new module.CompactMerkleAccumulator().appendMany(fixtures, { batchSize }))
			).toBeInstanceOf(RangeError);
		}
		expect(await asyncError(() => module.buildMerkleTree("not-an-array" as unknown as Uint8Array[]))).toBeInstanceOf(
			TypeError
		);
		expect(await asyncError(() => module.merkleLeafHash("bytes" as unknown as Uint8Array))).toBeInstanceOf(TypeError);
		expect(await asyncError(() => module.merkleNodeHash(bytes(1), new Uint8Array(32)))).toBeInstanceOf(TypeError);

		const tree = await module.buildMerkleTree(fixtures);
		for (const index of [-1, fixtures.length, 1.5, Number.NaN]) {
			expect(await asyncError(() => module.inclusionProof(tree, index))).toBeInstanceOf(RangeError);
		}
		expect(await asyncError(() => tree.hashRange(-1, 1))).toBeInstanceOf(RangeError);
		expect(await asyncError(() => tree.hashRange(0, tree.size + 1))).toBeInstanceOf(RangeError);
		expect(await asyncError(() => module.consistencyProof(tree, -1))).toBeInstanceOf(RangeError);
		expect(await asyncError(() => module.consistencyProof(tree, tree.size + 1))).toBeInstanceOf(RangeError);
		expect(await module.verifyInclusion(fixtures[0], { auditPath: [], leafIndex: -1, treeSize: 1 }, tree.root)).toBe(
			false
		);
		expect(await module.verifyConsistency(2, 1, new Uint8Array(32), new Uint8Array(32), [])).toBe(false);

		const corruptSnapshots: AccumulatorSnapshot[] = [
			{ peaks: [], size: 1 },
			{ peaks: [new Uint8Array(31)], size: 1 },
			{ peaks: [new Uint8Array(32)], size: 2 },
			{ peaks: [null, null], size: 2 },
		];
		for (const snapshot of corruptSnapshots) {
			expect(
				await asyncError(async () => {
					const accumulator = module.CompactMerkleAccumulator.fromSnapshot(snapshot);
					await accumulator.root();
				})
			).toBeInstanceOf(Error);
		}
	});
});
