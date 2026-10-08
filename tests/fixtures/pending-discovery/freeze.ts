import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { browserAuthProbes, browserCases, budgets, probeModes, sqliteAuthProbes, sqliteCases } from "./roster.js";
const [artifacts, previous, output] = process.argv.slice(2);
if (artifacts === undefined || previous === undefined || output === undefined || existsSync(output))
	throw new Error("FREEZE_REQUIRES_EXISTING_ARTIFACTS_PREVIOUS_AND_NEW_OUTPUT");
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const root = resolve(import.meta.dirname, "../../..");
const manifestPath = resolve(artifacts, "artifacts.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
	controllers: Record<string, string>;
	entries: {
		name: string;
		outputPath: string;
		outputSha256: string;
		graphPath: string;
		graphSha256: string;
		inputs: Record<string, string>;
	}[];
};
for (const [path, expected] of Object.entries(manifest.controllers))
	if (hash(readFileSync(path)) !== expected) throw new Error("FREEZE_CONTROLLER_DRIFT:" + path);
for (const entry of manifest.entries) {
	if (
		hash(readFileSync(entry.outputPath)) !== entry.outputSha256 ||
		hash(readFileSync(entry.graphPath)) !== entry.graphSha256
	)
		throw new Error("FREEZE_BUNDLE_DRIFT:" + entry.name);
	for (const [path, expected] of Object.entries(entry.inputs))
		if (hash(readFileSync(resolve(root, path))) !== expected) throw new Error("FREEZE_INPUT_DRIFT:" + path);
}
const old = JSON.parse(readFileSync(previous, "utf8")) as {
	head: string;
	authority: string;
	requirementMap: Record<string, unknown>[];
	roster: {
		sqliteCases: typeof sqliteCases;
		sqliteAuthProbes: typeof sqliteAuthProbes;
		browserCases: typeof browserCases;
		browserAuthProbes: typeof browserAuthProbes;
		probeModes: typeof probeModes;
	};
	budgets: typeof budgets;
};
assert.deepEqual(
	sqliteCases.filter((scenario) => scenario.mode !== "divergent-mixed-unavailable"),
	old.roster.sqliteCases,
	"all original SQLite product registrations unchanged"
);
assert.deepEqual(
	sqliteAuthProbes.filter((scenario) => scenario.mode !== "divergent-mixed-unavailable"),
	old.roster.sqliteAuthProbes,
	"all original SQLite diagnostics unchanged"
);
assert.deepEqual(browserCases, old.roster.browserCases);
assert.deepEqual(browserAuthProbes, old.roster.browserAuthProbes);
assert.deepEqual(probeModes, old.roster.probeModes);
assert.deepEqual(budgets, old.budgets, "ordinary frozen limits unchanged");
const requirementMap = old.requirementMap.map((entry) => ({ ...entry }));
for (const entry of requirementMap)
	if (
		["controls.node.ts all 6; contract.type.ts", "controls.node.ts all 8; contract.type.ts"].includes(
			String(entry.cases)
		)
	)
		entry.cases = "controls.node.ts all 9; oracle-controls.node.ts all 24; contract.type.ts";
requirementMap.push(
	{
		requirement: "F1 independent exact per-case/per-candidate native I/O, gate and race oracles",
		source: [
			"observation-oracle.ts:recoverySchedule/directSchedule/exactSteps/counters",
			"setup.ts:prepared candidate role/state and contiguous preloaded actual manifest descriptors",
			"assertions.ts:assertRecovery/assertProbe",
			"native-transform.ts:lookup resolution/conflict/native mutable refusal insertions",
			"observer.ts:lookupOutcome/lookupRefusal/mutationRefusal",
			"snapshot-observation.ts:actual race-applied events",
			"recovery.ts:actual swap argument candidate attribution",
		],
		cases:
			"every original336 plus new2 discriminator registrations; every intended reaching candidate, independently classified invalid auxiliary candidates, owner primitive competing call and verified primitive availability attempts",
		probe:
			"Expected schedules depend only on fixed fixture mode/branch/publication status and setup-only IDs, states, closure digests and manifest descriptor count C, never actual telemetry. Independently bind expected scope to trusted previous objectId/epoch/anchor and distinct competing triple. Exact ordered events, candidate/scopes, property/attempt/native distinction, native outcome/refusal provenance, reads/completion/race applications, CAS/reread attribution and counters; lost-response/failed-CAS/reread-failure fault branches require candidate-attributed applied events, not just counts/results. Shared verifier and direct owner have distinct protocols: verified C/0complete, intact open2C/1complete, missing/corrupt/replaced firstread1/0complete, delete/expiredtemporary firstquarantine+source miss2/0complete, legacy openC/1completion/migration-required. Current legacy diagnostic lookup0 stays explicit. Staged warm proposal kind1 and unmatched installed-anchor chain load closures but cannot satisfy projection prerequisites, so exact0snapshotIO; discarded/Staged IDs have0closure/gates. Controller records expectedObservations externally, including masked expectations without inferred execution.",
		backend: "SQLite140 + Chromium66 + Firefox66 + WebKit66 =338; masks are unchanged causal declaration-free refusals",
	},
	{
		requirement: "F1 controller oracle negative self-controls and fail-closed native resolution seams",
		source: [
			"oracle-controls.node.ts:handwritten two-preloaded-chunk controller DTO model",
			"controls.node.ts:native insertion custody and observer identity",
		],
		cases:
			"24 labeled controller self-controls; original8 source controls unchanged in registration identity plus one helper identity control",
		probe:
			"Same exact comparator first accepts each independently handwritten unmutated DTO, then captures AssertionError for zeroIO pending-missing, duplicate reads/lookups, wrong candidate, omitted race/gate, inverted gate, absent scope, metadata miss substituted for missing capability, omitted legacy completion and omitted native migration provenance; direct primitive missing-read negative, omitted lost-response/failed-CAS/reread-failure fault reach despite unchanged counters/results, wrong trusted triple and same competing triple. Controller-fabricated reports are NOT native mutants or auth/native reach. Backend exact native insertions per observed owner: lookup/acquire/complete entry1 each, real port-read1, lookup missing+present resolution2, conflict error1, mutable migration error1. Identity controls return original frozen values/errors; missing/duplicate resolution and missing mutable guard fail closed. Source required-discovery control remains genuine causal RED: actual authenticator invocation0 versus required1.",
		backend: "source/static controls for both native owners, controller only; no extra native registrations",
	},
	{
		requirement: "F2 divergent unavailable/available discriminator without equivalent-fork ambiguity",
		source: [
			"candidates.ts:actual different-authenticated-closure native variant",
			"setup.ts:distinct native closure provenance and original survivor publication oracle",
			"auth-probe.ts:two genuine public legacy invocations, diagnostic-only before-open native lookup fault",
			"snapshot-observation.ts:actual native present/verified first rejection",
			"assertions.ts:separate allAvailable comparator and exact survivor durable result",
		],
		cases:
			"APPEND SQLite product1-divergent-mixed-unavailable and instrumentationONLY1-divergent-mixed-unavailable; original336 and equivalent mixed-unavailable unchanged",
		probe:
			"All-available first genuine invocation authenticates/verifies BOTH distinct closures then actual true-fork/no durable change. Second distinct effects lifetime intentionally rejects lower-ID first native present/verified lookup at the diagnostic-only before-open boundary; actual original survivor native scope/quarantine/port/receipt/verifier result is unchanged and publishes exact original ID/closure/revision. No first-phase reads count toward second expectations. Declaration-free product registration stays masked by envelope today; diagnostic is not product success. At GREEN obsolete key refuses/noIO and ordinary product case must supply genuine reach. No declaration/manifest/descriptors/payload/oracle enter restart carrier/recovery graph.",
		backend:
			"SQLite only concrete shared fork/filter semantic allocation; all original browser owner/auth coverage retained",
	},
	{
		requirement: "exact durable publication and recovered application state",
		source: [
			"setup.ts:actual prepared native candidate oracle",
			"auth-transform.ts:unique shared verifier local insertion",
			"observer.ts:snapshot",
			"assertions.ts:assertRecovery",
			"probe.ts:actual decoded native payload",
			"assertions.ts:assertProbe",
		],
		cases:
			"all actual verifier successes (including later gate refusals and retries); all positive direct owner cases; exact durable unchanged/refusal, success, failed reread and concurrent unrelated publication",
		probe:
			"setup-only controller oracle binds actual native candidate ID/closure/base revision, lower-ID equivalent retry and already-active precedence; no oracle fields in bootstrap or recovery graph. Detached real verifier numeric application/digest/length evidence and direct native payload state equal independent arithmetic oracle. Original returns/promises/native bytes/quarantine/receipt untouched. Masked product cases do not infer these passes.",
		backend: "SQLite, Chromium, Firefox, WebKit",
	},
	{
		requirement: "native invocation placement, original promise/scope/quarantine/receipt identity",
		source: ["native-transform.ts:transformNativeOwners", "snapshot-observation.ts:observedSnapshot", "probe.ts:probe"],
		cases: "all direct owner controls on all 4 backends",
		probe:
			"exact native lookup/acquire/complete insertions and neutral native port read insertions; direct open receipt completion proves actual quarantine identity; ordinary method return promises unchanged, only named faults schedule delays",
		backend: "SQLite, Chromium, Firefox, WebKit",
	},
	{
		requirement: "conditional unavailable/available lookup fault and duplicate-ID injector placement",
		source: [
			"availability-probe.ts:availabilityProbe",
			"snapshot-observation.ts:observedSnapshot",
			"recovery.ts:readGenerationPage owner seam",
		],
		cases:
			"each existing verified direct-owner case now also proves first actual native present/verified lookup intentionally rejects, second same-key native lookup available; SQLite instrumentation-1-duplicate-id added without removing any original335 row",
		probe:
			"primitive availability control has no production auth claims; full declaration-free candidate availability remains masked until GREEN",
		backend: "all4 for lookup primitive; SQLite duplicate-ID",
	},
	{
		requirement: "source-correct raw bitrot evidence",
		source: [
			"auth-transform.ts:loadClosure insertion",
			"auth-fault-plan.ts:planAuthFault",
			"assertions.ts:assertRecovery",
		],
		cases: "storage-corrupt-trust/cut/qc both SQLite branches",
		probe:
			"actual getBlob bytes independently mismatch their reference; existing pending loadClosure does not validate digest, so preserve actual downstream trust refusal instead of inventing a closure refusal policy",
		backend: "SQLite",
	},
	{
		requirement: "per-case actual assertion reach retained for unchanged GREEN execution",
		source: [
			"assertions.ts:assertRecovery",
			"node-red.node.ts:executed-assertions.json",
			"browser-red.pw.ts:executed-assertions attachment",
		],
		cases: "all product and legacy instrumentation cases",
		probe:
			"original assertions execute unchanged; controller records each passed/failed assertion. Envelope-caused RED records causal assertions only and labels entire downstream MASKED_BY_ENVELOPE_REJECTION; obsolete diagnostic key refusal is explicit and no product success",
		backend: "all4",
	}
);
const sequence = /pre-matrix-freeze-([0-9]+)\.json$/u.exec(basename(output))?.[1];
if (sequence === undefined) throw new Error("FREEZE_OUTPUT_SEQUENCE_REQUIRED");
const freeze = {
	status: "PRE_MATRIX_FROZEN_" + sequence,
	head: old.head,
	authority: old.authority,
	previousFreeze: { path: resolve(previous), sha256: hash(readFileSync(previous)) },
	roster: { sqliteCases, probeModes, sqliteAuthProbes, browserCases, browserAuthProbes },
	budgets,
	counts: {
		sqliteProduct: sqliteCases.length,
		sqliteOwner: probeModes.length,
		sqliteInstrumentationOnly: sqliteAuthProbes.length,
		browserProductPerEngine: browserCases.length,
		browserOwnerPerEngine: probeModes.length,
		browserInstrumentationPerEngine: browserAuthProbes.length,
		totalNative:
			sqliteCases.length +
			probeModes.length +
			sqliteAuthProbes.length +
			3 * (browserCases.length + probeModes.length + browserAuthProbes.length),
	},
	custody: {
		artifactManifestPath: manifestPath,
		artifactManifestSha256: hash(readFileSync(manifestPath)),
		controllers: manifest.controllers,
		entries: manifest.entries,
	},
	requirementMap: [...new Map(requirementMap.map((entry) => [entry.requirement, entry])).values()],
	qualification: {
		product:
			"Declaration-free public calls are still causal envelope RED; downstream assertions MASKED_BY_ENVELOPE_REJECTION, not inferred passes.",
		diagnostic:
			"Isolated legacy interface is RED-baseline instrumentation ONLY. At GREEN the obsolete key must yield OBSOLETE_DIAGNOSTIC_KEY_REFUSAL/no I/O; unchanged ordinary cases then supply genuine reach.",
		priorMatrix:
			"All01/02/03/04 archives, packets, verdicts and raw failures remain retained unchanged.04 independent XHIGH verdict CHANGES_REQUIRED with parent-confirmed F1/P1 exact-controller-oracle gap and F2/P2 divergent discriminator gap.04 passing primitive/diagnostic results are prior evidence, not acceptance of this05 correction. Starting custody04-to05 rechecked all45 original controller hashes and6496 retained04 evidence hashes before mutable edits. New338 matrix is held for parent frozen-checkpoint inspection; later native execution and unchanged full51 default browser baseline plus supplemental phase4a must be new05 evidence.",
		scope:
			"No product, accepted cold, historical fixture, package, lock, canonical docs or factory writes. No stage/commit/review/GREEN authority.",
		budgets: "Original3 browser workers, retries0, case15s/global360s; no partition or budget increase.",
	},
};
writeFileSync(output, JSON.stringify(freeze, null, 2) + "\n", { flag: "wx" });
console.log(
	JSON.stringify({
		output: resolve(output),
		sha256: hash(readFileSync(output)),
		counts: freeze.counts,
		controllers: Object.keys(manifest.controllers).length,
	})
);
