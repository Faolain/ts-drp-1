import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const repository = "/Users/aristotle/Documents/Projects/ts-drp-1";
const git = (where, args) => execFileSync("git", ["-C", where, ...args]);
const hash = value => createHash("sha256").update(value).digest("hex");
const commit = git(repository, ["rev-parse", "HEAD"]).toString().trim();
if (!git(repository, ["log", "-1", "--format=%s"]).toString().includes("bound settlement migration recovery control")) throw new Error("wrong correction commit");
const evidence = join(repository, ".logs", `d110c-0c1f5b0u-red-correction-${commit.slice(0,8)}`);
mkdirSync(evidence);
const checkout = join(mkdtempSync("/tmp/d110c-f5b0u-corrective-red-"), "checkout");
const prior = join(repository, ".logs/d110c-0c1f5b0u-red-539606eb/overlay");
const patch = readFileSync(join(prior, "rejected-candidate.patch"));
const expected = JSON.parse(readFileSync(join(prior, "overlay-before.json"), "utf8"));
if (hash(patch) !== "1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9") throw new Error("overlay changed");
const mainPatch = hash(git(repository, ["diff", "--binary"]));
const stash = hash(git(repository, ["stash", "list", "--format=%H"]));
const commands = [];
async function run(name, command, args, cwd=checkout, expectedStatus=0) {
  const startedAt = new Date().toISOString();
  const out=join(evidence, name+".stdout"), err=join(evidence,name+".stderr");
  writeFileSync(out,"",{flag:"wx"}); writeFileSync(err,"",{flag:"wx"});
  const child=spawn(command,args,{cwd,env:{...process.env,NODE_OPTIONS:"--max-old-space-size=8192"},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data", bytes=>appendFileSync(out,bytes)); child.stderr.on("data",bytes=>appendFileSync(err,bytes));
  const result=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",(status,signal)=>resolve({status,signal}));});
  commands.push({name,command,args,cwd,startedAt,finishedAt:new Date().toISOString(),...result});
  writeFileSync(join(evidence,"commands.json"),JSON.stringify(commands,null,2)+"\n");
  console.log(name,result.status);
  if(result.status!==expectedStatus) throw new Error(name+" status differs");
}
function audit() {
  for(const [file,digest] of Object.entries(expected.sources)) if(hash(readFileSync(join(checkout,file)))!==digest) throw new Error("overlay file differs: "+file);
  if(hash(git(checkout,["diff","--binary"]))!==expected.patchHash) throw new Error("overlay diff differs");
  if(hash(git(repository,["diff","--binary"]))!==mainPatch || hash(git(repository,["stash","list","--format=%H"]))!==stash) throw new Error("main custody differs");
}
writeFileSync(join(evidence,"identity.json"),JSON.stringify({commit,checkout,mainPatch,stash,overlay:expected,node:process.version,nodePath:process.execPath},null,2)+"\n",{flag:"wx"});
await run("worktree","git",["-C",repository,"worktree","add","--detach",checkout,commit],repository);
await run("apply","git",["-C",checkout,"apply",join(prior,"rejected-candidate.patch")]);
audit();
await run("install","pnpm",["install","--offline","--frozen-lockfile","--ignore-scripts"]);
await run("build","pnpm",["build:packages"]);
const selection=["tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts","-t","queues migration rehearsal"];
await run("list","pnpm",["exec","vitest","list",...selection]);
await run("focused","pnpm",["exec","vitest","run",...selection,"--coverage.enabled=false","--reporter=json",`--outputFile=${join(evidence,"reporter.json")}`],checkout,1);
audit();
const report=JSON.parse(readFileSync(join(evidence,"reporter.json"),"utf8"));
const cases=report.testResults.flatMap(file=>file.assertionResults);
const selected=cases.filter(row=>row.status==="failed");
const failures=selected.flatMap(row=>row.failureMessages);
if(report.success || report.numFailedTests!==1 || selected.length!==1 || failures.length!==3 ||
 !failures.some(text=>text.includes("D110C_0C1F5B0U_QUEUED_ISSUE_NOT_RECOVERED")) ||
 !failures.some(text=>text.includes("D110C_0C1F5B0U_MIGRATION_DID_NOT_RESUME")) ||
 !failures.some(text=>text.includes("D110C_0C1F5B0U_MIGRATION_ACTIVATION_DID_NOT_RESUME")) ||
 failures.some(text=>/timed out|unbounded|FLOOR_MISMATCH|Cannot find/.test(text))) throw new Error("causal matrix differs");
writeFileSync(join(evidence,"validation.json"),JSON.stringify({status:"CAUSAL_CORRECTIVE_RED_NOT_GREEN",selected:1,files:1,failures,mainCustodyUnchanged:true},null,2)+"\n",{flag:"wx"});
console.log("EVIDENCE",evidence);
