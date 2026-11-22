import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = import.meta.dirname;
const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const testCommit = "539606ebe5f87f9f20e200df9025983c4a2433a1";
const json = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = args => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
const files = [
  "phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts",
  "phase-6b-d110c-0c1f5b0c-room-red.test.ts",
  "phase-6b-d110c-0c1f5b0u-store-red.test.ts",
  "phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts",
].sort();
const expectedControls = [
  "transforms 2 actual source intents and persists exact real Node batch times",
  "transforms 16 actual source intents and persists exact real Node batch times",
  "pins a real Node-assembled sixteen-entry progress chunk to its final child logical time",
  "genuine nested applicationBatch derives the final child rather than outer time",
];
function causalFailure(test) {
  const { title, failureMessages: messages } = test;
  let token;
  let expectedSoft;
  let owner;
  if (title.startsWith("treats a compatible pre-sign race")) {
    token = "D110C_0C1F5B0U_COMPATIBLE_PLAN_REUSED_UNCLASSIFIED_HANDLE";
    expectedSoft = 1; owner = "unclassified handle reused after compatible durable truth";
  } else if (title.startsWith("rejects stale ")) {
    token = "D110C_0C1F5B0U_STALE_INTENT_SIGNED_FENCE";
    expectedSoft = 3; owner = "fence signed and lineage/plan mutated before stale digest refusal";
  } else if (title.startsWith("does not interpret an absent") || title.includes("ambiguous progress readback")) {
    token = 'promise resolved "undefined" instead of rejecting';
    expectedSoft = 1; owner = "absent or inexact readback falsely accepted";
  } else if (title.startsWith("recovers one genuinely signed")) {
    token = "D110C_0C1F5B0U_HALTED_HANDLE_NOT_RECOVERED";
    expectedSoft = 3; owner = "signed issue fault fired; no fresh activation and old owner remains";
    assert(messages[1].includes("D110C_0C1F5B0U_FRESH_ACTIVATION_MISSING"));
    assert(messages[2].includes("D110C_0C1F5B0U_OLD_OWNER_STILL_ACTIVE"));
  } else if (title.startsWith("queues migration")) {
    token = "D110C_0C1F5B0U_QUEUED_ISSUE_NOT_RECOVERED";
    expectedSoft = 2; owner = "actual fault reached; startup recovery absent, queued work rejects";
    assert(messages[1].includes("D110C_0C1F5B0U_MIGRATION_DID_NOT_RESUME"));
  } else if (title.startsWith("keeps a store-close")) {
    token = "D110C_0C1F5B0U_RECOVERY_BEFORE_CLEANUP_FAILED";
    expectedSoft = 1; owner = "signed recovery prerequisite absent; terminal cleanup controls pass";
  } else if (title.startsWith("rebinds creator-close")) {
    token = title.endsWith("true)") ? "D110C_0C1F5B0U_REBIND_TERMINAL_CODE_MISSING" : "promise rejected";
    expectedSoft = 1; owner = "missing recovery prevents fresh close binding and required terminal rebind code";
  } else if (title.startsWith("ordinary ")) {
    token = "D110C_0C1F5B0U_ORDINARY_FIELD_FLOOR_COLLISION";
    expectedSoft = 1; owner = "field-name heuristic chooses child-like value for ordinary operation";
  } else if (title.includes("child time without")) {
    token = "D110C_0C1F5B0U_INVALID_CHILD_TIME_ACCEPTED";
    expectedSoft = 4; owner = "invalid child time committed instead of ISSUANCE_COMMIT_INVALID; durable state changed";
  } else if (title.startsWith("refuses a structurally")) {
    token = "D110C_0C1F5B0U_BATCH_CEILING_BYPASSED";
    expectedSoft = 3; owner = "oversize batch committed instead of ISSUANCE_COMMIT_INVALID";
  } else if (title.includes("refuses a nonempty legacy CAS")) {
    token = "D110C_0C1F5B0U_NONEMPTY_PROGRESS_ORIGINATED_BY_CAS";
    expectedSoft = 2; owner = "legacy CAS originated nonempty chunks instead of ISSUANCE_RETRY_REQUIRED";
  } else throw new Error(`unclassified test: ${title}`);
  assert.equal(test.status, "failed");
  assert.equal(messages.length, expectedSoft, title);
  assert(messages[0].includes(token), title);
  for (const message of messages) assert(!/timed out|Cannot find module|does not provide an export|FAULT_NOT_REACHED|journal-rejected/.test(message));
  return { owner, token, softFailures: messages.length };
}
const summaries = [];
let selected;
for (const layer of ["clean", "overlay"]) {
  const reporter = json(`${layer}/reporter.json`);
  assert.equal(reporter.success, false);
  assert.equal(reporter.numTotalTests, 67);
  assert.equal(reporter.numPassedTests, layer === "clean" ? 20 : 39);
  assert.equal(reporter.numFailedTests, layer === "clean" ? 47 : 28);
  assert.equal(reporter.numPendingTests, 0);
  assert.equal(reporter.numTodoTests, 0);
  assert.deepEqual(reporter.testResults.map(file => basename(file.name)).sort(), files);
  const tests = reporter.testResults.flatMap(file => file.assertionResults.map(test => ({ ...test, file: basename(file.name) })));
  assert.equal(tests.length, 67);
  const names = tests.map(test => test.fullName).sort();
  assert.equal(new Set(names).size, 67);
  if (selected) assert.deepEqual(names, selected); else selected = names;
  for (const test of tests) assert(!/campaign|cold reopen.*terminalThrough/i.test(test.fullName));
  const listing = readFileSync(join(root, layer, "list.stdout"), "utf8");
  const listed = listing.trim().split("\n").sort();
  assert.deepEqual(listed, tests.map(test => [`tests/${test.file}`, ...test.ancestorTitles, test.title].join(" > ")).sort());
  const ledger = json(`${layer}/commands.json`);
  assert.equal(ledger.filter(row => row.name === "focused").length, 1);
  for (const command of ledger) {
    assert.equal(command.signal, null);
    assert.equal(command.status, command.name === "focused" ? 1 : 0);
    assert(command.startedAt <= command.finishedAt);
    for (const stream of ["stdout", "stderr"]) readFileSync(join(root, layer, `${command.name}.${stream}`));
  }
  const before = json(`${layer}/main-before.json`);
  const after = json(`${layer}/main-after.json`);
  assert.equal(before.commit, testCommit);
  assert.deepEqual(before.sourceHashes, after.sourceHashes);
  assert.equal(before.patchHash, after.patchHash);
  assert.equal(before.stashHash, after.stashHash);
  assert.equal(before.stashCount, 27);
  assert.equal(after.stashCount, 27);
  for (const [path, expected] of Object.entries(after.sourceHashes)) assert.equal(hash(readFileSync(join(repository, path))), expected);
  const classified = tests.map(test => {
    const retained = !test.fullName.includes("D.110c-0c1f5b0u");
    let classification;
    if (layer === "clean") classification = { owner: test.status === "passed" ? "retained or negative control; no f5b0u causality claimed" : "inherited absent f5b0t progress/split prerequisite; no f5b0u causality claimed" };
    else if (retained || expectedControls.includes(test.title)) {
      assert.equal(test.status, "passed", test.fullName);
      assert.deepEqual(test.failureMessages, []);
      classification = { owner: retained ? "retained f5b0t control" : "genuine grammar/split/signed-row equality control" };
    } else classification = causalFailure(test);
    return { file: test.file, title: test.fullName, status: test.status, ...classification, completeFailureMessages: test.failureMessages };
  });
  if (layer === "overlay") {
    assert.equal(classified.filter(test => test.owner === "retained f5b0t control").length, 35);
    assert.equal(classified.filter(test => test.owner === "genuine grammar/split/signed-row equality control").length, 4);
    const overlayBefore = json("overlay/overlay-before.json");
    const overlayAfter = json("overlay/overlay-after.json");
    assert.deepEqual(overlayBefore.sources, overlayAfter.sources);
    assert.equal(overlayBefore.patchHash, before.patchHash);
    assert.equal(overlayAfter.patchHash, before.patchHash);
    assert.equal(hash(readFileSync(join(root, "overlay/rejected-candidate.patch"))), before.patchHash);
    assert.deepEqual(overlayAfter.changedPaths.sort(), Object.keys(before.sourceHashes).sort());
  }
  summaries.push({ layer, total: 67, passed: reporter.numPassedTests, failed: reporter.numFailedTests, skipped: 0, unexpected: 0, classified });
}
assert.equal(git(["show", "-s", "--format=%G?", testCommit]), "G");
assert.equal(git(["rev-parse", "origin/codex/phase3a1b-p6-golden-path"]), testCommit);
const result = { testCommit, signature: "G", pushedRef: testCommit, layers: summaries, acceptance: "CAUSAL_RED_NOT_GREEN" };
writeFileSync(join(root, "validation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ acceptance: result.acceptance, layers: summaries.map(({ layer, total, passed, failed, skipped, unexpected }) => ({ layer, total, passed, failed, skipped, unexpected })) }));
