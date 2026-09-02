import "fake-indexeddb/auto";

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type D110c0b1ClosureEntry,
	type D110c0b1RedFixture,
	openD110c0b1RedFixture,
} from "./fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.js";
import { inspectBoundedCreatorTrustAdvance } from "../packages/control-plane/src/creator-trust-checkpoint-advance.js";
import { openCreatorCheckpointTrust } from "../packages/protocol-v3/src/creator-checkpoint.js";

function entries(
	census: readonly D110c0b1ClosureEntry[],
	kind: string,
	epoch: number,
	phase?: string
): readonly D110c0b1ClosureEntry[] {
	return census.filter(
		(entry) => entry.kind === kind && entry.epoch === epoch && (phase === undefined || entry.phase === phase)
	);
}

describe("D.110c-0b1 bounded checkpoint and control-proof GREEN", () => {
	let fixture: D110c0b1RedFixture;
	let bounded: ReturnType<typeof inspectBoundedCreatorTrustAdvance>;
	let checkpoint: ReturnType<typeof openCreatorCheckpointTrust>;

	beforeAll(async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		fixture = await openD110c0b1RedFixture();
		checkpoint = openCreatorCheckpointTrust(fixture.evidence.checkpointInput);
		bounded = inspectBoundedCreatorTrustAdvance(fixture.evidence.boundedInput);
		const evidencePath = process.env.D110C_0B1_EVIDENCE_PATH;
		if (evidencePath !== undefined) {
			const coldReopen = fixture.evidence.coldReopen;
			const coldHandle =
				coldReopen.handle !== null && typeof coldReopen.handle === "object"
					? (coldReopen.handle as Readonly<Record<string, unknown>>)
					: undefined;
			writeFileSync(
				evidencePath,
				`${JSON.stringify(
					{
						bounded,
						checkpoint:
							checkpoint.ok === true
								? {
										currentTrust: checkpoint.currentTrust,
										ok: true,
										predecessorTrust: checkpoint.predecessorTrust,
									}
								: checkpoint,
						coldReopen: {
							detail: coldReopen.detail,
							handle:
								coldHandle === undefined
									? undefined
									: { epoch: coldHandle.epoch, objectId: coldHandle.objectId, topic: coldHandle.topic },
							kind: coldReopen.kind,
							lifecycle: coldReopen.lifecycle,
							ok: coldReopen.ok,
							recovery: coldReopen.recovery,
							trust: coldReopen.trust,
						},
						coldIssued: fixture.evidence.coldIssued,
						coldPublished: fixture.evidence.coldPublished,
						census: {
							active: fixture.evidence.activeCensus,
							current: fixture.evidence.currentCensus,
							proposed: fixture.evidence.proposedCensus,
						},
						durableHeads: fixture.evidence.durableHeads,
						durableReferences: fixture.evidence.durableReferences,
					},
					null,
					2
				)}\n`
			);
		}
	});

	afterAll(async () => {
		await fixture?.close();
	});

	it("opens the genuine epoch-two checkpoint from pinned genesis and its immediate pair", () => {
		expect(fixture.evidence.currentOpenReasons).toEqual(["trust-state-inconsistent", "trust-state-inconsistent"]);
		expect(fixture.evidence.oneStepFromGenesis).toEqual({ ok: false, reason: "EPOCH_GAP" });
		expect(checkpoint).toMatchObject({
			currentTrust: { currentEpoch: 2 },
			ok: true,
			predecessorTrust: { currentEpoch: 1 },
		});
	});

	it("retires the stale proof pair and predecessor ACL under the bounded advance", () => {
		const { activeCensus, currentCensus, existingAdvance, proposedCensus } = fixture.evidence;
		expect(existingAdvance).toMatchObject({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
		expect(bounded).toEqual({ kind: "successor", ok: true });
		expect(currentCensus).toHaveLength(5);
		expect(proposedCensus).toHaveLength(4);
		expect(activeCensus).toHaveLength(5);
		expect(entries(currentCensus, "drp-hard-epoch-cut", 0)).toHaveLength(1);
		expect(entries(currentCensus, "drp-seal-qc", 0, "commit")).toHaveLength(1);
		expect(entries(currentCensus, "drp-v3-latched-acl", 0)).toHaveLength(1);
		expect(entries(proposedCensus, "drp-hard-epoch-cut", 0)).toHaveLength(0);
		expect(entries(proposedCensus, "drp-seal-qc", 0, "commit")).toHaveLength(0);
		expect(entries(proposedCensus, "drp-v3-latched-acl", 0)).toHaveLength(0);
		expect(entries(proposedCensus, "drp-hard-epoch-cut", 1)).toHaveLength(1);
		expect(entries(proposedCensus, "drp-seal-qc", 1, "commit")).toHaveLength(1);
		expect(entries(activeCensus, "drp-hard-epoch-cut", 0)).toHaveLength(0);
		expect(entries(activeCensus, "drp-seal-qc", 0, "commit")).toHaveLength(0);
		expect(entries(activeCensus, "drp-v3-latched-acl", 0)).toHaveLength(0);
		expect(entries(activeCensus, "drp-v3-latched-acl", 1)).toHaveLength(1);
	});

	it("cold reopens the genuine active epoch-two room through the bounded checkpoint owner", () => {
		const { active, current, proposed } = fixture.evidence.durableHeads;
		expect(Number(proposed.revision)).toBe(Number(current.revision) + 1);
		expect(Number(active.revision)).toBe(Number(proposed.revision) + 1);
		expect(fixture.evidence.coldReopen).toMatchObject({
			handle: { epoch: 2 },
			lifecycle: "active",
			ok: true,
			recovery: "active-new",
		});
		expect(fixture.evidence.coldIssued).toMatchObject({ kind: "accepted", ok: true });
		expect(fixture.evidence.coldPublished).toEqual({ kind: "published", ok: true });
	});
});
