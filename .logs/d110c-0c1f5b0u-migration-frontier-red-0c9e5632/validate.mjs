import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args]);
const identity = read("identity.json"), report = read("reporter.json"), commands = read("commands.json");
const title = "queues migration rehearsal behind startup recovery without a nested lifetime-tail deadlock";
const file = "tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts";
const expected = [
  "D110C_0C1F5B0U_QUEUED_ISSUE_NOT_RECOVERED",
  "D110C_0C1F5B0U_MIGRATION_DID_NOT_RESUME",
  "D110C_0C1F5B0U_MIGRATION_ACTIVATION_BOUNDARY_DIFFERS",
  "D110C_0C1F5B0U_MIGRATION_FRONTIER_CAUSE_DIFFERS",
];
assert(identity.commit === "0c9e56321ea770259c90afe0e2d99d3569320ea7", "test source commit differs");
assert(report.success === false && report.numTotalTests === 9 && report.numFailedTests === 1 && report.numPassedTests === 0 && report.numPendingTests === 8 && report.numTodoTests === 0, "report counts differ");
assert(report.testResults.length === 1 && (report.numRuntimeErrorTestSuites ?? 0) === 0, "file/runtime error count differs");
assert((report.errors ?? []).length === 0 && (report.unhandledErrors ?? []).length === 0, "top-level error");
const suite = report.testResults[0];
assert(suite.message === "" && suite.status === "failed" && suite.name.endsWith(file), "suite-level failure differs");
const selected = suite.assertionResults.filter(row => row.status !== "skipped");
assert(selected.length === 1 && selected[0].status === "failed" && selected[0].title === title, "selected test differs");
assert(suite.assertionResults.filter(row => row.status === "skipped" && row.failureMessages.length === 0).length === 8, "excluded test result differs");
const tokens = selected[0].failureMessages.map(message => {
  const matched = /^AssertionError: (D110C_0C1F5B0U_[A-Z_]+):/u.exec(message);
  assert(matched !== null, "unexpected noncausal runtime/loader/harness failure");
  return matched[1];
});
assert(JSON.stringify(tokens) === JSON.stringify(expected), "complete soft-failure matrix differs");
assert(commands.length === 6 && commands.filter(row => row.name === "focused").length === 1, "invocation count differs");
assert(commands.every(row => row.signal === null && row.status === (row.name === "focused" ? 1 : 0)), "command status differs");
assert(read("static.json").length === 3 && read("static.json").every(row => row.status === 0 && row.signal === null), "static command status differs");
const listing = readFileSync(join(root, "list.stdout"), "utf8").trim().split("\n");
assert(listing.length === 1 && listing[0].startsWith(`${file} > `) && listing[0].endsWith(title), "one-test one-file listing differs");
assert(hash(readFileSync(join(root, "rejected-candidate.patch"))) === identity.patchHash, "evidence overlay hash differs");
assert(identity.patchHash === "1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9", "historical overlay pin differs");
assert(identity.mainPatchHash === "4296998368a87e11c7be6fcc8da05583c37d485c96b8f7b1917dd500a7839f61", "preserved candidate pin differs");
for (const [path, digest] of Object.entries(identity.sources)) assert(hash(readFileSync(join(identity.checkout, path))) === digest, `historical source changed: ${path}`);
for (const [path, digest] of Object.entries(identity.mainSources)) assert(hash(readFileSync(join(repository, path))) === digest, `main production source changed: ${path}`);
assert(git(identity.checkout, ["rev-parse", "HEAD"]).toString().trim() === identity.commit, "isolated source ref differs");
assert(hash(git(identity.checkout, ["diff", "--binary"])) === identity.patchHash, "isolated overlay differs");
assert(hash(git(repository, ["diff", "--binary"])) === identity.mainPatchHash, "main production patch differs");
assert(git(repository, ["stash", "list", "--format=%H"]).toString() === identity.stash && identity.stash.trim().split("\n").length === 27, "stash custody differs");
assert(hash(readFileSync(join(identity.checkout, file))) === hash(git(repository, ["show", `${identity.commit}:${file}`])), "isolated test differs from signed correction");
const result = { status: "CAUSAL_MIGRATION_RECOVERY_RED_NOT_GREEN", sourceCommit: identity.commit, selectedFiles: 1, selectedTests: 1, failed: 1, passed: 0, skipped: 8, focusedInvocationCount: 1, completeSoftFailureCount: 4, tokens, unexpectedFailureCount: 0, atMostOneOwnerAndCloseToZeroPassed: true, intendedLaterFrontierNotReachedByPreGreen: true, historicalOverlayHash: identity.patchHash, preservedMainGreenHash: identity.mainPatchHash, stashCount: 27 };
if (process.argv.includes("--record")) writeFileSync(join(root, "validation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
