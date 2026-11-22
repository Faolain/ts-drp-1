// Bounded, source-hashed replay/retirement adjunct checks. A negative control
// passes only on an actual counterexample, never a timeout or translation error.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.argv[2] ?? "all";
if (!["all", "test", "verify", "induction"].includes(mode)) throw new Error("Expected all, test, verify or induction");
const dir = process.env.REPLAY_LOGS ?? mkdtempSync(resolve(tmpdir(), "replay-custody-"));
mkdirSync(dir, { recursive: true });
const formal = "packages/protocol-v3/formal/";
const phase = formal + "replay-read-custody.qnt";
const pool = formal + "replay-egress-pool.qnt";
const broadcast = formal + "replay-broadcast-rounds.qnt";
const intent = formal + "retirement-intent-selection.qnt";
const fence = formal + "current-fence-projection.qnt";
const bridge = formal + "current-fence-bridge.qnt";
const recovery = formal + "retirement-recovery-admission.qnt";
const currency = formal + "issuance-quote-currency.qnt";
const age = formal + "source-age-projection.qnt";
const watchdog = formal + "settlement-replacement-retirement-mutations/run-check.mjs";
const quint = resolve(root, "node_modules/.bin/quint");
const sha = file => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
const sourceHashes = Object.fromEntries([phase, pool, broadcast, intent, fence, bridge, recovery, currency, age, watchdog,
  formal + "check-replay-custody.mjs", formal + "settlement-replacement-retirement.qnt",
  "packages/node/src/v3-live.ts", "packages/node/src/creator-close.ts",
  "packages/node/src/internal/creator-closed-rollback-data.ts"].map(file => [file, sha(file)]));
writeFileSync(resolve(dir, "tlc.json"), JSON.stringify({ workers: 1, maxHeap: "-Xmx1G" }));
writeFileSync(resolve(dir, "apalache.json"), JSON.stringify({ common: { "out-dir": resolve(dir, "out") },
  checker: { "discard-disabled": false } }));
const cases = [];
if (["all", "test"].includes(mode)) {
  for (const file of [phase, pool, broadcast, intent, fence, bridge, recovery, currency, age]) cases.push({ name: `${file.split("/").at(-1)}-typecheck`,
    command: "typecheck", args: [file], expected: "typecheck" });
  for (const [name, file, main, count] of [["phase", phase, "replayReadPhases", 13],
    ["borrow", phase, "replayBorrowedCustody", 7], ["pool", pool, "replayEgressPoolSmall", 9],
    ["pool-32", pool, "replayEgressPool32", 10], ["broadcast", broadcast, "replayBroadcastRounds", 5],
    ["intent", intent, "retirementIntentSelection", 8], ["fence", fence, "currentFenceProjection", 3],
    ["recovery", recovery, "retirementRecoveryAdmission", 7], ["currency", currency, "issuanceQuoteCurrency", 9],
    ["age", age, "sourceAgeProjection", 3]]) {
    cases.push({ name: `${name}-tests`, command: "test", args: [file, "--main", main], expected: "tests", count });
  }
}
const verification = [];
if (["all", "verify"].includes(mode)) {
  for (const [name, file, main, property, mutation, never] of [
    ["phase", phase, "replayReadPhases", "safety", "unsafeStep", "neverSealed"],
    ["borrow", phase, "replayBorrowedCustody", "safety", "unsafeStep", "neverBorrowed"],
    ["pool", pool, "replayEgressPoolSmall", "safety", "unsafeStep", "neverRetiredNative"],
    ["broadcast", broadcast, "replayBroadcastRounds", "safety", "unsafeSafetyStep", "neverComplete"],
    ["intent", intent, "retirementIntentSelection", "safety", "unsafeStep", "neverFreshSameFloor"],
    ["fence", fence, "currentFenceProjection", "currentFence", "unsafeStep", "neverInstalled"],
    ["recovery", recovery, "retirementRecoveryAdmission", "safety", "unsafeStep", "neverOrdinary"],
    ["currency", currency, "issuanceQuoteCurrency", "safety", "unsafeStep", "neverCrypto"],
    ["age", age, "sourceAgeProjection", "safety", "unsafeStep", "neverAssigned"],
  ]) {
    verification.push([`${name}-tlc`, file, main, "tlc", "step", "init", property, "ok"],
      [`${name}-mutation`, file, main, "tlc", mutation, "init", property, "violation"],
      [`${name}-nonvacuity`, file, main, "tlc", "step", "init", never, "violation"]);
  }
  verification.push(
    ["fence-actual-bridge", bridge, "currentFenceBridge", "tlc", "bridgeStep", "bridgeInit", "bridgeSafety", "ok"],
    ["pool-progress", pool, "replayEgressPoolSmall", "tlc", "step", "init", "quiescentShutdown", "ok", "temporal"],
    ["broadcast-progress", broadcast, "replayBroadcastRounds", "tlc", "step", "init", "fairCompletion", "ok", "temporal"],
    ["broadcast-progress-mutation", broadcast, "replayBroadcastRounds", "tlc", "unsafeQuietStep", "init", "unsafeFairCompletion", "violation", "temporal"],
  );
}
if (["all", "induction"].includes(mode)) {
  for (const [name, file, main, property] of [["borrow", phase, "replayBorrowedCustody", "safety"],
    ["pool", pool, "replayEgressPoolSmall", "safety"], ["fence", fence, "currentFenceProjection", "currentFence"],
    ["age", age, "sourceAgeProjection", "safety"]]) {
    verification.push([`${name}-apalache-base`, file, main, "apalache", "step", "init", property, "ok", "invariants", 0],
      [`${name}-apalache-step`, file, main, "apalache", "step", "indInit", property, "ok", "invariants", 1]);
  }
  verification.push(["age-weak-hypothesis", age, "sourceAgeProjection", "apalache", "step", "weakIndInit", "sourceAge", "violation", "invariants", 1]);
}
for (const [name, file, main, backend, step, init, property, expected, kind = "invariants", depth = 1] of verification) {
  cases.push({ name, command: "verify", expected, args: [file, "--main", main, "--backend", backend,
    "--apalache-version", "0.56.1", "--server-endpoint", process.env.REPLAY_ENDPOINT ?? "localhost:8870",
    "--step", step, "--init", init, `--${kind}`, property, "--verbosity=3",
    ...(backend === "tlc" ? ["--tlc-config", resolve(dir, "tlc.json")] :
      ["--apalache-config", resolve(dir, "apalache.json"), `--max-steps=${depth}`])] });
}
const results = [];
for (const test of cases) {
  const args = [watchdog, quint, test.command, ...test.args];
  const log = resolve(dir, `${test.name}.log`), started = Date.now();
  const fd = openSync(log, "w"); // Silent typechecks still produce an evidence file.
  let code;
  try {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", fd, fd],
      env: { ...process.env, TRACK_J_TIMEOUT_SECONDS: process.env.TRACK_J_TIMEOUT_SECONDS ?? "300" } });
    code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
  } finally { closeSync(fd); }
  const body = readFileSync(log, "utf8");
  const got = code === 0 && test.expected === "typecheck" ? "typecheck" :
    code === 0 && test.expected === "tests" && new RegExp(`\\b${test.count} passing\\b`).test(body) ? "tests" :
    code === 0 && /^\[ok\]/m.test(body) ? "ok" : code === 1 && /^\[violation\]/m.test(body) ? "violation" :
    code === 124 ? "timeout" : "error";
  const result = { ...test, code, got, seconds: Math.round((Date.now() - started) / 1000), log };
  results.push(result);
  const unchanged = Object.entries(sourceHashes).every(([file, hash]) => sha(file) === hash);
  writeFileSync(resolve(dir, `results-${mode}.json`), JSON.stringify({ sourceHashes, unchanged, results }, null, 2) + "\n");
  console.log(JSON.stringify(result));
  if (got !== test.expected || !unchanged) process.exitCode = 1;
}
console.log(`Evidence: ${dir}`);
