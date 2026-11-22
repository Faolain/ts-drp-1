import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const reporterPath = ".logs/d110c-0c-red-causal-2cb28a1a/playwright.json";
const reporter = JSON.parse(readFileSync(reporterPath, "utf8"));
const exactTitle = "D.110c-0c resumes a genuine epoch-3 pending adoption after both process-death orderings";
const token = "D110C_0C_PENDING_EPOCH3_RESUME_MISSING";
const failures = [];
const check = (condition, message) => {
	if (!condition) failures.push(message);
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

check(reporter.stats.expected === 0, "expected count");
check(reporter.stats.skipped === 0, "skipped count");
check(reporter.stats.unexpected === 1, "unexpected count");
check(reporter.stats.flaky === 0, "flaky count");
check(reporter.errors.length === 0, "top-level errors");
check(reporter.suites.length === 1, "selected file count");
const specs = reporter.suites.flatMap((suite) => suite.specs);
check(specs.length === 1 && specs[0].title === exactTitle, "selected test count/title");
const tests = specs.flatMap((spec) => spec.tests);
check(tests.length === 1 && tests[0].projectName === "chromium", "project count/name");
const results = tests.flatMap((test) => test.results);
check(results.length === 1 && results[0].status === "failed", "result status/count");
check(results[0].errors.length === 2, "soft-failure count");
check(
	results[0].errors.every((error) => error.message.split("\n", 1)[0] === `Error: ${token}`),
	"exact soft-failure tokens"
);
const attachment = results[0].attachments.find(({ name }) => name === "d110c-0c-causal-evidence");
check(attachment?.contentType === "application/json" && typeof attachment.body === "string", "causal attachment");
const rows = attachment === undefined ? [] : JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));
check(rows.length === 2, "ordering evidence count");

for (const [index, ordering] of ["old-ahe", "new-ahe"].entries()) {
	const row = rows[index];
	check(row?.ordering === ordering && row?.staged?.ordering === ordering, `${ordering} identity/order`);
	const { staged, recovered } = row ?? {};
	const state = staged?.floor?.state;
	check(state?.stable?.epoch === 2 && state?.pending?.next?.epoch === 3, `${ordering} floor epochs`);
	check(equal(state?.pending?.previous, state?.stable), `${ordering} previous/stable identity`);
	check(staged?.floor?.fault === "none", `${ordering} floor fault reset`);
	check(staged?.stable?.authority?.epoch === 2 && staged?.after?.authority?.epoch === 2, `${ordering} authority`);
	check(equal(staged?.stable?.projection, staged?.after?.projection), `${ordering} projection unchanged`);
	check(equal(staged?.stable?.acl, staged?.after?.acl), `${ordering} ACL unchanged`);
	check(staged?.close?.epoch === 2 && staged?.close?.successorEpoch === 3, `${ordering} close transition`);
	const expectedOperations = ["create", "begin", "commit", "begin", "commit", "begin"];
	if (ordering === "new-ahe") expectedOperations.push("commit-fault");
	check(equal(staged?.floor?.events?.map(({ operation }) => operation), expectedOperations), `${ordering} floor operations`);
	check(
		staged?.interrupted ===
			(ordering === "old-ahe" ? "D110C controlled pre-publication process death" : "D110C_FLOOR_UNAVAILABLE"),
		`${ordering} interruption seam`
	);
	const closure = staged?.ahe?.generations?.flatMap(({ closure }) => closure) ?? [];
	const hasClosure = (kind, epochKey, epoch) =>
		closure.some((entry) => entry.kind === kind && entry[epochKey] === epoch);
	check(hasClosure("drp-anchor-trust-state", "currentEpoch", 2), `${ordering} current trust closure`);
	check(hasClosure("drp-anchor-trust-state", "currentEpoch", 3), `${ordering} successor trust closure`);
	check(hasClosure("drp-hard-epoch-cut", "epoch", 2), `${ordering} cut closure`);
	check(hasClosure("drp-seal-qc", "epoch", 2), `${ordering} QC closure`);
	check(hasClosure("v3-live-generation-2", "epoch", 3), `${ordering} successor projection closure`);
	check(equal(recovered?.floorBefore, staged?.floor), `${ordering} staged/reopened floor`);
	check(equal(recovered?.aheBefore, staged?.ahe), `${ordering} staged/reopened AHE`);
	check(recovered?.snapshotScope?.epoch === 2, `${ordering} snapshot scope`);
	check(recovered?.detail === "D110C_FLOOR_RECOVERY_UNAVAILABLE", `${ordering} room failure`);
	check(
		equal(recovered?.recovery, { callCount: 1, resultKind: "pending-missing", swapHeadCount: 0 }),
		`${ordering} causal recovery classification`
	);
	check(equal(recovered?.floorAfter, recovered?.floorBefore), `${ordering} failed floor immutability`);
	check(equal(recovered?.aheAfter, recovered?.aheBefore), `${ordering} failed AHE immutability`);
	check(recovered?.reopened === null, `${ordering} fail-closed reopen`);
}

const asset = readFileSync(
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
	"utf8"
);
const testSource = readFileSync("packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts", "utf8");
const config = readFileSync("packages/storage-browser/playwright.d110c-0c-red.config.ts", "utf8");
check(asset.includes("rawSnapshotDeclarationAtEpoch(databaseName, 2)"), "exact epoch-2 snapshot selector");
check(asset.includes("fingerprint(aheBefore) !== fingerprint(aheAfter)"), "diagnostic AHE comparison");
check(asset.includes("!sameCanonical(floorBefore, floorAfter)"), "canonical floor comparison");
check(testSource.includes(`const token = \"${token}\"`), "frozen RED token source");
check(
	config.includes(
		"grep: /D\\.110c-0c resumes a genuine epoch-3 pending adoption after both process-death orderings/u"
	),
	"exact config grep"
);
execFileSync("git", ["diff", "--quiet", "HEAD", "--", "packages/node/src", "packages/room/src", "packages/storage-browser/src"]);

const validation = Object.freeze({
	causalRows: rows.length,
	expected: reporter.stats.expected,
	failures,
	flaky: reporter.stats.flaky,
	ordering: rows.map(({ ordering }) => ordering),
	productSourceDiff: 0,
	skipped: reporter.stats.skipped,
	softFailures: results[0].errors.length,
	topLevelErrors: reporter.errors.length,
	unexpected: reporter.stats.unexpected,
});
if (failures.length > 0) throw new TypeError(`D110C_0C RED validation failed: ${JSON.stringify(validation)}`);
process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
