import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd();
const evidence = import.meta.dirname;
const read = name => JSON.parse(readFileSync(resolve(evidence, name), "utf8"));
const save = (name, value) => writeFileSync(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
const hash = value => createHash("sha256").update(value).digest("hex");
const expected = read("expected-matrix.json");
const prior = JSON.parse(readFileSync(resolve(root, ".logs/d110c-0c1f5b0w-red-8f91396a/complete-matrix.json"), "utf8"));
const report = read("reporter.json");
const before = read("before.json");
const after = read("after.json");
const initial = read("initial.json");
const red = read("red.status.json");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const matrix = report.testResults.flatMap(file => file.assertionResults.map(test => ({
 file: relative(root, file.name), title: test.fullName, status: test.status,
 tokens: [...new Set(test.failureMessages.flatMap(message => message.match(/D110C_[A-Z0-9_]+/g) ?? []))].sort(),
 failureMessages: test.failureMessages, duration: test.duration
})));
const contradictions = [];
for (const test of matrix) {
 const frozen = expected.find(row => row.file === test.file && row.title === test.title);
 if (!frozen || frozen.status !== test.status || !same(frozen.tokens, test.tokens)) contradictions.push({ test, frozen });
 const messageCount = test.status !== "failed" ? 0 : test.file.endsWith("f5b0w-store-red.test.ts")
 ? prior.find(row => row.file === test.file && row.title === test.title).failureMessages.length : 1;
 if (test.failureMessages.length !== messageCount) contradictions.push({ title: test.title, expectedMessageCount: messageCount,
 actualMessageCount: test.failureMessages.length });
}
for (const row of expected) if (!matrix.some(test => test.file === row.file && test.title === row.title))
 contradictions.push({ missing: row });
const transcript = readFileSync(resolve(evidence, "red.stdout"), "utf8") + readFileSync(resolve(evidence, "red.stderr"), "utf8");
const anomalies = /Hook timed out|Test timed out|Unhandled Error|Unhandled Rejection|Uncaught Exception|Failed to load url|Cannot find module|does not provide an export named|Error during worker shutdown|close timed out/i.test(transcript);
const custody = {
 stashCount: after.stashes.length, stashesUnchanged: same(initial.stashes, before.stashes) && same(before.stashes, after.stashes),
 untrackedUnchanged: same(initial.untracked, before.untracked) && same(before.untracked, after.untracked),
 trackedSourceHashesUnchanged: same(initial.trackedSourceHashes, before.trackedSourceHashes) && same(before.trackedSourceHashes, after.trackedSourceHashes),
 sourceHashesUnchanged: same(initial.sourceHashes, before.sourceHashes) && same(before.sourceHashes, after.sourceHashes),
 cleanTrackedRun: before.trackedStatus === "" && after.trackedStatus === "",
 signedPushedTestHead: before.head === after.head && before.head === before.remote && after.head === after.remote && before.signature === "G"
};
const counts = { selected: read("list.json").length, total: report.numTotalTests, passed: report.numPassedTests,
 failed: report.numFailedTests, skipped: report.numPendingTests, todo: report.numTodoTests };
const cleanup = transcript.includes("publicCloseSettled: false") && transcript.includes("orderlyShutdownClaimed: false");
const files = report.testResults.map(file => ({ file: relative(root, file.name), total: file.assertionResults.length,
 passed: file.assertionResults.filter(test => test.status === "passed").length,
 failed: file.assertionResults.filter(test => test.status === "failed").length, message: file.message }));
if (!same(counts, { selected: 219, total: 219, passed: 156, failed: 63, skipped: 0, todo: 0 })) contradictions.push({ counts });
if (report.testResults.length !== 8 || report.numRuntimeErrorTestSuites > 0 || anomalies || !cleanup || red.status !== 1 || red.signal !== null || custody.stashCount !== 27 ||
 Object.values(custody).includes(false)) contradictions.push({ anomalies, cleanup, process: red, custody });
const expectedMatrixHashUnchanged = hash(readFileSync(resolve(evidence, "expected-matrix.json"))) === read("selection.json").exactMatrixSha256;
if (!expectedMatrixHashUnchanged) contradictions.push({ expectedMatrixHashUnchanged });
const accepted = contradictions.length === 0;
save("complete-matrix.json", matrix);
save("failed-titles.json", matrix.filter(test => test.status === "failed"));
save("validation.json", { disposition: accepted ? "CAUSAL_EXPECTED_RED_MATRIX_MATCH" : "REJECTED_UNEXPECTED_MATRIX_STOP_NO_RERUN",
 acceptedF5b0wRed: accepted, testCommit: before.head, focusedRunCount: 1, counts, files, anomalies,
 redirectCleanupObservedPending: cleanup, orderlyRedShutdownClaimed: false,
 expectedMatrixHashUnchanged: hash(readFileSync(resolve(evidence, "expected-matrix.json"))) === read("selection.json").exactMatrixSha256,
 typecheck: { baseline: read("typecheck.json").baseline.length, current: read("typecheck.json").current.length, added: read("typecheck.json").added },
 custody, contradictions });
console.log(JSON.stringify(read("validation.json"), null, 2));
if (process.argv.includes("--manifest")) {
 const files = readdirSync(evidence).filter(name => name !== "manifest.sha256").sort();
 writeFileSync(resolve(evidence, "manifest.sha256"), files.map(name => hash(readFileSync(resolve(evidence, name))) + "  " + name + "\n").join(""));
 console.log("manifest SHA-256 " + hash(readFileSync(resolve(evidence, "manifest.sha256"))));
}
process.exitCode = accepted ? 0 : 1;

