import nativeAssert from "node:assert/strict";

import { assertDirectObservations, assertRecoveryObservations, recoverySchedule } from "./observation-oracle.js";
import type { Case } from "./roster.js";
import type { OwnerCase, ProbeReport, RecoveryReport, SetupReport } from "./types.js";
import { encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import { digest } from "../cold-discovery/application.js";
let assertionReport: RecoveryReport | undefined;
// Controller-only assertion accounting. Original assertions still execute and throw unchanged.
const assert: typeof nativeAssert = new Proxy(nativeAssert, {
	get(target, key): unknown {
		const method = Reflect.get(target, key, target) as unknown;
		if (typeof method !== "function" || assertionReport === undefined) return method;
		return (...args: unknown[]): unknown => {
			const report = assertionReport;
			if (report?.executedAssertions === undefined) throw new Error("ASSERTION_ACCOUNTING_NOT_ACTIVE");
			const entry: {
				id: number;
				method: string;
				status: "passed" | "failed";
				scope: "envelope-causality" | "recovery";
				message?: string;
			} = {
				id: report.executedAssertions.length + 1,
				method: String(key),
				status: "passed",
				scope: report.classification === "MASKED_BY_ENVELOPE_REJECTION" ? "envelope-causality" : "recovery",
			};
			const message = key === "fail" ? args[0] : key === "ok" ? args[1] : args[2];
			if (typeof message === "string") entry.message = message;
			try {
				return Reflect.apply(method, target, args) as unknown;
			} catch (error) {
				entry.status = "failed";
				throw error;
			} finally {
				report.executedAssertions.push(entry);
			}
		};
	},
});
const malformed = ["retained-key", "retained-undefined", "missing-key", "extra-key", "accessor", "symbol", "non-plain"];
const structural = ["invalid-previous", "invalid-next", "invalid-object", "wrong-profile", "nonconsecutive"];
const success = [
	"verified",
	"open",
	"identical-replacement",
	"expired-recovery",
	"legacy-verified",
	"expired-temporary-legacy-elsewhere",
	"expiry-after-acquisition",
	"mutate-heads",
	"retry",
	"retry-active",
	"mixed-unavailable",
	"divergent-mixed-unavailable",
	"lost-cas",
];
/**
 * Run the named pending-only fixture seam.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function expectedKind(mode: string): string | undefined {
	if (malformed.includes(mode)) return "malformed-input";
	if (structural.includes(mode)) return "chain-invalid";
	if (["storage-failed", "lineage-failed"].includes(mode)) return "storage-failed";
	if (mode === "unexpected-read") return "internal-invariant";
	if (["fork", "fork-active"].includes(mode)) return "true-fork";
	if (mode === "stale-base") return "stale-head";
	if (["failed-cas", "reread-failed", "reread-unrelated"].includes(mode)) return "pending-old";
	if (success.includes(mode)) return undefined;
	return "pending-missing";
}
/**
 * Run the named pending-only fixture seam.
 * @param report - Explicit fixture-owned input for this isolated control.
 * @param setup - Explicit fixture-owned input for this isolated control.
 * @param scenario - Explicit fixture-owned input for this isolated control.
 * @param diagnostic - Explicit fixture-owned input for this isolated control.
 */
export function assertRecovery(report: RecoveryReport, setup: SetupReport, scenario: Case, diagnostic = false): void {
	if (assertionReport !== undefined) throw new Error("ASSERTION_ACCOUNTING_REENTRY");
	if (
		diagnostic &&
		scenario.mode === "divergent-mixed-unavailable" &&
		report.classification !== "OBSOLETE_DIAGNOSTIC_KEY_REFUSAL"
	) {
		nativeAssert.ok(report.allAvailable, "divergent diagnostic requires a distinct all-available genuine invocation");
		nativeAssert.equal(
			new Set(setup.oracle.preparedCandidates.map((candidate) => candidate.closureDigest)).size,
			2,
			"two genuinely prepared distinct native closure digests"
		);
		assertRecovery(report.allAvailable, setup, { ...scenario, mode: "fork" }, true);
	}
	report.expectedObservations = recoverySchedule(setup, scenario, diagnostic);
	assertionReport = report;
	report.executedAssertions = [];
	report.downstreamAssertions =
		report.classification === "MASKED_BY_ENVELOPE_REJECTION" ? "MASKED_BY_ENVELOPE_REJECTION" : "EXECUTED_AS_LISTED";
	try {
		assertRecoveryBody(report, setup, scenario, diagnostic);
	} finally {
		assertionReport = undefined;
	}
}
function assertRecoveryBody(report: RecoveryReport, setup: SetupReport, scenario: Case, diagnostic: boolean): void {
	const { mode, effects } = report;
	if (report.classification === "MASKED_BY_ENVELOPE_REJECTION") {
		assert.equal(report.result.ok, false);
		assert.equal(report.result.kind, "malformed-input");
		assert.equal(effects.acquisitions, 0);
		assert.equal(effects.reads, 0);
		assert.equal(effects.accesses, 0);
		assert.equal(effects.lookups, 0);
		assert.equal(effects.nativeLookups, 0);
		assert.equal(effects.nativeAcquisitions, 0);
		assert.equal(effects.completes, 0);
		assert.equal(effects.rereads, 0);
		assert.equal(effects.swaps.length, 0);
		assert.deepEqual(report.durableAfter, report.durableBefore);
		assert.fail("CAUSAL_RED: declaration-free envelope rejected; downstream assertions MASKED_BY_ENVELOPE_REJECTION");
	}
	// The RED-baseline diagnostic intentionally becomes obsolete at GREEN.
	if (diagnostic && report.result.kind === "malformed-input") {
		assert.equal(report.classification, "OBSOLETE_DIAGNOSTIC_KEY_REFUSAL");
		assert.equal(effects.traces.length, 0, "obsolete legacy diagnostic performs no product I/O");
		assert.deepEqual(report.durableAfter, report.durableBefore, "obsolete diagnostic never publishes");
		return;
	}
	const expected = expectedKind(mode);
	assert.equal(report.result.ok, expected === undefined);
	if (expected !== undefined) assert.equal(report.result.kind, expected);
	assertRecoveryObservations(report, setup, scenario, diagnostic, assert);
	if (malformed.includes(mode) || structural.includes(mode)) {
		assert.equal(effects.traces.length, 0);
		assert.equal(effects.accesses, 0);
		assert.deepEqual(report.durableAfter, report.durableBefore);
		return;
	}
	const snapshots = effects.traces.filter((entry) => entry.site === "snapshot-payload");
	const verifiedSnapshots = effects.traces.filter((entry) => entry.site === "snapshot-result" && entry.ok === true);
	assert.equal(snapshots.length, verifiedSnapshots.length, "one observation per actual shared verifier success");
	for (const verified of verifiedSnapshots) {
		const values = snapshots.filter((entry) => entry.candidate === verified.candidate);
		assert.equal(values.length, 1, "candidate-local actual snapshot value");
		const value = values[0];
		assert.ok(value);
		assert.equal(
			value.application,
			setup.oracle.expectedState,
			"actual recovered application equals independent arithmetic oracle"
		);
		assert.equal(
			value.stateDigest,
			digest("ts-drp/state/v3", encodeCanonical(setup.oracle.expectedState)),
			"actual recovered state digest"
		);
		assert.equal(value.ok, true, "actual payload bytes match authenticated manifest digest");
		assert.match(value.payloadDigest ?? "", /^[0-9a-f]{64}$/u);
		assert.ok((value.payloadBytes ?? 0) > 0, "actual shared verifier payload length");
	}
	if (report.result.ok === true) {
		assert.ok(setup.oracle.intendedPublicationHead, "setup captured intended publication head");
		assert.deepEqual(
			report.durableAfter,
			setup.oracle.intendedPublicationHead,
			"exact durable published head and revision"
		);
		assert.deepEqual(report.result.head, setup.bootstrap.expectedNextRoomHead, "trusted next head");
		assert.equal(report.result.lifecycle, "successor-published");
		assert.equal(report.result.recovery, "active-new");
	}
	if (report.result.ok !== true) {
		if (mode === "reread-failed") {
			assert.ok(setup.oracle.intendedPublicationHead);
			assert.deepEqual(
				report.durableAfter,
				setup.oracle.intendedPublicationHead,
				"committed publication survives failed reread"
			);
		} else if (mode === "reread-unrelated") {
			assert.ok(setup.oracle.intendedUnrelatedHead);
			assert.deepEqual(
				report.durableAfter,
				setup.oracle.intendedUnrelatedHead,
				"exact concurrent unrelated publication"
			);
		} else assert.deepEqual(report.durableAfter, report.durableBefore, "refusal leaves exact durable head unchanged");
	}
	if (mode.startsWith("storage-corrupt-")) {
		assert.ok(
			effects.traces.some((entry) => entry.site === "native-blob-integrity" && entry.ok === false),
			"actual durable bytes mismatch their reference digest"
		);
		const damaged = new Set(
			effects.traces
				.filter((entry) => entry.site === "native-blob-integrity" && entry.ok === false)
				.map((entry) => entry.candidate)
		);
		assert.ok(
			effects.traces.some(
				(entry) =>
					["successor-trust", "checkpoint-trust"].includes(entry.site) &&
					entry.ok === false &&
					damaged.has(entry.candidate)
			),
			"same damaged candidate reaches actual native trust refusal"
		);
	}
}
/**
 * Run the named pending-only fixture seam.
 * @param report - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param setup - Independent arithmetic and manifest oracle, controller-only.
 */
export function assertProbe(report: ProbeReport, mode: OwnerCase, setup: SetupReport): void {
	assertDirectObservations(report, setup, mode, assert);
	const expectedState = setup.oracle.expectedState;
	if (mode === "verified") {
		assert.ok(
			report.availability?.effects.traces.some(
				(entry) => entry.site === "intentional-first-lookup-rejection" && entry.ok === true
			),
			"first native lookup was present/verified before intentional injection"
		);
		assert.equal(
			report.availability?.firstRejected,
			true,
			"conditional fault dynamically rejects first actual native lookup"
		);
		assert.equal(report.availability?.secondAvailable, true, "same key second actual native lookup is available");
	}
	assert.equal(report.competing, true, "real competing scope");
	const expected = [
		"verified",
		"open",
		"identical-replacement",
		"expired-recovery",
		"legacy-verified",
		"expired-temporary-legacy-elsewhere",
		"expiry-after-acquisition",
	].includes(mode);
	assert.equal(report.verified, expected, `native direct owner verification: ${mode} ${report.failure ?? ""}`);
	if (expected) {
		assert.equal(report.application, expectedState, "actual native owner payload application state");
		assert.equal(report.stateDigest, digest("ts-drp/state/v3", encodeCanonical(expectedState)));
		assert.match(report.payloadDigest ?? "", /^[0-9a-f]{64}$/u);
		assert.ok(report.bytes > 0);
	}
	if (mode === "same-triple-conflict")
		assert.equal(report.failureCode, "conflict", "native exact-key conflict provenance");
	if (mode === "lookup-rejected") assert.match(report.failure ?? "", /INTENTIONAL_LOOKUP_REJECTION/u);
	if (mode === "narrow-store") assert.match(report.failure ?? "", /not a function/u);
	if (["legacy-open", "open-legacy-elsewhere"].includes(mode)) {
		assert.equal(report.failureCode, "migration-required", "native legacy-completion refusal provenance");
	}
}
