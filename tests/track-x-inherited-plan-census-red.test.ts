import type { SettlementPlan } from "@ts-drp/issuance-store";
import {
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementImage,
	type IssuanceRetirementRows,
} from "@ts-drp/issuance-store/maintenance";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// Track X, from Track V's shipped Grid spec (tests/phase-3a1b-d9346-v3-zone.pw.ts:908) on the
// creator-trusted-settlement-v1 profile. A Writer issues a block in the source zone; the
// creator rehearses and activates a migration that imports it. The Writer then joins the
// target through the persisted redirect. On settlement its target session first writes a
// settlement plan (v3-room.ts writeMergedSettlementPlan) with one `inherited` entry for that
// block, and only then issues its first target fence, which creates its target lineage.
// The plan is the exact shape the browser store held at the failure: one inherited entry,
// fenceSequence null, revision 0, and no lineage, issued or outbox row for the Writer.
// The store accepts the write, but the bounded recovery census refused it ("issuance
// retirement plan has no lineage"), so the Writer's target session failed and could never
// open the zone again.

const SOURCE = `creator:${"f".repeat(32)}`;
const TARGET = `creator:${"e".repeat(32)}`;
const OTHER = `creator:${"d".repeat(32)}`;
const WRITER = "a".repeat(64);
const TARGET_CREATOR = "9".repeat(64);
const SCOPE = Object.freeze({ author: WRITER, objectId: TARGET });

const inheritedPlan = (
	overrides: Readonly<{ fenceSequence?: number | null; targetObjectId?: string }> = {}
): SettlementPlan => ({
	entries: [
		{
			disposition: "inherited",
			inheritance: {
				sourceObjectId: SOURCE,
				targetAuthor: TARGET_CREATOR,
				targetAuthorSequence: 3,
				targetObjectId: overrides.targetObjectId ?? TARGET,
				targetVertexDigest: new Uint8Array(32).fill(0x22),
			},
			replacementSequence: null,
			sourceDigest: new Uint8Array(32).fill(0x11),
			sourceSequence: 2,
		},
	],
	fenceSequence: overrides.fenceSequence === undefined ? null : overrides.fenceSequence,
	revision: 0,
	scope: SCOPE,
});

const onlyPlans = (plans: readonly SettlementPlan[]): IssuanceRetirementRows => ({
	issued: [],
	lineages: [],
	outbox: [],
	plans,
});

describe("Track X: a migrated Writer's settlement plan before its first target fence", () => {
	it("is classified by the native bounded recovery census, not refused for having no lineage", async () => {
		const directory = mkdtempSync(join(realpathSync(tmpdir()), "track-x-inherited-plan-"));
		const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
		try {
			const plan = inheritedPlan();
			expect(await store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: SCOPE })).toEqual(plan);
			const owner = durableIssuancePruningMaintenanceForStore(store);
			const read = owner?.readBoundedRecoveryCensus;
			if (owner === undefined || read === undefined) throw new Error("native recovery census is unavailable");
			const census = await read.call(owner, { limits: ISSUANCE_RETIREMENT_LIMITS, objectId: TARGET });
			expect(census.rows).toEqual(onlyPlans([plan]));
			expect(census.image).toEqual(issuanceRetirementImage(census.rows, TARGET));
			expect(census.image).toMatchObject({ issuedCount: 0, lineageCount: 0, outboxCount: 0, planCount: 1 });
		} finally {
			await store.close();
		}
	});

	it("still refuses a lineage-less plan that is not wholly external to this object", () => {
		const local = {
			disposition: "rebase" as const,
			replacementSequence: null,
			sourceDigest: new Uint8Array(32).fill(0x33),
			sourceSequence: 1,
		};
		const refusals: readonly SettlementPlan[] = [
			// inherited into a different object
			inheritedPlan({ targetObjectId: OTHER }),
			// a fence is already recorded, so a lineage must exist
			inheritedPlan({ fenceSequence: 0 }),
			// a local source in this object needs its lineage
			{ ...inheritedPlan(), entries: [...inheritedPlan().entries, local] },
			// nothing to settle
			{ ...inheritedPlan(), entries: [] },
		];
		for (const plan of refusals)
			expect(() => issuanceRetirementImage(onlyPlans([plan]), TARGET)).toThrow(
				"issuance retirement plan has no lineage"
			);
	});
});
