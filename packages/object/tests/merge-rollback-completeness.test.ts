import { ACLGroup, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

interface ReplayFailureControl {
	invocations: number;
}

interface CheckpointFailureControl {
	armed: boolean;
	readsWhileArmed: number;
	invocations: number;
}

const replayFailures = new Map<string, ReplayFailureControl>();
const checkpointFailures = new Map<string, CheckpointFailureControl>();

class RollbackProbeDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	appendThenFailDuringReplay(controlId: string, value: number): void {
		const operationControl = replayFailures.get(controlId);
		if (!operationControl) throw new Error(`Missing replay control ${controlId}`);
		operationControl.invocations++;
		this.values.push(value);
		if (operationControl.invocations === 2) throw new Error("controlled transient replay failure");
	}
}

class CheckpointProbeDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];
	declare checkpointTrap: string;

	constructor(controlId: string) {
		Object.defineProperty(this, "checkpointTrap", {
			configurable: true,
			enumerable: true,
			get: () => {
				const operationControl = checkpointFailures.get(controlId);
				if (!operationControl) throw new Error(`Missing checkpoint control ${controlId}`);
				if (!operationControl.armed) return "stable";
				operationControl.readsWhileArmed++;
				if (operationControl.readsWhileArmed === 3) {
					throw new Error("controlled transient checkpoint failure");
				}
				return "stable";
			},
			set: () => {},
		});
	}

	armFailureDuringCheckpoint(controlId: string, value: number): void {
		const operationControl = checkpointFailures.get(controlId);
		if (!operationControl) throw new Error(`Missing checkpoint control ${controlId}`);
		operationControl.invocations++;
		this.values.push(value);
		if (operationControl.invocations === 2) operationControl.armed = true;
	}
}

function makeVertex(opType: string, value: unknown[], timestamp: number, drpType = DrpType.DRP): Vertex {
	return createVertex("sender", Operation.create({ drpType, opType, value }), [HashGraph.rootHash], timestamp);
}

function checkpointShape<T extends IDRP>(
	receiver: DRPObject<T>
): { frontier: string[]; origin: string; vertexCount: number }[] {
	return receiver["_applier"]["checkpoints"].map(({ frontier, origin, vertexCount }) => ({
		frontier: [...frontier],
		origin,
		vertexCount,
	}));
}

describe("per-vertex rollback completeness", () => {
	it("undoes the failing vertex on every surface while committed batch peers survive, for replay and post-replay failures", async () => {
		const replayControl = { invocations: 0 };
		replayFailures.set("replay", replayControl);
		const receiver = new DRPObject({
			peerId: "receiver",
			acl: createACL({ admins: ["receiver", "sender"] }),
			drp: new RollbackProbeDRP(),
		});

		const healthyDRP = makeVertex("append", [1], 1);
		const healthyACL = makeVertex("grant", ["healthy-writer", ACLGroup.Writer], 2, DrpType.ACL);
		await expect(
			receiver.applyVertices([healthyDRP, healthyACL]),
			"positive control: ordinary DRP and ACL mutations must reach every live/store surface"
		).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(receiver.drp?.values).toEqual([1]);
		expect(receiver.acl.query_isWriter("healthy-writer")).toBe(true);
		expect(receiver.finalityStore.states.has(healthyDRP.hash)).toBe(true);
		expect(receiver.getStates(healthyDRP.hash).every((state) => state !== undefined)).toBe(true);

		const baselineInvalid = makeVertex("operationThatDoesNotExist", [], 3);
		await expect(receiver.applyVertices([baselineInvalid])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [baselineInvalid.hash],
		});
		expect(
			receiver["_applier"]["knownInvalidVertexHashes"].has(baselineInvalid.hash),
			"positive control: a committed deterministic rejection must enter known-invalid memory"
		).toBe(true);

		const replayHostile = makeVertex("anotherMissingOperation", [], 4);
		const replayACL = makeVertex("grant", ["committed-writer", ACLGroup.Writer], 5, DrpType.ACL);
		const replayDRP = makeVertex("appendThenFailDuringReplay", ["replay", 7], 6);
		const replayVerticesBefore = receiver.vertices.map(({ hash }) => hash);
		const replayInvalidBefore = [...receiver["_applier"]["knownInvalidVertexHashes"]];

		// Per-vertex atomicity (plan appendix D.3(b)): the batch is network framing chosen by the
		// sender, not a causal unit, so it must NOT be the unit of rollback. Each vertex either
		// applies across every surface or leaves no trace, and the batch continues past a failure.
		// A committed vertex is never removed — any dependency-closed subset of a causal DAG is a
		// valid replica state, so no failure can require removing one.
		await expect(
			receiver.applyVertices([replayHostile, replayACL, replayDRP]),
			"a per-vertex applier resolves with an accurate result rather than rejecting the whole batch"
		).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [replayHostile.hash],
			quarantined: [replayDRP.hash],
		});
		expect(replayControl.invocations, "the transient throw must come from the second, final replay invocation").toBe(2);
		expect(
			{
				committedACLInGraph: receiver.vertices.some(({ hash }) => hash === replayACL.hash),
				committedWriter: receiver.acl.query_isWriter("committed-writer"),
				committedACLFinality: receiver.finalityStore.states.has(replayACL.hash),
				deterministicInvalidRemembered: receiver["_applier"]["knownInvalidVertexHashes"].has(replayHostile.hash),
			},
			"a vertex that committed before a later vertex failed must survive on every surface, and a deterministic rejection must stay remembered"
		).toEqual({
			committedACLInGraph: true,
			committedWriter: true,
			committedACLFinality: true,
			deterministicInvalidRemembered: true,
		});
		expect(
			{
				quarantinedInGraph: receiver.vertices.some(({ hash }) => hash === replayDRP.hash),
				quarantinedFinality: receiver.finalityStore.states.has(replayDRP.hash),
				quarantinedStates: receiver.getStates(replayDRP.hash),
				quarantinedRemembered: receiver["_applier"]["knownInvalidVertexHashes"].has(replayDRP.hash),
				values: receiver.drp?.values,
				priorVerticesIntact: replayVerticesBefore.every((hash) =>
					receiver.vertices.some((vertex) => vertex.hash === hash)
				),
				priorInvalidIntact: replayInvalidBefore.every((hash) =>
					receiver["_applier"]["knownInvalidVertexHashes"].has(hash)
				),
			},
			"the failing vertex must leave no trace on any surface, must stay retriable rather than shared-invalid, and must not disturb anything committed earlier"
		).toEqual({
			quarantinedInGraph: false,
			quarantinedFinality: false,
			quarantinedStates: [undefined, undefined],
			quarantinedRemembered: false,
			values: [1],
			priorVerticesIntact: true,
			priorInvalidIntact: true,
		});

		const previousSuffixSize = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "1";
		try {
			const checkpointControl = { armed: false, readsWhileArmed: 0, invocations: 0 };
			checkpointFailures.set("checkpoint", checkpointControl);
			const checkpointReceiver = new DRPObject({
				peerId: "receiver",
				acl: createACL({ admins: ["receiver", "sender"] }),
				drp: new CheckpointProbeDRP("checkpoint"),
			});
			const checkpointHostile = makeVertex("yetAnotherMissingOperation", [], 10);
			const checkpointACL = makeVertex("grant", ["checkpoint-writer", ACLGroup.Writer], 11, DrpType.ACL);
			const checkpointDRP = makeVertex("armFailureDuringCheckpoint", ["checkpoint", 9], 12);
			const verticesBefore = checkpointReceiver.vertices.map(({ hash }) => hash);

			// Same per-vertex contract, exercised through a throw raised *after* replay, inside
			// checkpoint snapshotting — the surface the batch-scoped implementation left un-journaled.
			await expect(
				checkpointReceiver.applyVertices([checkpointHostile, checkpointACL, checkpointDRP]),
				"a post-replay failure is still a per-vertex outcome, not a batch rejection"
			).resolves.toEqual({
				applied: false,
				missing: [],
				invalid: [checkpointHostile.hash],
				quarantined: [checkpointDRP.hash],
			});
			expect(
				checkpointControl.invocations,
				"positive control: the valid DRP operation must execute in the pipeline and final replay"
			).toBe(2);
			expect(
				checkpointControl.readsWhileArmed,
				"positive control: live adoption must reach checkpoint snapshotting before the injected throw"
			).toBe(3);

			expect(
				{
					committedACLInGraph: checkpointReceiver.vertices.some(({ hash }) => hash === checkpointACL.hash),
					committedWriter: checkpointReceiver.acl.query_isWriter("checkpoint-writer"),
					priorVerticesIntact: verticesBefore.every((hash) =>
						checkpointReceiver.vertices.some((vertex) => vertex.hash === hash)
					),
				},
				"a post-replay failure must not remove a vertex that already committed in the same batch"
			).toEqual({ committedACLInGraph: true, committedWriter: true, priorVerticesIntact: true });

			expect(
				{
					quarantinedInGraph: checkpointReceiver.vertices.some(({ hash }) => hash === checkpointDRP.hash),
					quarantinedFinality: checkpointReceiver.finalityStore.states.has(checkpointDRP.hash),
					quarantinedStates: checkpointReceiver.getStates(checkpointDRP.hash),
					values: checkpointReceiver.drp?.values,
					checkpointsMentionQuarantined: checkpointShape(checkpointReceiver).some(({ frontier }) =>
						frontier.includes(checkpointDRP.hash)
					),
				},
				"a failure inside checkpoint snapshotting must undo the failing vertex on every surface, checkpoints included"
			).toEqual({
				quarantinedInGraph: false,
				quarantinedFinality: false,
				quarantinedStates: [undefined, undefined],
				values: [],
				checkpointsMentionQuarantined: false,
			});
		} finally {
			if (previousSuffixSize === undefined) {
				delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			} else {
				process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffixSize;
			}
		}
	});
});
