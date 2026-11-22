import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),entries=[],sources=[];
for(const gate of [17,20,22,35,36,42,49,50]){
 const file=gate===22?'.logs/d110c-0c1f5b-green-room-guard-db8a8615/focused-13/focused.json':'.logs/d110c-0c1f5b-green-ab98cce6/retained-'+gate+'/result.json',bytes=fs.readFileSync(path.join(root,file)),report=JSON.parse(bytes);sources.push({gate,file,sha256:hash(bytes),count:report.numTotalTests});
 for(const suite of report.testResults)for(const t of suite.assertionResults)entries.push({gate,file:path.relative(root,suite.name),ancestorTitles:t.ancestorTitles,title:t.title,fullName:t.fullName??[...t.ancestorTitles,t.title].join(' '),priorStatus:t.status,expectedStatus:'passed'});
}
if(entries.length!==72||new Set(entries.map(e=>e.file)).size!==8||entries.some(e=>e.priorStatus!=='passed'))throw Error('Core roster differs');
fs.writeFileSync(path.join(out,'future-core-roster.json'),JSON.stringify({classification:'FROZEN_CORE_ONLY_ADDITIONAL_CONSUMER_DISPOSITION_PENDING_ROOT',files:8,total:72,executionCount:0,sources,entries,additionalConsumers:'Not presumed superseded. Root audits accepted 0b0-floor, 0b0a-staged-handoff and remaining direct-consumer evidence before GREEN runtime.'},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({files:8,total:72,executionCount:0,additionalDispositionPending:true}));
