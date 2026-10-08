import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = read("identity.json"), report = read("reporter.json"), commands = read("commands.json");
const expected = [
  ["REPLAY_EXACT_ORDER", "REPLAY_EXACT_BYTES_SIGNATURES", "REPLAY_EXACTLY_ONCE_COMMIT", "REPLAY_RECOVERS_PROJECTION", "REPLAY_SINK_PRESENT", "REPLAY_COMMIT_AFTER_VALIDATION", "REPLAY_SINK_PRESENT", "REPLAY_COMMIT_AFTER_VALIDATION", "REPLAY_BEFORE_PUBLIC_ISSUE", "REPLAY_NO_DUPLICATE_COMMIT"],
  ["REPLAY_FAILURE_REFUSED", "REPLAY_FAILURE_SEAM_REACHED", "REPLAY_FAILURE_NO_ACTIVE_OWNER", "REPLAY_FAILURE_TRANSPORT_RELEASED"],
  ["REPLAY_FAILURE_REFUSED", "REPLAY_FAILURE_SEAM_REACHED", "REPLAY_FAILURE_NO_ACTIVE_OWNER", "REPLAY_FAILURE_TRANSPORT_RELEASED"],
];
const assert = (condition, detail) => { if (!condition) throw new Error(detail); };
assert(identity.commit === "8af5561c48f8b8d2d3767c33d613c2e1ec33c2f3", "source pin differs");
assert(report.success === false && report.numTotalTests === 3 && report.numFailedTests === 3 && report.numPassedTests === 0 && report.numPendingTests === 0 && (report.numTodoTests ?? 0) === 0, "report counts differ");
assert(report.testResults.length === 1 && (report.numRuntimeErrorTestSuites ?? 0) === 0, "file/runtime error count differs");
assert(report.testResults[0].message === "" && report.testResults[0].status === "failed", "top-level suite error");
const cases = report.testResults[0].assertionResults;
assert(cases.length === 3 && cases.every(row => row.status === "failed"), "selected cases differ");
const tokens = cases.map(row => row.failureMessages.map(message => {
  const matched = /^AssertionError: (REPLAY_[A-Z_]+):/u.exec(message);
  assert(matched !== null, "non-replay assertion or runtime failure");
  return matched[1];
}));
assert(JSON.stringify(tokens) === JSON.stringify(expected), "complete soft-failure token matrix differs");
assert(commands.length === 6 && commands.filter(row => row.name === "focused").length === 1, "invocation accounting differs");
assert(commands.every(row => row.signal === null && row.status === (row.name === "focused" ? 1 : 0)), "command status differs");
const lines = readFileSync(join(root, "list.stdout"), "utf8").trim().split("\n");
assert(lines.length === 3 && lines.every(line => line.startsWith("tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts > ")), "listing differs");
for (const [file, digest] of Object.entries(identity.sources)) {
  assert(hash(readFileSync(join(identity.checkout, file))) === digest, `isolated source differs: ${file}`);
  assert(hash(readFileSync(join(repository, file))) === digest, `main source differs: ${file}`);
}
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args]);
assert(hash(git(identity.checkout, ["diff", "--binary"])) === identity.patchHash, "isolated overlay differs");
assert(hash(git(repository, ["diff", "--binary"])) === identity.patchHash, "main overlay differs");
assert(git(repository, ["stash", "list", "--format=%H"]).toString() === identity.stash, "stash identities differ");
assert(identity.stash.trim().split("\n").length === 27, "stash count differs");
const proof = {
  status: "CAUSAL_SUCCESSOR_REPLAY_RED_NOT_GREEN",
  testCorrectionCommit: "87c3c836",
  sourceCommit: identity.commit,
  selectedFiles: 1,
  selectedTests: 3,
  passed: 0,
  failed: 3,
  skipped: 0,
  completeSoftFailureCount: 18,
  tokens,
  unexpectedFailureCount: 0,
  invocationCount: 1,
  frozenNinePathOverlayUnchanged: true,
  stashCount: 27,
};
if (process.argv.includes("--record")) writeFileSync(join(root, "validation.json"), JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(proof, null, 2));
