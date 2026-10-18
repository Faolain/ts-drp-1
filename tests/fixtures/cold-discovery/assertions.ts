import assert from "node:assert/strict";

import type { RecoveryReport, SetupReport } from "./types.js";

/**
 * Assert the intended reached product gate; masking is an explicit causal RED, never a pass.
 * @param report
 * @param setup
 */
export function assertRecovery(report: RecoveryReport, setup: SetupReport): void {
	const { mode, effects, result } = report;
	const physicalFault = [
		"bad-trust",
		"bad-cut",
		"bad-qc",
		"storage-corrupt-trust",
		"storage-corrupt-cut",
		"storage-corrupt-qc",
		"missing-metadata",
		"poisoned",
		"open",
		"legacy",
		"same-triple-conflict",
		"missing-chunk",
		"corrupt-chunk",
	].includes(mode);
	if (physicalFault) assert.equal(effects.mutations, 1, "physical before-recovery fault was not applied once");
	assert.notEqual(
		report.classification,
		"MASKED_BY_ENVELOPE_REJECTION",
		`MASKED_BY_ENVELOPE_REJECTION:${mode}:downstream assertions not reached`
	);
	const prelookup: Record<string, string> = {
		"old-key": "malformed-input",
		"missing-floor": "D110C_FLOOR_MIGRATION_REQUIRED",
		"missing-floor-old-key": "D110C_FLOOR_MIGRATION_REQUIRED",
		"invalid-floor": "D110C_FLOOR_INVALID",
		"invalid-object": "chain-invalid",
		"wrong-floor": setup.bootstrap.expectedRoomHead.epoch === 1 ? "D110C_FLOOR_MISMATCH" : "chain-invalid",
		"bad-trust": "chain-invalid",
		"bad-cut": "chain-invalid",
		"bad-qc": "chain-invalid",
		"storage-corrupt-trust": "storage-failed",
		"storage-corrupt-cut": "storage-failed",
		"storage-corrupt-qc": "storage-failed",
	};
	const expected = prelookup[mode];
	if (expected !== undefined) {
		assert.equal(result.ok, false);
		assert.equal(result.kind, expected);
		assert.deepEqual(effects.lookupScopes, [], "prelookup gate performed discovery");
		assert.equal(effects.acquisitions, 0);
		assert.equal(effects.reads, 0);
		if (mode.startsWith("storage-corrupt-")) {
			assert.deepEqual(
				effects.recoverResults,
				[{ ok: false, reason: "ADOPTED_BLOB_CORRUPT" }],
				"raw bitrot did not reach native integrity rejection"
			);
			assert.deepEqual(effects.authEvents, [], "raw bitrot reached authentication");
			assert.equal(effects.authMutation?.kind, "storage-corrupt");
		} else if (["bad-trust", "bad-cut", "bad-qc"].includes(mode)) {
			assert.deepEqual(
				effects.recoverResults,
				[{ ok: true, kind: "active" }],
				"authentication fault was masked by storage rejection"
			);
			assert.equal(effects.authMutation?.kind, "digest-consistent");
			assert.ok((effects.authMutation?.changedClosures ?? 0) > 0);
			assert.ok((effects.authMutation?.promotionChanges ?? 0) > 0);
			const checkpoint = setup.bootstrap.expectedRoomHead.epoch === 2;
			const prefix = checkpoint ? [] : [{ site: "cold-genesis", ok: true }];
			const outer = checkpoint ? "cold-checkpoint" : "cold-successor";
			const expectedEvents =
				mode === "bad-trust"
					? [
							...prefix,
							{ site: outer, ok: false, reason: checkpoint ? "current-rejected" : "CERTIFIED_VALUE_MISMATCH" },
						]
					: mode === "bad-cut"
						? [
								...prefix,
								{ site: "successor-qc", ok: true },
								{ site: "successor-cut-binding", matches: false },
								{ site: outer, ok: false, reason: checkpoint ? "commit-qc-rejected" : "CERTIFIED_VALUE_MISMATCH" },
							]
						: [
								...prefix,
								{ site: "successor-qc", ok: false, reason: "proposal-hash-mismatch" },
								{ site: outer, ok: false, reason: checkpoint ? "commit-qc-rejected" : "COMMIT_QC_REJECTED" },
							];
			assert.deepEqual(effects.authEvents, expectedEvents, "intended authentication gate not reached");
		}
		if (mode === "wrong-floor" && setup.bootstrap.expectedRoomHead.epoch === 1)
			assert.equal(result.detail, "creator successor differs from the authenticated room-head floor");
	} else if (mode === "narrow-store") {
		assert.equal(result.kind, "snapshot-unavailable", "required capability violation must be caught locally");
		assert.deepEqual(effects.lookupScopes, []);
		assert.equal(effects.acquisitions, 0);
		assert.equal(effects.reads, 0);
		assert.ok(effects.events.includes("required-capability-missing"), "missing method was never accessed");
	} else {
		if (["delete-after-lookup", "replace-after-lookup", "identical-replacement"].includes(mode))
			assert.equal(effects.mutations, 1, "physical lookup/acquisition race was not applied once");
		assert.deepEqual(
			effects.lookupScopes,
			[setup.oracle.lookupScope],
			"one exact authenticated predecessor key required"
		);
		assert.equal(
			effects.recoverObjects[0],
			setup.bootstrap.expectedRoomHead.objectId,
			"initial selection must use detached expected object"
		);
		if (["missing-metadata", "poisoned", "lookup-rejected", "same-triple-conflict"].includes(mode)) {
			assert.equal(result.ok, false);
			assert.equal(result.kind, "snapshot-unavailable");
			assert.equal(effects.acquisitions, 0);
			assert.equal(effects.reads, 0);
			if (mode === "poisoned") assert.deepEqual(effects.lookupStates, ["poisoned"]);
		} else if (
			["missing-chunk", "corrupt-chunk", "delete-after-lookup", "replace-after-lookup", "legacy"].includes(mode)
		) {
			assert.equal(result.ok, false);
			assert.equal(result.kind, "snapshot-unavailable");
			assert.equal(effects.acquisitions, 1);
			assert.ok(effects.reads > 0);
			if (mode === "legacy") assert.deepEqual(effects.lookupRetentions, ["legacy-unclassified"]);
			else assert.deepEqual(effects.lookupStates, ["verified"]);
		} else {
			assert.equal(result.ok, true, `GENUINE_COLD_ACTIVATION:${String(result.kind)}:${String(result.detail)}`);
			assert.deepEqual(report.head, setup.bootstrap.expectedRoomHead);
			assert.equal(
				report.state,
				setup.oracle.expectedState,
				"recovered application state differs from genuine producer"
			);
			assert.equal(report.issued?.ok, true);
			assert.equal(report.published?.ok, true);
			assert.equal(effects.acquisitions, 1);
			assert.ok(effects.reads > 0);
			assert.ok(effects.signs >= 2);
			assert.ok(effects.publications > 0);
			if (mode === "success" || mode === "rehash-noop") {
				assert.deepEqual(effects.recoverResults, [{ ok: true, kind: "active" }]);
				assert.deepEqual(effects.authEvents, [
					...(setup.bootstrap.expectedRoomHead.epoch === 1 ? [{ site: "cold-genesis", ok: true }] : []),
					{ site: "successor-qc", ok: true },
					{ site: "successor-cut-binding", matches: true },
					{ site: setup.bootstrap.expectedRoomHead.epoch === 1 ? "cold-successor" : "cold-checkpoint", ok: true },
				]);
				if (mode === "rehash-noop") {
					assert.equal(effects.authMutation?.kind, "digest-consistent");
					assert.equal(effects.authMutation?.mode, mode);
					assert.deepEqual(effects.authMutation?.oldRef, effects.authMutation?.newRef);
					assert.equal(effects.authMutation?.changedClosures, 0);
					assert.equal(effects.authMutation?.changedBases, 0);
					assert.equal(effects.authMutation?.promotionChanges, 0);
				}
			}
			if (mode === "open") {
				assert.deepEqual(effects.lookupStates, ["open"]);
				assert.equal(effects.completes, 1);
			} else assert.deepEqual(effects.lookupStates, ["verified"]);
			if (mode === "mutate-floor") assert.ok(effects.events.includes("caller-floor-mutated-after-await"));
		}
	}
	if (!result.ok) {
		assert.equal(effects.signs, 0);
		assert.equal(effects.subscriptions, 0);
		assert.equal(effects.publications, 0);
	}
}
