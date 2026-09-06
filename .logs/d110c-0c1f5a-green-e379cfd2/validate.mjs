import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (name) => readFileSync(resolve(import.meta.dirname, name), "utf8");
const json = (name) => JSON.parse(read(name));

function invariant(value, message) {
	if (!value) throw new TypeError(message);
}

function status(name, expected) {
	invariant(read(name).trim() === String(expected), `${name}:STATUS_INVALID`);
}

function vitest(name, expected) {
	const report = json(name);
	invariant(report.testResults.length === expected.files, `${name}:FILE_COUNT_INVALID`);
	invariant(report.numTotalTests === expected.total, `${name}:TOTAL_INVALID`);
	invariant(report.numPassedTests === expected.passed, `${name}:PASSED_INVALID`);
	invariant(report.numFailedTests === expected.failed, `${name}:FAILED_INVALID`);
	invariant(report.numPendingTests === expected.pending, `${name}:PENDING_INVALID`);
	invariant(report.success === expected.success, `${name}:SUCCESS_INVALID`);
	return report;
}

const focused = vitest("focused.json", {
	failed: 0,
	files: 1,
	passed: 1,
	pending: 0,
	success: true,
	total: 1,
});
const focusedAssertions = focused.testResults.flatMap(({ assertionResults }) => assertionResults);
invariant(
	focusedAssertions.length === 1 &&
		focusedAssertions[0].fullName ===
			"D.110c-0c1f5 foreign-author close liveness keeps foreign frontier anomalies author-local while creator corruption stays fail closed" &&
		focusedAssertions[0].status === "passed" &&
		focusedAssertions[0].failureMessages.length === 0,
	"FOCUSED_ASSERTION_INVALID"
);

vitest("f24-41.json", { failed: 0, files: 6, passed: 41, pending: 0, success: true, total: 41 });
const firstRetained = vitest("retained-195.json", {
	failed: 1,
	files: 20,
	passed: 194,
	pending: 0,
	success: false,
	total: 195,
});
invariant(
	JSON.stringify(firstRetained).includes("phase-6b-runtime-reclamation-red.test.ts:611:75"),
	"FIRST_RETAINED_DIAGNOSTIC_INVALID"
);
for (const name of ["d109d-targeted-diagnostic.json", "d109d-baseline-e379.json"]) {
	const report = vitest(name, { failed: 1, files: 1, passed: 0, pending: 12, success: false, total: 13 });
	invariant(JSON.stringify(report).includes("expected false to be true"), `${name}:FAILURE_INVALID`);
}
vitest("d109d-targeted-green.json", {
	failed: 0,
	files: 1,
	passed: 1,
	pending: 12,
	success: true,
	total: 13,
});
const earlyRestore = vitest("retained-195-corrected.json", {
	failed: 5,
	files: 20,
	passed: 190,
	pending: 0,
	success: false,
	total: 195,
});
invariant(
	JSON.stringify(earlyRestore).includes("D110C_FIXTURE_REGISTERED_VERTEX_ADMISSION_TIMEOUT"),
	"EARLY_RESTORE_DIAGNOSTIC_INVALID"
);
vitest("fixture-restoration-targeted.json", {
	failed: 0,
	files: 2,
	passed: 2,
	pending: 12,
	success: true,
	total: 14,
});
vitest("retained-195-final.json", {
	failed: 0,
	files: 20,
	passed: 195,
	pending: 0,
	success: true,
	total: 195,
});
vitest("f5a-retained-red-named.json", {
	failed: 0,
	files: 1,
	passed: 1,
	pending: 0,
	success: true,
	total: 1,
});

const playwright = json("playwright-two-title.json");
const browserCases = playwright.suites.flatMap(({ specs }) =>
	specs.flatMap((spec) => spec.tests.map((test) => ({ spec, test })))
);
invariant(playwright.errors.length === 0, "PLAYWRIGHT_TOP_LEVEL_ERRORS");
invariant(playwright.stats.expected === 2, "PLAYWRIGHT_EXPECTED_INVALID");
invariant(playwright.stats.skipped === 0, "PLAYWRIGHT_SKIPPED_INVALID");
invariant(playwright.stats.unexpected === 0, "PLAYWRIGHT_UNEXPECTED_INVALID");
invariant(playwright.stats.flaky === 0, "PLAYWRIGHT_FLAKY_INVALID");
invariant(browserCases.length === 2, "PLAYWRIGHT_CASE_COUNT_INVALID");
invariant(
	browserCases.every(({ test }) =>
		test.results.every(({ status: resultStatus }) => resultStatus === "passed")
	),
	"PLAYWRIGHT_RESULT_INVALID"
);

for (const name of [
	"required-builds.status",
	"f24-41.status",
	"d109d-targeted-green.status",
	"fixture-restoration-targeted.status",
	"retained-195-final.status",
	"f5a-retained-red-named.status",
	"playwright-two-title.status",
	"final-static.status",
]) {
	status(name, 0);
}
for (const name of [
	"runner-status.txt",
	"retained-195.status",
	"d109d-targeted-diagnostic.status",
	"d109d-baseline-e379.status",
	"retained-195-corrected.status",
]) {
	status(name, 1);
}
status("build-typecheck.status", 2);
status("remaining-build-typecheck.status", 2);

const closeSource = readFileSync(resolve(repositoryRoot, "packages/node/src/creator-close.ts"), "utf8");
const fixtureSource = readFileSync(
	resolve(repositoryRoot, "tests/fixtures/phase-6a-v3/creator-adoption-contract.ts"),
	"utf8"
);
const closeFunction = closeSource.slice(
	closeSource.indexOf("async function authorIssuanceFrontiersCandidate("),
	closeSource.indexOf("async function successorAclCandidate(")
);
invariant(closeFunction.includes("const duplicateAuthors = new Set<string>();"), "DUPLICATE_OWNER_MISSING");
invariant(
	closeFunction.includes('throw new TypeError("creator issuance-frontier author slot is ambiguous")'),
	"CREATOR_DUPLICATE_ERROR_MISSING"
);
invariant(
	closeFunction.includes('throw new TypeError("creator issuance-frontier boundary regressed")'),
	"CREATOR_REGRESSION_ERROR_MISSING"
);
invariant(closeFunction.includes("frontiers.push(Object.freeze([author, boundary] as const));"), "FREEZE_PATH_MISSING");
invariant(!closeFunction.includes("Math.max"), "OBSERVED_MAXIMUM_FORBIDDEN");
const override = fixtureSource.indexOf('Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId)');
const route = fixtureSource.indexOf("claimed = routeV3Ingress", override);
const restore = fixtureSource.indexOf('Reflect.set(networkNode, "gossipTopicFor", gossipTopicFor)', route);
const waiterCleanup = fixtureSource.indexOf("admittedVertexWaiters.delete(digest)", restore);
invariant(override >= 0 && route > override && restore > route && waiterCleanup > restore, "FIXTURE_OVERRIDE_SCOPE_INVALID");
invariant(!read("green.patch").includes("packages/protocol-v3/"), "PROTOCOL_V3_PATCH_FORBIDDEN");

process.stdout.write(
	JSON.stringify({
		browserTests: 2,
		focusedAssertions: 1,
		retainedTests: 195,
		status: "VALID",
	}) + "\n"
);
