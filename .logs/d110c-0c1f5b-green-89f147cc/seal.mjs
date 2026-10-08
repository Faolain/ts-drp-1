import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:128*1024*1024});
const write=(file,value)=>fs.writeFileSync(path.join(out,file),value,{flag:'wx'});
const json=(file,value)=>write(file,JSON.stringify(value,null,2)+'\n');
const custody=JSON.parse(fs.readFileSync(path.join(out,'custody-stopped.json')));
if(git('rev-parse','HEAD').trim()!==custody.head)throw Error('HEAD drift');
const owners=Object.keys(custody.ownerHashes);
for(const file of owners)if(hash(fs.readFileSync(path.join(root,file)))!==custody.ownerHashes[file])throw Error('Owner drift '+file);
const patch=git('diff','--binary','--full-index','--',...owners);
if(hash(patch)!=='245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed')throw Error('Unchanged patch drift');
write('partial-production.patch',patch);
write('partial-production.patch.sha256',hash(patch)+'  partial-production.patch\n');
const frozen=JSON.parse(fs.readFileSync(path.join(out,'retained-runtime-roster.json')));
const retainedHashes=Object.assign({},...frozen.roster.map(row=>row.hashes));
for(const[file,digest]of Object.entries(retainedHashes))if(hash(fs.readFileSync(path.join(root,file)))!==digest)throw Error('Retained test drift '+file);
json('retained-source-custody.json',{fileCount:Object.keys(retainedHashes).length,hashes:retainedHashes,unchanged:true});
const summarize=label=>{
 const report=JSON.parse(fs.readFileSync(path.join(out,label,'result.json')));
 const assertions=report.testResults.flatMap(file=>file.assertionResults.map(row=>({file:file.name,...row})));
 return {label,success:report.success,total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,numRuntimeErrorTestSuites:report.numRuntimeErrorTestSuites,numUnhandledErrors:report.numUnhandledErrors,suites:report.testResults.map(file=>({file:file.name,message:file.message,testExecError:file.testExecError})),assertions};
};
const focused=summarize('focused-01');
const retained=Array.from({length:7},(_,index)=>summarize('retained-'+String(index+1).padStart(2,'0')));
const totals=retained.reduce((sum,row)=>({total:sum.total+row.total,passed:sum.passed+row.passed,failed:sum.failed+row.failed,pending:sum.pending+row.pending}),{total:0,passed:0,failed:0,pending:0});
if(focused.total!==45||focused.passed!==28||focused.failed!==0||focused.pending!==17||totals.total!==168||totals.passed!==167||totals.failed!==1||totals.pending!==0)throw Error('Outcome accounting differs');
json('stopped-results.json',{focused,retained,retainedTotals:totals,firstSixPassed:retained.slice(0,6).reduce((sum,row)=>sum+row.passed,0),coverageNote:'retained-02 is root13 + separately intended Node21; Node gate26 must not rerun'});
const ledger=[];
for(const entry of fs.readdirSync(out,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
 if(!entry.isDirectory()||!fs.existsSync(path.join(out,entry.name,'command.json')))continue;
 ledger.push({label:entry.name,command:JSON.parse(fs.readFileSync(path.join(out,entry.name,'command.json'))),status:JSON.parse(fs.readFileSync(path.join(out,entry.name,'status.json'))),stdout:entry.name+'/stdout',stderr:entry.name+'/stderr'});
}
json('command-ledger.json',ledger);
const selections={
 'packages/node/src/v3-live.ts':[[4510,4542],[5179,5190],[5227,5238],[5853,5864],[7148,7163],[7295,7306],[8829,8849]],
 'packages/node/src/internal/creator-transition-advance.ts':[[673,697]],
 'tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts':[[126,165],[337,356]],
};
json('source-seams.json',Object.fromEntries(Object.entries(selections).map(([file,ranges])=>{
 const bytes=fs.readFileSync(path.join(root,file)),lines=bytes.toString().split('\n');
 return [file,{sha256:hash(bytes),excerpts:ranges.map(([from,to])=>({from,to,text:lines.slice(from-1,to).map((line,index)=>`${from+index}: ${line}`).join('\n')}))}];
})));
const baseline=git('show',custody.head+':packages/node/src/v3-live.ts');
const start=baseline.indexOf('function countHistoricalIssuanceRow('),end=baseline.indexOf('\nfunction recoveryFailure(',start);
json('signed-counter-custody.json',{head:custody.head,signedFileSha256:hash(baseline),counter:baseline.slice(start,end),currentTestByteIdenticalToSigned:hash(git('show',custody.head+':tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts'))===hash(fs.readFileSync(path.join(root,'tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts')))});
json('seal-summary.json',{head:custody.head,patchSha256:hash(patch),ownerCount:owners.length,productionChangedThisContinuation:false,focused:{total:45,passed:28,failed:0,filtered:17},retained:totals,protectedPaths:custody.protectedPaths,stashes:27,retainedRoster:{files:72,assertions:876,gates:71},browser:{closedSelected:16,executed:0},typecheckPreparedButNotExecuted:true,productionAccepted:false,signedByThisAgent:false});
const collect=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?collect(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
const files=collect(out).filter(file=>path.basename(file)!=='manifest.sha256').sort();
write('manifest.sha256',files.map(file=>hash(fs.readFileSync(file))+'  '+path.relative(out,file)).join('\n')+'\n');
console.log(JSON.stringify({files:files.length,manifestSha256:hash(fs.readFileSync(path.join(out,'manifest.sha256'))),patchSha256:hash(patch),retainedTotals:totals}));
