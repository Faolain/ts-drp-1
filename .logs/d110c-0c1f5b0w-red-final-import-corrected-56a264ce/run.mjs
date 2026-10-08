import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";
const root = process.cwd();
const evidence = import.meta.dirname;
const parent = "56a264ce1c6888e317a04d9435ef8c4f34b72d2d";
const prior = resolve(root, ".logs/d110c-0c1f5b0w-red-8f91396a");
const changed = ["tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts"];
const selected = JSON.parse(readFileSync(resolve(prior, "selection.json"), "utf8")).selected;
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (name, value) => writeFileSync(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
function git(...args) {
 const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
 if (r.status !== 0) throw new Error(r.stderr);
 return r.stdout;
}
function command(name, executable, args) {
 const started = new Date().toISOString();
 const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
 env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192", NO_COLOR: "1" } });
 writeFileSync(resolve(evidence, name + ".stdout"), result.stdout ?? "");
 writeFileSync(resolve(evidence, name + ".stderr"), result.stderr ?? "");
 save(name + ".status.json", { executable, args, cwd: root, started, finished: new Date().toISOString(),
 status: result.status, signal: result.signal, error: result.error?.message });
 console.log(name + ": status=" + result.status);
 return result;
}
function snapshot() {
 const protectedFiles = Object.keys(JSON.parse(readFileSync(resolve(prior, "before.json"))).sourceHashes);
 return {
 head: git("rev-parse", "HEAD").trim(), remote: git("ls-remote", "origin", "refs/heads/codex/phase3a1b-p6-golden-path").split("\t")[0],
 signature: git("log", "-1", "--format=%G?").trim(),
 trackedStatus: git("status", "--porcelain", "-uno"), stashes: git("stash", "list", "--format=%H").trim().split("\n"),
 untracked: git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
 .filter(path => !path.startsWith(relative(root, evidence) + "/")),
 sourceHashes: Object.fromEntries(protectedFiles.map(path => [path, hash(readFileSync(resolve(root, path)))])),
 trackedSourceHashes: Object.fromEntries(git("ls-files", "-z", "packages", "examples", "tests").split("\0").filter(Boolean)
 .filter(path => existsSync(resolve(root, path))).map(path => [path, hash(readFileSync(resolve(root, path)))]))
 };
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
 save("initial.json", snapshot());
 const paths = git("diff", "--name-only", parent).trim().split("\n");
 if (JSON.stringify(paths) !== JSON.stringify(changed)) throw new Error("NON_TEST_CHANGE");
 const runtime = readFileSync(resolve(root, changed[0]), "utf8");
 const baselineRuntime = git("show", parent + ":" + changed[0]);
 const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
 const tokens = source => [...source.matchAll(/D110C_[A-Z0-9_]+/g)].map(match => match[0]);
 const priorManifests = {
  ".logs/d110c-0c1f5b0w-red-8f91396a": "5113c5bab9d698e98360d8039f11e04fb9d5c691640a1f5ae212fa536595a498",
  ".logs/d110c-0c1f5b0w-red-91386f86": "3e1e5dc7f0c5a9d540a27185baf3c93c3d72dc12c59d0bb6863ec92c28f83ee1"
 };
 for (const [directory, expectedHash] of Object.entries(priorManifests)) {
  const manifest = readFileSync(resolve(root, directory, "manifest.sha256"), "utf8");
  if (hash(manifest) !== expectedHash) throw new Error("PRIOR_MANIFEST_CHANGED");
  for (const line of manifest.trim().split("\n")) {
   const [digest, name] = line.split("  ");
   if (hash(readFileSync(resolve(root, directory, name))) !== digest) throw new Error("PRIOR_EVIDENCE_CHANGED");
  }
 }
 save("prior-manifests.json", { verified: true, manifests: priorManifests });
 const probe = readFileSync(resolve(root, "tests/fixtures/phase-6b-d110c-0c1f5b0w/manual-review-probe.ts"), "utf8");
 const checks = {
 testsOnly: paths,
 unchangedTokens: JSON.stringify(tokens(runtime)) === JSON.stringify(tokens(baselineRuntime)),
 unchangedRedirect: section(runtime, '\tit("single-generation internal redirect', '\nafterEach(') === section(baselineRuntime, '\tit("single-generation internal redirect', '\nafterEach('),
 unchangedSameSessionCustody: section(runtime, 'async function holdCustody', 'function expectPromptRefusal') === section(baselineRuntime, 'async function holdCustody', 'function expectPromptRefusal'),
 exactCanonicalProjection: runtime.includes("expect(canonicalStateBytes(reopened.projection())).toEqual(canonicalProjection)"),
 freshReopenBoundary: runtime.includes("effects: reopenedHold.effects, target: reopened"),
 publicReadback: runtime.includes("const readback = await createBrowserDurableIssuanceStore({ primaryDatabaseName: fixture.name })"),
 closedReadback: runtime.includes("await readback.close()"),
 originalHoldPresent: readFileSync(resolve(root, "examples/v3-room/src/index.ts"), "utf8").includes("await settlementHold;"),
 noWallClockProbe: !/setTimeout|setInterval/.test(probe),
 boundarySnapshot: runtime.includes("resolve({ plan, effects: holdEffects() })"),
 zeroDelta: runtime.includes("expect(holdEffects()).toEqual(fixture.effects)"),
 frozenPolicy: runtime.includes('displacementPolicies: Object.freeze({ message: "rebase" as const })'),
 singleGeneration: runtime.includes("singleGeneration: true"),
 pendingPublicCleanup: runtime.includes("const cleanup = observeResult(fixture.target.close())"),
 noCleanShutdownClaim: runtime.includes("orderlyShutdownClaimed: false"),
 futureOrderlyCleanup: runtime.includes("await fixture.target.close();"),
 unchangedProbe: git("diff", parent, "--", "tests/fixtures/phase-6b-d110c-0c1f5b0w/manual-review-probe.ts") === "",
 noTimeoutChange: !/^[+-].*(?:setTimeout|testTimeout|hookTimeout)/m.test(git("diff", parent, "--", ...changed))
 };
 save("source-check.json", checks);
 if (Object.values(checks).includes(false)) throw new Error("SOURCE_CHECK_FAILED");
 typecheck();
 for (const [name, args] of [
 ["lint", ["exec", "eslint", ...changed]],
 ["format", ["exec", "prettier", "--check", ...changed]],
 ["list", ["exec", "vitest", "list", ...selected, ...flags, "--json=" + resolve(evidence, "list.json")]],
 ]) if (command(name, "pnpm", args).status !== 0) throw new Error("PREFLIGHT_" + name + "_FAILED");
 if (command("diff", "git", ["diff", "--check"]).status !== 0) throw new Error("DIFF_FAILED");
 const listed = JSON.parse(readFileSync(resolve(evidence, "list.json"), "utf8"));
 const oldMatrix = JSON.parse(readFileSync(resolve(prior, "complete-matrix.json"), "utf8"));
 const oldFailures = JSON.parse(readFileSync(resolve(prior, "failed-titles.json"), "utf8"));
 const runtimeTokens = [
 ["refuses held issue promptly", "ISSUE"], ["creator-held seal", "CLOSE"],
 ["held source refuses rehearsal", "REHEARSAL"], ["held source refuses activation", "ACTIVATION"],
 ["single-generation internal redirect", "REDIRECT"]
 ];
 const matrix = oldMatrix.map(test => {
 const title = test.title.replace("pins target hold refusal or the deferred parent frontier terminus",
 "pins target hold refusal and orderly source cleanup");
 const match = runtimeTokens.find(([fragment]) => title.includes(fragment));
 const isRuntime = test.file.endsWith("f5b0u-room-runtime-red.test.ts");
 const failed = isRuntime ? Boolean(match) : test.status === "failed";
 const tokens = !failed ? [] : isRuntime ? ["D110C_F5B0W_MANUAL_REVIEW_" + match[1] + "_HANG"]
 : oldFailures.find(row => row.title === title && row.file === test.file).tokens;
 return { file: test.file, title, status: failed ? "failed" : "passed", tokens: tokens.sort() };
 });
 const listKeys = listed.map(row => relative(root, row.file) + "|" + row.name.replaceAll(" > ", " ")).sort();
 const expectedKeys = matrix.map(row => row.file + "|" + row.title).sort();
 if (JSON.stringify(listKeys) !== JSON.stringify(expectedKeys) || matrix.length !== 219 ||
 matrix.filter(row => row.status === "failed").length !== 63) throw new Error("FROZEN_SELECTION_MISMATCH");
 save("expected-matrix.json", matrix);
 save("selection.json", { parent, changed, selected, selectedCount: 219, passed: 156, failed: 63, skipped: 0,
 exactMatrixSha256: hash(readFileSync(resolve(evidence, "expected-matrix.json"))),
 soleExecution: true, noCampaign: true, noRerunOnMismatch: true, frozenAt: new Date().toISOString() });
} else if (process.argv[2] === "red") {
 const before = snapshot();
 const initial = JSON.parse(readFileSync(resolve(evidence, "initial.json"), "utf8"));
 if (before.head === parent || before.head !== before.remote || before.signature !== "G" || before.trackedStatus ||
 JSON.stringify(before.trackedSourceHashes) !== JSON.stringify(initial.trackedSourceHashes) ||
 JSON.stringify(before.stashes) !== JSON.stringify(initial.stashes)) throw new Error("SIGNED_PUSHED_CUSTODY_FAILED");
 save("before.json", before);
 writeFileSync(resolve(evidence, "red-started.json"), JSON.stringify({ sha: before.head, at: new Date().toISOString() }), { flag: "wx" });
 command("red", "pnpm", ["exec", "vitest", "run", ...selected, ...flags, "--reporter=verbose", "--reporter=json",
 "--outputFile.json=" + resolve(evidence, "reporter.json")]);
 save("after.json", snapshot());
} else throw new Error("Select preflight or red");



