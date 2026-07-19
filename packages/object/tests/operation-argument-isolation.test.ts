import { ActionType, type IDRP, type ResolveConflictsType, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, test } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPObject } from "../src/index.js";

class MutableValueDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	private values = new Map<string, { count: number }>();

	set(key: string, value: { count: number }): void {
		this.values.set(key, value);
	}

	increment(key: string): void {
		const value = this.values.get(key);
		if (value) value.count++;
	}

	query_get(key: string): number | undefined {
		return this.values.get(key)?.count;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

describe("operation argument isolation", () => {
	test("detaches vertex payloads and state from caller-owned objects", () => {
		const object = new DRPObject({ peerId: "peer1", drp: new MutableValueDRP() });
		const value = { count: 0 };

		object.drp?.set("target", value);
		value.count = 9;

		const vertex = object.vertices.find((candidate) => candidate.operation?.opType === "set");
		expect(vertex?.operation?.value).toEqual(["target", { count: 0 }]);
		expect(object.drp?.query_get("target")).toBe(0);
	});

	test("does not mutate historical vertex payloads during replay", async () => {
		const acl = createACL({ admins: ["peer1", "peer2", "receiver"] });
		const left = new DRPObject({ peerId: "peer1", acl, drp: new MutableValueDRP() });
		const right = new DRPObject({ peerId: "peer2", acl, drp: new MutableValueDRP() });
		const receiver = new DRPObject({ peerId: "receiver", acl, drp: new MutableValueDRP() });

		left.drp?.set("target", { count: 0 });
		right.drp?.set("other", { count: 0 });
		await left.applyVertices(right.vertices);
		left.drp?.increment("target");

		const operations = left.vertices.filter((vertex) => vertex.operation?.drpType === "DRP");
		const targetVertex = operations.find(
			(vertex) => vertex.operation?.opType === "set" && vertex.operation.value[0] === "target"
		);
		const payloadBeforeReplay = structuredClone(targetVertex?.operation?.value);

		await receiver.applyVertices(operations);

		expect(targetVertex?.operation?.value).toEqual(payloadBeforeReplay);
		expect(receiver.drp?.query_get("target")).toBe(1);
	});
});
