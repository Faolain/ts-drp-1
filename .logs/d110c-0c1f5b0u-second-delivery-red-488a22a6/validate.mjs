import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const root = import.meta.dirname;
const json = name => JSON.parse(readFileSync(join(root, name), "utf8"));
const report = json("reporter.json");
assert.equal(report.success, false);
assert.equal(report.testResults.length, 1);
assert.equal(report.numTotalTests, 4);
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 0);
assert.equal(report.numPendingTests, 3);
assert.equal(report.numTodoTests, 0);
assert.deepEqual(report.unhandledErrors ?? [], []);
const file = report.testResults[0];
assert.equal(file.message, "");
assert.ok(file.name.endsWith("/tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts"));
const selected = file.assertionResults.filter(value => value.status !== "skipped");
assert.equal(selected.length, 1);
const test = selected[0];
assert.equal(test.status, "failed");
assert.equal(test.title, "preserves external delivery custody when callback two fails after callback one and the same room cold-reopens");
const errors = test.failureMessages.map(value => value.split("\n")[0]);
assert.deepEqual(errors, [
  "AssertionError: REPLAY_SECOND_FAILURE_ATOMIC_EXTERNAL_LEDGER: expected [ Array(1) ] to deeply equal []",
  "AssertionError: REPLAY_COLD_REOPEN_IDEMPOTENT_EXTERNAL_LEDGER: expected [ …(3) ] to deeply equal [ …(2) ]",
]);
const listing = readFileSync(join(root, "list.stdout"), "utf8").trim();
assert.equal(listing, "tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts > " + [...test.ancestorTitles, test.title].join(" > "));
assert.equal(/campaign/i.test(listing), false);
const commands = json("commands.json");
assert.deepEqual(commands.map(value => [value.name, value.status]), [["format", 0], ["lint", 0], ["diff", 0], ["list", 0], ["red", 1]]);
for (const value of commands) {
  assert.equal(value.signal, null);
  for (const stream of ["stdout", "stderr"]) readFileSync(join(root, `${value.name}.${stream}`));
}
const before = json("main-before.json"), after = json("main-after.json");
assert.equal(before.trackedStatus, ""); assert.equal(after.trackedStatus, "");
assert.equal(before.stashCount, 27); assert.equal(after.stashCount, 27);
assert.equal(after.stashHash, before.stashHash);
assert.deepEqual(after.protectedEntries, before.protectedEntries);
assert.equal(json("source-check.json").exit_code, 0);
const result = { status: "CAUSAL_RED", commit: after.commit, signature: after.signature, pushedRef: after.pushedRef, selectedFiles: 1, failedTests: 1, filteredTests: 3, completeSoftFailures: errors, nonfailureControls: ["second callback reached in order", "one-shot fault consumed", "failed reopen refused", "active owner released", "transport released", "cold reopen succeeded", "exact canonical recovered state", "each durable operation once", "authority unchanged", "one recovered owner"], stashCount: 27, protectedEntries: Object.keys(after.protectedEntries).length, productionChanges: 0, validatedAt: new Date().toISOString() };
writeFileSync(join(root, "validation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const names = readdirSync(root).filter(name => name !== "manifest.sha256").sort();
const manifest = names.map(name => `${hash(readFileSync(join(root, name)))}  ${name}`).join("\n") + "\n";
writeFileSync(join(root, "manifest.sha256"), manifest, { flag: "wx" });
console.log(JSON.stringify({ ...result, manifestFiles: names.length, manifestSha256: hash(manifest) }, null, 2));
