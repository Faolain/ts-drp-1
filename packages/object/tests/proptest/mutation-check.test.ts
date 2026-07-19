/**
 * Harness self-check ("mutation test"): a deliberately order-dependent
 * conflict resolver ("left vertex always wins") must be caught by the
 * harness as a divergence, with a shrunk seed/config in the message.
 * This proves the properties are not vacuously green.
 */
import {
	antiEntropy,
	assertConverged,
	type BoxGame,
	BoxGame2D,
	checkProperty,
	CLOCK_BASE,
	type Replica,
	resetClock,
	runSim,
} from "@ts-drp/test-utils";
import { ActionType, type ResolveConflictsType, type Vertex } from "@ts-drp/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createACL } from "../../src/acl/index.js";
import { DRPObject } from "../../src/index.js";

/**
 * Deliberate BUG: conflict resolution is biased by the local replica's
 * identity, so two replicas holding the exact same graph resolve the same
 * conflict differently — the class of bug that produces production desync.
 *
 * (Findings from weaker mutations, kept for the record: "always DropRight"
 * is NOT a bug — linearization feeds conflicts in a canonical graph-derived
 * order, identical on every replica, so a constant bias stays deterministic.
 * A stateful call-parity flip escaped state-level detection too, because
 * anti-entropy advances every replica's resolver call count in lockstep once
 * graphs are equal; it IS visible as back-to-back linearizations of an
 * unchanged graph disagreeing.)
 */
class BrokenBoxGame extends BoxGame2D {
	constructor(private readonly bias: ActionType.DropLeft | ActionType.DropRight) {
		super();
	}

	resolveConflicts(vertices: Vertex[]): ResolveConflictsType {
		const [left, right] = vertices;
		if (!left?.operation || !right?.operation) return { action: ActionType.Nop };
		if (left.operation.value[0] !== right.operation.value[0]) return { action: ActionType.Nop };
		return { action: this.bias };
	}
}

function makeBrokenReplicas(n: number): Replica[] {
	const peerIds = Array.from({ length: n }, (_, i) => `peer${i}`);
	return peerIds.map((peerId, i) => {
		const obj = new DRPObject<BoxGame>({
			peerId,
			id: "mutation-check",
			acl: createACL({ admins: peerIds }),
			drp: new BrokenBoxGame(i % 2 === 0 ? ActionType.DropLeft : ActionType.DropRight),
		});
		return { peerId, obj, hashGraph: obj["hashGraph"] };
	});
}

beforeAll(() => vi.useFakeTimers({ now: CLOCK_BASE }));
afterAll(() => vi.useRealTimers());

describe("harness mutation check", () => {
	it("detects an order-dependent conflict resolver and reports a shrunk seed", { timeout: 120_000 }, async () => {
		let caught: Error | undefined;
		try {
			await checkProperty(
				"mutation",
				[1, 2, 3, 4, 5],
				{ ops: 30, replicaCount: 4 },
				async (seed, ops, replicaCount) => {
					resetClock();
					const replicas = makeBrokenReplicas(replicaCount);
					const sim = await runSim({ seed, ops, replicaCount, dims: 2, boxes: 1 }, replicas);
					await antiEntropy(replicas, sim.rand, sim.stats);
					assertConverged(replicas, `seed=${seed}`);
				}
			);
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		expect(caught?.message).toContain("PROPERTY VIOLATION");
		expect(caught?.message).toContain("minimal:");
		// surface the shrunk repro for eyeballing
		console.log(caught?.message.split("\n").slice(0, 4).join("\n"));
	});
});
