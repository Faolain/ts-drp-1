import {readFileSync,writeFileSync,readdirSync,realpathSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {resolve,relative} from "node:path";
import {createHash} from "node:crypto";
const evidence=import.meta.dirname,root=process.cwd(),isolated=realpathSync("/tmp/d110c-f5b0w-green-m7UvLk/checkout");
const read=name=>JSON.parse(readFileSync(resolve(evidence,name)));
const save=(name,value)=>writeFileSync(resolve(evidence,name),JSON.stringify(value,null,2)+"\n");
const hash=value=>createHash("sha256").update(value).digest("hex");
const git=(cwd,...args)=>{const r=spawnSync("git",args,{cwd,encoding:"utf8",maxBuffer:128*1024*1024});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const filename=name=>relative(name.startsWith(isolated)?isolated:root,name);
const matrix=report=>report.testResults.flatMap(file=>file.assertionResults.map(test=>({file:filename(file.name),title:test.fullName,status:test.status,errors:test.failureMessages.map(message=>message.split("\n")[0])}))).sort((a,b)=>(a.file+"|"+a.title).localeCompare(b.file+"|"+b.title));
const summary=report=>({total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,skipped:report.numPendingTests,runtimeErrors:report.numRuntimeErrorTestSuites??0});
const focused=read("focused-verified.json"),isolatedFocused=read("isolated-focused.json"),retained=read("retained.json"),isolatedRetained=read("isolated-retained.json"),baseline=read("isolated-baseline-rebase-complete.json"),v1=read("retained-v1-exact.json"),isolatedV1=read("isolated-v1.json");
const expected=JSON.parse(readFileSync(resolve(root,".logs/d110c-0c1f5b0w-red-final-import-corrected-56a264ce/expected-matrix.json")));
const key=rows=>rows.map(r=>r.file+"|"+r.title).sort();
const sourceFiles=["examples/v3-room/src/index.ts","packages/issuance-store/src/contract.ts"];
const sourceHashes=Object.fromEntries(sourceFiles.map(p=>[p,hash(readFileSync(resolve(root,p)))]));
const checks={
 focused:focused.numTotalTests===219&&focused.numPassedTests===219&&focused.numFailedTests===0&&focused.numPendingTests===0,
 frozenSelection:JSON.stringify(key(matrix(focused)))===JSON.stringify(key(expected)),
 isolatedFocused:JSON.stringify(matrix(focused))===JSON.stringify(matrix(isolatedFocused)),
 retainedMatrix:JSON.stringify(matrix(retained))===JSON.stringify(matrix(isolatedRetained)),
 exactBaselineDebt:JSON.stringify(matrix(retained).filter(r=>r.file==="tests/phase-3g-v3-room-rebase-red.test.ts"))===JSON.stringify(matrix(baseline)),
 retainedCounts:retained.numTotalTests===136&&retained.numPassedTests===118&&retained.numFailedTests===18,
 v1:v1.numPassedTests===1&&v1.numFailedTests===0&&v1.numPendingTests===1&&JSON.stringify(matrix(v1))===JSON.stringify(matrix(isolatedV1)),
 sourceIdentity:sourceFiles.every(p=>hash(readFileSync(resolve(isolated,p)))===sourceHashes[p]),
 patchIdentity:git(root,"diff","25ec98628eba5d348086ba18d6481544803e03c9","--",...sourceFiles)===git(isolated,"diff","--",...sourceFiles),
 unrelatedIsolation:JSON.stringify(git(isolated,"diff","--name-only").trim().split("\n"))===JSON.stringify(sourceFiles),
 cleanIsolationAnchor:git(isolated,"rev-parse","HEAD").trim()==="25ec98628eba5d348086ba18d6481544803e03c9",
 custody:Object.values(read("candidate-final-custody.json")).every(Boolean),
 sourceShape:Object.values(read("source-check.json").checks).every(Boolean),
 typeDeltas:["source-mapped","browser-native","node-native"].every(name=>read("typecheck-delta-"+name+".json").pass),
 noRuntimeErrors:[focused,isolatedFocused,retained,isolatedRetained,baseline,v1,isolatedV1].every(r=>(r.numRuntimeErrorTestSuites??0)===0),
};
const finalGates=["affected-builds","final-build","build-issuance","typecheck-issuance","typecheck-room-final","lint-final","format-final","diff","typecheck-deltas","isolated-install","isolated-complete-build","isolated-candidate-build","isolated-typechecks","isolated-lint","isolated-format","isolated-diff","isolated-runtime-identity-esm"];
checks.finalGates=finalGates.every(name=>read(name+".status.json").status===0);
const statuses=Object.fromEntries(readdirSync(evidence).filter(n=>n.endsWith(".status.json")).map(n=>[n.slice(0,-12),read(n).status]));
const result={disposition:Object.values(checks).every(Boolean)?"GREEN_WITH_EXACT_RETAINED_BASELINE_DEBT":"CONTRADICTION",checks,sourceHashes,counts:{focused:summary(focused),isolatedFocused:summary(isolatedFocused),retained:summary(retained),isolatedRetained:summary(isolatedRetained),retainedV1:summary(v1),isolatedV1:summary(isolatedV1)},finalGates,statuses,isolated:{path:isolated,method:"Sparse detached accepted-anchor checkout with exact two-file candidate patch; independent offline frozen-lockfile install and fresh builds. Tracked packages/examples/tests/configs/scripts/patches and root files present; historical .logs/docs/specs excluded. No protected untracked paths copied.",nodeResolution:JSON.parse(readFileSync(resolve(evidence,"isolated-runtime-identity-esm.stdout"),"utf8"))},debt:{rebase:"18 unchanged Phase-3g mock-fixture failures before settlement startup: invalid/truncated canonical genesis parameters. Exact baseline title/status/error comparison passed. No rebaseline or test edits.",typechecks:{sourceMapped:53,browserNative:78,nodeNative:111,added:0},parent:"Successful settlement close/adopt, successor codec/frontier, cross-close hold custody, authenticated removal/re-admission and long workloads remain unimplemented and unclaimed.",review:"Separate formal trio owned by root follows signed/pushed GREEN."},diagnostics:["Iteration 1: 180 pass / 39 fail; 38 stale compiled browser/node store cases and one exact redirect error wrapper. Rebuilt issuance package.","Iteration 2: 218 pass / 1 fail; blanket terminal-error preservation changed the old no-hold terminal-rejected outcome. Narrowed preservation to exact manual-review TypeError.","Initial room typecheck saw callback flow-narrowing TS2358/TS2339. Explicit unknown snapshot of callback-mutated terminalFailure fixes typing without behavior change.","Initial custody comparator incorrectly treated authorized source edits and rebuilt contract.js as protected; only those three exact paths now excluded. No stash/untracked/unrelated-source change occurred.","Initial isolated baseline lacked built outcome-commit test dependency; complete fresh package build preceded accepted baseline and final runs.","Initial v1 name filter selected zero tests; exact title corrected before claiming v1 coverage.","Initial CommonJS runtime-resolution probe was incompatible with ESM-only exports; corrected ESM import proves isolated runtime identity."]};
save("complete-matrix.json",matrix(focused));
save("retained-baseline-matrix.json",matrix(baseline));
save("validation.json",result);
console.log(JSON.stringify({disposition:result.disposition,checks,counts:result.counts}));
if(Object.values(checks).includes(false))process.exitCode=1;
