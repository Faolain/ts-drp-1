import { ACLGroup, type ApplyResult, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { ObjectACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

class NumberLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}
}

class TransientPolicyACL extends ObjectACL {
	override grant(peerId: string, group: ACLGroup): void {
		if (peerId === "policy-denied") throw new Error("transient ACL policy rejection");
		super.grant(peerId, group);
	}
}

interface ACLGuardCase {
	name: string;
	peerId: string;
	opType: "grant" | "setKey";
	value: unknown[];
}

interface HeldGroupFixture {
	w0: Vertex;
	f0: Vertex;
	ga: Vertex;
	rw: Vertex;
	rf: Vertex;
	childOfGA: Vertex;
	childOfRF: Vertex;
}

interface AuthorityChainFixture {
	ga: Vertex;
	wg: Vertex;
	rf: Vertex;
	childOfRF: Vertex;
}

function makeACLVertex(
	peerId: string,
	opType: string,
	value: unknown[],
	dependencies: string[],
	timestamp: number
): Vertex {
	return createVertex(peerId, Operation.create({ drpType: DrpType.ACL, opType, value }), dependencies, timestamp);
}

function makeDRPVertex(peerId: string, value: number, dependencies: string[], timestamp: number): Vertex {
	return createVertex(
		peerId,
		Operation.create({ drpType: DrpType.DRP, opType: "append", value: [value] }),
		dependencies,
		timestamp
	);
}

function makeReceiver(acl: ObjectACL = new ObjectACL({ admins: ["adm"] })): DRPObject<NumberLogDRP> {
	return new DRPObject({
		peerId: "adm",
		acl,
		drp: new NumberLogDRP(),
	});
}

function isKnownInvalid(object: DRPObject<NumberLogDRP>, hash: string): boolean {
	return (
		object as unknown as {
			_applier: { knownInvalidVertexHashes: { has(candidate: string): boolean } };
		}
	)._applier.knownInvalidVertexHashes.has(hash);
}

function findVertexAfter(
	lowerHash: string,
	startTimestamp: number,
	makeVertex: (timestamp: number) => Vertex,
	description: string
): Vertex {
	for (let offset = 0; offset < 512; offset++) {
		const candidate = makeVertex(startTimestamp + offset);
		if (lowerHash < candidate.hash) return candidate;
	}
	throw new Error(`Could not force ${description} in 512 timestamp assignments`);
}

function bucketNames(result: ApplyResult, hash: string): string[] {
	return [
		result.missing.includes(hash) ? "missing" : undefined,
		result.invalid.includes(hash) ? "invalid" : undefined,
		result.quarantined?.includes(hash) ? "quarantined" : undefined,
	].filter((name): name is string => name !== undefined);
}

function makeHeldGroupFixture(): HeldGroupFixture {
	const w0 = makeACLVertex("adm", "grant", ["p", ACLGroup.Writer], [HashGraph.rootHash], 1_701_000_000_000);
	const f0 = makeACLVertex("adm", "grant", ["p", ACLGroup.Finality], [w0.hash], 1_701_000_000_001);
	const ga = makeACLVertex("adm", "grant", ["p", ACLGroup.Admin], [f0.hash], 1_701_000_000_002);
	const rw = findVertexAfter(
		ga.hash,
		1_701_000_000_003,
		(timestamp) => makeACLVertex("adm", "revoke", ["p", ACLGroup.Writer], [f0.hash], timestamp),
		"GA < RW"
	);
	const rf = findVertexAfter(
		rw.hash,
		1_701_000_000_003,
		(timestamp) => makeACLVertex("adm", "revoke", ["p", ACLGroup.Finality], [f0.hash], timestamp),
		"RW < RF"
	);
	expect(ga.hash < rw.hash && rw.hash < rf.hash, "fixture must force GA < RW < RF").toBe(true);
	return {
		w0,
		f0,
		ga,
		rw,
		rf,
		childOfGA: makeACLVertex("p", "grant", ["child-writer", ACLGroup.Writer], [ga.hash], 1_701_000_001_000),
		childOfRF: makeDRPVertex("adm", 99, [rf.hash], 1_701_000_001_001),
	};
}

function makeAuthorityChainFixture(): AuthorityChainFixture {
	const ga = makeACLVertex("adm", "grant", ["eve", ACLGroup.Admin], [HashGraph.rootHash], 1_700_000_000_000);
	const wg = makeACLVertex("eve", "grant", ["writer", ACLGroup.Writer], [ga.hash], 1_700_000_000_001);
	const rf = makeACLVertex("adm", "revoke", ["eve", ACLGroup.Finality], [HashGraph.rootHash], 1_700_000_000_002);
	return {
		ga,
		wg,
		rf,
		childOfRF: makeDRPVertex("adm", 7, [rf.hash], 1_700_000_000_003),
	};
}

async function makeAuthorityChainReceiver(fixture: AuthorityChainFixture): Promise<DRPObject<NumberLogDRP>> {
	const receiver = makeReceiver();
	await expect(receiver.applyVertices([fixture.ga, fixture.wg])).resolves.toEqual({
		applied: true,
		missing: [],
		invalid: [],
	});
	return receiver;
}

async function applyThreeWaySchedule(
	fixture: HeldGroupFixture,
	order: ("ga" | "rw" | "rf")[]
): Promise<DRPObject<NumberLogDRP>> {
	const receiver = makeReceiver();
	await receiver.applyVertices([fixture.w0, fixture.f0]);
	for (const label of order) await receiver.applyVertices([fixture[label]]);
	return receiver;
}

function threeWaySnapshot(receiver: DRPObject<NumberLogDRP>, fixture: HeldGroupFixture): unknown {
	const labels = new Map([
		[fixture.ga.hash, "GA"],
		[fixture.rw.hash, "RW"],
		[fixture.rf.hash, "RF"],
	]);
	return {
		members: receiver.vertices
			.map((vertex) => labels.get(vertex.hash))
			.filter((label): label is string => label !== undefined)
			.sort(),
		knownInvalid: [...labels]
			.filter(([hash]) => isKnownInvalid(receiver, hash))
			.map(([, label]) => label)
			.sort(),
		acl: {
			admin: receiver.acl.query_isAdmin("p"),
			writer: receiver.acl.query_isWriter("p"),
			finality: receiver.acl.query_isFinalitySigner("p"),
		},
	};
}

describe("L7 attempt 3 RED pins", () => {
	it.each<ACLGuardCase>([
		{
			name: "non-admin grant",
			peerId: "non-admin",
			opType: "grant",
			value: ["target", ACLGroup.Writer],
		},
		{
			name: "invalid group",
			peerId: "adm",
			opType: "grant",
			value: ["target", "NotARealACLGroup"],
		},
		{
			name: "setKey by a non-signer",
			peerId: "non-signer",
			opType: "setKey",
			value: ["bls-key"],
		},
	])("F1 classifies a built-in $name guard identically on direct admission and replay", async (testCase) => {
		const replayFixture = makeAuthorityChainFixture();
		const replayReceiver = await makeAuthorityChainReceiver(replayFixture);
		const replayResult = await replayReceiver.applyVertices([replayFixture.rf]);
		expect(replayResult, "the replay wrapper marks a built-in ACL guard terminal").toEqual({
			applied: false,
			missing: [],
			invalid: [replayFixture.rf.hash],
		});
		expect(replayResult.invalid, "the committed replay culprit is remembered, not publicly reported").not.toContain(
			replayFixture.wg.hash
		);
		expect(isKnownInvalid(replayReceiver, replayFixture.wg.hash)).toBe(true);
		expect(isKnownInvalid(replayReceiver, replayFixture.rf.hash)).toBe(true);

		const rejected = makeACLVertex(
			testCase.peerId,
			testCase.opType,
			testCase.value,
			[HashGraph.rootHash],
			1_700_000_000_000
		);
		const directReceiver = makeReceiver();
		const directResult = await directReceiver.applyVertices([rejected]);
		expect(directResult, "direct admission must use the same terminal built-in ACL classification").toEqual({
			applied: false,
			missing: [],
			invalid: [rejected.hash],
		});
		expect(isKnownInvalid(directReceiver, rejected.hash)).toBe(true);
		expect(
			{
				...replayResult,
				invalid: replayResult.invalid.map((hash) => (hash === replayFixture.rf.hash ? "submitted" : hash)),
			},
			"direct admission and canonical replay give their submitted vertex the same terminal verdict"
		).toEqual({
			...directResult,
			invalid: directResult.invalid.map((hash) => (hash === rejected.hash ? "submitted" : hash)),
		});
	});

	it("F2 gives the submitted RF one terminal bucket on first delivery and redelivery", async () => {
		const fixture = makeAuthorityChainFixture();
		const receiver = await makeAuthorityChainReceiver(fixture);

		const first = await receiver.applyVertices([fixture.rf]);
		const second = await receiver.applyVertices([fixture.rf]);

		expect(
			[first, second].map((result) => bucketNames(result, fixture.rf.hash)),
			"an attributed replay failure must not leave the submitted vertex verdict-less forever"
		).toEqual([["invalid"], ["invalid"]]);
	});

	it("F2 never reports a graph member as invalid", async () => {
		const fixture = makeAuthorityChainFixture();
		const receiver = await makeAuthorityChainReceiver(fixture);

		const result = await receiver.applyVertices([fixture.rf]);
		const graphHashes = new Set(receiver.vertices.map((vertex) => vertex.hash));

		expect(
			result.invalid.filter((hash) => graphHashes.has(hash)),
			"invalid is a rejection bucket, so it cannot name an already-committed graph vertex"
		).toEqual([]);
		expect(
			isKnownInvalid(receiver, fixture.wg.hash),
			"the committed replay culprit remains internally attributed"
		).toBe(true);
	});

	it("F2 classifies a child of the rejected RF as invalid rather than missing forever", async () => {
		const fixture = makeAuthorityChainFixture();
		const receiver = await makeAuthorityChainReceiver(fixture);
		await receiver.applyVertices([fixture.rf]);

		const first = await receiver.applyVertices([fixture.childOfRF]);
		const second = await receiver.applyVertices([fixture.childOfRF]);

		expect(
			[first, second],
			"a child whose rejected parent cannot arrive must not remain eligible for missing-parent recovery"
		).toEqual([
			{ applied: false, missing: [], invalid: [fixture.childOfRF.hash] },
			{ applied: false, missing: [], invalid: [fixture.childOfRF.hash] },
		]);
	});

	it("F3 converges membership, folded ACL state, and invalid memory for three concurrent ACL operations", async () => {
		const fixture = makeHeldGroupFixture();
		const grantFirst = await applyThreeWaySchedule(fixture, ["ga", "rw", "rf"]);
		const revokeFirst = await applyThreeWaySchedule(fixture, ["rw", "rf", "ga"]);

		expect(
			threeWaySnapshot(grantFirst, fixture),
			"three pairwise-Nop operations with GA < RW < RF must converge independently of delivery order"
		).toEqual(threeWaySnapshot(revokeFirst, fixture));
	});

	it("F3 does not cascade the three-way disagreement to a child of RF", async () => {
		const fixture = makeHeldGroupFixture();
		const grantFirst = await applyThreeWaySchedule(fixture, ["ga", "rw", "rf"]);
		const revokeFirst = await applyThreeWaySchedule(fixture, ["rw", "rf", "ga"]);

		await grantFirst.applyVertices([fixture.childOfRF]);
		await revokeFirst.applyVertices([fixture.childOfRF]);

		expect(
			{
				grantFirst: {
					childCommitted: grantFirst.vertices.some((vertex) => vertex.hash === fixture.childOfRF.hash),
					childInvalid: isKnownInvalid(grantFirst, fixture.childOfRF.hash),
					values: grantFirst.drp?.values,
				},
				revokeFirst: {
					childCommitted: revokeFirst.vertices.some((vertex) => vertex.hash === fixture.childOfRF.hash),
					childInvalid: isKnownInvalid(revokeFirst, fixture.childOfRF.hash),
					values: revokeFirst.drp?.values,
				},
			},
			"a delivery-order disagreement at RF must not create an unbounded invalid descendant subtree"
		).toEqual({
			grantFirst: { childCommitted: true, childInvalid: false, values: [99] },
			revokeFirst: { childCommitted: true, childInvalid: false, values: [99] },
		});
	});

	it("F4 merge reports committed honest batch vertices despite one quarantined ACL rejection", async () => {
		const receiver = makeReceiver(new TransientPolicyACL({ admins: ["adm"] }));
		const rejected = makeACLVertex(
			"adm",
			"grant",
			["policy-denied", ACLGroup.Writer],
			[HashGraph.rootHash],
			1_702_000_000_000
		);
		const honestA = makeDRPVertex("adm", 1, [HashGraph.rootHash], 1_702_000_000_001);
		const honestB = makeDRPVertex("adm", 2, [honestA.hash], 1_702_000_000_002);

		const outcome = await receiver.merge([rejected, honestA, honestB]).then(
			(value) => ({ status: "resolved" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error: String(error) })
		);

		expect(
			{
				outcome,
				committedHonestVertices: [honestA, honestB]
					.filter((candidate) => receiver.vertices.some((vertex) => vertex.hash === candidate.hash))
					.map((candidate) => candidate.hash),
			},
			"legacy merge must return its partial per-vertex result instead of aborting the whole UPDATE"
		).toEqual({
			outcome: { status: "resolved", value: [false, [], []] },
			committedHonestVertices: [honestA.hash, honestB.hash],
		});
	});

	it("F4 an unauthorized built-in ACL vertex cannot suppress the honest batch result", async () => {
		const receiver = makeReceiver();
		const rejected = makeACLVertex(
			"hostile-peer",
			"grant",
			["target", ACLGroup.Writer],
			[HashGraph.rootHash],
			1_703_000_000_000
		);
		const honestA = makeDRPVertex("adm", 3, [HashGraph.rootHash], 1_703_000_000_001);
		const honestB = makeDRPVertex("adm", 4, [honestA.hash], 1_703_000_000_002);

		const outcome = await receiver.merge([rejected, honestA, honestB]).then(
			(value) => ({ status: "resolved" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error: String(error) })
		);

		expect(
			{
				outcome,
				committedHonestVertices: [honestA, honestB]
					.filter((candidate) => receiver.vertices.some((vertex) => vertex.hash === candidate.hash))
					.map((candidate) => candidate.hash),
			},
			"one unauthorized ACL operation must not hide committed honest UPDATE vertices from the caller"
		).toEqual({
			outcome: { status: "resolved", value: [false, [], [rejected.hash]] },
			committedHonestVertices: [honestA.hash, honestB.hash],
		});
	});
});
