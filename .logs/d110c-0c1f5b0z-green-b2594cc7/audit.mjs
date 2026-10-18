import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const main='/Users/aristotle/Documents/Projects/ts-drp-1';
const out=path.dirname(new URL(import.meta.url).pathname);
const [mode,stage]=process.argv.slice(2);
const root=fs.realpathSync(process.cwd());
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,data)=>fs.writeFileSync(path.join(out,file),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const owners=['packages/storage/src/maintenance.ts','packages/storage-browser/src/internal/ahe-reclamation.ts','packages/storage-node/src/internal/ahe-reclamation.ts'];
const red=read(path.join(main,'.logs/d110c-0c1f5b0z-red-1eba4f90/custody-after.json'));
const matrix=read(path.join(main,'.logs/d110c-0c1f5b0z-red-1eba4f90/matrix.json'));
if(mode==='custody') {
 const baselineFile=path.join(main,'.logs/d110c-0c1f5b-green-57834387/custody-before.json');
 const baseline=read(baselineFile);
 const parentHashes=Object.fromEntries(Object.keys(red.productionHashes).map(file=>[file,hash(fs.readFileSync(path.join(main,file)))]));
 if(JSON.stringify(parentHashes)!==JSON.stringify(red.productionHashes))throw Error('Parent source drift');
 const stashes=git('stash','list','--format=%H %gd %s');
 if(stashes!==baseline.stashes.trim())throw Error('Stash drift');
 const untracked=baseline.untracked;
 const protectedPaths=typeof untracked==='string'?untracked.trim().split('\n'):untracked;
 if(!Array.isArray(protectedPaths))throw Error('Unknown baseline protected-path format');
 const missing=protectedPaths.filter(file=>!fs.existsSync(path.join(main,file)));
 if(missing.length)throw Error('Missing protected paths: '+missing.join(','));
 for(const [file,digest]of Object.entries(matrix.fileHashes))if(hash(fs.readFileSync(path.join(main,file)))!==digest)throw Error('Signed test drift: '+file);
 write(`custody-${stage}.json`,{head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),parentHashes,stashesSha256:hash(stashes),stashCount:stashes.split('\n').length,protectedPathCount:protectedPaths.length,missing,baselineSha256:hash(fs.readFileSync(baselineFile)),status:git('status','--short','--untracked-files=no'),testHashes:matrix.fileHashes});
} else if(mode==='isolation') {
 const head=git('rev-parse','HEAD');
 const files=[...Object.keys(red.productionHashes),...Object.keys(matrix.fileHashes),...owners,'pnpm-lock.yaml','package.json','vite.config.mts','tsconfig.json'];
 const sources=Object.fromEntries(files.map(file=>{
  const bytes=fs.readFileSync(path.join(root,file));
  if(red.productionHashes[file]&&hash(bytes)===red.productionHashes[file])throw Error('Parent partial patch leaked');
  if(matrix.fileHashes[file]&&hash(bytes)!==matrix.fileHashes[file])throw Error('Test drift');
  if(!stage.startsWith('initial-patched')&&!bytes.equals(execFileSync('git',['show',`${head}:${file}`],{cwd:root})))throw Error('Signed-source mismatch');
  return[file,hash(bytes)];
 }));
 const runtimeFiles=['packages/storage/dist/src/index.js','packages/storage/dist/src/maintenance.js','packages/storage-browser/dist/src/index.js','packages/storage-browser/dist/src/maintenance.js','packages/storage-browser/dist/src/internal/ahe-reclamation.js','packages/storage-node/dist/src/index.js','packages/storage-node/dist/src/maintenance.js','packages/storage-node/dist/src/internal/ahe-reclamation.js'];
 const runtimes=Object.fromEntries(runtimeFiles.map(file=>{
  const resolved=fs.realpathSync(path.join(root,file));
  if(!resolved.startsWith(root+'/'))throw Error('External dist');
  return[file,{path:resolved,sha256:hash(fs.readFileSync(resolved))}];
 }));
 write(`isolation-${stage}.json`,{root,head,signature:git('log','-1','--format=%G?'),status:git('status','--short','--untracked-files=no'),sources,runtimes,noCopiedDist:true,noParentPartialPatch:true,patchBoundary:stage.startsWith('initial-patched')?'Signed b2594cc7 plus only three-owner production.patch applied before second full source build.':'Exact signed checkout with no overlay.'});
} else if(mode==='manifests') {
 const data=[];
 for(const relative of ['.logs/d110c-0c1f5b0z-plan-609ee4ba','.logs/d110c-0c1f5b0z-plan-correction-7eb2a8df','.logs/d110c-0c1f5b0z-red-1eba4f90']){
  const directory=path.join(main,relative),bytes=fs.readFileSync(path.join(directory,'manifest.sha256'));
  const entries=bytes.toString().trim().split('\n');
  for(const line of entries){const [,digest,file]=line.match(/^([a-f0-9]{64})  (.+)$/);if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Manifest mismatch: '+file);}
  data.push({root:relative,entries:entries.length,sha256:hash(bytes)});
 }
 write('accepted-manifests.json',data);
} else throw Error('Unknown mode');
console.log(JSON.stringify({mode,stage,complete:true}));
