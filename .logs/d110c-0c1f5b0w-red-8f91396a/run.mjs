import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";

const root = process.cwd();
const evidence = resolve(import.meta.dirname);
const sha = "8f91396a77cdd9a1f40fee4f1f0f0be844ca1bb7";
const parent = "e9c41096ed82c246bcfdf6c6ea214ae6dc7e8e59";
const changed = [
  "tests/fixtures/phase-6b-d110c-0c1f5b0w/manual-review-probe.ts",
  "tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0w-store-red.test.ts",
];
const selected = [
  "tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0w-store-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0u-store-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts",
  "tests/phase-6b-d110c-0c1f5b0v-callback-contract.test.ts",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const save = (name, value) => writeFileSync(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
function command(name, executable, args) {
  const started = new Date().toISOString();
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192", NO_COLOR: "1" } });
  writeFileSync(resolve(evidence, `${name}.stdout`), result.stdout ?? "");
  writeFileSync(resolve(evidence, `${name}.stderr`), result.stderr ?? "");
  save(`${name}.status.json`, { executable, args, cwd: root, started, finished: new Date().toISOString(),
    status: result.status, signal: result.signal, error: result.error?.message });
  process.stdout.write(`${name}: status=${result.status} signal=${result.signal}\n`);
  return result;
}
function snapshot() {
  return { head: git("rev-parse", "HEAD").trim(), remote: git("rev-parse", "origin/codex/phase3a1b-p6-golden-path").trim(),
    signature: git("log", "-1", "--format=%G?").trim(), branch: git("branch", "--show-current").trim(),
    trackedStatus: git("status", "--porcelain", "-uno"), stashes: git("stash", "list", "--format=%H").trim().split("\n"),
    untracked: git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
      .filter((path) => !path.startsWith(relative(root, evidence) + "/")),
    sourceHashes: Object.fromEntries([
      "examples/v3-room/src/index.ts", "packages/issuance-store/src/contract.ts",
      "packages/issuance-store/dist/src/contract.js", "packages/storage-browser/src/internal/browser-issuance-store.ts",
      "packages/storage-browser/dist/src/internal/browser-issuance-store.js", "packages/storage-node/src/internal/node-issuance-store.ts",
      ...changed,
    ].map((path) => [path, hash(readFileSync(resolve(root, path)))])) };
}
function sourceCheck() {
  const paths = git("diff", "--name-only", parent, sha).trim().split("\n").sort();
  if (JSON.stringify(paths) !== JSON.stringify([...changed].sort())) throw new Error("NON_TEST_CHECKPOINT_PATH");
  const room = readFileSync(resolve(root, "examples/v3-room/src/index.ts"), "utf8");
  const runtime = readFileSync(resolve(root, changed[2]), "utf8");
  const probe = readFileSync(resolve(root, changed[0]), "utf8");
  const tokens = ["D110C_F5B0W_MANUAL_REVIEW_ISSUE_HANG", "D110C_F5B0W_MANUAL_REVIEW_CLOSE_HANG",
    "creator close actor failed: CERTIFIED_VALUE_MISMATCH", "singleGeneration: true"];
  if (tokens.some((token) => !runtime.includes(token))) throw new Error("MISSING_CAUSAL_ORACLE");
  if (/setTimeout|setInterval/.test(probe)) throw new Error("WALL_CLOCK_PROBE");
  if (!room.includes("await settlementHold;")) throw new Error("PRODUCT_NOT_EXPECTED_RED_BASE");
  save("source-check.json", { pass: true, testsOnly: paths, tokens, microtaskBound: 256, productionHoldPresent: true,
    fixturePlanWriteOwner: "await real.transactWriteSettlementPlan(input)",
    staticTypecheckScope: "exact changed test entrypoints with package-export source mapping; baseline diagnostic delta" });
}
function typecheck() {
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const paths = {};
  for (const directory of readdirSync(resolve(root, "packages"))) {
    const file = resolve(root, "packages", directory, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      if (key.includes("*")) continue;
      const target = typeof value === "string" ? value : value.import ?? value.types;
      if (typeof target !== "string") continue;
      const source = resolve(root, "packages", directory, target.replace("./dist/", "./").replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts"));
      paths[pkg.name + (key === "." ? "" : key.slice(1))] = [existsSync(source) ? source : resolve(root, "packages", directory, typeof value === "object" ? value.types ?? target : target)];
    }
  }
  const options = { ...parsed.options, paths, composite: false, declaration: false, declarationMap: false,
    noEmit: true, incremental: false };
  const entries = changed.filter((file) => file.endsWith(".test.ts"));
  function diagnostics(baseline) {
    const host = ts.createCompilerHost(options);
    const read = host.readFile;
    if (baseline) host.readFile = (file) => {
      const path = relative(root, file);
      if (changed.includes(path) && !path.includes("f5b0w")) return git("show", `${parent}:${path}`);
      return read(file);
    };
    const program = ts.createProgram(baseline ? entries.filter((file) => !file.includes("f5b0w")) : entries, options, host);
    return ts.getPreEmitDiagnostics(program).map((d) => ({ file: d.file ? relative(root, d.file.fileName) : null,
      code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") }));
  }
  const baseline = diagnostics(true);
  const current = diagnostics(false);
  const added = current.filter((d) => !baseline.some((b) => JSON.stringify(b) === JSON.stringify(d)));
  save("typecheck.json", { baseline, current, added, pass: added.length === 0 });
  if (added.length) throw new Error("NEW_TYPE_DIAGNOSTICS");
}
const flags = ["--no-file-parallelism", "--maxWorkers=1", "--minWorkers=1", "--coverage.enabled=false"];
if (process.argv[2] === "preflight") {
  const before = snapshot();
  save("before.json", before);
  if (before.head !== sha || before.remote !== sha || before.signature !== "G" || before.trackedStatus || before.stashes.length !== 27)
    throw new Error("CHECKPOINT_CUSTODY_MISMATCH");
  sourceCheck();
  typecheck();
  for (const [name, args] of [
    ["lint", ["exec", "eslint", ...changed]],
    ["format", ["exec", "prettier", "--check", ...changed]],
    ["list", ["exec", "vitest", "list", ...selected, ...flags, `--json=${resolve(evidence, "list.json")}`]],
  ]) if (command(name, "pnpm", args).status !== 0) throw new Error(`PREFLIGHT_${name}_FAILED`);
  save("selection.json", { changed, selected, runCountAuthorized: 1, noCampaign: true,
    expectedStore: { total: 93, failed: 57, passed: 36 }, expectedNewRoomFailures: [
      "D110C_F5B0W_MANUAL_REVIEW_ISSUE_HANG", "D110C_F5B0W_MANUAL_REVIEW_CLOSE_HANG",
      "D110C_F5B0W_MANUAL_REVIEW_REHEARSAL_HANG", "D110C_F5B0W_MANUAL_REVIEW_ACTIVATION_HANG" ],
    supersededF5b0cFailures: 1,
    redirect: "Either genuine durable target hold causal refusal or exact record-rejected pre-hold deferral; no other failure accepted" });
} else if (process.argv[2] === "red") {
  const before = snapshot();
  if (before.head !== sha || before.remote !== sha || before.trackedStatus) throw new Error("TESTED_CHECKOUT_CHANGED");
  writeFileSync(resolve(evidence, "red-started.json"), JSON.stringify({ sha, at: new Date().toISOString() }), { flag: "wx" });
  command("red", "pnpm", ["exec", "vitest", "run", ...selected, ...flags,
    "--reporter=verbose", "--reporter=json", `--outputFile.json=${resolve(evidence, "reporter.json")}`]);
  save("after.json", snapshot());
} else throw new Error("Select preflight or red");
