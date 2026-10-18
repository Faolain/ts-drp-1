import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),core=JSON.parse(fs.readFileSync(path.join(out,'future-core-roster.json'),'utf8')),entries=[...core.entries],sources=[...core.sources];
for(const relative of ['.logs/d110c-0a-green-0b7a1cf6/batch1-corrected-vitest.json','.logs/d110c-0a-green-0b7a1cf6/batch2-genuine-actor-matrix-vitest.json','.logs/d110c-0b0-green-798489fd/focused.json','.logs/d110c-0b0a-green-c1e443fc/focused.json']){
 const bytes=fs.readFileSync(path.join(root,relative)),r=JSON.parse(bytes);sources.push({gate:'additional-accepted-direct-consumer',file:relative,sha256:hash(bytes),count:r.numTotalTests});
 for(const s of r.testResults)for(const t of s.assertionResults)entries.push({gate:'additional-accepted-direct-consumer',file:path.relative(root,s.name),ancestorTitles:t.ancestorTitles,title:t.title,fullName:t.fullName??[...t.ancestorTitles,t.title].join(' '),priorStatus:t.status,expectedStatus:'passed'});
}
const files=[...new Set(entries.map(e=>e.file))],sourceFiles=[];
for(const file of files){const bytes=fs.readFileSync(path.join(root,file));sourceFiles.push({file,sha256:hash(bytes),reporterTitleCount:entries.filter(e=>e.file===file).length})}
if(files.length!==12||entries.length!==78||entries.some(e=>e.priorStatus!=='passed'))throw Error('Combined roster differs');
fs.writeFileSync(path.join(out,'future-combined-roster.json'),JSON.stringify({classification:'PROSPECTIVE_CORRECTION_PENDING_ROOT_SIGNED_RED_EVIDENCE_AND_PLAN_COMMIT',coreFiles:8,coreTotal:72,additionalFiles:4,additionalTotal:6,files:12,total:78,sources,sourceFiles,entries,reporterDerivedTitleIdentity:true,staticLiteralScannerNotUsed:true,noVitestCollection:true,runtimeExecutions:0,rootDisposition:'All four additional files have accepted GREEN reports; the initial superseded-history classification was incorrect. Preserve f17 history; root corrects the prose without repeating compiler RED.'},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({files:12,total:78,reporterTitlesExact:true,noCollectionOrRuntime:true,prospectiveRootCorrection:true}));
