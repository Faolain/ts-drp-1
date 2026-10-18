import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const consumers=JSON.parse(fs.readFileSync(path.join(out,'consumers-final.json')));
const focused='tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts';
const retained=[
 'tests/phase-6b-d110c-0c1k-w0-writer-capacity-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts',
 'tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts',
 ...consumers.tests.filter(f=>f!==focused),
 'tests/phase-6c-retained-heap-red.test.ts'
];
const files=[focused,...retained];if(new Set(files).size!==files.length)throw Error('Duplicate selection');
fs.writeFileSync(path.join(out,'selected-files-final.json'),JSON.stringify(files,null,2)+'\n',{flag:'wx'});
const result=spawnSync(process.execPath,[path.join(out,'run.mjs'),'collection-final',root,'pnpm','exec','vitest','list',...files.map(f=>path.join(root,f)),'--json'],{cwd:root,stdio:'inherit',env:process.env});process.exitCode=result.status??1;
