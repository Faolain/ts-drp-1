import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=execFileSync('rg',['--files','tests','packages','scripts','-g','*.ts','-g','*.mjs','-g','!**/dist/**','-g','!**/node_modules/**'],{cwd:root,encoding:'utf8'}).trim().split('\n');
const deps=new Map(files.map(f=>[f,[]]));
for(const f of files){const text=fs.readFileSync(path.join(root,f),'utf8');for(const m of text.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu)){if(!m[1].startsWith('.'))continue;const dep=path.normalize(path.join(path.dirname(f),m[1])).replace(/\.js$/u,'.ts');if(deps.has(dep))deps.get(f).push(dep);}}
deps.get('packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts').push('tests/fixtures/phase-6a-v3/creator-adoption-contract.ts','tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts');
deps.get('packages/storage-node/tests/phase-6b-differential-exit-red.test.ts').push('tests/phase-6b-runtime-reclamation-red.test.ts');
const helper='tests/fixtures/phase-6a-v3/creator-adoption-contract.ts',affected=new Set([helper]);
let changed=true;while(changed){changed=false;for(const[f,imports]of deps)if(!affected.has(f)&&imports.some(d=>affected.has(d))){affected.add(f);changed=true;}}
const result={helper,directConsumers:files.filter(f=>deps.get(f).includes(helper)).sort(),transitiveConsumers:[...affected].sort(),tests:[...affected].filter(f=>f.endsWith('.test.ts')).sort(),dependencies:Object.fromEntries([...affected].sort().map(f=>[f,deps.get(f)])),hashes:Object.fromEntries([...affected].sort().map(f=>[f,hash(fs.readFileSync(path.join(root,f)))]))};
fs.writeFileSync(path.join(out,'consumers-final.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));
