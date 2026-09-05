import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=fs.realpathSync(process.cwd()),out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const before=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json'),'utf8'));
const signed=JSON.parse(fs.readFileSync(path.join(out,'signed-test.json'),'utf8'));
const matrix=JSON.parse(fs.readFileSync(path.join(out,'matrix.json'),'utf8'));
const head=git('rev-parse','HEAD'),status=git('status','--short','--untracked-files=no');
if(head!==signed.head||status!==''||git('log','-1','--format=%G?')!=='G')throw Error('Isolated checkout not exact signed clean test commit');
const files=[...Object.keys(before.productionHashes),...Object.keys(matrix.fileHashes),'packages/storage/src/maintenance.ts','packages/storage-browser/src/internal/ahe-reclamation.ts','packages/storage-node/src/internal/ahe-reclamation.ts','pnpm-lock.yaml','package.json','vite.config.mts','tsconfig.json'];
const sourceHashes=Object.fromEntries(files.map(file=>{
 const bytes=fs.readFileSync(path.join(root,file)),committed=execFileSync('git',['show',`${head}:${file}`],{cwd:root});
 if(!bytes.equals(committed))throw Error('Source differs from signed commit: '+file);
 if(Object.keys(before.productionHashes).includes(file)&&hash(bytes)===before.productionHashes[file])throw Error('Parent partial GREEN leaked: '+file);
 if(matrix.fileHashes[file]&&hash(bytes)!==matrix.fileHashes[file])throw Error('Frozen test drift: '+file);
 return[file,hash(bytes)];
}));
const runtimePaths=['packages/storage/dist/src/index.js','packages/storage/dist/src/maintenance.js','packages/storage-browser/dist/src/index.js','packages/storage-browser/dist/src/maintenance.js','packages/storage-browser/dist/src/internal/ahe-reclamation.js','packages/storage-node/dist/src/index.js','packages/storage-node/dist/src/maintenance.js','packages/storage-node/dist/src/internal/ahe-reclamation.js'];
const runtimes=Object.fromEntries(runtimePaths.map(file=>{
 const resolved=fs.realpathSync(path.join(root,file));
 if(!resolved.startsWith(root+'/'))throw Error('Runtime outside isolated checkout');
 return[file,{path:resolved,sha256:hash(fs.readFileSync(resolved))}];
}));
const data={stage,root,head,signature:'G',trackedStatus:status,sourceHashes,runtimes,noProductionOverlay:true,noCopiedDist:true,buildMethod:'Fresh signed sparse clone; independent frozen offline install without lifecycle scripts; complete build:packages before native child runtime.'};
if(stage==='after'){
 const prior=JSON.parse(fs.readFileSync(path.join(out,'isolation-before.json'),'utf8'));
 if(JSON.stringify(prior.sourceHashes)!==JSON.stringify(sourceHashes)||JSON.stringify(prior.runtimes)!==JSON.stringify(runtimes))throw Error('Isolated source/runtime drift');
}
fs.writeFileSync(path.join(out,`isolation-${stage}.json`),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,root,head,noProductionOverlay:true,trackedStatus:status}));
