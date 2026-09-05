import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = import.meta.dirname;
const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const commit = "6394f55101cc4c559df6a3087c7ae4f3c8dfdb2f";
const before = JSON.parse(readFileSync(join(root, "main-before.json"), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = args => execFileSync("git", ["-C", repository, ...args]);
function custody() {
  const files = Object.fromEntries(before.paths.map(path => [path, hash(readFileSync(join(repository, path)))]));
  assert.deepEqual(files, before.files);
  const patchHash = hash(git(["diff", "--binary", "--", ...before.paths]));
  assert.equal(patchHash, before.patchHash);
  const stashHash = hash(git(["stash", "list", "--format=%H"]));
  assert.equal(stashHash, before.stashHash);
  const protectedEntries = Object.fromEntries(Object.keys(before.protectedEntries).map(path => {
    const full = join(repository, path), stat = lstatSync(full);
    return [path, stat.isSymbolicLink() ? { kind: "symlink", target: readlinkSync(full) } : stat.isDirectory() ? { kind: "directory" } : { kind: "file", sha256: hash(readFileSync(full)) }];
  }));
  assert.deepEqual(protectedEntries, before.protectedEntries);
  return { files, patchHash, stashHash, stashCount: 27, protectedEntries };
}
custody();
assert.equal(git(["show", "-s", "--format=%G?", commit]).toString().trim(), "G");
assert.equal(git(["rev-parse", "origin/codex/phase3a1b-p6-golden-path"]).toString().trim(), commit);
writeFileSync(join(root, "started.json"), JSON.stringify({ commit, cwd: repository, node: process.version, nodePath: process.execPath, startedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
const commands = [];
async function run(name, args) {
  const started = Date.now();
  const stdout = join(root, name + ".stdout"), stderr = join(root, name + ".stderr");
  writeFileSync(stdout, "", { flag: "wx" }); writeFileSync(stderr, "", { flag: "wx" });
  console.log("START " + name);
  const child = spawn("pnpm", args, { cwd: repository, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => appendFileSync(stdout, bytes)); child.stderr.on("data", bytes => appendFileSync(stderr, bytes));
  const result = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (status, signal) => resolve({ status, signal })); });
  commands.push({ name, command: "pnpm", args, cwd: repository, ...result, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
  writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2) + "\n");
  console.log("END " + name + ": " + result.status);
  assert.equal(result.status, 0, name);
}
try {
  const paths = ["tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts", "tests/phase-6a-creator-successor-product-red.test.ts"];
  await run("format", ["exec", "prettier", "--check", ...paths]);
  await run("lint", ["exec", "eslint", ...paths]);
  const test = "tests/phase-6a-creator-successor-product-red.test.ts";
  const selection = "D\\.108d2 public return AST oracle|keeps node-root and chat authority closed while assigning the room as sole node consumer";
  await run("list", ["exec", "vitest", "list", test, "-t", selection]);
  await run("focused", ["exec", "vitest", "run", test, "-t", selection, "--no-file-parallelism", "--coverage.enabled=false", "--reporter=json", "--outputFile=" + join(root, "reporter.json")]);
} catch (error) {
  writeFileSync(join(root, "failure.json"), JSON.stringify({ message: String(error), stack: error.stack }, null, 2) + "\n", { flag: "wx" });
  process.exitCode = 1;
} finally {
  writeFileSync(join(root, "main-after.json"), JSON.stringify(custody(), null, 2) + "\n", { flag: "wx" });
}
