import { describe, expect, it } from "vitest";

import {
	auditPerAuthorCapacitySource,
	encodedAclBoundary,
	measureMembershipLookups,
	silentCreatorCloseOversizeSites,
	source,
	stageOpenBoundary,
	W0_LEGACY_ACL_MAX_CANONICAL_BYTES,
} from "./fixtures/phase-6b-d110c-0c1k/w0-contract.js";

describe("D.110c-0c1k W0 writer-capacity RED", () => {
	it("keeps the legacy 8,192-byte ACL ceiling and aligns stage/open at 31/64/65", () => {
		const lifecycleConsumers = [
			"packages/node/src/creator-close.ts",
			"packages/node/src/creator-adoption.ts",
			"packages/node/src/v3-live.ts",
		];
		for (const path of lifecycleConsumers) {
			expect(source(path), `${path} must consume the canonical ACL opener`).toContain(
				"openCanonicalLatchedAclSnapshot"
			);
		}
		const expectedByCount = new Map<31 | 64 | 65, boolean>([
			[31, true],
			[64, false],
			[65, false],
		]);
		expect(W0_LEGACY_ACL_MAX_CANONICAL_BYTES).toBe(8_192);
		const aclSource = source("packages/protocol-v3/src/latched-acl.ts");
		expect(aclSource).toContain("const MAX_CANONICAL_BYTES = 8192;");
		expect(aclSource).toContain("record.members.length > (record.version === 3 ? 256 : 64)");
		expect([31, 64, 65].map((count) => encodedAclBoundary(count as 31 | 64 | 65))).toEqual([
			{ byteLength: 6_297, fitsLegacyCeiling: true },
			{ byteLength: 12_864, fitsLegacyCeiling: false },
			{ byteLength: 13_063, fitsLegacyCeiling: false },
		]);
		for (const memberCount of [31, 64, 65] as const) {
			const result = stageOpenBoundary(memberCount);
			const expected = expectedByCount.get(memberCount);
			expect.soft(result.stageOk, `${memberCount} members: staging boundary`).toBe(expected);
			expect.soft(result.openOk, `${memberCount} members: close/adoption/recovery open boundary`).toBe(expected);
			expect.soft(result.stageOk, `${memberCount} members: stage/open parity`).toBe(result.openOk);
		}
	});

	it("rejects each oversized recognized creator-close record loudly instead of omitting it from either scan", () => {
		expect(
			silentCreatorCloseOversizeSites(),
			"an oversized recognized record must reach its kind codec and reject, never disappear from the candidate set"
		).toEqual([]);
		expect(source("packages/node/src/creator-close.ts")).not.toContain("SCANNABLE_BYTES");
	});

	it("uses one opened-snapshot O(1) membership index without changing 8,192 accept/reject decisions in either mode", () => {
		const measured = measureMembershipLookups();
		expect(measured.decisionsMatch).toBe(true);
		expect(
			measured.memberIterationsAfterOpen,
			"authorization must use the membership index built at open, not re-copy/re-scan members per vertex"
		).toBe(0);
	});

	it("accounts an author-specific default-4 epoch share at every ingress/local capacity gate while preserving global close capacity", () => {
		const audit = auditPerAuthorCapacitySource();
		expect
			.soft(audit.newParameterNames, "the canonical genesis parameter schema adds exactly the share multiplier")
			.toHaveLength(1);
		expect.soft(audit.parameterName, "the new parameter names its author/writer share authority").toBeDefined();
		expect
			.soft(audit.parameterValueIsDefaultedByBuilders, "product genesis builders pin the decided default k=4")
			.toBe(true);
		expect
			.soft(audit.capacityBody, "the capacity owner must retain the shared epoch ceiling")
			.toContain("maxEpochVertices");
		expect
			.soft(audit.capacityBody, "the capacity owner must apply the canonical share parameter")
			.toContain(audit.parameterName ?? "D110C_0C1K_W0_SHARE_PARAMETER_MISSING");
		expect.soft(audit.capacityBody, "the per-writer share uses the decided ceiling division").toMatch(/\bceil\b/iu);
		expect
			.soft(audit.capacityCalls.length, "ingress and both local pre/post-sign gates remain covered")
			.toBeGreaterThanOrEqual(3);
		for (const call of audit.capacityCalls) {
			expect
				.soft(call, `capacity call must charge the authenticated author (fences are not exempt): ${call}`)
				.toMatch(/author/iu);
		}
	});
});
