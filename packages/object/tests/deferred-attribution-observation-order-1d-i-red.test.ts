/* eslint-disable @typescript-eslint/no-non-null-assertion -- the local publication assertion first proves the vertex exists */
import { DRPStateOtherTheWire, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { trackMutations } from "../src/proxy.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface AttributionResult {
	changedKeys: string[];
	hasChanges: boolean;
}

function mutateThenEqualDetach(path: "context" | "governed", observeBeforeDetach = false): AttributionResult {
	const shared = { value: 0 };
	const state = { context: { link: shared }, governed: shared, untouched: { value: 0 } };
	const beforeBytes = serializeValue(state.governed);
	const tracked = trackMutations(state);

	if (path === "context") tracked.proxy.context.link.value = 1;
	else tracked.proxy.governed.value = 1;
	if (observeBeforeDetach) {
		expect([...tracked.changedKeys()]).toEqual(["governed"]);
		expect(tracked.hasChanges()).toBe(true);
	}

	const equalReplacement = { value: 1 };
	tracked.proxy.governed = equalReplacement;
	expect(state.governed).toBe(equalReplacement);
	expect(state.governed).not.toBe(shared);
	expect(serializeValue(state.governed)).not.toEqual(beforeBytes);

	return { changedKeys: [...tracked.changedKeys()], hasChanges: tracked.hasChanges() };
}

class EqualDetachFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context: { caller: string; link?: { value: number } } = { caller: "" };
	governed = { value: 0 };

	mutateThroughContextThenEqualDetach(value: number): void {
		this.context.link = this.governed;
		this.context.link.value = value;
		this.governed = { value };
	}
}

function encodedState(value: IDRP): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

describe("Phase 1d(i) deferred attribution is observation-order independent", () => {
	it("retains the governed owner after a context-alias mutation followed by an equal-value detach", () => {
		expect(mutateThenEqualDetach("context")).toEqual({ changedKeys: ["governed"], hasChanges: true });
	});

	it("has the same terminal result with and without an intermediate observation", () => {
		const withoutIntermediateObservation = mutateThenEqualDetach("context");
		const withIntermediateObservation = mutateThenEqualDetach("context", true);

		expect(withoutIntermediateObservation).toEqual(withIntermediateObservation);
		expect(withoutIntermediateObservation).toEqual({ changedKeys: ["governed"], hasChanges: true });
	});

	it("retains attribution for the same sequence through the governed path", () => {
		expect(mutateThenEqualDetach("governed")).toEqual({ changedKeys: ["governed"], hasChanges: true });
	});

	it("keeps a distinct equal-value replacement with no preceding mutation silent", () => {
		const state = { governed: { value: 1 }, untouched: { value: 0 } };
		const tracked = trackMutations(state);
		const previous = state.governed;

		tracked.proxy.governed = { value: 1 };

		expect(state.governed).not.toBe(previous);
		expect([...tracked.changedKeys()]).toEqual([]);
		expect(tracked.hasChanges()).toBe(false);
	});

	it("authors and stores exact local bytes for the context-alias sequence", () => {
		const rawDRP = new EqualDetachFixture();
		const rawACL = createACL({ admins: ["local"] });
		const hashGraph = new HashGraph("local", rawACL.resolveConflicts?.bind(rawACL), undefined, rawDRP.semanticsType);
		const states = new DRPObjectStateManager(rawACL, rawDRP);
		const options = {
			drp: rawDRP,
			acl: rawACL,
			hashGraph,
			states,
			finalityStore: new FinalityStore(),
			notify: (): void => {},
		};
		const Applier = DRPVertexApplier as unknown as new (
			candidate: typeof options
		) => DRPVertexApplier<EqualDetachFixture>;
		const applier = new Applier(options);

		applier.drp!.mutateThroughContextThenEqualDetach(1);

		const vertex = hashGraph
			.getAllVertices()
			.find(({ operation }) => operation?.opType === "mutateThroughContextThenEqualDetach");
		expect(vertex, "the governed byte delta must author a vertex").toBeDefined();
		expect(rawDRP.governed.value).toBe(1);
		expect(DRPStateOtherTheWire.encode(serializeDRPState(states.getDRPState(vertex!.hash)!)).finish()).toEqual(
			encodedState(rawDRP)
		);
	});
});
