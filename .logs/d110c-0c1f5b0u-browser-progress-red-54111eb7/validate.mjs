import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const read = name => JSON.parse(readFileSync(join(root, name), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const specs = suites => suites.flatMap(suite => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
const report = read("reporter.json");
const listing = read("isolated/list.stdout");
assert.deepEqual(report.errors, []);
assert.deepEqual(listing.errors, []);
assert.deepEqual({ expected: report.stats.expected, skipped: report.stats.skipped, unexpected: report.stats.unexpected, flaky: report.stats.flaky }, { expected: 0, skipped: 0, unexpected: 1, flaky: 0 });
const selected = specs(report.suites), listed = specs(listing.suites);
assert.equal(selected.length, 1); assert.equal(listed.length, 1);
assert.equal(selected[0].file, "phase-6b-settlement-progress-red.pw.ts");
assert.equal(selected[0].title, "Chromium preserves atomic settlement progress and exact CAS refusal across reopen");
assert.equal(selected[0].title, listed[0].title);
assert.equal(selected[0].file, listed[0].file);
assert.equal(selected[0].tests.length, 1);
const test = selected[0].tests[0];
assert.equal(test.projectName, "chromium"); assert.equal(test.status, "unexpected");
assert.equal(test.results.length, 1);
const result = test.results[0];
assert.equal(result.status, "failed"); assert.equal(result.retry, 0);
assert.deepEqual(result.errors.map(error => error.message.split("\n")[0]), [
  "Error: D110C_F5B0U_BROWSER_zero-origin", "Error: D110C_F5B0U_BROWSER_nonempty-origin",
  "Error: D110C_F5B0U_BROWSER_partial", "Error: D110C_F5B0U_BROWSER_final",
]);
const attachment = result.attachments.filter(item => item.name === "complete-native-progress-vectors");
assert.equal(attachment.length, 1);
const bytes = Buffer.from(attachment[0].body, "base64");
const payload = JSON.parse(bytes);
assert.equal(typeof payload.browser, "string");
const ok = { ok: true, errorCode: null };
const invalid = { ok: false, errorCode: "ISSUANCE_INVALID_ARGUMENT" };
const commitInvalid = { ok: false, errorCode: "ISSUANCE_COMMIT_INVALID" };
const retry = { ok: false, errorCode: "ISSUANCE_RETRY_REQUIRED" };
const legacy = revision => ({ entries: [{ disposition: "rebase", replacementSequence: null, sourceDigest: Array(32).fill(0xd1), sourceSequence: 7 }], fenceSequence: 4, revision, scope: { author: "author:browser-progress", objectId: "room:browser-progress" } });
const expected = [
  ["zero-origin", [ok], invalid, 0], ["nonempty-origin", [ok], invalid, 0],
  ["partial", [ok, invalid], commitInvalid, 0], ["final", [ok, invalid, commitInvalid], commitInvalid, 0],
  ["stale-revision", [ok, ok], retry, 1], ["inexact-revision", [ok], invalid, 0],
].map(([name, setup, attempt, revision]) => ({
  name, setup, attempt, before: legacy(revision), beforeLineage: { exhausted: false, next: 0 },
  after: legacy(revision), lineage: { exhausted: false, next: 0 }, issuedSequences: [], outboxSequences: [], reopened: legacy(revision),
}));
assert.deepEqual(payload.result, expected);
for (const item of result.attachments) if (item.path) readFileSync(item.path);
const ledger = read("commands.json");
assert.equal(ledger.filter(item => item.name === "chromium").length, 1);
for (const item of ledger) {
  assert.equal(item.status, item.name === "chromium" ? 1 : 0);
  assert.equal(item.signal, null);
  assert(item.startedAt <= item.finishedAt);
  for (const stream of ["stdout", "stderr"]) readFileSync(join(root, "isolated", item.name + "." + stream));
}
const before = read("main-before.json"), after = read("main-after.json");
assert.equal(before.patchHash, "797511cab746df7ae44de600ae8eb110787b276f96973ef77863665c9cfa2675");
assert.equal(after.patchHash, before.patchHash);
assert.deepEqual(after.files, before.files);
assert.equal(after.stashHash, before.stashHash);
assert.equal(after.stashCount, 27);
assert.deepEqual(after.protectedEntries, before.protectedEntries);
for (const [path, digest] of Object.entries(before.files)) assert.equal(hash(readFileSync(join(repository, path))), digest);
for (const [path, expectedEntry] of Object.entries(before.protectedEntries)) {
  const full = join(repository, path), stat = lstatSync(full);
  const actual = stat.isSymbolicLink() ? { kind: "symlink", target: readlinkSync(full) } : stat.isDirectory() ? { kind: "directory" } : { kind: "file", sha256: hash(readFileSync(full)) };
  assert.deepEqual(actual, expectedEntry);
}
const commit = read("environment.json").commit;
const git = args => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
assert.equal(git(["show", "-s", "--format=%G?", commit]), "G");
assert.equal(git(["rev-parse", "origin/codex/phase3a1b-p6-golden-path"]), commit);
assert.deepEqual(git(["show", "--pretty=", "--name-only", commit]).split("\n").sort(), ["packages/storage-browser/tests/assets/phase-6b-settlement-progress-entry.ts", "packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts"]);
writeFileSync(join(root, "complete-vectors.json"), bytes, { flag: "wx" });
const verdict = { acceptance: "CAUSAL_NATIVE_BROWSER_RED", commit, browser: payload.browser, tests: 1, files: 1, vectors: 6, expectedSoftFailures: 4, runtimeInvocations: 1, skipped: 0, flaky: 0, topLevelErrors: 0, candidateUnchanged: true, stashes: 27, protectedEntries: Object.keys(before.protectedEntries).length };
writeFileSync(join(root, "validation.json"), JSON.stringify(verdict, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(verdict));
