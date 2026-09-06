import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=fs.realpathSync(process.cwd()),out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const before=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json'),'utf8'));
const head=git('rev-parse','HEAD'),status=git('status','--short','--untracked-files=no');
if(head!=='f83764c5a141972f13870168eb5b9a758cd92e1c'||status!==''||git('log','-1','--format=%G?')!=='G') throw Error('Isolated checkout not exact signed clean commit');
const files=[...Object.keys(before.productionHashes),'tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts','tests/fixtures/phase-6b-d110c-0c1f5b/transient-payload-application.ts','tests/fixtures/phase-6b-d110c-0c1f5b/snapshot-state-oracle.ts'];
const sourceHashes=Object.fromEntries(files.map(file=>{
 const bytes=fs.readFileSync(path.join(root,file)), committed=execFileSync('git',['show',`${head}:${file}`],{cwd:root});
 if(!bytes.equals(committed))throw Error('Source differs from signed commit: '+file);
 if(Object.keys(before.productionHashes).includes(file)&&hash(bytes)===before.productionHashes[file])throw Error('Partial GREEN leaked: '+file);
 return [file,hash(bytes)];
}));
const runtimePaths=['packages/node/dist/src/creator-adoption.js','packages/node/dist/src/creator-close.js','packages/node/dist/src/v3-live.js','packages/protocol-v3/dist/src/creator-checkpoint.js','packages/protocol-v3/dist/src/creator-close.js','packages/storage-browser/dist/src/issuance.js','packages/issuance-store/dist/src/contract.js'];
const runtimes=Object.fromEntries(runtimePaths.map(file=>{
 const resolved=fs.realpathSync(path.join(root,file));
 if(!resolved.startsWith(root+'/'))throw Error('Runtime outside isolated checkout');
 return [file,{path:resolved,sha256:hash(fs.readFileSync(resolved))}];
}));
const dependencies = Object.fromEntries(['typescript', 'vitest', 'vite'].map(name => { const resolved = fs.realpathSync(path.join(root, 'node_modules', name)); if (!resolved.startsWith(root + '/')) throw Error('Dependency outside isolated install'); return [name, resolved]; }));
const configHashes = Object.fromEntries(['pnpm-lock.yaml','vite.config.mts','package.json'].map(file => [file,hash(fs.readFileSync(path.join(root,file)))]));
const data={stage,root,head,nodeVersion:process.version,nodeExecutable:process.execPath,pnpmVersion:execFileSync('pnpm',['--version'],{encoding:'utf8'}).trim(),dependencies,configHashes,signature:'G',trackedStatus:status,sourceHashes,runtimes,noProductionOverlay:true,buildMethod:'Fresh sparse signed checkout; independent frozen offline install; complete build:packages before collection or runtime.'};
if(stage==='after'){
 const prior=JSON.parse(fs.readFileSync(path.join(out,'isolation-before.json'),'utf8'));
 if(JSON.stringify(prior.sourceHashes)!==JSON.stringify(sourceHashes)||JSON.stringify(prior.runtimes)!==JSON.stringify(runtimes))throw Error('Isolated source/runtime drift');
}
fs.writeFileSync(path.join(out,`isolation-${stage}.json`),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,root,head,noProductionOverlay:true,trackedStatus:status}));
