import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=[
 'tests/phase-2l-a-shared-issuance-contract.test.ts',
 'tests/phase-6b-issuance-retention-red.test.ts',
 'tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts',
 'tests/phase-3g-v3-rebase-outbox-red.test.ts',
 'tests/phase-3g-v3-room-rebase-red.test.ts',
 'tests/phase-3h-v3-room-rehearsal-red.test.ts',
 'tests/phase-3h-v3-room-activation-red.test.ts',
 'tests/phase-3h-v3-terminal-transition-red.test.ts',
 'tests/phase-3f-c-v3-room-batching-red.test.ts',
 'tests/phase-3a1b-d9336-authorized-recovery-red.test.ts',
 'tests/phase-5e-creator-close-red.test.ts',
 'tests/phase-6a-creator-successor-activation-red.test.ts',
 'tests/phase-6a-creator-successor-epoch-red.test.ts',
 'tests/phase-6a-creator-successor-local-author-red.test.ts',
 'tests/phase-6a-creator-successor-handle-identity-red.test.ts',
 'tests/phase-6a-creator-successor-infrastructure-red.test.ts',
 'tests/phase-6a-creator-successor-product-red.test.ts',
 'tests/phase-6b-d110c-b-hot-adoption.test.ts',
 'packages/storage-node/tests/phase-2l-c-node-issuance-red.test.ts',
 'packages/storage-node/tests/phase-2l-c-node-issuance-corrective-red.test.ts',
 'packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts',
 'packages/storage-browser/tests/phase-2l-b-browser-issuance-registry-red.test.ts',
 'tests/phase-3h-v3-migration-record-red.test.ts',
 'tests/phase-3a1b-d9346-shared-v3-room-red.test.ts',
 'tests/phase-5a-seal-digest-law-red.test.ts',
 'tests/phase-5a-c-seal-safety-red.test.ts',
 'tests/phase-5e-creator-actor-red.test.ts',
 'tests/phase-5e-creator-relearn-red.test.ts',
 'tests/phase-5e-creator-live-close-red.test.ts',
 'tests/phase-6a-creator-adoption-red.test.ts',
 'tests/phase-6a-creator-adoption-commit-red.test.ts',
 'tests/phase-4c-snapshot-quarantine-red.test.ts',
 'packages/storage-node/tests/phase-4c-b-snapshot-quarantine-red.test.ts',
 'tests/phase-3a1b-p4-live-journal-contract-red.test.ts',
 'tests/phase-3a1b-p4-live-journal-parity-governance-red.test.ts',
 'packages/storage-node/tests/phase-3a1b-p4-node-live-journal-red.test.ts',
 'tests/phase-6b-cleanup-eligibility-red.test.ts',
 'tests/phase-6b-ahe-reclamation-red.test.ts',
 'tests/phase-6b-runtime-reclamation-red.test.ts',
 'tests/phase-6b-differential-exit-red.test.ts',
 'packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts',
 'tests/phase-6c-retained-heap-red.test.ts',
 'tests/phase-6c-retained-heap-forensics-red.test.ts',
 'tests/phase-6c-creator-replay-pagination-red.test.ts',
 'tests/protocol-v3-creator-author-issuance-frontiers.test.ts',
 'tests/phase-6b-d110c-0c1f2-multi-author-frontier.test.ts',
 'tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts',
 'tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts',
 'tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts',
 'tests/d110c-0c1f5b0a-settlement-codec-red.test.ts',
 'tests/d110c-0c1f5b0a-corrective-red.test.ts',
 'tests/phase-6b-d110c-0c1k-w0-writer-capacity-red.test.ts',
 'tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0u-store-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0v-callback-contract.test.ts',
 'tests/phase-6b-d110c-0c1f5b0w-store-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts',
 'tests/e5-01-v3-operation-admission-red.test.ts',
 'tests/phase-3a1b-p2-outbox-publication-contract.test.ts',
 'tests/phase-3g-v3-rebase-outbox-red.test.ts',
 'tests/phase-4b-v3-live-snapshot-composition-red.test.ts',
 'tests/phase-6b-d110c-a-repeat-close-red.test.ts',
 'tests/phase-3a1b-p3-live-transport-red.test.ts',
];
const unique=[...new Set(files)];
const parent=['tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts'];
const invoke=(label,args)=>spawnSync(process.execPath,[path.join(out,'run.mjs'),label,root,...args],{stdio:'inherit'});
const write=(file,value)=>fs.writeFileSync(path.join(out,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
if(process.argv[2]==='collect'||process.argv[2]==='freeze'){
 if(process.argv[2]==='collect'){
  const collected=invoke('retained-collection',['pnpm','exec','vitest','list',...unique,...parent,'--json']);
  if(collected.status!==0)process.exit(collected.status??1);
 }
 const rows=JSON.parse(fs.readFileSync(path.join(out,'retained-collection/stdout')));
 const groups=[...unique.map(file=>[file]),parent];
 const roster=groups.map((selected,index)=>{
  const label='retained-'+String(index+1).padStart(2,'0');
  const names=rows.filter(row=>selected.includes(path.relative(root,row.file))).map(row=>row.name.replaceAll(' > ',' '));
  if(names.length===0)throw Error('Missing collection '+selected);
  const output=path.join(out,label,'result.json');
  return {label,files:selected,count:names.length,names,hashes:Object.fromEntries(selected.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])),command:['pnpm','exec','vitest','run',...selected,'--no-file-parallelism','--coverage.enabled=false','--reporter=json','--outputFile='+output],output,expected:'All pass; any failure stops for explicit attribution, never automatic baseline waiver'};
 });
 if(roster.at(-1).count!==45)throw Error('Full parent control inventory differs');
 write('retained-roster.json',{frozenAt:new Date().toISOString(),testFileCount:unique.length+parent.length,total:roster.reduce((n,row)=>n+row.count,0),deduplicatedEntries:files.length-unique.length,roster,collection:rows,exclusions:['D110a consuming full/preflight launchers','long campaigns','unclosed browser D110c-0c process-death title'],d110aSafety:'Only source/synthetic validators and miniature fault children; pagination is129genuine rows, not full workload'});
 console.log(JSON.stringify({files:unique.length+parent.length,gates:roster.length,total:roster.reduce((n,row)=>n+row.count,0)}));
}else if(process.argv[2]==='exact'){
 const frozen=JSON.parse(fs.readFileSync(path.join(out,'retained-roster.json')));
 const selected=new Set(frozen.roster.flatMap(row=>row.files));
 write('retained-exact-roster.json',{...frozen,supersedes:'retained-roster.json relative CLI arguments only',unselectedCollected:frozen.collection.filter(row=>!selected.has(path.relative(root,row.file))),roster:frozen.roster.map(row=>({...row,command:row.command.map(arg=>row.files.includes(arg)?path.join(root,arg):arg)}))});
 console.log(JSON.stringify({files:frozen.testFileCount,total:frozen.total,gates:frozen.roster.length}));
}else{
 const frozen=JSON.parse(fs.readFileSync(path.join(out,'retained-runtime-roster.json')));
 const begin=Number(process.argv[2]??0),end=Number(process.argv[3]??frozen.roster.length);
 for(let index=begin;index<end;index++){
  const row=frozen.roster[index];if(!row)throw Error('Unknown gate');
  if(row.coveredBy){console.log(JSON.stringify({gate:index,label:row.label,coveredBy:row.coveredBy,rerun:false}));continue;}
  for(const[file,expected]of Object.entries(row.hashes))if(hash(fs.readFileSync(path.join(root,file)))!==expected)throw Error('Test drift '+file);
  const result=invoke(row.label,row.command);
  let validation={status:result.status,missingReporter:true};
  if(fs.existsSync(row.output)){
   const report=JSON.parse(fs.readFileSync(row.output));
   const assertions=report.testResults.flatMap(file=>file.assertionResults);
   const actualNameRows=report.testResults.flatMap(file=>file.assertionResults.map(assertion=>file.name+'\0'+[...assertion.ancestorTitles,assertion.title].join(' > '))).sort();
   const expectedNameRows=frozen.collection.filter(entry=>row.files.includes(path.relative(root,entry.file))).map(entry=>entry.file+'\0'+entry.name).sort();
   const exact=JSON.stringify(actualNameRows)===JSON.stringify(expectedNameRows);
   const exactFiles=JSON.stringify(report.testResults.map(file=>path.relative(root,file.name)).sort())===JSON.stringify([...row.files].sort());
   validation={status:result.status,success:report.success,total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,exactNames:exact,exactFiles,numRuntimeErrorTestSuites:report.numRuntimeErrorTestSuites,numUnhandledErrors:report.numUnhandledErrors,suiteMessages:report.testResults.map(file=>({name:file.name,message:file.message,testExecError:file.testExecError})),topLevelErrors:report.testResults.filter(file=>file.testExecError).map(file=>file.testExecError),nonemptyFailureMessages:assertions.filter(assertion=>assertion.failureMessages.length).map(assertion=>({name:assertion.fullName,messages:assertion.failureMessages})),assertions};
  }
  write(row.label+'-validation.json',validation);
  console.log(JSON.stringify({gate:index,label:row.label,total:validation.total,passed:validation.passed,failed:validation.failed,pending:validation.pending,status:result.status,exactNames:validation.exactNames}));
  if(result.status!==0||validation.success!==true||validation.exactNames!==true||validation.exactFiles!==true||validation.topLevelErrors?.length||validation.numRuntimeErrorTestSuites||validation.numUnhandledErrors||validation.suiteMessages?.some(file=>file.message)||validation.nonemptyFailureMessages?.length||validation.pending||validation.failed){process.exitCode=1;break;}
 }
}
