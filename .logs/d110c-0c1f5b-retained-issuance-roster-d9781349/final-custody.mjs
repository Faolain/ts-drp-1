import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const baseline='.logs/d110c-0c1f5b-green-ab98cce6/runtime-test-custody-after.json';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const prior=JSON.parse(fs.readFileSync(path.join(root,baseline)));
const built=Object.fromEntries(Object.entries(prior.built).map(([file,row])=>{const digest=hash(fs.readFileSync(path.join(root,file)));if(digest!==row.sha256)throw Error('Main built runtime drift '+file);return [file,{sha256:digest,unchanged:true}]}));
const reporter=fs.readFileSync(path.join(out,'focused.json')),report=JSON.parse(reporter),result=JSON.parse(fs.readFileSync(path.join(out,'result.json')));
const data={baseline,built,allSevenUnchanged:Object.keys(built).length===7,reporterSha256:hash(reporter),success:report.success,total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,topLevel:result.topLevel,stderrEmpty:fs.readFileSync(path.join(out,'stderr.log'),'utf8')==='',diagnosticNote:'One read-only metadata inspection initially requested absent green-ab98cce6/signed-source-custody.json (ENOENT). A bounded rg listing located the existing runtime-test-custody-after.json; no source edit, build or runtime repetition resulted.'};
if(!data.allSevenUnchanged||!data.stderrEmpty)throw Error('Final custody gate failed');
fs.writeFileSync(path.join(out,'final-custody.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(data));

