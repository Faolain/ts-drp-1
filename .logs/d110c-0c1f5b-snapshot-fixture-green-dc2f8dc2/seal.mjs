import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const hash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const write = (p, value) => fs.writeFileSync(path.join(root, p), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
assert(!fs.existsSync(path.join(root, "manifest.sha256")));
const reports = [];
for (const [prefix, expected] of [["focused", 1], ["retained", 118], ["isolated/focused", 1], ["isolated/retained", 118]]) {
  const validation = read(`${prefix}/validation.json`);
  const status = read(`${prefix}/status.json`);
  assert.equal(validation.valid, true);
  assert.equal(validation.total, expected);
  assert.equal(validation.passed, expected);
  assert.equal(validation.failed, 0);
  assert.equal(validation.skipped, 0);
  assert.equal(status.code, 0);
  assert.equal(status.signal, null);
  assert.equal(status.quiescent, true);
  const reporterSha256 = hash(path.join(root, prefix, "result.json"));
  assert.equal(reporterSha256, validation.reporterSha256);
  reports.push({ prefix, total: expected, passed: expected, reporterSha256, status });
}
for (const p of ["equivalence.json", "isolated/equivalence.json", "typecheck-matrix.json", "isolated/typecheck-matrix.json", "isolated/graph-comparison.json"]) assert.equal(read(p).valid, true);
for (const prefix of ["", "isolated/"]) {
  const diagnostics = read(`${prefix}typecheck.json`);
  assert.deepEqual(diagnostics, { targetDiagnostics: [], externalDiagnostics: [] });
}
const custody = read("custody-final.json");
const isolated = read("isolated/custody-after.json");
assert.equal(custody.originExact, true);
assert.equal(custody.indexEmpty, true);
assert.equal(custody.stashCount, 27);
assert.equal(custody.allProtectedPathsExist, true);
assert.equal(custody.patchSha256, isolated.parentPatchSha256);
const effective = {};
for (const map of [custody.testHashes, custody.fixtureHashes, read("runtime-roster.json").testHashes]) {
  for (const [file, sha256] of Object.entries(map)) {
    if (effective[file]) assert.equal(effective[file], sha256, file);
    effective[file] = sha256;
  }
}
assert.equal(Object.keys(effective).length, 95);
for (const [file, sha256] of Object.entries({ ...custody.ownerHashes, ...effective })) assert.equal(isolated.sourceHashes[file], sha256, file);
for (const [file, sha256] of Object.entries(custody.built)) assert.equal(isolated.runtimes[file].sha256, sha256, file);
const files = () => fs.readdirSync(root, { recursive: true }).filter((p) => fs.statSync(path.join(root, p)).isFile()).sort();
const statuses = files().filter((p) => p.endsWith("/status.json")).map((file) => {
  const status = read(file);
  assert.equal(status.code, 0, file);
  return { file, sha256: hash(path.join(root, file)), status };
});
write("effective-test-fixture-hashes.json", Object.fromEntries(Object.entries(effective).sort(([a], [b]) => a.localeCompare(b))));
write("command-status-inventory.json", { count: statuses.length, nonzero: 0, statuses });
write("seal-summary.json", { sourceCommit: custody.head, reports, commandStatuses: statuses.length, allCommandStatusesZero: true, effectiveTestFixtureFiles: 95, sourceIdentities: 103, productionOwners: 8, builtOwners: 7, stashes: 27, protectedPaths: custody.protectedPaths, patchSha256: custody.patchSha256, custodyFinalSha256: hash(path.join(root, "custody-final.json")), isolatedCustodySha256: hash(path.join(root, "isolated/custody-after.json")), assessmentSha256: hash(path.join(root, "assessment.md")), noFurtherRuntime: true, parentClosureClaimed: false });
const inventory = files();
fs.writeFileSync(path.join(root, "manifest.sha256"), inventory.map((p) => `${hash(path.join(root, p))}  ${p}\n`).join(""), { flag: "wx" });
console.log(JSON.stringify({ entries: inventory.length, manifestSha256: hash(path.join(root, "manifest.sha256")), commandStatuses: statuses.length, reports: reports.map(({ prefix, total, passed, reporterSha256 }) => ({ prefix, total, passed, reporterSha256 })) }, null, 2));
