// Bounded, source-hashed pending-floor authority adjunct checks. A negative control
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
const dir = process.env.PENDING_FLOOR_LOGS ?? mkdtempSync(resolve(tmpdir(), "pending-floor-"));
mkdirSync(dir, { recursive: true });
const formal = "packages/protocol-v3/formal/";
const model = formal + "pending-floor-ephemeral.qnt";
const watchdog = formal + "settlement-replacement-retirement-mutations/run-check.mjs";
const quint = resolve(root, "node_modules/.bin/quint");
const sha = file => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
// Inspected source identities are evidence provenance, not TS/native refinement.
const sourceHashes = Object.fromEntries([model,watchdog,formal + "check-pending-floor.mjs",
  "packages/node/src/v3-live.ts", "packages/node/src/v3-room.ts",
  "packages/ephemeral/src/index.ts", "packages/node/src/creator-adoption-activate.ts"
].map(file => [file, sha(file)]));
writeFileSync(resolve(dir, "tlc.json"), JSON.stringify({ workers: 1, maxHeap: "-Xmx1G" }));
writeFileSync(resolve(dir, "apalache.json"), JSON.stringify({ common: { "out-dir": resolve(dir, "out") },
  checker: { "discard-disabled": false } }));
const cases = [], verification = [];
const primary = "pendingFloorEphemeral", projection = "pendingFloorOwnerGate";
if (["all","test"].includes(mode)) {
  cases.push({name:"model-typecheck",command:"typecheck",args:[model],expected:"typecheck"});
  for (const [main,count] of [[primary,21],[projection,9]])
    cases.push({name:`${main}-tests`,command:"test",args:[model,"--main",main],expected:"tests",count});
}
if (["all","verify"].includes(mode)) {
  for (const [name,main,step,property,expected] of [
    ["installed-safe",primary,"step","safety","ok"],
    ["suspension-safe",primary,"gatedStep","gatedAvailability","ok"],
    ["installed-pending-observation",primary,"step","neverPendingTraffic","violation"],
    ["installed-postcommit-observation",primary,"step","neverRetiredTraffic","violation"],
    ["suspension-no-pending",primary,"gatedStep","neverPendingTraffic","ok"],
    ["suspension-no-retired",primary,"gatedStep","neverRetiredTraffic","ok"],
    ["ready-nonvacuity",primary,"gatedStep","neverReady","violation"],
    ...["earlyStep","coldStep","abortStep","queueStep","tupleStep","cachedStep"].map(step => [step,primary,step,"safety","violation"]),
    ["late-suspension",primary,"lateGateStep","gatedAvailability","violation"],
    ["queued-suspension",primary,"queuedGateStep","neverPendingTraffic","violation"],
    ["owner-safe",projection,"step","safety","ok"],
    ["owner-stale-finish",projection,"finishStep","safety","violation"],
    ["owner-delayed-receive",projection,"delayedStep","safety","violation"],
  ]) verification.push([name,model,main,"tlc",step,"init",property,expected]);
}
if (["all","induction"].includes(mode)) verification.push(
  ["owner-base",model,projection,"apalache","step","init","safety","ok",0],
  ["owner-step",model,projection,"apalache","step","indInit","safety","ok",1],
  ["owner-mutant",model,projection,"apalache","unsafeStep","indInit","safety","violation",1]);
for (const [name,file,main,backend,step,init,property,expected,depth=1] of verification) {
  cases.push({name,command:"verify",expected,args:[file,"--main",main,"--backend",backend,
    "--apalache-version","0.56.1","--server-endpoint",process.env.PENDING_FLOOR_ENDPOINT ?? "localhost:8924",
    "--step",step,"--init",init,"--invariants",property,"--verbosity=3",
    ...(backend === "tlc" ? ["--tlc-config",resolve(dir,"tlc.json")] :
      ["--apalache-config",resolve(dir,"apalache.json"),`--max-steps=${depth}`])]});
}
const declaredCases = cases;
const caseFilter = process.env.PENDING_FLOOR_CASE_FILTER;
const selectedCases = caseFilter === undefined ? cases : cases.filter(test => new RegExp(caseFilter).test(test.name));
if (selectedCases.length === 0) throw new Error("Case filter selected no checks");
const results = [];
for (const test of selectedCases) {
  const args = [watchdog, quint, test.command, ...test.args];
  const log = resolve(dir, `${test.name}.log`), started = Date.now();
  const fd = openSync(log, "w"); // Silent typechecks still produce an evidence file.
  let code;
  try {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", fd, fd],
      env: { ...process.env, TRACK_J_TIMEOUT_SECONDS: process.env.TRACK_J_TIMEOUT_SECONDS ?? "180" } });
    code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
  } finally { closeSync(fd); }
  const body = readFileSync(log, "utf8");
  const got = code === 0 && test.expected === "typecheck" ? "typecheck" :
    code === 0 && test.expected === "tests" && new RegExp(`\\b${test.count} passing\\b`).test(body) ? "tests" :
    code === 0 && /^\[ok\]/m.test(body) ? "ok" : code === 1 && /^\[violation\]/m.test(body) ? "violation" :
    code === 124 ? "timeout" : "error";
  const inputHashes = Object.fromEntries([test.args[0],watchdog].map(file => [file,sha(file)]));
  const result = { ...test,inputHashes,code,got,seconds: Math.round((Date.now() - started) / 1000), log };
  results.push(result);
  const unchanged = Object.entries(sourceHashes).every(([file, hash]) => sha(file) === hash);
  writeFileSync(resolve(dir, `results-${mode}.json`), JSON.stringify({sourceHashes,unchanged,mode,caseFilter:caseFilter ?? null,declaredCases,results},null,2) + "\n");
  console.log(JSON.stringify(result));
  if (got !== test.expected || !unchanged) process.exitCode = 1;
}
console.log(`Evidence: ${dir}`);
