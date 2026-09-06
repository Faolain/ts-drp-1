import { describe, expect, it } from "vitest";

import {
	type FrontierScenarioResult,
	runDependencyBoundScenario,
	runFrontierScenario,
	runParameterCarrierScenario,
} from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";

function exactDependencyClasses(result: FrontierScenarioResult): readonly (readonly string[])[] {
	let tips = [...result.initialTips].sort();
	return result.issued.map((vertex) => {
		const selected = Reflect.get(vertex.operation, "action") === "causalJoin" ? tips.slice(0, 16) : [...tips];
		const consumed = new Set(selected);
		tips = [...tips.filter((tip) => !consumed.has(tip)), vertex.digest].sort();
		return selected;
	});
}

function reachableInitialTips(result: FrontierScenarioResult): ReadonlySet<string> {
	const issuedByDigest = new Map(result.issued.map((vertex) => [vertex.digest, vertex]));
	const final = result.issued.at(-1);
	if (final === undefined) return new Set();
	const reached = new Set<string>();
	const pending = [...final.dependencies];
	while (pending.length > 0) {
		const digest = pending.pop();
		if (digest === undefined || reached.has(digest)) continue;
		reached.add(digest);
		const issued = issuedByDigest.get(digest);
		if (issued !== undefined) pending.push(...issued.dependencies);
	}
	return reached;
}

function expectEveryIssuedVertexDelivered(result: FrontierScenarioResult): void {
	expect(result.admittedDigests).toEqual(result.issued.map(({ digest }) => digest));
}

describe("Phase 3f-b genuine node-owned frontier reduction RED", () => {
	for (const width of [2, 16] as const) {
		it(`issues one application vertex directly over the complete ${width}-tip frontier`, async () => {
			const result = await runFrontierScenario(width);
			expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
			expect(result.issued).toHaveLength(1);
			expect(result.issued[0]?.operation).toEqual({ action: "add", value: 7 });
			expect(result.issued[0]?.dependencies).toEqual(result.initialTips);
			expect(result.issued[0]?.logicalTime).toBe(width + 1);
			expectEveryIssuedVertexDelivered(result);
			expect(result.result).toMatchObject({
				authorSequence: result.issued[0]?.authorSequence,
				digest: result.issued[0]?.digest,
			});
		});
	}

	it("reduces seventeen tips through one admitted join before the requested application", async () => {
		const result = await runFrontierScenario(17);
		expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.issued).toHaveLength(2);
		expect(result.issued.map(({ operation }) => operation)).toEqual([
			{ action: "causalJoin" },
			{ action: "add", value: 7 },
		]);
		expect(result.issued.map(({ dependencies }) => dependencies.length)).toEqual([16, 2]);
		expect(result.issued.map(({ logicalTime }) => logicalTime)).toEqual([18, 18]);
		expectEveryIssuedVertexDelivered(result);
		expect(result.issued.map(({ dependencies }) => dependencies)).toEqual(exactDependencyClasses(result));
		expect([...reachableInitialTips(result)].filter((digest) => result.initialTips.includes(digest))).toHaveLength(17);
		expect(result.result).toMatchObject({
			authorSequence: result.issued.at(-1)?.authorSequence,
			digest: result.issued.at(-1)?.digest,
		});
	});

	it("reduces sixty-four tips without dropping ancestry or widening any vertex", async () => {
		const result = await runFrontierScenario(64);
		expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.issued).toHaveLength(5);
		expect(result.issued.slice(0, 4).map(({ operation }) => operation)).toEqual([
			{ action: "causalJoin" },
			{ action: "causalJoin" },
			{ action: "causalJoin" },
			{ action: "causalJoin" },
		]);
		expect(result.issued.at(-1)?.operation).toEqual({ action: "add", value: 7 });
		expect(result.issued.map(({ dependencies }) => dependencies.length)).toEqual([16, 16, 16, 16, 4]);
		expect(result.issued.map(({ logicalTime }) => logicalTime)).toEqual([65, 65, 65, 65, 65]);
		expectEveryIssuedVertexDelivered(result);
		expect(result.issued.map(({ dependencies }) => dependencies)).toEqual(exactDependencyClasses(result));
		expect(result.issued.every(({ dependencies }) => dependencies.length > 0 && dependencies.length <= 16)).toBe(true);
		const reached = reachableInitialTips(result);
		expect(result.initialTips.every((digest) => reached.has(digest))).toBe(true);
		expect(result.result).toMatchObject({
			authorSequence: result.issued.at(-1)?.authorSequence,
			digest: result.issued.at(-1)?.digest,
		});
	});

	it("derives the same sorted dependency classes from reversed genuine recovery insertion", async () => {
		const forward = await runFrontierScenario(64);
		const reverse = await runFrontierScenario(64, { recoveryOrder: "reverse" });
		expect(reverse.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(reverse.issued.map(({ dependencies }) => dependencies)).toEqual(
			forward.issued.map(({ dependencies }) => dependencies)
		);
		expect(reverse.issued.map(({ dependencies }) => dependencies)).toEqual(exactDependencyClasses(reverse));
		expect(reverse.initialTips.every((tip) => reachableInitialTips(reverse).has(tip))).toBe(true);
		expect(reverse.issued.map(({ logicalTime }) => logicalTime)).toEqual([65, 65, 65, 65, 65]);
		expectEveryIssuedVertexDelivered(reverse);
	});

	it("installs the registration gate before a synchronous signer can reenter", async () => {
		const result = await runFrontierScenario(17, { reenterFromSigner: true });
		expect(result.synchronousReentry).toBe(false);
		expect(result.result).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.nestedResult).toMatchObject({ ok: true, kind: "accepted" });
		expect(result.issued.map(({ operation }) => operation)).toEqual([
			{ action: "causalJoin" },
			{ action: "add", value: 7 },
			{ action: "add", value: 9 },
		]);
		expect(result.issued[2]?.dependencies).toEqual([result.issued[1]?.digest]);
		expect(result.issued.map(({ authorSequence }) => authorSequence)).toEqual([17, 18, 19]);
		expect(result.issued.map(({ logicalTime }) => logicalTime)).toEqual([18, 18, 19]);
		expectEveryIssuedVertexDelivered(result);
	});

	it("does not report application acceptance after an intermediate signer or journal failure", async () => {
		const signerFailure = await runFrontierScenario(17, { failSignerAtIssuedOrdinal: 0 });
		expect(signerFailure.result).toMatchObject({ ok: false, kind: "issuance-rejected" });
		expect(signerFailure.issued).toEqual([]);
		expect(signerFailure.admittedDigests).toEqual([]);

		const journalFailure = await runFrontierScenario(17, { failJournalAtIssuedOrdinal: 0 });
		expect(journalFailure.result).toMatchObject({ ok: false, kind: "journal-rejected" });
		expect(journalFailure.issued).toHaveLength(1);
		expect(journalFailure.issued[0]?.operation).toEqual({ action: "causalJoin" });
		expect(journalFailure.admittedDigests).toEqual([]);

		const laterSignerFailure = await runFrontierScenario(17, {
			failSignerAtIssuedOrdinal: 1,
			retryAfterFailure: true,
		});
		expect(laterSignerFailure.result).toMatchObject({ ok: false, kind: "issuance-rejected" });
		expect(laterSignerFailure.retryResult).toMatchObject({ ok: true, kind: "accepted" });
		expect(laterSignerFailure.issued.map(({ operation }) => operation)).toEqual([
			{ action: "causalJoin" },
			{ action: "add", value: 7 },
		]);
		expect(laterSignerFailure.issued.map(({ authorSequence }) => authorSequence)).toEqual([17, 18]);
		expect(laterSignerFailure.issued.map(({ logicalTime }) => logicalTime)).toEqual([18, 20]);
		expectEveryIssuedVertexDelivered(laterSignerFailure);
		expect(laterSignerFailure.issued[1]?.dependencies).toEqual(
			[laterSignerFailure.initialTips.at(-1), laterSignerFailure.issued[0]?.digest].sort()
		);
	});

	it("requires the exact reserved causalJoin ABI and current authorization", async () => {
		for (const causalJoin of ["missing", "altered-abi"] as const) {
			const result = await runFrontierScenario(17, { causalJoin });
			expect(result.result).toMatchObject({ ok: false });
			expect(result.issued.some(({ operation }) => Reflect.get(operation, "action") === "add")).toBe(false);
		}
		await expect(runFrontierScenario(17, { causalJoin: "unknown-abi" })).rejects.toThrow(
			/^frontier preparation failed: /u
		);
	});

	it("accepts only the frozen sixteen-dependency parameter carrier", async () => {
		expect(await runParameterCarrierScenario(16)).toEqual({ accepted: true });
		for (const maxDependencies of [1, 15, 17] as const) {
			expect(await runParameterCarrierScenario(maxDependencies)).toEqual({ accepted: false });
		}
	});

	it("fails closed when the authenticated graph is already at vertex capacity", async () => {
		const result = await runFrontierScenario(8191);
		expect(result.result).toMatchObject({ ok: false, kind: "graph-rejected" });
		expect(result.issued.some(({ operation }) => Reflect.get(operation, "action") === "add")).toBe(false);
		expect(result.admittedDigests).toEqual([]);
	}, 60_000);

	for (const source of ["recovered-local", "recovered-received", "live-received"] as const) {
		it(`enforces the authenticated dependency bound for ${source}`, async () => {
			const exactBound = await runDependencyBoundScenario(16, source);
			if (source !== "live-received") {
				expect(exactBound.result, JSON.stringify(exactBound.result)).toMatchObject({ ok: true });
			}
			expect(exactBound).toMatchObject(
				source === "live-received"
					? { appendedCount: 17, sinkCount: 1 }
					: { appendedCount: source === "recovered-local" ? 17 : 0, sinkCount: 0 }
			);
			const overBound = await runDependencyBoundScenario(17, source);
			if (source === "live-received") {
				expect(overBound).toMatchObject({ appendedCount: 17, sinkCount: 0 });
			} else {
				expect(overBound.result).toMatchObject({ ok: false, kind: "admission-rejected" });
				expect(overBound.appendedCount).toBe(source === "recovered-local" ? 17 : 0);
			}
		});
	}
});
