// Reproducible adjunct checks. Every subprocess owns a watchdog process group;
// expected counterexamples require a real checker verdict, never an error.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.argv[2] ?? "all";
if (!["all", "test", "verify", "fence"].includes(mode)) throw new Error("Expected all, test, verify or fence");
const dir = process.env.CUSTODY_LOGS ?? mkdtempSync(resolve(tmpdir(), "native-custody-"));
mkdirSync(dir, { recursive: true });
const native = "packages/protocol-v3/formal/native-retirement-custody.qnt";
const repair = "packages/protocol-v3/formal/room-repair-custody.qnt";
const fence = "packages/protocol-v3/formal/settlement-replacement-retirement-fence-proof.qnt";
const watchdog = "packages/protocol-v3/formal/settlement-replacement-retirement-mutations/run-check.mjs";
const quint = resolve(root, "node_modules/.bin/quint");
const sha = file => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
const sourceHashes = Object.fromEntries([native, repair, fence, watchdog,
  "packages/protocol-v3/formal/settlement-replacement-retirement.qnt",
  "packages/protocol-v3/formal/check-native-custody.mjs"].map(file => [file, sha(file)]));
writeFileSync(resolve(dir, "tlc.json"), JSON.stringify({ workers: 1, maxHeap: "-Xmx2G" }));
writeFileSync(resolve(dir, "apalache.json"), JSON.stringify({ common: { "out-dir": resolve(dir, "out") },
  checker: { "discard-disabled": false } }));
const cases = [];
if (["all", "test"].includes(mode)) {
  for (const file of [native, repair]) cases.push({ name: `${file === native ? "native" : "repair"}-typecheck`,
    command: "typecheck", args: [file], expected: "typecheck" });
  for (const [name, file, main, count] of [["native-small", native, "nativeRetirementCustodySmall", 9],
    ["native-today", native, "nativeRetirementCustodyToday", 9], ["native-300", native, "nativeRetirementCustody300", 6],
    ["repair-small", repair, "roomRepairCustodySmall", 6], ["repair-65", repair, "roomRepairCustody65", 6]]) {
    cases.push({ name, command: "test", args: [file, "--main", main], expected: "tests", count });
  }
}
const verificationCases = [];
if (["all", "verify"].includes(mode)) {
  verificationCases.push(
    ["native-tlc", native, "nativeRetirementCustodySmall", "tlc", "step", "init", "inv", "ok"],
    ["repair-tlc", repair, "roomRepairCustodySmall", "tlc", "step", "init", "safety", "ok"],
    ["native-mutation", native, "nativeRetirementCustodySmall", "tlc", "unsafeStep", "init", "inv", "violation"],
    ["repair-mutation", repair, "roomRepairCustodySmall", "tlc", "unsafeStep", "init", "safety", "violation"],
    ["native-nonvacuity", native, "nativeRetirementCustodySmall", "tlc", "step", "init", "neverRewrite", "violation"],
    ["native-custody-nonvacuity", native, "nativeRetirementCustodySmall", "tlc", "step", "init", "neverPrunedBehindCustody", "violation"],
    // Today's rewrite: structurally safe, but it loses the entry of a held row and a later rebuild is refused.
    ["native-today-safety", native, "nativeRetirementCustodyToday", "tlc", "step", "init", "safety", "ok"],
    ["native-today-entry", native, "nativeRetirementCustodyToday", "tlc", "step", "init", "entryKept", "violation"],
    ["native-today-refusal", native, "nativeRetirementCustodyToday", "tlc", "step", "init", "noRefusal", "violation"],
    ["native-today-mutation", native, "nativeRetirementCustodyToday", "tlc", "unsafeStep", "init", "safety", "violation"],
    ["repair-nonvacuity", repair, "roomRepairCustodySmall", "tlc", "step", "init", "neverUnrememberedPeer", "violation"],
    ["repair-temporal", repair, "roomRepairCustodySmall", "tlc", "liveStep", "init", "fairRepair", "ok", "temporal"],
    ["repair-temporal-mutation", repair, "roomRepairCustodySmall", "tlc", "unsafeHintLiveStep", "init", "fairHintRepair", "violation", "temporal"],
    ["native-apalache-base", native, "nativeRetirementCustody300", "apalache", "step", "init", "inv", "ok", "invariants", 0],
    ["native-apalache-step", native, "nativeRetirementCustody300", "apalache", "step", "indInit", "inv", "ok", "invariants", 1],
  );
}
if (mode === "fence") {
  cases.push({ name: "fence-typecheck", command: "typecheck", args: [fence], expected: "typecheck" });
  cases.push({ name: "fence-tests", command: "test", args: [fence, "--main", "proofContractCurrentFence"], expected: "tests", count: 2 });
  for (const [name, init, step, depth, property] of [
    ["fence-base", "init", "step", 0, "currentFence"],
    ["fence-preservation", "indInitFence", "step", 1, "currentFence"],
    ["fenced-move", "indInitContractFenced", "stepMove", 1, "indContractFenced"],
  ]) verificationCases.push([name, fence, "proofContractCurrentFence", "apalache", step, init, property, "ok", "invariants", depth]);
}
for (const [name, file, main, backend, step, init, property, expected, kind = "invariants", depth = 1] of verificationCases) {
  cases.push({ name, command: "verify", expected, args: [file, "--main", main, "--backend", backend,
    "--apalache-version", "0.56.1", "--server-endpoint", process.env.CUSTODY_ENDPOINT ?? "localhost:8844",
    "--step", step, "--init", init, `--${kind}`, property, "--verbosity=3",
    ...(backend === "tlc" ? ["--tlc-config", resolve(dir, "tlc.json")] :
      ["--apalache-config", resolve(dir, "apalache.json"), `--max-steps=${depth}`])] });
}
const results = [];
for (const test of cases) {
  const args = [watchdog, quint, test.command, ...test.args];
  const log = resolve(dir, `${test.name}.log`), output = [], started = Date.now();
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TRACK_J_TIMEOUT_SECONDS: process.env.TRACK_J_TIMEOUT_SECONDS ?? "600" } });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", b => {
    output.push(b); writeFileSync(log, Buffer.concat(output));
  });
  const code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
  const body = Buffer.concat(output).toString("utf8");
  const got = code === 0 && test.expected === "typecheck" ? "typecheck" :
    code === 0 && new RegExp(`\\b${test.count} passing\\b`).test(body) ? "tests" :
    code === 0 && /^\[ok\]/m.test(body) ? "ok" : code === 1 && /^\[violation\]/m.test(body) ? "violation" :
    code === 124 ? "timeout" : "error";
  const result = { ...test, code, got, seconds: Math.round((Date.now() - started) / 1000), log };
  results.push(result);
  const unchanged = Object.entries(sourceHashes).every(([file, hash]) => sha(file) === hash);
  writeFileSync(resolve(dir, "results.json"), JSON.stringify({ sourceHashes, unchanged, results }, null, 2) + "\n");
  console.log(JSON.stringify(result));
  if (got !== test.expected || !unchanged) process.exitCode = 1;
}
console.log(`Evidence: ${dir}`);
