import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const accepted=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-red-observer-78e068a8/matrix.json')));
const label=process.argv[2],cwd=process.argv[3]??root;
const output=path.join(out,label,'result.json');
const command=['pnpm','exec','vitest','run',...accepted.files,`--testNamePattern=${accepted.filter}`,'--coverage.enabled=false','--reporter=json',`--outputFile=${output}`];
fs.writeFileSync(path.join(out,label+'-frozen.json'),JSON.stringify({command,cwd,expectedTotal:45,expectedActive:28,expectedPass:28,expectedFail:0,expectedFiltered:17,entries:accepted.entries.map(e=>({...e,expectedStatus:'passed',token:null})),fileHashes:accepted.fileHashes},null,2)+'\n',{flag:'wx'});
const result=spawnSync(process.execPath,[path.join(out,'run.mjs'),label,cwd,...command],{stdio:'inherit'});
if(fs.existsSync(output)){
 const reporter=JSON.parse(fs.readFileSync(output));
 const results=reporter.testResults.flatMap(file=>file.assertionResults);
 const active=results.filter(test=>test.status==='passed'||test.status==='failed');
 const expected=new Set(accepted.entries.map(e=>e.name));
 const violations=[];
 if(reporter.numTotalTests!==45||reporter.numPassedTests!==28||reporter.numFailedTests!==0||reporter.numPendingTests!==17)violations.push('counts');
 if((reporter.numRuntimeErrorTestSuites??0)!==0)violations.push('runtime errors');
 if(active.length!==28||active.some(e=>!expected.has(e.fullName)))violations.push('selected names');
 const failures=results.filter(e=>e.status==='failed').map(e=>({name:e.fullName,messages:e.failureMessages}));
 fs.writeFileSync(path.join(out,label+'-validation.json'),JSON.stringify({status:result.status,total:reporter.numTotalTests,passed:reporter.numPassedTests,failed:reporter.numFailedTests,filtered:reporter.numPendingTests,violations,failures,allResults:results},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({label,status:result.status,total:reporter.numTotalTests,passed:reporter.numPassedTests,failed:reporter.numFailedTests,filtered:reporter.numPendingTests,violations,failures}));
}
process.exitCode=result.status??1;
