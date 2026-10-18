import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const root = import.meta.dirname;
const commit = "54111eb767c53e360b17d002382ae5c7a59dba8b";
const before = JSON.parse(readFileSync(join(root, "main-before.json"), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (where, args) => execFileSync("git", ["-C", where, ...args], { maxBuffer: 32 * 1024 * 1024 });
function custody() {
  const patchHash = hash(git(repository, ["diff", "--binary", "--", ...before.paths]));
  assert.equal(patchHash, before.patchHash);
  const files = Object.fromEntries(before.paths.map(path => [path, hash(readFileSync(join(repository, path)))]));
  assert.deepEqual(files, before.files);
  const stashes = git(repository, ["stash", "list", "--format=%H"]);
  assert.equal(hash(stashes), before.stashHash);
  const protectedEntries = Object.fromEntries(Object.keys(before.protectedEntries).map(path => {
    const full = join(repository, path), stat = lstatSync(full);
    return [path, stat.isSymbolicLink() ? { kind: "symlink", target: readlinkSync(full) } : stat.isDirectory() ? { kind: "directory" } : { kind: "file", sha256: hash(readFileSync(full)) }];
  }));
  assert.deepEqual(protectedEntries, before.protectedEntries);
  return { patchHash, files, stashHash: hash(stashes), stashCount: stashes.toString().trim().split("\n").length, protectedEntries };
}
custody();
assert.equal(git(repository, ["show", "-s", "--format=%G?", commit]).toString().trim(), "G");
assert.equal(git(repository, ["rev-parse", "origin/codex/phase3a1b-p6-golden-path"]).toString().trim(), commit);
const layer = join(root, "isolated");
if (existsSync(layer)) throw new Error("single isolated execution already exists");
mkdirSync(layer);
const temporary = mkdtempSync("/tmp/d110c-browser-progress-red-");
const checkout = join(temporary, "checkout");
writeFileSync(join(root, "environment.json"), JSON.stringify({ commit, temporary, checkout, node: process.version, nodePath: process.execPath, startedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
const ledger = [];
async function run(name, command, args, cwd = checkout, expected = 0) {
  const start = Date.now();
  const out = join(layer, name + ".stdout"), err = join(layer, name + ".stderr");
  writeFileSync(out, "", { flag: "wx" }); writeFileSync(err, "", { flag: "wx" });
  console.log("START " + name);
  const child = spawn(command, args, { cwd, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192", ...(name === "chromium" ? { PLAYWRIGHT_JSON_OUTPUT_FILE: join(root, "reporter.json") } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => appendFileSync(out, chunk));
  child.stderr.on("data", chunk => appendFileSync(err, chunk));
  const result = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (status, signal) => resolve({ status, signal })); });
  ledger.push({ name, command, args, cwd, ...result, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start });
  writeFileSync(join(root, "commands.json"), JSON.stringify(ledger, null, 2) + "\n");
  console.log("END " + name + ": " + result.status);
  assert.equal(result.status, expected, name);
}
try {
  await run("worktree", "git", ["-C", repository, "worktree", "add", "--detach", checkout, commit], repository);
  await run("install", "pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"]);
  await run("build", "pnpm", ["build:packages"]);
  const paths = ["packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts", "packages/storage-browser/tests/assets/phase-6b-settlement-progress-entry.ts"];
  await run("format", "pnpm", ["exec", "prettier", "--check", ...paths]);
  await run("lint", "pnpm", ["exec", "eslint", ...paths]);
  await run("diff", "git", ["-C", checkout, "diff", "HEAD^", "HEAD", "--check", "--", ...paths]);
  const config = "packages/storage-browser/playwright.phase-6b-settlement-progress.config.ts";
  await run("list", "pnpm", ["exec", "playwright", "test", "--config", config, "--list", "--reporter=json"]);
  await run("chromium", "pnpm", ["exec", "playwright", "test", "--config", config, "--reporter=json", "--output", join(root, "artifacts")], checkout, 1);
  assert.equal(git(checkout, ["diff", "--name-only"]).toString().trim(), "");
} catch (error) {
  writeFileSync(join(root, "failure.json"), JSON.stringify({ message: String(error), stack: error.stack }, null, 2) + "\n", { flag: "wx" });
  process.exitCode = 1;
} finally {
  writeFileSync(join(root, "main-after.json"), JSON.stringify(custody(), null, 2) + "\n", { flag: "wx" });
}
