import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
const root=dirname(new URL(import.meta.url).pathname),[cwd,prefix]=process.argv.slice(2);
const baseline='/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b0u-green-ea02487e/commands';
const files=[
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
 'tests/phase-6b-d110c-b-hot-adoption.test.ts'
];
const failures=j=>j.testResults.flatMap(f=>f.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,failures:a.failureMessages.map(m=>m.split('\n')[0])})));
for(let i=0;i<files.length;i++){
 const number=String(i+9).padStart(2,'0'),label=`${prefix}-${number}`,output=resolve(root,label,'result.json');
 const child=spawn(process.execPath,[resolve(root,'run.mjs'),label,cwd,'pnpm','exec','vitest','run',files[i],'--no-file-parallelism','--coverage.enabled=false','--reporter=json',`--outputFile=${output}`],{stdio:['ignore','ignore','pipe']});
 child.stderr.pipe(process.stderr);
 const status=await new Promise(r=>child.on('close',r));
 const j=JSON.parse(readFileSync(output)),failed=failures(j);
 const expected=i===1||i===13?failures(JSON.parse(readFileSync(resolve(baseline,i===13?'retained-22-corrected':`retained-${number}`,'result.json')))):[];
 const valid=JSON.stringify(failed)===JSON.stringify(expected)&&j.numPendingTests===0&&j.testResults.every(f=>f.message===''||f.assertionResults.some(a=>a.status==='failed'))&&status===(expected.length?1:0);
 console.log(JSON.stringify({label,file:files[i],status,total:j.numTotalTests,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,success:j.success,expectedInheritedFailures:expected,valid}));
 if(!valid){process.exitCode=1;break;}
}
