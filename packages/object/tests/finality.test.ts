import { bls } from "@chainsafe/bls/herumi";
import { SetDRP } from "@ts-drp/blueprints";
import { Keychain } from "@ts-drp/keychain";
import { AggregatedAttestation, type Attestation } from "@ts-drp/types";
import { toString as uint8ArrayToString } from "uint8arrays";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { FinalityState, FinalityStore } from "../src/finality/index.js";
import { BitSet } from "../src/hashgraph/bitset.js";
import { createACL, DRPObject } from "../src/index.js";

// initialize log
const _ = new DRPObject({
	peerId: "peer1",
	acl: createACL(),
	drp: new SetDRP(),
});

describe("Tests for FinalityState", () => {
	const N = 128;
	let finalityState: FinalityState;
	const peers: string[] = [];
	const stores: Keychain[] = [];

	beforeEach(async () => {
		for (let i = 0; i < N; i++) {
			peers.push(uint8ArrayToString(crypto.getRandomValues(new Uint8Array(32)), "hex"));
		}
		peers.sort();

		for (let i = 0; i < N; i++) {
			stores.push(new Keychain());
			await stores[i].start();
		}

		const signers = new Map();
		for (let i = 0; i < N; i++) {
			signers.set(peers[i], stores[i].blsPublicKey);
		}
		finalityState = new FinalityState("vertex1", signers);
	});

	test("addSignature: Nodes outside the signer set are rejected", async () => {
		const keychain = new Keychain();
		await keychain.start();

		const signature = keychain.signWithBls(finalityState.data);

		expect(() => finalityState.addSignature("badNode", signature)).toThrowError("Peer not found in signer list");
	});

	test("addSignature: Bad signatures are rejected", async () => {
		const keychain = new Keychain();
		await keychain.start();

		const signature = keychain.signWithBls(finalityState.data);

		expect(() => finalityState.addSignature(peers[0], signature)).toThrowError("Invalid signature");
	});

	test("addSignature: signatures are counted correctly", () => {
		let count = 0;
		for (let i = 0; i < N; i++) {
			const signature = stores[i].signWithBls(finalityState.data);
			finalityState.addSignature(peers[i], signature);
			count++;
			expect(finalityState.numberOfSignatures).toEqual(count);
		}
		for (let i = 0; i < count; i++) {
			expect(finalityState.aggregation_bits.get(i)).toEqual(true);
		}
	});

	test("Duplicated signatures", () => {
		finalityState.addSignature(peers[0], stores[0].signWithBls(finalityState.data));
		finalityState.addSignature(peers[0], stores[0].signWithBls(finalityState.data));
		expect(finalityState.numberOfSignatures).toEqual(1);
	});
});

describe("FinalityState aggregate merge policy", () => {
	const hash = "aggregate-merge-policy";
	const peerIds = ["peer-a", "peer-b", "peer-c", "peer-d", "peer-e"];
	let keychains: Keychain[];
	let signers: Map<string, string>;

	beforeEach(async () => {
		keychains = peerIds.map(() => new Keychain());
		await Promise.all(keychains.map((keychain) => keychain.start()));
		signers = new Map(peerIds.map((peerId, index) => [peerId, keychains[index].blsPublicKey]));
	});

	const aggregate = (indices: number[]): AggregatedAttestation => {
		const bits = new BitSet(peerIds.length);
		const signatures = indices.map((index) => {
			bits.set(index, true);
			return keychains[index].signWithBls(hash);
		});
		return AggregatedAttestation.create({
			data: hash,
			signature: bls.aggregateSignatures(signatures),
			aggregationBits: bits.toBytes(),
		});
	};

	const expectExactAggregate = (state: FinalityState, indices: number[]): void => {
		const publicKeys = indices.map((index) => uint8ArrayFromString(state.signerCredentials[index], "base64"));
		expect(state.numberOfSignatures).toBe(indices.length);
		expect(Array.from({ length: peerIds.length }, (_, index) => state.aggregation_bits.get(index))).toEqual(
			peerIds.map((_, index) => indices.includes(index))
		);
		expect(state.signature).toBeDefined();
		if (!state.signature) throw new Error("aggregate signature is missing");
		expect(bls.verifyAggregate(publicKeys, uint8ArrayFromString(hash), state.signature)).toBe(true);
	};

	test("a relay unions repeated pure aggregates, adopts a superset, and ignores a subset", () => {
		const relay = new FinalityState(hash, signers);
		relay.merge(aggregate([0, 1]));
		relay.merge(aggregate([2, 3]));
		expectExactAggregate(relay, [0, 1, 2, 3]);

		relay.merge(aggregate([0, 1, 2, 3, 4]));
		expectExactAggregate(relay, [0, 1, 2, 3, 4]);

		const adoptedSignature = relay.signature;
		relay.merge(aggregate([0, 1]));
		expectExactAggregate(relay, [0, 1, 2, 3, 4]);
		expect(relay.signature).toEqual(adoptedSignature);
	});

	test.each([
		{ name: "superset adopt", local: [0, 1], remote: [0, 1, 2], expected: [0, 1, 2], adopts: true },
		{ name: "subset keep", local: [0, 1, 2], remote: [0, 1], expected: [0, 1, 2], adopts: false },
		{ name: "incomparable equal-size keep", local: [0, 1], remote: [1, 2], expected: [0, 1], adopts: false },
		{ name: "larger partial adopt", local: [0, 1], remote: [1, 2, 3], expected: [1, 2, 3], adopts: true },
	])("partial-overlap branch: $name", ({ local, remote, expected, adopts }) => {
		const state = new FinalityState(hash, signers);
		for (const index of local) {
			state.addSignature(peerIds[index], keychains[index].signWithBls(hash));
		}
		const remoteAttestation = aggregate(remote);
		const localSignature = state.signature;
		state.merge(remoteAttestation);

		expectExactAggregate(state, expected);
		expect(state.signature).toEqual(adopts ? remoteAttestation.signature : localSignature);
	});

	test("masks remote aggregation bits outside the signer range", () => {
		const state = new FinalityState(hash, signers);
		const remote = aggregate([0]);
		remote.aggregationBits[3] |= 0x80;

		state.merge(remote);

		expect(state.aggregation_bits.get(31)).toBe(false);
		expect(state.aggregation_bits.toBytes()[3] & 0x80).toBe(0);
		expectExactAggregate(state, [0]);
	});
});

describe("Tests for FinalityStore", () => {
	const N = 1000;
	let finalityStore: FinalityStore;
	const peers: string[] = [];
	const stores: Keychain[] = [];

	const generateAttestation = (index: number, hash: string): Attestation => {
		return {
			data: hash,
			signature: stores[index].signWithBls(hash),
		};
	};

	beforeEach(async () => {
		finalityStore = new FinalityStore({ finality_threshold: 0.51 });

		for (let i = 0; i < N; i++) {
			peers.push(uint8ArrayToString(crypto.getRandomValues(new Uint8Array(32)), "hex"));
		}
		peers.sort();

		for (let i = 0; i < N; i++) {
			stores.push(new Keychain());
			await stores[i].start();
		}

		const signers = new Map();
		for (let i = 0; i < N; i++) {
			signers.set(peers[i], stores[i].blsPublicKey);
		}
		finalityStore.initializeState("vertex1", signers);
		finalityStore.initializeState("vertex2", signers);
		finalityStore.initializeState("vertex3", signers);
	});

	test("Runs addSignatures, canSign and signed on 100 attestations", () => {
		for (let i = 0; i < 100; i++) {
			const peerId = peers[i];
			const hash = "vertex1";
			expect(finalityStore.canSign(peerId, hash)).toEqual(true);
			expect(finalityStore.signed(peerId, hash)).toEqual(false);

			const attestation = generateAttestation(i, hash);
			finalityStore.addSignatures(peerId, [attestation]);
			expect(finalityStore.signed(peerId, hash)).toEqual(true);
		}

		// invalid peer
		finalityStore.addSignatures("badNode", []);
		expect(finalityStore.getNumberOfSignatures("vertex1")).toEqual(100);
	});

	test("mergeSignatures: Merge signatures for multiple vertices", () => {
		const attestations: AggregatedAttestation[] = [];
		const warn = vi.fn();
		(finalityStore as unknown as { log: { warn: typeof warn } }).log.warn = warn;

		// signatures for vertex1
		for (let i = 0; i < 10; i++) {
			const signature = stores[i].signWithBls("vertex1");
			const bits = new BitSet(N);
			bits.set(i, true);

			attestations.push(
				AggregatedAttestation.create({
					data: "vertex1",
					signature,
					aggregationBits: bits.toBytes(),
				})
			);
		}

		// signatures for vertex2
		const signatures: Uint8Array[] = [];
		const bitset = new BitSet(N);
		for (let i = 0; i < 50; i++) {
			signatures.push(stores[i].signWithBls("vertex2"));
			bitset.set(i, true);
		}
		const aggregatedSignature = bls.aggregateSignatures(signatures);
		attestations.push(
			AggregatedAttestation.create({
				data: "vertex2",
				signature: aggregatedSignature,
				aggregationBits: bitset.toBytes(),
			})
		);

		// signatures for vertex3
		// invalid signature
		attestations.push(
			AggregatedAttestation.create({
				data: "vertex3",
				signature: stores[0].signWithBls("vertex3"),
				aggregationBits: new BitSet(N).toBytes(),
			})
		);

		finalityStore.mergeSignatures(attestations);

		expect(finalityStore.getNumberOfSignatures("vertex1")).toEqual(10);
		expect(finalityStore.getNumberOfSignatures("vertex2")).toEqual(50);
		expect(finalityStore.getAttestation("vertex2")?.signature).toEqual(aggregatedSignature);
		expect(finalityStore.getNumberOfSignatures("vertex3")).toEqual(0);
		expect(warn).toHaveBeenCalledWith("::finality::mergeSignatures", {
			hash: "vertex3",
			errorName: "Error",
		});
	});

	test("Quorum test", () => {
		for (let i = 0; i < 509; i++) {
			const attestation = generateAttestation(i, "vertex1");
			finalityStore.addSignatures(peers[i], [attestation]);
		}
		expect(finalityStore.isFinalized("vertex1")).toEqual(false);

		for (let i = 509; i < 510; i++) {
			const attestation = generateAttestation(i, "vertex1");
			finalityStore.addSignatures(peers[i], [attestation]);
		}
		// 1000 * 0.51 = 510
		expect(finalityStore.isFinalized("vertex1")).toEqual(true);
	}, 30000);
});
