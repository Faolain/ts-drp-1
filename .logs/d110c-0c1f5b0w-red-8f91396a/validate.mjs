import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const directory = import.meta.dirname;
const read = (name) => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
const save = (name, value) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + "\n");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const reporter = read("reporter.json");
const listed = read("list.json");
const before = read("before.json");
const after = read("after.json");
const red = read("red.status.json");
const matrix = reporter.testResults.flatMap((file) => file.assertionResults.map((test) => ({
  file: relative(root, file.name), title: test.fullName, status: test.status,
  failureMessages: test.failureMessages, duration: test.duration,
})));
const files = reporter.testResults.map((file) => ({ file: relative(root, file.name),
  total: file.assertionResults.length,
  passed: file.assertionResults.filter((test) => test.status === "passed").length,
  failed: file.assertionResults.filter((test) => test.status === "failed").length,
}));
const store = matrix.filter((test) => test.file.endsWith("f5b0w-store-red.test.ts"));
const failed = matrix.filter((test) => test.status === "failed");
const runtime = failed.filter((test) => test.file.endsWith("f5b0u-room-runtime-red.test.ts"));
const runtimeCustody = runtime.filter((test) => test.failureMessages.some((message) => message.includes("at holdCustody")));
const stderr = readFileSync(resolve(directory, "red.stderr"), "utf8");
const transcript = readFileSync(resolve(directory, "red.stdout"), "utf8") + stderr;
const priorUntracked = new Set(before.untracked);
const afterUntracked = new Set(after.untracked);
const custody = {
  stashCount: after.stashes.length,
  stashesUnchanged: JSON.stringify(before.stashes) === JSON.stringify(after.stashes),
  untrackedAdded: after.untracked.filter((path) => !priorUntracked.has(path)),
  untrackedRemoved: before.untracked.filter((path) => !afterUntracked.has(path)),
  trackedStatus: after.trackedStatus,
  sourceAndTestHashesUnchanged: JSON.stringify(before.sourceHashes) === JSON.stringify(after.sourceHashes),
  testedSignedPushedHead: before.head === after.head && before.head === before.remote && before.signature === "G",
};
const expectedStoreFailure = (test) => {
  const title = test.title;
  if (/empty-progress refuses|in-progress refuses|unlinked refuses progress direct CAS|legacy-linked refuses progress direct CAS/.test(title)) return false;
  if (/initialization control|store removal control/.test(title)) return false;
  return true;
};
const storeUnexpected = store.filter((test) => (test.status === "failed") !== expectedStoreFailure(test));
const absentRequiredRuntimeTokens = ["D110C_F5B0W_MANUAL_REVIEW_ISSUE_HANG", "D110C_F5B0W_MANUAL_REVIEW_CLOSE_HANG",
  "D110C_F5B0W_MANUAL_REVIEW_REHEARSAL_HANG", "D110C_F5B0W_MANUAL_REVIEW_ACTIVATION_HANG"]
  .filter((token) => !runtime.some((test) => test.failureMessages.some((message) => message.includes(token))));
const observed = {
  disposition: "REJECTED_UNEXPECTED_FAILURE_MATRIX_STOP_NO_RERUN",
  acceptedF5b0wRed: false,
  testCommit: before.head,
  focusedRunCount: 1,
  selected: listed.length, total: reporter.numTotalTests, passed: reporter.numPassedTests,
  failed: reporter.numFailedTests, skipped: reporter.numPendingTests,
  process: { status: red.status, signal: red.signal, started: red.started, finished: red.finished },
  files,
  expectedIndependentFailures: 62,
  expectedIndependentPasses: 157,
  store: { total: store.length, failed: store.filter((test) => test.status === "failed").length,
    passed: store.filter((test) => test.status === "passed").length, unexpected: storeUnexpected },
  causalF5b0cIssueToken: failed.some((test) => test.file.endsWith("f5b0c-room-red.test.ts") &&
    test.failureMessages.some((message) => message.includes("D110C_F5B0W_MANUAL_REVIEW_ISSUE_HANG"))),
  realRuntime: {
    requiredTokensNotReached: absentRequiredRuntimeTokens,
    custodyFailures: runtimeCustody.map((test) => test.title),
    custodyObservation: "issueTransactions is 1, not 0; observer counter includes target startup before durable hold. Earlier exact plan/source/lineage/outbox readback assertions passed, but prompt issue/close sentinels and later custody assertions were not reached.",
    policyFixtureRejectedBeforeSourceMerge: runtime.some((test) => test.failureMessages.some((message) => message.includes("v3 room displacement policy is invalid"))),
    policyFixtureCause: "Replacement displacementPolicies dictionary is not frozen; validateDisplacementPolicy rejects it before retained-entry merge.",
    singleGenerationRedirectDurableHoldReached: runtime.some((test) => test.failureMessages.some((message) => message.includes("D110C_F5B0W_MANUAL_REVIEW_REDIRECT_HANG"))),
    redirectDeferred: false,
    cleanupHookTimeout: stderr.includes("Hook timed out in 10000ms"),
  },
  loaderFailure: /Failed to load url|Cannot find module|does not provide an export named/.test(transcript),
  typecheck: { baseline: read("typecheck.json").baseline.length, current: read("typecheck.json").current.length,
    added: read("typecheck.json").added },
  custody,
};
save("complete-matrix.json", matrix);
save("failed-titles.json", failed.map((test) => ({
  file: test.file, title: test.title,
  classification: test.file.endsWith("f5b0w-store-red.test.ts") ? "expected-native-store-causal-red"
    : test.file.endsWith("f5b0c-room-red.test.ts") ? "expected-superseded-room-causal-red"
    : test.failureMessages.some((message) => message.includes("at holdCustody")) ? "rejected-pre-sentinel-counter-window"
    : test.failureMessages.some((message) => message.includes("displacement policy is invalid")) ? "rejected-fixture-policy-shape"
    : "reachable-redirect-causal-hang-but-rejected-cleanup-timeout",
  tokens: [...new Set(test.failureMessages.flatMap((message) => message.match(/D110C_[A-Z0-9_]+/g) ?? []))],
  observations: test.failureMessages.map((message) => message.split("\n")[0]),
  ...(test.title.includes("single-generation internal redirect") ? { additionalStderr: "Error: Hook timed out in 10000ms." } : {}),
})));
save("validation.json", observed);
const diff = spawnSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
writeFileSync(resolve(directory, "diff.stdout"), diff.stdout);
writeFileSync(resolve(directory, "diff.stderr"), diff.stderr);
save("diff.status.json", { command: ["git", "diff", "--check"], status: diff.status, signal: diff.signal });
if (listed.length !== 219 || matrix.length !== 219 || reporter.numPassedTests !== 154 || reporter.numFailedTests !== 65 ||
  reporter.numPendingTests !== 0 || storeUnexpected.length || store.length !== 93 || runtimeCustody.length !== 5 ||
  !observed.realRuntime.cleanupHookTimeout || !observed.realRuntime.singleGenerationRedirectDurableHoldReached ||
  !custody.stashesUnchanged || custody.stashCount !== 27 || custody.untrackedAdded.length || custody.untrackedRemoved.length ||
  !custody.sourceAndTestHashesUnchanged || custody.trackedStatus || red.status !== 1 || red.signal !== null || diff.status !== 0)
  throw new Error("FAILED_EVIDENCE_CLASSIFICATION_DIFFERS");

const names = readdirSync(directory).filter((name) => name !== "manifest.sha256").sort();
writeFileSync(resolve(directory, "manifest.sha256"), names.map((name) =>
  `${sha256(readFileSync(resolve(directory, name)))}  ${name}\n`).join(""));
console.log(JSON.stringify({ disposition: observed.disposition, files: names.length,
  manifestSha256: sha256(readFileSync(resolve(directory, "manifest.sha256"))), custody }, null, 2));
