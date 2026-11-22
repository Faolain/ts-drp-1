// Small source-proof/native-drain adjunct. Counterexamples require a verifier
// violation verdict; translation errors and timeouts are never successes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.argv[2] ?? "all";
if (!["all", "test", "verify", "induction"].includes(mode)) throw new Error("Expected all, test, verify or induction");
const dir = process.env.SOURCE_PROOF_LOGS ?? mkdtempSync(resolve(tmpdir(), "source-proof-drain-"));
mkdirSync(dir, { recursive: true });
const formal = "packages/protocol-v3/formal/";
const model = formal + "source-proof-drain.qnt";
const watchdog = formal + "settlement-replacement-retirement-mutations/run-check.mjs";
const quint = resolve(root, "node_modules/.bin/quint");
const sha = file => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
// This model checks an implementation obligation. Final production-source
// correspondence is separate; an evolving WIP hash is not refinement evidence.
const sourceHashes = Object.fromEntries([model,watchdog,formal + "check-source-proof-drain.mjs"].map(file => [file,sha(file)]));
writeFileSync(resolve(dir,"tlc.json"),JSON.stringify({workers:1,maxHeap:"-Xmx1G"}));
writeFileSync(resolve(dir,"apalache.json"),JSON.stringify({common:{"out-dir":resolve(dir,"out")},checker:{"discard-disabled":false}}));
const cases = [], verification = [];
const primary = "sourceProofDrain", projection = "sourceProofTargetCurrency";
if (["all","test"].includes(mode)) {
  cases.push({name:"model-typecheck",command:"typecheck",args:[model],expected:"typecheck"});
  for (const [main,count] of [[primary,13],[projection,4]])
    cases.push({name:`${main}-tests`,command:"test",args:[model,"--main",main],expected:"tests",count});
}
if (["all","verify"].includes(mode)) {
  for (const [name,main,step,property,expected] of [
    ["custody-safe",primary,"step","safety","ok"],
    ["cold-safe",primary,"step","coldCustody","ok"],
    ["partial-nonvacuity",primary,"step","neverPartial","violation"],
    ["release-nonvacuity",primary,"step","neverReleased","violation"],
    ["premature-cold-loss",primary,"prematureStep","coldCustody","violation"],
    ["stale-before-plan",primary,"inverseStep","inverseSafety","violation"],
    ["shared-context-loss",primary,"contextStep","safety","violation"],
    ["pending-pair-loss",primary,"pendingStep","pendingRetained","violation"],
    ["target-safe",projection,"step","safety","ok"],
    ["target-stale-read",projection,"unsafeStep","safety","violation"],
  ]) verification.push([name,main,"tlc",step,"init",property,expected]);
}
if (["all","induction"].includes(mode)) verification.push(
  ["target-base",projection,"apalache","step","init","safety","ok",0],
  ["target-step",projection,"apalache","step","indInit","safety","ok",1],
  ["target-mutation",projection,"apalache","unsafeStep","indInit","safety","violation",1]);
for (const [name,main,backend,step,init,property,expected,depth=1] of verification)
  cases.push({name,command:"verify",expected,args:[model,"--main",main,"--backend",backend,
    "--apalache-version","0.56.1","--server-endpoint",process.env.SOURCE_PROOF_ENDPOINT ?? "localhost:8931",
    "--step",step,"--init",init,"--invariants",property,"--verbosity=3",
    ...(backend === "tlc" ? ["--tlc-config",resolve(dir,"tlc.json")] :
      ["--apalache-config",resolve(dir,"apalache.json"),`--max-steps=${depth}`])]});
const declaredCases = cases, caseFilter = process.env.SOURCE_PROOF_CASE_FILTER;
const selectedCases = caseFilter === undefined ? cases : cases.filter(test => new RegExp(caseFilter).test(test.name));
if (selectedCases.length === 0) throw new Error("Case filter selected no checks");
const results = [];
for (const test of selectedCases) {
  const args = [watchdog,quint,test.command,...test.args];
  const log = resolve(dir,`${test.name}.log`), started = Date.now(), fd = openSync(log,"w");
  let code;
  try {
    const child = spawn(process.execPath,args,{cwd:root,stdio:["ignore",fd,fd],
      env:{...process.env,TRACK_J_TIMEOUT_SECONDS:process.env.TRACK_J_TIMEOUT_SECONDS ?? "120"}});
    code = await new Promise((done,fail) => {child.once("error",fail);child.once("close",done);});
  } finally {closeSync(fd);}
  const body = readFileSync(log,"utf8");
  const got = code === 0 && test.expected === "typecheck" ? "typecheck" :
    code === 0 && test.expected === "tests" && new RegExp(`\\b${test.count} passing\\b`).test(body) ? "tests" :
    code === 0 && /^\[ok\]/m.test(body) ? "ok" : code === 1 && /^\[violation\]/m.test(body) ? "violation" :
    code === 124 ? "timeout" : "error";
  const inputHashes = Object.fromEntries([test.args[0],watchdog].map(file => [file,sha(file)]));
  const result = {...test,inputHashes,code,got,seconds:Math.round((Date.now()-started)/1000),log};
  results.push(result);
  const unchanged = Object.entries(sourceHashes).every(([file,hash]) => sha(file) === hash);
  writeFileSync(resolve(dir,`results-${mode}.json`),JSON.stringify({sourceHashes,unchanged,mode,
    caseFilter:caseFilter ?? null,declaredCases,results},null,2)+"\n");
  console.log(JSON.stringify(result));
  if (got !== test.expected || !unchanged) process.exitCode = 1;
}
console.log(`Evidence: ${dir}`);
