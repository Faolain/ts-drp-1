import { bls } from "@chainsafe/bls/herumi";
import { Keychain } from "@ts-drp/keychain";
import { type Attestation } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FinalityStore } from "../src/finality/index.js";

const peerId = "phase-0k-a-signer";
const knownHash = "phase-0k-a-known-hash";
const signerCredentials = new Map([[peerId, "verification-disabled-test-credential"]]);

function attestation(data: string): Attestation {
	return {
		data,
		signature: new Uint8Array([1, 2, 3]),
	};
}

describe("Phase 0k-a FinalityStore.addSignatures return contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("excludes an attestation for an unknown hash from the returned added set", () => {
		const store = new FinalityStore();
		const unknown = attestation("phase-0k-a-unknown-hash");

		expect(store.addSignatures(peerId, [unknown], false)).toEqual([]);
		expect(store.states.size).toBe(0);
	});

	it("excludes an already-signed duplicate from the returned added set", () => {
		const store = new FinalityStore();
		store.initializeState(knownHash, signerCredentials);
		const first = attestation(knownHash);
		const duplicate = attestation(knownHash);

		expect(store.addSignatures(peerId, [first], false)).toEqual([first]);
		expect(store.addSignatures(peerId, [duplicate], false)).toEqual([]);
		expect(store.getNumberOfSignatures(knownHash)).toBe(1);
	});

	it("continues a mixed batch and returns every changed attestation in input order", () => {
		const firstHash = "phase-0k-a-batch-first";
		const middleHash = "phase-0k-a-batch-middle";
		const lastHash = "phase-0k-a-batch-last";
		const throwingHash = "phase-0k-a-batch-throwing";
		const store = new FinalityStore();
		for (const hash of [firstHash, middleHash, lastHash]) {
			store.initializeState(hash, signerCredentials);
		}
		store.initializeState(throwingHash, new Map([["different-peer", "credential"]]));
		const first = attestation(firstHash);
		const unknown = attestation("phase-0k-a-batch-unknown");
		const middle = attestation(middleHash);
		const duplicate = attestation(firstHash);
		const throwing = attestation(throwingHash);
		const last = attestation(lastHash);
		const warn = vi.fn();
		(store as unknown as { log: { warn: typeof warn } }).log.warn = warn;

		const added = store.addSignatures(peerId, [first, unknown, middle, duplicate, throwing, last], false);

		expect(added).toEqual([first, middle, last]);
		expect(added[0]).toBe(first);
		expect(added[1]).toBe(middle);
		expect(added[2]).toBe(last);
		expect(added).not.toContain(unknown);
		expect(added).not.toContain(duplicate);
		expect(added).not.toContain(throwing);
		expect(store.states.has(unknown.data)).toBe(false);
		expect(store.getNumberOfSignatures(firstHash)).toBe(1);
		expect(store.getNumberOfSignatures(middleHash)).toBe(1);
		expect(store.getNumberOfSignatures(lastHash)).toBe(1);
		expect(store.getNumberOfSignatures(throwingHash)).toBe(0);
		expect(store.states.get(firstHash)?.signature).toBe(first.signature);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("atomically preserves a known record when aggregating a second signer throws", async () => {
		const firstPeerId = "phase-0k-a-first-signer";
		const secondPeerId = "phase-0k-a-second-signer";
		const firstKeychain = new Keychain({ private_key_seed: firstPeerId });
		const secondKeychain = new Keychain({ private_key_seed: secondPeerId });
		await Promise.all([firstKeychain.start(), secondKeychain.start()]);
		const store = new FinalityStore();
		store.initializeState(
			knownHash,
			new Map([
				[firstPeerId, firstKeychain.blsPublicKey],
				[secondPeerId, secondKeychain.blsPublicKey],
			])
		);
		const first = { data: knownHash, signature: firstKeychain.signWithBls(knownHash) };
		const second = { data: knownHash, signature: secondKeychain.signWithBls(knownHash) };

		expect(store.addSignatures(firstPeerId, [first])).toEqual([first]);
		const state = store.states.get(knownHash);
		if (!state?.signature) throw new Error("Expected the first signature to be installed");
		const firstIndex = state.signerIndices.get(firstPeerId);
		const secondIndex = state.signerIndices.get(secondPeerId);
		if (firstIndex === undefined || secondIndex === undefined) throw new Error("Expected both signers");
		const signatureBefore = state.signature;
		const countBefore = state.numberOfSignatures;
		const aggregateBefore = structuredClone(store.getAttestation(knownHash));

		const aggregate = vi.spyOn(bls, "aggregateSignatures").mockImplementationOnce(() => {
			throw new Error("phase-0k-a controlled aggregation failure");
		});

		expect(store.addSignatures(secondPeerId, [second])).toEqual([]);
		expect.soft(aggregate).toHaveBeenCalledTimes(1);
		expect.soft(state.aggregation_bits.get(firstIndex)).toBe(true);
		expect.soft(state.aggregation_bits.get(secondIndex)).toBe(false);
		expect.soft(state.signature).toBe(signatureBefore);
		expect.soft(state.numberOfSignatures).toBe(countBefore);
		expect.soft(store.getAttestation(knownHash)).toEqual(aggregateBefore);

		expect.soft(store.addSignatures(secondPeerId, [second])).toEqual([second]);
		expect.soft(aggregate).toHaveBeenCalledTimes(2);
		expect.soft(state.aggregation_bits.get(secondIndex)).toBe(true);
		expect.soft(state.numberOfSignatures).toBe(2);
		expect.soft(state.signature).not.toEqual(signatureBefore);
	});
});
