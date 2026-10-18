import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const identity = read("identity.json"), report = read("reporter.json"), commands = read("commands.json");
const expected = [
  ["REPLAY_EXACT_ORDER", "REPLAY_EXACT_BYTES_SIGNATURES", "REPLAY_EXACTLY_ONCE_COMMIT", "REPLAY_RECOVERS_APPLICATION_STATE", "REPLAY_SINK_PRESENT", "REPLAY_COMMIT_AFTER_VALIDATION", "REPLAY_SINK_PRESENT", "REPLAY_COMMIT_AFTER_VALIDATION", "REPLAY_BEFORE_PUBLIC_ISSUE", "REPLAY_NO_DUPLICATE_COMMIT"],
  ["REPLAY_FAILURE_REFUSED", "REPLAY_FAILURE_SEAM_REACHED", "REPLAY_FAILURE_NO_ACTIVE_OWNER", "REPLAY_FAILURE_TRANSPORT_RELEASED"],
  ["REPLAY_FAILURE_REFUSED", "REPLAY_FAILURE_SEAM_REACHED", "REPLAY_FAILURE_NO_ACTIVE_OWNER", "REPLAY_FAILURE_TRANSPORT_RELEASED"],
];
assert(identity.commit === "fad19ef785d75e0f5231e1ddc1f8c78e6da0d31d", "source commit differs");
assert(report.success === false && report.numTotalTests === 3 && report.numFailedTests === 3 && report.numPassedTests === 0 && report.numPendingTests === 0 && (report.numTodoTests ?? 0) === 0, "report counts differ");
assert(report.testResults.length === 1 && (report.numRuntimeErrorTestSuites ?? 0) === 0, "file/runtime error count differs");
assert(report.testResults[0].message === "" && report.testResults[0].status === "failed", "suite-level error");
const cases = report.testResults[0].assertionResults;
assert(cases.length === 3 && cases.every(row => row.status === "failed"), "case statuses differ");
const tokens = cases.map(row => row.failureMessages.map(message => {
  const matched = /^AssertionError: (REPLAY_[A-Z_]+):/u.exec(message);
  assert(matched !== null, "non-replay assertion/runtime failure");
  return matched[1];
}));
assert(JSON.stringify(tokens) === JSON.stringify(expected), "complete soft-failure matrix differs");
assert(commands.length === 6 && commands.filter(row => row.name === "focused").length === 1, "invocation count differs");
assert(commands.every(row => row.signal === null && row.status === (row.name === "focused" ? 1 : 0)), "command status differs");
const lines = readFileSync(join(root, "list.stdout"), "utf8").trim().split("\n");
assert(lines.length === 3 && lines.every(line => line.startsWith("tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts > ")), "listing differs");
for (const [file, digest] of Object.entries(identity.sources)) assert(hash(readFileSync(join(identity.checkout, file))) === digest, `historical overlay changed: ${file}`);
for (const [file, digest] of Object.entries(identity.mainSources)) assert(hash(readFileSync(join(repository, file))) === digest, `current main GREEN changed: ${file}`);
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args]);
assert(hash(git(identity.checkout, ["diff", "--binary"])) === identity.patchHash, "isolated overlay differs");
assert(hash(git(repository, ["diff", "--binary"])) === identity.mainPatchHash, "current GREEN overlay differs");
assert(git(repository, ["stash", "list", "--format=%H"]).toString() === identity.stash, "stash identities differ");
assert(identity.stash.trim().split("\n").length === 27, "stash count differs");
const result = { status: "CAUSAL_CORRECTIVE_REPLAY_RED_NOT_GREEN", sourceCommit: identity.commit, selectedFiles: 1, selectedTests: 3, failed: 3, passed: 0, skipped: 0, invocationCount: 1, completeSoftFailureCount: 18, tokens, authenticatedSnapshotProvenanceControlPassed: true, projectionRepresentationFalseFailureCount: 0, unexpectedFailureCount: 0, historicalOverlayHash: identity.patchHash, preservedMainGreenHash: identity.mainPatchHash, stashCount: 27 };
if (process.argv.includes("--record")) writeFileSync(join(root, "validation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
