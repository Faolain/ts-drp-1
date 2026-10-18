import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root = dirname(new URL(import.meta.url).pathname);
const cwd = process.argv[2];
const prefix = process.argv[3];
const files = [
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
 'packages/storage-browser/tests/phase-2l-b-browser-issuance-registry-red.test.ts'
];
for (let i=Number(process.argv[4] ?? 0);i<files.length;i++) {
 const label = `${prefix}-${String(i+1).padStart(2,'0')}`;
 const output = resolve(root,label,'result.json');
 const args = [resolve(root,'run.mjs'),label,cwd,'pnpm','exec','vitest','run',files[i],'--no-file-parallelism','--coverage.enabled=false','--reporter=json',`--outputFile=${output}`];
 const child = spawn(process.execPath,args,{stdio:['ignore','ignore','pipe']});
 child.stderr.pipe(process.stderr);
 const status = await new Promise(r=>child.on('close',r));
 let result;
 try { const j=JSON.parse(readFileSync(output)); result={total:j.numTotalTests,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,success:j.success}; } catch {}
 console.log(JSON.stringify({label,file:files[i],status,result}));
 if (status !== 0) {
  const parentCwd=process.argv[5];
  if (!parentCwd) { process.exitCode = 1; break; }
  if(parentCwd==='@local') {
   const expectedLabel=i===21?'retained-22-corrected':`retained-${String(i+1).padStart(2,'0')}`;
   const rows=p=>JSON.parse(readFileSync(p)).testResults.flatMap(f=>f.assertionResults.map(a=>({name:a.fullName,status:a.status,failures:a.failureMessages.map(m=>m.split('\n')[0])})));
   const equal=JSON.stringify(rows(output))===JSON.stringify(rows(resolve(root,expectedLabel,'result.json')));
   console.log(JSON.stringify({label,localBaseline:expectedLabel,equivalent:equal}));
   if(!equal) {process.exitCode=1;break;}
   continue;
  }
  const parentLabel=`parent-${label}`;
  const parentOutput=resolve(root,parentLabel,'result.json');
  const parentArgs=[resolve(root,'run.mjs'),parentLabel,parentCwd,'pnpm','exec','vitest','run',files[i],'--no-file-parallelism','--coverage.enabled=false','--reporter=json',`--outputFile=${parentOutput}`];
  const baseline=spawn(process.execPath,parentArgs,{stdio:['ignore','ignore','pipe']});
  baseline.stderr.pipe(process.stderr);
  const baselineStatus=await new Promise(r=>baseline.on('close',r));
  const rows=p=>JSON.parse(readFileSync(p)).testResults.flatMap(f=>f.assertionResults.map(a=>({name:a.fullName,status:a.status,failures:a.failureMessages.map(m=>m.split('\n')[0])})));
  const equal=baselineStatus===status && JSON.stringify(rows(output))===JSON.stringify(rows(parentOutput));
  console.log(JSON.stringify({label,baselineStatus,baselineEquivalent:equal}));
  if(!equal) {process.exitCode=1;break;}
 }
}
