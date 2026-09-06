import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
const out=path.dirname(new URL(import.meta.url).pathname),main='/Users/aristotle/Documents/Projects/ts-drp-1';
const mode=process.argv[2],production='6f3d3049942c29f547f5cefdda628a3a01078077';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(path.join(out,file),'utf8'));
const write=(file,value)=>fs.writeFileSync(path.join(out,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const git=(...args)=>execFileSync('git',args,{cwd:main,encoding:'utf8'}).trim();
function files(directory=out){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.relative(out,path.join(directory,entry.name))]).sort();}
if(mode==='validate'){
 const outcomes=[];
 for(const [label,count,fileCount]of [['initial-focused',16,1],['initial-retained',125,7],['initial-issuance',12,1],['signed-focused',16,1]]){
  const r=read(`${label}.json`),status=read(`${label}/status.json`),frozen=read(`${label}-frozen.json`);
  assert.equal(status.code,0);assert.equal(status.signal,null);assert.equal(r.success,true);
  assert.equal(r.numTotalTests,count);assert.equal(r.numPassedTests,count);
  for(const key of ['numFailedTests','numPendingTests','numTodoTests','numFailedTestSuites','numPendingTestSuites'])assert.equal(r[key],0,key);
  for(const key of ['numRuntimeErrorTestSuites','numUnhandledErrors'])if(key in r)assert.equal(r[key],0,key);
  assert.equal(r.errors?.length??0,0);assert.equal(r.unhandledErrors?.length??0,0);
  assert.equal(r.testResults.length,fileCount);
  assert.deepEqual(r.testResults.map(row=>path.relative(frozen.root,row.name)).sort(),[...frozen.files].sort());
  const assertions=r.testResults.flatMap(row=>{
   assert.equal(row.status,'passed');assert.equal(row.message??'','');assert.equal(row.testExecError??null,null);return row.assertionResults;
  });
  assert.equal(assertions.length,count);
  for(const row of assertions){assert.equal(row.status,'passed');assert.deepEqual(row.failureMessages,[]);}
  if(label.endsWith('focused')){
   const red=JSON.parse(fs.readFileSync(path.join(main,'.logs/d110c-0c1f5b0z-red-1eba4f90/matrix.json'),'utf8'));
   assert.deepEqual(assertions.map(row=>row.fullName),red.entries.map(row=>row.name));
  }
  outcomes.push({label,processStatus:0,files:fileCount,total:count,passed:count,failed:0,skippedTodoPending:0,topLevelErrors:0,reporterSha256:hash(fs.readFileSync(path.join(out,`${label}.json`)))});
 }
 const browser=fs.readFileSync(path.join(out,'initial-browser/stdout'),'utf8').replace(/\u001b\[[0-9;]*m/gu,'');
 assert.equal(read('initial-browser/status.json').code,0);
 assert.match(browser,/Running 4 tests using 1 worker/u);assert.match(browser,/4 passed/u);
 const browserTests=browser.split('\n').filter(line=>/^\s+✓\s+\d+ \[chromium\]/u.test(line));
 assert.equal(browserTests.length,4);assert.doesNotMatch(browser,/\b(?:failed|skipped|flaky|timed out|unexpected)\b/u);
 const native=[];
 const signed=read('isolation-signed-before.json'),signedAfter=read('isolation-signed-after.json');
 assert.equal(signed.head,production);assert.equal(signed.signature,'G');assert.equal(signed.status,'');assert.equal(signedAfter.status,'');
 assert.deepEqual(signed.sources,signedAfter.sources);assert.deepEqual(signed.runtimes,signedAfter.runtimes);
 for(const name of ['duplicate','value','accessor','descriptor']){
  const report=read(`signed-native-${name}/stdout`),status=read(`signed-native-${name}/status.json`);
  assert.equal(status.code,0);assert.equal(status.signal,null);assert.equal(report.token,null);assert.equal(report.completed,true);
  assert.equal(report.evidence.root,signed.root);assert.equal(report.evidence.mode,name);
  for(const [file,runtime]of Object.entries(report.evidence.runtimes))assert.deepEqual(runtime,signed.runtimes[file]);
  native.push({mode:name,status:0,completed:true,token:null,premises:report.evidence.premises,stdoutSha256:hash(fs.readFileSync(path.join(out,`signed-native-${name}/stdout`))),stderrSha256:hash(fs.readFileSync(path.join(out,`signed-native-${name}/stderr`)))});
 }
 const initial=read('isolation-initial-patched-before.json'),initialAfter=read('isolation-initial-patched-after.json');
 assert.deepEqual(initial.sources,initialAfter.sources);assert.deepEqual(initial.runtimes,initialAfter.runtimes);
 assert.deepEqual(initial.sources,signed.sources);
 for(const file of Object.keys(initial.runtimes))assert.equal(initial.runtimes[file].sha256,signed.runtimes[file].sha256);
 const owners=git('diff-tree','--no-commit-id','--name-only','-r',production).split('\n');
 assert.deepEqual(owners,['packages/storage-browser/src/internal/ahe-reclamation.ts','packages/storage-node/src/internal/ahe-reclamation.ts','packages/storage/src/maintenance.ts']);
 const ownerHashes=Object.fromEntries(owners.map(file=>{const digest=hash(fs.readFileSync(path.join(main,file)));assert.equal(digest,signed.sources[file]);return[file,digest];}));
 const actualPatch=execFileSync('git',['diff',`${production}^`,production,'--',...owners],{cwd:main});
 assert.equal(hash(actualPatch),hash(fs.readFileSync(path.join(out,'production.patch'))));
 for(const stage of ['initial','signed']){
  const delta=read(`type-delta-${stage}.json`);assert.equal(delta.sourceMappedUnchanged,true);assert.equal(delta.targetDiagnostics.length,0);
  assert.deepEqual(delta.comparison.map(row=>[row.baselineCount,row.greenCount,row.identical]),[[0,0,true],[74,74,true],[144,144,true]]);
 }
 const commands=Object.fromEntries(files().filter(file=>file.endsWith('/status.json')).map(file=>[path.dirname(file),read(file)]));
 const expectedFailures={'main-eslint':1,'main-prettier':1};
 for(const stage of ['baseline','initial','signed'])for(const pkg of ['storage-browser','storage-node'])expectedFailures[`${stage}-typecheck-${pkg}`]=2;
 for(const [label,status]of Object.entries(commands)){assert.equal(status.code,expectedFailures[label]??0,label);assert.equal(status.signal,null,label);assert.equal(status.spawnError,undefined,label);}
 for(const label of ['baseline-build','initial-green-build','signed-build','initial-install','signed-install','main-eslint-corrected','main-prettier-corrected','main-diff-check','initial-focused-revalidation','production-signature','production-push'])assert.equal(commands[label].code,0);
 const signatures={};
 for(const commit of ['1eba4f9065d220afb0d77d90aac4a05b250a05bb','5ab259fedeea24a102d1e3309d7282da81a3b224','b2594cc7734d4e61c1cc3bff49f6996c4bbddc77',production]){signatures[commit]=git('log','-1','--format=%G?',commit);assert.equal(signatures[commit],'G');}
 const remote=git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path');assert.equal(remote.split(/\s/u)[0],production);
 const custody=read('custody-after-gates.json');assert.equal(custody.stashCount,27);assert.equal(custody.protectedPathCount,86522);assert.deepEqual(custody.missing,[]);
 const result={productionCommit:production,signatures,remote,owners,ownerHashes,productionPatchSha256:hash(actualPatch),outcomes,browser:{passed:4,skipped:0,failed:0,flaky:0,topLevelErrors:0,tests:browserTests,ephemeralPort:true,precedingIssuanceFinished:read('initial-issuance/status.json').finish<read('initial-browser/status.json').start},native,sourceCustody:{wholeFiles:12,statementSpans:66,initialAndSignedSourcesIdentical:true,allEightNativeRuntimeHashesIdentical:true},typecheck:{storagePass:true,browserPass:false,nodePass:false,browserInherited:74,nodeInherited:144,targetDiagnostics:0,externalSourceMappedDiagnostic:'TS2322 tests/fixtures/phase-6b/ahe-reclamation-contract.ts:234, BlobDigest/ClosureDigest'},custody:{parentFiles:7,stashes:27,protectedPaths:86522},commandStatuses:Object.fromEntries(Object.entries(commands).map(([label,status])=>[label,status.code])),recorderDiagnostic:{initialFocusedWrapperStatus:1,initialFocusedProcessStatus:0,cause:'Absent optional numRuntimeErrorTestSuites field compared strictly to 0',sameReporterRevalidated:true,noRuntimeRerunForValidator:true},focusedGreenRuns:2,redRuntimeRuns:0,formalReviewPending:true,parentIntegrationNotPerformed:true};
 write('validation.json',result);console.log(JSON.stringify({validated:true,outcomes:outcomes.map(({label,passed})=>({label,passed})),browser:4,native:4}));
} else if(mode==='whitespace'){
 const results=files().filter(file=>file!=='manifest.sha256').map(file=>{
  const r=spawnSync('git',['diff','--no-index','--check','/dev/null',path.join(out,file)],{encoding:'utf8'});
  return {file,status:r.status,stdout:r.stdout,stderr:r.stderr};
 }).filter(row=>row.status!==0&&row.status!==1);
 write('evidence-whitespace-corrected.json',{results,disposition:'git diff --no-index status1 means ordinary differences; status3 includes whitespace errors. Exact production.patch and raw command stdout (except explicitly sanitized process snapshot) are preserved. No source whitespace waiver.'});
 console.log(JSON.stringify(results.map(({file,status})=>({file,status}))));
 if(results.some(row=>!row.file.endsWith('/stdout')&&row.file!=='production.patch'))process.exitCode=1;
} else if(mode==='seal'){
 const inventory=files().filter(file=>file!=='manifest.sha256');
 fs.writeFileSync(path.join(out,'manifest.sha256'),inventory.map(file=>`${hash(fs.readFileSync(path.join(out,file)))}  ${file}\n`).join(''),{flag:'wx'});
 const bytes=fs.readFileSync(path.join(out,'manifest.sha256'));
 const entries=bytes.toString().trim().split('\n');
 assert.deepEqual(entries.map(line=>line.slice(66)).sort(),files().filter(file=>file!=='manifest.sha256'));
 for(const line of entries)assert.equal(hash(fs.readFileSync(path.join(out,line.slice(66)))),line.slice(0,64));
 console.log(JSON.stringify({entries:entries.length,manifestSha256:hash(bytes),verified:true}));
} else throw Error('Unknown mode');
