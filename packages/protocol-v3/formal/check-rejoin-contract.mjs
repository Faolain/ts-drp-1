// Bounded, source-hashed rejoin/retention adjunct checks. A negative control
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
const dir = process.env.REJOIN_LOGS ?? mkdtempSync(resolve(tmpdir(), "rejoin-contract-"));
mkdirSync(dir, { recursive: true });
const formal = "packages/protocol-v3/formal/";
const roles = formal + "rejoin-head-roles.qnt";
const custody = formal + "rejoin-unknown-custody.qnt";
const pruning = formal + "rejoin-pruning-currency.qnt";
const watchdog = formal + "settlement-replacement-retirement-mutations/run-check.mjs";
const quint = resolve(root, "node_modules/.bin/quint");
const sha = file => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
// Implementation hashes identify the inspected integrated baseline. They are not
// a proof that these abstract actions refine TS or native SQLite/browser actions.
const sourceHashes = Object.fromEntries([roles,custody,pruning,watchdog,formal + "check-rejoin-contract.mjs",
  "packages/node/src/v3-live.ts", "packages/node/src/creator-close.ts",
  "packages/node/src/internal/creator-closed-rollback-data.ts",
  "packages/storage-node/src/internal/node-issuance-store.ts",
  "packages/issuance-store/src/retirement.ts"].map(file => [file, sha(file)]));
writeFileSync(resolve(dir, "tlc.json"), JSON.stringify({ workers: 1, maxHeap: "-Xmx1G" }));
writeFileSync(resolve(dir, "apalache.json"), JSON.stringify({ common: { "out-dir": resolve(dir, "out") },
  checker: { "discard-disabled": false } }));
const cases = [], verification = [];
const modules = [
  ["head",roles,"rejoinHeadFloor",12,["staleStep","lowerStep","reviveStep","signatureStep","receiptOnlyStep","receiptAdmissionStep","receiptTargetStep"],["neverGap","neverReceiptOnlyRecovery"]],
  ["roles",roles,"rejoinActualHeadRoles",10,["remoteStep","protectedStep","obsoleteStep","mixedStep"],["neverNormalized"]],
  ["custody",custody,"rejoinUnknownCustody",19,["replayStep","autoExpiryStep","unknownStep","consumerStep","reserveStep","undoStep","foreignStep","gapCustodyStep","staleExpiryStep","projectionCommitStep","wrongSourceStep"],["neverExpired","neverUnknownAfterGap"]],
  ["pruning",pruning,"rejoinPruningCurrency",13,["forgedStep","staleStep","receiptProtectedStep","receiptForeignStep","consumerStep","censusStep"],["neverDeleted","neverNormalizedCertificate"]],
];
const projections = [["role-projection",roles,"rejoinRoleProjection"],
  ["custody-projection",custody,"rejoinCustodyProjection"],
  ["absence-projection",pruning,"rejoinAbsenceProjection"]];
if (["all","test"].includes(mode)) {
  for (const file of [roles,custody,pruning]) cases.push({name:`${file.split("/").at(-1)}-typecheck`,command:"typecheck",args:[file],expected:"typecheck"});
  for (const [name,file,main,count] of modules) cases.push({name:`${name}-tests`,command:"test",args:[file,"--main",main],expected:"tests",count});
}
if (["all","verify"].includes(mode)) {
  for (const [name,file,main,count,mutations,nonvacuities] of modules) {
    verification.push([`${name}-tlc`,file,main,"tlc","step","init","safety","ok"]);
    for (const step of mutations) verification.push([`${name}-${step}`,file,main,"tlc",step,"init","safety","violation"]);
    for (const property of nonvacuities) verification.push([`${name}-${property}`,file,main,"tlc","step","init",property,"violation"]);
  }
  for (const [name,file,main] of projections) verification.push([`${name}-tlc`,file,main,"tlc","step","init","safety","ok"]);
}
if (["all","induction"].includes(mode)) {
  for (const [name,file,main] of projections) verification.push(
    [`${name}-base`,file,main,"apalache","step","init","safety","ok",0],
    [`${name}-step`,file,main,"apalache","step","indInit","safety","ok",1],
    [`${name}-mutation`,file,main,"apalache","unsafeStep","indInit","safety","violation",1]);
}
for (const [name,file,main,backend,step,init,property,expected,depth=1] of verification) {
  cases.push({name,command:"verify",expected,args:[file,"--main",main,"--backend",backend,
    "--apalache-version","0.56.1","--server-endpoint",process.env.REJOIN_ENDPOINT ?? "localhost:8910",
    "--step",step,"--init",init,"--invariants",property,"--verbosity=3",
    ...(backend === "tlc" ? ["--tlc-config",resolve(dir,"tlc.json")] :
      ["--apalache-config",resolve(dir,"apalache.json"),`--max-steps=${depth}`])]});
}
const declaredCases = cases;
const caseFilter = process.env.REJOIN_CASE_FILTER;
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
