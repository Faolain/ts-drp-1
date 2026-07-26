import {
	type DrpRuntimeContext,
	type DRPState,
	DRPStateOtherTheWire,
	DrpType,
	type IDRP,
	Operation,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

class ShrinkingDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	retained = "canonical";
	obsolete?: string = "stale";

	deleteObsolete(): void {
		delete this.obsolete;
	}
}

class ContextOnlyDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	context: DrpRuntimeContext;
	value = "same replicated value";

	constructor(localCaller: string) {
		this.context = { caller: localCaller };
	}
}

function makeVertex(peerId: string, operation: Operation, timestamp: number): Vertex {
	return createVertex(peerId, operation, [HashGraph.rootHash], timestamp);
}

function encodeState(state: DRPState | undefined): Uint8Array {
	expect(state, "the applied vertex must have a stored state").toBeDefined();
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

describe("state adoption replacement", () => {
	it("removes live top-level keys that are absent from the canonical replayed state", async () => {
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "sender"] }),
			drp: new ShrinkingDRP(),
		});
		const deletion = makeVertex(
			"sender",
			Operation.create({ drpType: DrpType.DRP, opType: "deleteObsolete", value: [] }),
			1
		);

		await expect(receiver.applyVertices([deletion])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		const [, canonicalState] = receiver.getStates(deletion.hash);
		expect(canonicalState, "the deletion vertex must have a canonical DRP state").toBeDefined();
		const canonicalKeys = canonicalState?.state.map(({ key }) => key).sort();
		const liveKeys = Object.keys(receiver.drp ?? {}).sort();

		expect(liveKeys, "live DRP keys must exactly equal the canonical replayed keys").toEqual(canonicalKeys);
	});
});

describe("replica-local context snapshots", () => {
	it("stores byte-identical state for the same hash across replicas with different local callers and delivery order", async () => {
		const admins = ["author-a", "author-b"];
		const replicaA = new DRPObject({
			peerId: "replica-a",
			acl: createACL({ admins }),
			drp: new ContextOnlyDRP("replica-a"),
		});
		const replicaB = new DRPObject({
			peerId: "replica-b",
			acl: createACL({ admins }),
			drp: new ContextOnlyDRP("replica-b"),
		});
		const target = makeVertex(
			"author-a",
			Operation.create({ drpType: DrpType.ACL, opType: "setKey", value: ["key-a"] }),
			1
		);
		const concurrent = makeVertex(
			"author-b",
			Operation.create({ drpType: DrpType.ACL, opType: "setKey", value: ["key-b"] }),
			2
		);

		await expect(replicaA.applyVertices([target, concurrent])).resolves.toMatchObject({ applied: true });
		await expect(replicaB.applyVertices([concurrent, target])).resolves.toMatchObject({ applied: true });

		const [, targetStateA] = replicaA.getStates(target.hash);
		const [, targetStateB] = replicaB.getStates(target.hash);
		expect(encodeState(targetStateA), "the same vertex hash must not encode replica-local caller context").toEqual(
			encodeState(targetStateB)
		);
	});
});
