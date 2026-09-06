import { type DrpRuntimeContext, FetchStateResponse, type IDRP, SemanticsType } from "@ts-drp/types";
import { deserializeDRPState, serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { REPLICA_LOCAL_STATE_KEYS, stateFromDRP } from "../src/state.js";

const LOCAL_CONTEXT_MARKER = "replica-local-context-marker-0c1";
const REPLICATED_VALUES_MARKER = "replicated-values-marker-0c1";
const EXPECTED_STATE_KEYS = new Set(["semanticsType", "values"]);

class StateContractFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context: DrpRuntimeContext = { caller: LOCAL_CONTEXT_MARKER };
	values = [REPLICATED_VALUES_MARKER];
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (needle.length === 0) return true;
	for (let start = 0; start <= haystack.length - needle.length; start += 1) {
		let matches = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[start + offset] !== needle[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

describe("replicated state field contract", () => {
	it("explicitly excludes replica-local context while retaining replicated values", () => {
		expect([...REPLICA_LOCAL_STATE_KEYS]).toEqual(["context"]);

		const state = stateFromDRP(new StateContractFixture());
		const keys = new Set(state.state.map(({ key }) => key));
		const values = state.state.find(({ key }) => key === "values")?.value;

		expect(keys).toEqual(EXPECTED_STATE_KEYS);
		expect(keys).not.toContain("context");
		expect(keys).toContain("values");
		expect(values).toEqual([REPLICATED_VALUES_MARKER]);
	});

	it("keeps context out of FetchStateResponse bytes and roundtrip state", () => {
		const state = stateFromDRP(new StateContractFixture());
		const response = FetchStateResponse.create({
			vertexHash: "phase-0c1-state-contract",
			drpState: serializeDRPState(state),
		});
		const bytes = FetchStateResponse.encode(response).finish();

		expect(containsBytes(bytes, utf8("context"))).toBe(false);
		expect(containsBytes(bytes, utf8(LOCAL_CONTEXT_MARKER))).toBe(false);
		expect(containsBytes(bytes, utf8(REPLICATED_VALUES_MARKER))).toBe(true);

		const decoded = FetchStateResponse.decode(bytes);
		const roundtrip = deserializeDRPState(decoded.drpState);
		const roundtripKeys = new Set(roundtrip.state.map(({ key }) => key));

		expect(roundtripKeys).toEqual(EXPECTED_STATE_KEYS);
		expect(roundtripKeys).not.toContain("context");
		expect(roundtripKeys).toContain("values");
		expect(roundtrip.state.find(({ key }) => key === "values")?.value).toEqual([REPLICATED_VALUES_MARKER]);
	});
});
