import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = import.meta.dirname;
const repo = "/Users/aristotle/Documents/Projects/ts-drp-1";
const commit = "6394f55101cc4c559df6a3087c7ae4f3c8dfdb2f";
const json = name => JSON.parse(readFileSync(join(root, name), "utf8"));
const git = args => execFileSync("git", ["-C", repo, ...args]).toString();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const reporter = json("reporter.json");
assert.equal(reporter.success, true);
assert.equal(reporter.numTotalTests, 11);
assert.equal(reporter.numPassedTests, 4);
assert.equal(reporter.numFailedTests, 0);
assert.equal(reporter.numPendingTests, 7);
assert.equal(reporter.numTodoTests, 0);
assert.equal(reporter.testResults.length, 1);
assert.equal(reporter.testResults[0].name, join(repo, "tests/phase-6a-creator-successor-product-red.test.ts"));
assert.equal(reporter.testResults[0].message, "");
assert.deepEqual(reporter.unhandledErrors ?? [], []);
const assertions = reporter.testResults[0].assertionResults;
const passed = assertions.filter(value => value.status === "passed");
assert.deepEqual(passed.map(value => value.fullName), [
  "D.108d2 public return AST oracle accepts private computations and primitive comparisons without confusing operand names with returned authority",
  "D.108d2 public return AST oracle rejects exact sensitive properties and values on exported returned shapes",
  "D.108d2 public return AST oracle follows local returned aliases, helpers, methods, export aliases and global product surfaces",
  "D.108e2b creator successor room lifetime RED keeps node-root and chat authority closed while assigning the room as sole node consumer",
]);
for (const value of assertions) assert.deepEqual(value.failureMessages, []);
const listing = readFileSync(join(root, "list.stdout"), "utf8").trim().split("\n");
assert.deepEqual(listing, passed.map(value => "tests/phase-6a-creator-successor-product-red.test.ts > " + [...value.ancestorTitles, value.title].join(" > ")));
assert.equal(listing.some(value => /campaign/i.test(value)), false);
const commands = json("commands.json");
assert.deepEqual(commands.map(value => value.name), ["format", "lint", "list", "focused"]);
for (const command of commands) {
  assert.equal(command.status, 0);
  assert.equal(command.signal, null);
  for (const stream of ["stdout", "stderr"]) readFileSync(join(root, `${command.name}.${stream}`));
}
const before = json("main-before.json"), after = json("main-after.json");
for (const key of ["files", "patchHash", "stashHash", "protectedEntries"]) assert.deepEqual(after[key], before[key]);
assert.equal(after.patchHash, "797511cab746df7ae44de600ae8eb110787b276f96973ef77863665c9cfa2675");
assert.equal(after.stashCount, 27);
assert.equal(git(["stash", "list", "--format=%H"]).trim().split("\n").length, 27);
assert.equal(hash(git(["diff", "--binary", "--", ...before.paths])), before.patchHash);
const owners = ["tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts", "tests/phase-6a-creator-successor-product-red.test.ts"];
assert.deepEqual(git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n"), owners);
assert.equal(git(["diff", `${commit}^`, commit, "--check", "--", ...owners]), "");
assert.equal(git(["show", "-s", "--format=%G?", commit]).trim(), "G");
assert.equal(git(["rev-parse", "origin/codex/phase3a1b-p6-golden-path"]).trim(), commit);
const staticResult = json("static-before-commit.json");
assert.equal(staticResult.syntax, "PASS");
assert.equal(staticResult.unchangedPredicates.length, 6);
const result = {
  status: "PASS", classification: "faulty read-only diagnostic correction; not product RED",
  commit, signature: "G", pushedRefAtValidation: commit,
  selectedFiles: 1, selectedTests: 4, passed: 4, failed: 0, filteredSkipped: 7,
  completeSelectedNames: passed.map(value => value.fullName),
  commandStatuses: commands.map(({ name, status }) => ({ name, status })),
  dirtyCandidateHash: after.patchHash, protectedEntries: Object.keys(after.protectedEntries).length,
  stashCount: 27, unrelatedGovernancePredicatesUnchanged: staticResult.unchangedPredicates,
  ownerHashes: Object.fromEntries(owners.map(path => [path, hash(readFileSync(join(repo, path)))])),
  validatedAt: new Date().toISOString(),
};
writeFileSync(join(root, "validation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
const files = readdirSync(root).filter(name => name !== "manifest.sha256").sort();
const manifest = files.map(name => `${hash(readFileSync(join(root, name)))}  ${name}`).join("\n") + "\n";
writeFileSync(join(root, "manifest.sha256"), manifest, { flag: "wx" });
for (const line of manifest.trim().split("\n")) {
  const [digest, name] = line.split("  ");
  assert.equal(hash(readFileSync(join(root, name))), digest);
}
console.log(JSON.stringify({ ...result, manifestFiles: files.length, manifestSha256: hash(manifest) }, null, 2));
