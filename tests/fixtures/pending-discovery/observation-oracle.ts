import nativeAssert from "node:assert/strict";

import type { Case } from "./roster.js";
import type { Effects, OwnerCase, ProbeReport, RecoveryCase, RecoveryReport, SetupReport, Trace } from "./types.js";

type Step = Pick<Trace, "site" | "ok" | "kind" | "state" | "retention" | "code">;
interface CandidateSchedule {
	id: string;
	steps: Step[];
}
export interface ObservationSchedule {
	candidates: CandidateSchedule[];
	global: Pick<Trace, "site" | "candidate" | "ok">[];
	mutations: number;
	swaps: string[];
}
export interface DirectSchedule {
	competing: Step[];
	target: Step[];
	availability: Step[] | null;
	mutations: number;
}
const malformed = ["retained-key", "retained-undefined", "missing-key", "extra-key", "accessor", "symbol", "non-plain"];
const structural = ["invalid-previous", "invalid-next", "invalid-object", "wrong-profile", "nonconsecutive"];
const storage = ["storage-failed", "lineage-failed", "unexpected-read"];
const trustRefusals = [
	"bad-trust",
	"bad-cut",
	"bad-qc",
	"storage-corrupt-trust",
	"storage-corrupt-cut",
	"storage-corrupt-qc",
];
const successful = [
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
const raceRefusals = ["failed-cas", "reread-failed", "reread-unrelated"];
const gateSites = new Set([
	"closure-load",
	"genesis-trust",
	"successor-trust",
	"checkpoint-trust",
	"authenticated-previous",
	"authenticated-next",
	"pre-transition",
	"snapshot-result",
	"snapshot-payload",
	"catalog-result",
	"projection-payload",
	"parameters",
	"acl-selection",
	"acl-result",
	"settlement-repeat",
]);
const nativeSites = new Set([
	"lookup-property-access",
	"lookup",
	"native-lookup",
	"native-lookup-outcome",
	"native-lookup-refusal",
	"native-mutation-refusal",
	"intentional-lookup-rejection",
	"intentional-first-lookup-rejection",
	"lookup-race-applied",
	"acquisition-race-applied",
	"diagnostic-before-open",
	"acquire",
	"native-acquire",
	"native-read",
	"complete",
]);
const globalSites = new Set([
	"read-head",
	"lineage",
	"heads-mutated-after-await",
	"cas",
	"unrelated-head-race",
	"active-reread",
	"failed-cas-applied",
	"lost-cas-response-applied",
	"reread-failure-applied",
]);
const scopedSites = new Set([
	"lookup",
	"native-lookup",
	"native-lookup-outcome",
	"native-lookup-refusal",
	"lookup-race-applied",
	"acquisition-race-applied",
	"acquire",
	"native-acquire",
	"complete",
]);
const plain = (site: string): Step => ({ site });
const gate = (site: string, ok: boolean): Step => ({ site, ok });
const repeated = (site: string, count: number): Step[] => Array.from({ length: count }, () => plain(site));

function chunks(setup: SetupReport): number {
	const value = setup.oracle.snapshotChunks;
	if (
		!value.allPreloaded ||
		value.count <= 0 ||
		value.indices.length !== value.count ||
		value.indices.some((index, position) => index !== position)
	)
		throw new Error("ORACLE_REQUIRES_CONTIGUOUS_PRELOADED_MANIFEST_CHUNKS");
	return value.count;
}
function ownerMutation(mode: string): number {
	if (["verified", "lookup-rejected", "narrow-store"].includes(mode)) return 0;
	if (["delete-after-lookup", "replace-after-lookup", "identical-replacement"].includes(mode)) return 1;
	return mode === "expiry-after-acquisition" ? 2 : 1;
}
function ownerMode(mode: RecoveryCase): OwnerCase {
	return [
		"verified",
		"open",
		"missing-metadata",
		"poisoned",
		"lookup-rejected",
		"narrow-store",
		"same-triple-conflict",
		"missing-chunk",
		"corrupt-chunk",
		"delete-after-lookup",
		"replace-after-lookup",
		"identical-replacement",
		"expired-temporary",
		"expired-recovery",
		"legacy-open",
		"legacy-verified",
		"expired-temporary-legacy-elsewhere",
		"open-legacy-elsewhere",
		"expiry-after-acquisition",
	].includes(mode)
		? (mode as OwnerCase)
		: "verified";
}
function outcome(mode: OwnerCase): Step {
	if (mode === "missing-metadata") return { site: "native-lookup-outcome", kind: "missing" };
	const state = ["open", "legacy-open", "open-legacy-elsewhere", "expiry-after-acquisition"].includes(mode)
		? "open"
		: mode === "poisoned"
			? "poisoned"
			: "verified";
	const retention = ["legacy-open", "legacy-verified"].includes(mode)
		? "legacy-unclassified"
		: [
					"open",
					"poisoned",
					"expired-temporary",
					"expired-temporary-legacy-elsewhere",
					"open-legacy-elsewhere",
					"expiry-after-acquisition",
			  ].includes(mode)
			? "temporary"
			: "recovery";
	return { site: "native-lookup-outcome", kind: "present", state, retention };
}
function lookup(mode: OwnerCase, unavailable: boolean): Step[] {
	const steps = [plain("lookup-property-access")];
	if (mode === "narrow-store") return steps;
	steps.push(plain("lookup"));
	if (mode === "lookup-rejected") return [...steps, plain("intentional-lookup-rejection")];
	steps.push(plain("native-lookup"));
	if (mode === "same-triple-conflict") return [...steps, { site: "native-lookup-refusal", code: "conflict" }];
	steps.push(outcome(mode));
	if (unavailable) steps.push(gate("intentional-first-lookup-rejection", true));
	if (["delete-after-lookup", "replace-after-lookup", "identical-replacement"].includes(mode))
		steps.push(gate("lookup-race-applied", true));
	return steps;
}
function lookupStops(mode: OwnerCase): boolean {
	return ["missing-metadata", "poisoned", "lookup-rejected", "narrow-store", "same-triple-conflict"].includes(mode);
}
/**
 * Independent fixture schedule, not a replay of the candidate authenticator.
 * All intact fixture chunks were already durably written by genuine setup verification.
 * Shared verifier443–529: verified reads C; open stream reads C from its native
 * quarantine (snapshot-stream verifyInput), so source.read is unused, and missing
 * collected chunks are then read C more. Direct probe explicitly rereads C instead.
 * These formulas coincide ONLY for our intact preloaded schedule. First missing
 * chunk in a newly recreated scope causes one quarantine + one source native read,
 * then refusal before completion. Legacy completion refuses after stream C and
 * before the post-stream reads. No lifetime/product policy is invented here.
 * @param mode - The frozen fixture fault schedule.
 * @param count - Independent actual manifest descriptor count.
 * @returns Exact acquisition/read/completion steps and real verifier outcome.
 */
function snapshotIo(mode: OwnerCase, count: number): { steps: Step[]; ok: boolean } {
	const steps = [plain("acquire"), plain("native-acquire")];
	if (mode === "expiry-after-acquisition") steps.push(gate("acquisition-race-applied", true));
	if (["missing-chunk", "corrupt-chunk", "replace-after-lookup"].includes(mode))
		return { steps: [...steps, plain("native-read")], ok: false };
	if (["delete-after-lookup", "expired-temporary"].includes(mode))
		return { steps: [...steps, ...repeated("native-read", 2)], ok: false };
	if (["legacy-open", "open-legacy-elsewhere"].includes(mode))
		return {
			steps: [
				...steps,
				...repeated("native-read", count),
				plain("complete"),
				{ site: "native-mutation-refusal", code: "migration-required" },
			],
			ok: false,
		};
	if (["open", "expiry-after-acquisition"].includes(mode))
		return {
			steps: [...steps, ...repeated("native-read", count), plain("complete"), ...repeated("native-read", count)],
			ok: true,
		};
	return { steps: [...steps, ...repeated("native-read", count)], ok: true };
}
function authenticatedPrefix(mode: RecoveryCase, epoch: 1 | 2): { steps: Step[]; proceeds: boolean } {
	const steps = [gate("closure-load", true)];
	if (epoch === 1) steps.push(gate("genesis-trust", true));
	steps.push(gate(epoch === 1 ? "successor-trust" : "checkpoint-trust", !trustRefusals.includes(mode)));
	if (trustRefusals.includes(mode)) return { steps, proceeds: false };
	steps.push(gate("authenticated-previous", mode !== "wrong-previous"));
	if (mode === "wrong-previous") return { steps, proceeds: false };
	steps.push(gate("authenticated-next", mode !== "wrong-next"));
	if (mode === "wrong-next") return { steps, proceeds: false };
	steps.push(gate("pre-transition", mode !== "bad-pre-transition"));
	return { steps, proceeds: mode !== "bad-pre-transition" };
}
function afterSnapshot(mode: RecoveryCase): Step[] {
	const steps = [gate("snapshot-payload", true), gate("catalog-result", mode !== "catalog-rejected")];
	if (mode === "catalog-rejected") return steps;
	steps.push(gate("projection-payload", mode !== "bad-projection"));
	if (mode === "bad-projection") return steps;
	steps.push(gate("parameters", mode !== "parameters-rejected"));
	if (mode === "parameters-rejected") return steps;
	steps.push(gate("acl-selection", mode !== "bad-acl"));
	if (mode === "bad-acl") return steps;
	return [...steps, gate("acl-result", true), gate("settlement-repeat", mode !== "bad-settlement")];
}
/**
 * Freeze exact per-candidate schedules from fixture mode and controller-only setup provenance.
 * @param setup - Native prepared IDs/digests and genuine manifest descriptor structure.
 * @param scenario - The concrete frozen case.
 * @param diagnostic - Current-interface instrumentation, never product success evidence.
 * @returns Independent exact schedule, not derived from observed recovery counters.
 */
export function recoverySchedule(setup: SetupReport, scenario: Case, diagnostic: boolean): ObservationSchedule {
	const mode = scenario.mode,
		count = chunks(setup),
		candidates: CandidateSchedule[] = [];
	const noInputIo = malformed.includes(mode) || structural.includes(mode);
	const global: ObservationSchedule["global"] = noInputIo
		? []
		: [
				{ site: "read-head", candidate: null },
				{ site: "lineage", candidate: null },
			];
	const owner = ownerMode(mode);
	let mutations =
		ownerMutation(owner) +
		(trustRefusals.includes(mode) ||
		["bad-pre-transition", "bad-projection", "bad-acl", "bad-settlement"].includes(mode)
			? 1
			: 0);
	if (mode === "mutate-heads") global.push({ site: "heads-mutated-after-await", candidate: null });
	if (!noInputIo && !storage.includes(mode) && mode !== "duplicate-id") {
		// The old adopted post-close proposal is not the intended successor. Its
		// genuine warm proposal closure has v3-live-generation-1, never the required
		// successor kind2, in both branches. Publication supersedes that proposal.
		if (!scenario.published) {
			const id =
				mode === "stale-base"
					? "0".repeat(63) + "2"
					: (setup.oracle.proposedHead as { generationId: string }).generationId;
			candidates.push({ id, steps: [gate("closure-load", true)] });
		}
		for (const [index, candidate] of setup.oracle.preparedCandidates.entries()) {
			if (candidate.role !== "intended") {
				// The fixed unmatched fault points one base earlier: its current chain
				// starts at installed anchor trust, which has no required live projection.
				// Incomplete Staged/discarded records fail before closure loads.
				candidates.push({
					id: candidate.generationId,
					steps: candidate.role === "unmatched-base" ? [gate("closure-load", true)] : [],
				});
				continue;
			}
			const prefix = authenticatedPrefix(mode, scenario.epoch);
			const steps = [...prefix.steps];
			if (prefix.proceeds) {
				const unavailable = ["mixed-unavailable", "divergent-mixed-unavailable"].includes(mode) && index === 0;
				const lookupHere = !diagnostic || mode === "divergent-mixed-unavailable";
				if (diagnostic && mode === "divergent-mixed-unavailable") steps.push(plain("diagnostic-before-open"));
				if (lookupHere) steps.push(...lookup(owner, unavailable));
				if (lookupHere && (lookupStops(owner) || unavailable)) {
					if (diagnostic && mode === "divergent-mixed-unavailable") steps.push(gate("snapshot-result", false));
				} else {
					const native = snapshotIo(owner, count);
					steps.push(...native.steps, gate("snapshot-result", native.ok));
					if (native.ok) steps.push(...afterSnapshot(mode));
				}
			}
			candidates.push({ id: candidate.generationId, steps });
		}
	}
	const willSwap = !scenario.published && (successful.includes(mode) || raceRefusals.includes(mode));
	const swaps: string[] = [];
	if (willSwap) {
		const head = setup.oracle.intendedPublicationHead;
		if (head === null) throw new Error("ORACLE_PUBLICATION_HEAD_REQUIRED");
		swaps.push(head.generationId);
		global.push({ site: "cas", candidate: head.generationId });
		if (mode === "failed-cas") global.push({ site: "failed-cas-applied", candidate: head.generationId, ok: true });
		if (mode === "lost-cas") global.push({ site: "lost-cas-response-applied", candidate: head.generationId, ok: true });
		if (mode === "reread-unrelated") {
			global.push({ site: "unrelated-head-race", candidate: head.generationId, ok: true });
			mutations++;
		}
		global.push({ site: "active-reread", candidate: head.generationId });
		if (mode === "reread-failed")
			global.push({ site: "reread-failure-applied", candidate: head.generationId, ok: true });
	}
	return { candidates, global, mutations, swaps };
}
function trustedScopeBinding(setup: SetupReport, assert: typeof nativeAssert): void {
	const previous = setup.bootstrap.expectedPreviousRoomHead;
	const triple = (scope: SetupReport["oracle"]["lookupScope"]): unknown => ({
		objectId: scope.objectId,
		epoch: scope.epoch,
		anchor: scope.anchor,
	});
	assert.deepEqual(
		triple(setup.oracle.lookupScope),
		{ objectId: previous.objectId, epoch: previous.epoch, anchor: previous.currentAnchorDigest },
		"independent trusted previous objectId/epoch/anchor binding"
	);
	assert.notDeepEqual(
		triple(setup.oracle.lookupScope),
		triple(setup.oracle.competingScope),
		"independent competing scope has another epoch/anchor triple"
	);
}
function exactSteps(
	actual: Trace[],
	steps: Step[],
	id: string | null,
	scope: SetupReport["oracle"]["lookupScope"],
	assert: typeof nativeAssert
): void {
	assert.equal(actual.length, steps.length, "exact observation/gate event count for " + String(id));
	for (const [index, expected] of steps.entries()) {
		const value = actual[index];
		assert.ok(value, "required observation exists");
		assert.equal(value.candidate, id, "exact candidate attribution");
		for (const [key, expectedValue] of Object.entries(expected))
			assert.equal(value[key as keyof Trace], expectedValue, "exact ordered " + expected.site + "/" + key);
		if (scopedSites.has(expected.site) || value.scope !== undefined)
			assert.deepEqual(value.scope, scope, "required exact authenticated native scope");
	}
}
function counters(
	effects: Effects,
	schedules: CandidateSchedule[],
	mutations: number,
	swaps: string[],
	global: ObservationSchedule["global"],
	assert: typeof nativeAssert
): void {
	const counts = (site: string): number =>
		schedules.reduce((total, candidate) => total + candidate.steps.filter((step) => step.site === site).length, 0);
	for (const [key, site] of Object.entries({
		accesses: "lookup-property-access",
		lookups: "lookup",
		nativeLookups: "native-lookup",
		acquisitions: "acquire",
		nativeAcquisitions: "native-acquire",
		reads: "native-read",
		completes: "complete",
	}))
		assert.equal(effects[key as keyof Effects], counts(site), "exact " + key + ", independent schedule");
	assert.equal(effects.mutations, mutations, "exact native setup/race mutation applications");
	assert.deepEqual(effects.swaps, swaps, "exact intended surviving CAS candidate");
	assert.equal(
		effects.rereads,
		global.filter((step) => step.site === "active-reread").length,
		"exact CAS reread count"
	);
}
/**
 * Execute the same exact comparison in real controllers and labeled oracle self-controls.
 * @param report - Detached actual telemetry, never used to derive expectations.
 * @param setup - Controller-only independent fixture provenance.
 * @param scenario - Frozen case.
 * @param diagnostic - Explicit current-interface instrumentation dialect.
 * @param assert - Original tracked assertions in controllers; native assertions in self-controls.
 */
export function assertRecoveryObservations(
	report: RecoveryReport,
	setup: SetupReport,
	scenario: Case,
	diagnostic: boolean,
	assert: typeof nativeAssert = nativeAssert
): void {
	trustedScopeBinding(setup, assert);
	const expected = recoverySchedule(setup, scenario, diagnostic);
	const ids = new Set(expected.candidates.map((entry) => entry.id));
	const selected = report.effects.traces.filter((event) => gateSites.has(event.site) || nativeSites.has(event.site));
	assert.ok(
		selected.every((event) => event.candidate !== null && ids.has(event.candidate)),
		"no snapshot/gate activity attributed to wrong/unexpected candidate"
	);
	for (const candidate of expected.candidates)
		exactSteps(
			selected.filter((event) => event.candidate === candidate.id),
			candidate.steps,
			candidate.id,
			setup.oracle.lookupScope,
			assert
		);
	const global = report.effects.traces
		.filter((event) => globalSites.has(event.site))
		.map((event) => ({
			site: event.site,
			candidate: event.candidate,
			...(event.ok === undefined ? {} : { ok: event.ok }),
		}));
	assert.deepEqual(global, expected.global, "exact AHE/fault/race reach and CAS attribution");
	counters(report.effects, expected.candidates, expected.mutations, expected.swaps, expected.global, assert);
}
/**
 * Exact primitive owner schedule with its separate competing-scope call.
 * @param report - Actual native probe report.
 * @param setup - Controller-only original manifest/chunk structure.
 * @param mode - Fixed owner fault schedule.
 * @param assert - Original controller assertions.
 */
export function assertDirectObservations(
	report: ProbeReport,
	setup: SetupReport,
	mode: OwnerCase,
	assert: typeof nativeAssert = nativeAssert
): void {
	trustedScopeBinding(setup, assert);
	const { target, competing, availability, mutations } = directSchedule(setup, mode);
	const actual = report.effects.traces.filter((event) => nativeSites.has(event.site));
	exactSteps(actual.slice(0, competing.length), competing, null, setup.oracle.competingScope, assert);
	exactSteps(actual.slice(competing.length), target, null, setup.oracle.lookupScope, assert);
	counters(
		report.effects,
		[
			{ id: "primitive-competing", steps: competing },
			{ id: "primitive-target", steps: target },
		],
		mutations,
		[],
		[],
		assert
	);
	if (availability !== null) {
		assert.ok(report.availability);
		exactSteps(
			report.availability.effects.traces.filter((event) => nativeSites.has(event.site)),
			availability,
			null,
			setup.oracle.lookupScope,
			assert
		);
		counters(report.availability.effects, [{ id: "primitive-availability", steps: availability }], 0, [], [], assert);
	}
}
/**
 * Freeze the distinct direct-owner protocol without observed telemetry.
 * @param setup - Controller-only genuine prepared manifest structure.
 * @param mode - Fixed owner fault schedule.
 * @returns Exact competing/target/availability expectations.
 */
export function directSchedule(setup: SetupReport, mode: OwnerCase): DirectSchedule {
	const target = [...lookup(mode, false)];
	if (!lookupStops(mode)) target.push(...snapshotIo(mode, chunks(setup)).steps);
	const competing: Step[] = [
		plain("native-lookup"),
		{
			site: "native-lookup-outcome",
			kind: "present",
			state: "verified",
			// Setup opens/completes/releases this neighboring scope, never retainForRecovery.
			retention: mode.endsWith("legacy-elsewhere") ? "legacy-unclassified" : "temporary",
		},
	];
	return {
		competing,
		target,
		availability: mode === "verified" ? [...lookup("verified", true), ...lookup("verified", false)] : null,
		mutations: ownerMutation(mode),
	};
}
