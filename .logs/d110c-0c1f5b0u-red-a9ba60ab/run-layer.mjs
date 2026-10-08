import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const evidence = resolve(import.meta.dirname);
const commit = execFileSync("git", ["-C", repository, "rev-parse", "a9ba60ab"], { encoding: "utf8" }).trim();
const layer = process.argv[2];
if (!["clean", "overlay"].includes(layer)) throw new Error("exact layer required");
const root = join(evidence, layer);
if (existsSync(root)) throw new Error("evidence layer already exists; no retry");
mkdirSync(root);
const temporary = mkdtempSync("/tmp/d110c-f5b0u-red-");
const checkout = join(temporary, "checkout");
const sources = {
  "examples/v3-room/src/index.ts": "d872ebca21e0b637a258423650a3fa074556c4408a2f6057f7427fcdbd2f75fd",
  "packages/issuance-store/src/conformance.ts": "00aa85f56e738686049099ded7ff4d1a12c34d54d7dadd9c6d47751df91a5c9a",
  "packages/issuance-store/src/contract.ts": "5616617c29488208fe46c2fafd45e19af28129f7948b164424ea6275b621fab9",
  "packages/issuance-store/src/types.ts": "2100ed2037bfb027d9f6090f843f04d9d448135498fa256e208afdd67ec65b8d",
  "packages/node/src/v3-live.ts": "04057f76969a1286d511f629a3a0a84e60f1a811a0d7a7b0ba131d0a29db0177",
  "packages/storage-browser/src/internal/browser-issuance-store.ts": "692e02f4381872f26b9d1801ef1d17cd760eb30ca6bfb9d8ffb09f4d27c024bd",
  "packages/storage-node/src/internal/node-issuance-store.ts": "ab4fa2a5f81c5f674a799387d324e2f83db6dddbda6e22bc5611f0818f140110",
};
const patchHash = "1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9";
const hash = value => createHash("sha256").update(value).digest("hex");
const git = (where, args) => execFileSync("git", ["-C", where, ...args]);
const patch = git(repository, ["diff", "--binary", "--", ...Object.keys(sources)]);
if (hash(patch) !== patchHash) throw new Error("main rejected candidate patch changed");
const stashBefore = git(repository, ["stash", "list", "--format=%H"]);
function sourceHashes(where) {
  const result = Object.fromEntries(Object.keys(sources).map(path => [path, hash(readFileSync(join(where, path)))]));
  for (const [path, expected] of Object.entries(sources)) if (result[path] !== expected) throw new Error(`candidate file changed: ${path}`);
  return result;
}
writeFileSync(join(root, "main-before.json"), JSON.stringify({ commit, sourceHashes: sourceHashes(repository), patchHash: hash(patch), stashHash: hash(stashBefore), stashCount: stashBefore.toString().trim().split("\n").length }, null, 2)+"\n", { flag: "wx" });
writeFileSync(join(root, "environment.json"), JSON.stringify({ layer, temporary, checkout, commit, node: process.version, nodePath: process.execPath, startedAt: new Date().toISOString() }, null, 2)+"\n", { flag: "wx" });
if (layer === "overlay") writeFileSync(join(root, "rejected-candidate.patch"), patch, { flag: "wx" });
const results = [];
async function run(name, command, args, cwd = checkout, expected = 0) {
  const start = Date.now();
  const stdout = join(root, `${name}.stdout`), stderr = join(root, `${name}.stderr`);
  writeFileSync(stdout, "", { flag: "wx" }); writeFileSync(stderr, "", { flag: "wx" });
  console.log(`START ${layer}/${name}`);
  const child = spawn(command, args, { cwd, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => appendFileSync(stdout, chunk));
  child.stderr.on("data", chunk => appendFileSync(stderr, chunk));
  const outcome = await new Promise((resolvePromise, reject) => { child.on("error", reject); child.on("close", (status, signal) => resolvePromise({ status, signal })); });
  const result = { name, command, args, cwd, ...outcome, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now()-start };
  results.push(result); writeFileSync(join(root, "commands.json"), JSON.stringify(results, null, 2)+"\n");
  console.log(`END ${layer}/${name}: ${outcome.status} (${result.elapsedMs}ms)`);
  if (expected !== null && outcome.status !== expected) throw new Error(`${name} unexpected status ${outcome.status}`);
  return outcome;
}
try {
  await run("worktree", "git", ["-C", repository, "worktree", "add", "--detach", checkout, commit], repository);
  if (layer === "overlay") {
    await run("apply-check", "git", ["-C", checkout, "apply", "--check", join(root, "rejected-candidate.patch")]);
    await run("apply", "git", ["-C", checkout, "apply", join(root, "rejected-candidate.patch")]);
    const overlayPatch = git(checkout, ["diff", "--binary", "--", ...Object.keys(sources)]);
    if (hash(overlayPatch) !== patchHash) throw new Error("isolated overlay patch differs");
    writeFileSync(join(root, "overlay-before.json"), JSON.stringify({ patchHash: hash(overlayPatch), sources: sourceHashes(checkout) }, null, 2)+"\n", { flag: "wx" });
  }
  await run("install", "pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"]);
  await run("build-packages", "pnpm", ["build:packages"]);
  const files = ["tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts", "tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts", "tests/phase-6b-d110c-0c1f5b0u-store-red.test.ts", "tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts"];
  await run("list", "pnpm", ["exec", "vitest", "list", ...files]);
  await run("focused", "pnpm", ["exec", "vitest", "run", ...files, "--no-file-parallelism", "--coverage.enabled=false", "--reporter=json", `--outputFile=${join(root, "reporter.json")}`], checkout, 1);
  if (layer === "overlay") {
    const after = git(checkout, ["diff", "--binary", "--", ...Object.keys(sources)]);
    if (hash(after) !== patchHash) throw new Error("isolated overlay patch changed during run");
    writeFileSync(join(root, "overlay-after.json"), JSON.stringify({ patchHash: hash(after), sources: sourceHashes(checkout), changedPaths: git(checkout, ["diff", "--name-only"]).toString().trim().split("\n") }, null, 2)+"\n", { flag: "wx" });
  } else if (git(checkout, ["diff", "--name-only"]).toString().trim() !== "") throw new Error("clean layer changed tracked files");
} catch (error) {
  writeFileSync(join(root, "failure.json"), JSON.stringify({ message: String(error), stack: error.stack }, null, 2)+"\n", { flag: "wx" });
  process.exitCode = 1;
} finally {
  const afterPatch = git(repository, ["diff", "--binary", "--", ...Object.keys(sources)]);
  const stashAfter = git(repository, ["stash", "list", "--format=%H"]);
  if (hash(afterPatch) !== patchHash || hash(stashBefore) !== hash(stashAfter)) throw new Error("main worktree custody changed");
  writeFileSync(join(root, "main-after.json"), JSON.stringify({ sourceHashes: sourceHashes(repository), patchHash: hash(afterPatch), stashHash: hash(stashAfter), stashCount: stashAfter.toString().trim().split("\n").length }, null, 2)+"\n", { flag: "wx" });
}
