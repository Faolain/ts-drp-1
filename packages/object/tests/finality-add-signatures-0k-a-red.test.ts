import { type Attestation } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

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
});
