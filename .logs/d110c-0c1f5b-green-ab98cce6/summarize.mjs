import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),prior=path.join(root,'.logs/d110c-0c1f5b-green-89f147cc'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p)),write=(p,v)=>fs.writeFileSync(path.join(out,p),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const frozen=read(path.join(out,'retained-runtime-roster.json'));
const reports=[];
for(let n=1;n<=71;n++){
 if(n===26)continue;
 const label='retained-'+String(n).padStart(2,'0'),base=n<=6?prior:out,file=path.join(base,label,'result.json');
 const report=read(file),status=read(path.join(base,label,'status.json'));
 reports.push({label,source:path.relative(root,file),sha256:hash(fs.readFileSync(file)),exit:status,success:report.success,total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,numRuntimeErrorTestSuites:report.numRuntimeErrorTestSuites??null,numUnhandledErrors:report.numUnhandledErrors??null,suites:report.testResults.map(s=>({file:s.name,message:s.message,testExecError:s.testExecError??null})),assertions:report.testResults.flatMap(s=>s.assertionResults.map(a=>({file:s.name,...a})))});
}
const total=rows=>rows.reduce((a,r)=>({total:a.total+r.total,passed:a.passed+r.passed,failed:a.failed+r.failed,pending:a.pending+r.pending}),{total:0,passed:0,failed:0,pending:0});
const all=reports.flatMap(r=>r.assertions),active=all.filter(a=>a.status!=='skipped');
const names=rows=>rows.map(a=>a.file+'\0'+[...a.ancestorTitles,a.title].join(' > ')).sort();
const files=new Set(frozen.roster.flatMap(r=>r.files));
const expected=frozen.collection.filter(e=>files.has(path.relative(root,e.file))).map(e=>e.file+'\0'+e.name).sort();
const exactActiveMultiset=JSON.stringify(names(active))===JSON.stringify(expected);
if(!exactActiveMultiset)throw Error('Selected active multiset differs');
if(reports.some(r=>r.numRuntimeErrorTestSuites||r.numUnhandledErrors||r.suites.some(s=>s.message||s.testExecError)))throw Error('Suite errors need attribution');
const hashes=Object.assign({},...frozen.roster.map(r=>r.hashes));for(const [f,h]of Object.entries(hashes))if(hash(fs.readFileSync(path.join(root,f)))!==h)throw Error('Test drift '+f);
const before=read(path.join(out,'runtime-identity-corrected.json'));for(const [f,r]of Object.entries(before.built))if(hash(fs.readFileSync(path.join(root,f)))!==r.sha256)throw Error('Runtime drift '+f);
write('complete-retained-results.json',{frozenSelectedActive:frozen.total,fullReporterTotals:total(reports),thisContinuationTotals:total(reports.slice(6)),priorPassingCoverage:total(reports.slice(0,6)),exactActiveMultiset,uniqueFiles:files.size,reports,conditionalSkips:all.filter(a=>a.status==='skipped'),allFailures:all.filter(a=>a.status==='failed'),focusedPrior:{source:'.logs/d110c-0c1f5b-green-89f147cc/focused-01/result.json',total:45,passed:28,failed:0,filtered:17,notRerun:true}});
write('runtime-test-custody-after.json',{testHashes:hashes,built:before.built,allUnchanged:true,guardEnvironment:{TS_DRP_PHASE_3A1B_P4_NODE_DEATH:process.env.TS_DRP_PHASE_3A1B_P4_NODE_DEATH??null},safeProcesses:execFileSync('ps',['-axo','pid=,ppid=,stat=,comm='],{encoding:'utf8'}).split('\n').filter(line=>/node|vitest|pnpm/iu.test(line)),processNote:'PID/PPID/status/executable only; no process arguments collected. All recorder statuses terminal. This agent launched no remaining runtime writer.'});
const ledger=fs.readdirSync(out,{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(out,e.name,'command.json'))).map(e=>({label:e.name,command:read(path.join(out,e.name,'command.json')),status:read(path.join(out,e.name,'status.json')),stdout:e.name+'/stdout',stderr:e.name+'/stderr'}));
write('command-ledger.json',ledger);
console.log(JSON.stringify({full:total(reports),current:total(reports.slice(6)),prior:total(reports.slice(0,6)),exactActiveMultiset,files:files.size,failedCases:all.filter(a=>a.status==='failed').length}));
