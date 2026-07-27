import { SetDRP } from "@ts-drp/blueprints";
import { DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import {
	DRP_VERTEX_FUTURE_TOLERANCE_MS,
	InvalidHashError,
	InvalidTimestampError,
	validateVertex,
} from "@ts-drp/validation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createACL, createVertex, DRPObject, HashGraph } from "../src/index.js";

const BASE_TIME = 1_000_000;

function operationVertex(label: string, dependencies: string[], timestamp: number, opType: string = "add"): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType, value: [label] });
	return createVertex("sender", operation, dependencies, timestamp);
}

function setReplica(): DRPObject<SetDRP<string>> {
	return new DRPObject({
		peerId: "receiver",
		acl: createACL({ admins: ["receiver", "sender"] }),
		drp: new SetDRP<string>(),
	});
}

function isRemembered<T extends IDRP>(receiver: DRPObject<T>, hash: string): boolean {
	return receiver["_applier"]["knownInvalidVertexHashes"].has(hash);
}

function expectSelfConsistentHash(vertex: Vertex): void {
	expect(vertex.hash).toBe(computeHash(vertex.peerId, vertex.operation, vertex.dependencies, vertex.timestamp));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Phase 0f timestamp provenance classification", () => {
	it("keeps receiver-future ancestry pending, untombstoned, and idempotent before eligibility", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const receiver = setReplica();
		const pendingParent = operationVertex(
			"pending-parent",
			[HashGraph.rootHash],
			BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 2
		);
		const pendingDescendant = operationVertex("pending-descendant", [pendingParent.hash], pendingParent.timestamp + 1);
		const expected = {
			applied: false,
			invalid: [],
			missing: [pendingParent.hash, pendingDescendant.hash],
		};

		await expect(receiver.applyVertices([pendingParent, pendingDescendant])).resolves.toEqual(expected);
		expect([isRemembered(receiver, pendingParent.hash), isRemembered(receiver, pendingDescendant.hash)]).toEqual([
			false,
			false,
		]);

		vi.setSystemTime(BASE_TIME + 1);
		await expect(receiver.applyVertices([pendingParent, pendingDescendant])).resolves.toEqual(expected);
		expect([isRemembered(receiver, pendingParent.hash), isRemembered(receiver, pendingDescendant.hash)]).toEqual([
			false,
			false,
		]);
	});

	it("remembers dependency inversion as terminal across later time and propagates to descendants", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const receiver = setReplica();
		const acceptedDependency = operationVertex("accepted-dependency", [HashGraph.rootHash], BASE_TIME);
		const terminalChild = operationVertex(
			"terminal-child",
			[acceptedDependency.hash],
			BASE_TIME - DRP_VERTEX_FUTURE_TOLERANCE_MS - 1
		);
		const descendant = operationVertex("terminal-descendant", [terminalChild.hash], BASE_TIME);

		await receiver.applyVertices([acceptedDependency]);
		const firstDelivery = await receiver.applyVertices([terminalChild]);
		const rememberedAfterFirstDelivery = isRemembered(receiver, terminalChild.hash);

		vi.setSystemTime(BASE_TIME + 100 * DRP_VERTEX_FUTURE_TOLERANCE_MS);
		const muchLaterRedelivery = await receiver.applyVertices([terminalChild]);
		const descendantDelivery = await receiver.applyVertices([descendant]);
		expect
			.soft(firstDelivery, "hash-bound dependency inversion must be terminal immediately")
			.toEqual({ applied: false, invalid: [terminalChild.hash], missing: [] });
		expect.soft(rememberedAfterFirstDelivery, "terminal dependency inversion must be remembered").toBe(true);
		expect
			.soft(muchLaterRedelivery, "waiting cannot repair a hash-bound timestamp relation")
			.toEqual({ applied: false, invalid: [terminalChild.hash], missing: [] });
		expect
			.soft(descendantDelivery, "a remembered terminal parent must terminalize its descendant")
			.toEqual({ applied: false, invalid: [descendant.hash], missing: [] });
		expect.soft(isRemembered(receiver, descendant.hash)).toBe(true);
	});

	it("classifies both dependency-inversion batch orders without over-promoting child-first delivery", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const parentFirst = setReplica();
		const parentA = operationVertex("parent-first-parent", [HashGraph.rootHash], BASE_TIME);
		const childA = operationVertex(
			"parent-first-child",
			[parentA.hash],
			BASE_TIME - DRP_VERTEX_FUTURE_TOLERANCE_MS - 1
		);
		const parentFirstResult = await parentFirst.applyVertices([parentA, childA]);

		const childFirst = setReplica();
		const parentB = operationVertex("child-first-parent", [HashGraph.rootHash], BASE_TIME);
		const childB = operationVertex("child-first-child", [parentB.hash], BASE_TIME - DRP_VERTEX_FUTURE_TOLERANCE_MS - 1);
		const childFirstResult = await childFirst.applyVertices([childB, parentB]);
		const childFirstRememberedBeforeReoffer = isRemembered(childFirst, childB.hash);
		const childFirstReoffer = await childFirst.applyVertices([childB]);

		expect
			.soft(parentFirstResult, "[P,C] must commit P and terminalize C")
			.toEqual({ applied: false, invalid: [childA.hash], missing: [] });
		expect.soft(isRemembered(parentFirst, childA.hash)).toBe(true);
		expect
			.soft(childFirstResult, "[C,P] legitimately leaves C missing on its first pass")
			.toEqual({ applied: false, invalid: [], missing: [childB.hash] });
		expect.soft(childFirstRememberedBeforeReoffer).toBe(false);
		expect
			.soft(childFirstReoffer, "after P commits, re-offered C must become terminal")
			.toEqual({ applied: false, invalid: [childB.hash], missing: [] });
		expect.soft(isRemembered(childFirst, childB.hash)).toBe(true);
	});

	it.each([
		["positive infinity", Number.POSITIVE_INFINITY, false],
		["dependency-relative negative infinity", Number.NEGATIVE_INFINITY, true],
	])("keeps %s terminal, remembered, and outside recovery", async (label, timestamp, needsFiniteDependency) => {
		vi.useFakeTimers({ now: BASE_TIME });
		const receiver = setReplica();
		const finiteDependency = operationVertex(`finite-dependency-${label}`, [HashGraph.rootHash], BASE_TIME);
		if (needsFiniteDependency) await receiver.applyVertices([finiteDependency]);
		const dependencies = needsFiniteDependency ? [finiteDependency.hash] : [HashGraph.rootHash];
		const vertex = operationVertex(`nonfinite-${label}`, dependencies, timestamp);
		const validationGraph = new HashGraph("validation-receiver");
		if (needsFiniteDependency) validationGraph.addVertex(finiteDependency);
		const validation = validateVertex(vertex, validationGraph, BASE_TIME);

		expectSelfConsistentHash(vertex);
		expect(validation.error).not.toBeInstanceOf(InvalidHashError);
		expect(validation.success).toBe(false);
		const firstDelivery = await receiver.applyVertices([vertex]);
		const redelivery = await receiver.applyVertices([vertex]);
		expect
			.soft(firstDelivery, `${label} must be terminal on first delivery`)
			.toEqual({ applied: false, invalid: [vertex.hash], missing: [] });
		expect.soft(isRemembered(receiver, vertex.hash), `${label} must enter terminal memory`).toBe(true);
		expect
			.soft(redelivery, `${label} must never enter recovery-facing pending`)
			.toEqual({ applied: false, invalid: [vertex.hash], missing: [] });
		expect
			.soft(
				receiver.vertices.some(({ hash }) => hash === vertex.hash),
				`${label} must not be accepted`
			)
			.toBe(false);
	});

	it("characterizes NaN admission as a deferred malformed-field and canonical-hash residual", async () => {
		// Opus assigns NaN accept-path validity and JSON.stringify timestamp collisions to later
		// malformed-field/canonical-encoding work. Phase 0f must not silently widen into that policy.
		vi.useFakeTimers({ now: BASE_TIME });
		const receiver = setReplica();
		const nanVertex = operationVertex("deferred-nan-residual", [HashGraph.rootHash], Number.NaN);

		expectSelfConsistentHash(nanVertex);
		expect(validateVertex(nanVertex, new HashGraph("validation-receiver"), BASE_TIME)).toEqual({ success: true });
		await expect(receiver.applyVertices([nanVertex])).resolves.toEqual({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(receiver.vertices.some(({ hash }) => hash === nanVertex.hash)).toBe(true);
	});

	it.each([
		["synchronous", false],
		["asynchronous", true],
	])(
		"keeps the %s blueprint-thrown public InvalidTimestampError terminal and non-missing",
		async (_label, asyncThrow) => {
			let attempts = 0;
			class TimestampThrowingDRP implements IDRP {
				semanticsType = SemanticsType.pair;

				failSynchronously(): never {
					attempts++;
					throw new InvalidTimestampError("synchronous application-stage timestamp failure");
				}

				async failAsynchronously(): Promise<never> {
					attempts++;
					await Promise.resolve();
					throw new InvalidTimestampError("asynchronous application-stage timestamp failure");
				}
			}

			vi.useFakeTimers({ now: BASE_TIME });
			const receiver = new DRPObject({
				peerId: "receiver",
				acl: createACL({ admins: ["receiver", "sender"] }),
				drp: new TimestampThrowingDRP(),
			});
			const opType = asyncThrow ? "failAsynchronously" : "failSynchronously";
			const vertex = operationVertex(`public-class-${opType}`, [HashGraph.rootHash], BASE_TIME, opType);

			const result = await receiver.applyVertices([vertex]);
			expect(result).toEqual({ applied: false, invalid: [vertex.hash], missing: [] });
			expect(result.missing).not.toContain(vertex.hash);
			expect(attempts).toBe(1);
			expect(receiver.vertices.some(({ hash }) => hash === vertex.hash)).toBe(false);
		}
	);

	it("partitions future, dependency-relative, genuinely missing, and +Infinity hashes exactly", async () => {
		vi.useFakeTimers({ now: BASE_TIME });
		const receiver = setReplica();
		const acceptedDependency = operationVertex("mixed-accepted", [HashGraph.rootHash], BASE_TIME);
		await receiver.applyVertices([acceptedDependency]);
		const pendingFuture = operationVertex(
			"mixed-pending-future",
			[HashGraph.rootHash],
			BASE_TIME + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1
		);
		const terminalDependencyRelative = operationVertex(
			"mixed-terminal-dependency",
			[acceptedDependency.hash],
			BASE_TIME - DRP_VERTEX_FUTURE_TOLERANCE_MS - 1
		);
		const genuinelyMissing = operationVertex("mixed-genuinely-missing", ["not-present"], BASE_TIME);
		const terminalInfinity = operationVertex("mixed-terminal-infinity", [HashGraph.rootHash], Number.POSITIVE_INFINITY);

		const result = await receiver.applyVertices([
			pendingFuture,
			terminalDependencyRelative,
			genuinelyMissing,
			terminalInfinity,
		]);

		expect(result).toEqual({
			applied: false,
			invalid: [terminalDependencyRelative.hash, terminalInfinity.hash],
			missing: [pendingFuture.hash, genuinelyMissing.hash],
		});
		expect(new Set([...result.missing, ...result.invalid])).toEqual(
			new Set([pendingFuture.hash, terminalDependencyRelative.hash, genuinelyMissing.hash, terminalInfinity.hash])
		);
		expect(result.missing.filter((hash) => result.invalid.includes(hash))).toEqual([]);
		expect(
			[
				isRemembered(receiver, pendingFuture.hash),
				isRemembered(receiver, terminalDependencyRelative.hash),
				isRemembered(receiver, genuinelyMissing.hash),
				isRemembered(receiver, terminalInfinity.hash),
			],
			"only intrinsic terminal hashes enter shared invalid memory"
		).toEqual([false, true, false, true]);
	});
});
