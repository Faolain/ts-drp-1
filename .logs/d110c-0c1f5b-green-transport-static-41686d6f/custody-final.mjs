import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2],head='c5b5f36a3d3201633ae7bab1d9959ab52fa14526',hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f)),json=f=>JSON.parse(read(f)),git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',maxBuffer:128*1024*1024}).trim();
const prior=json('.logs/d110c-0c1f5b-green-transport-static-41686d6f/custody-after.json'),original=json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
if(git('rev-parse','HEAD')!==head||git('log','-1','--format=%G?')!=='G')throw Error('Signed plan identity');
for(const map of [prior.ownerHashes,prior.built,prior.testHashes])for(const[f,d]of Object.entries(map))if(!(stage==="after"&&f==="tests/phase-3a1b-p3-live-transport-red.test.ts")&&hash(read(f))!==d)throw Error('Custody drift '+f);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(prior.ownerHashes)],{cwd:root,maxBuffer:128*1024*1024});if(hash(patch)!==prior.patchSha256)throw Error('Patch drift');
if(git('stash','list','--format=%H %gd %gs')!==original.stashes.trim())throw Error('Stashes');
for(const f of original.untracked)if(!fs.existsSync(path.join(root,f)))throw Error('Protected missing '+f);
const manifests={...prior.manifests,".logs/d110c-0c1f5b-red-transport-static-63e42eef":"c245961b238714159df0e1f77f347f43bb3b5d44ea7cea41a576083a092872c7",'.logs/d110c-0c1f5b-green-adoption-static-393eda67':hash(read('.logs/d110c-0c1f5b-green-adoption-static-393eda67/manifest.sha256'))};
for(const[dir,d]of Object.entries(manifests)){const m=read(dir+'/manifest.sha256');if(hash(m)!==d)throw Error('Manifest drift');for(const line of m.toString().trim().split('\n')){const[,h,f]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);if(hash(read(f.startsWith('.logs/')?f:dir+'/'+f))!==h)throw Error('Evidence drift '+f)}}
if(git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0]!==head||git('diff','--cached','--name-only'))throw Error('Remote/index drift');
for(const f of git('diff','--name-only').split('\n'))if(!Object.hasOwn(prior.ownerHashes,f)&&f!=='docs/production-hardening/production-hardening-tdd-plan-v2.md')throw Error('Unexpected dirty owner '+f);
const fixtureFiles=['tests/phase-3a1b-p3-live-transport-red.test.ts'],fixtureHashes=Object.fromEntries(fixtureFiles.map(f=>[f,hash(read(f))]));
if(stage!=="final")for(const f of fixtureFiles)fs.writeFileSync(path.join(out,path.basename(f)+'.'+stage),read(f),{flag:'wx'});
const data={stage,head,originExact:true,indexEmpty:true,rootOwnedPlanException:'docs/production-hardening/production-hardening-tdd-plan-v2.md',signature:'G',ownerHashes:prior.ownerHashes,built:prior.built,testHashes:stage==="after"?{...prior.testHashes,...fixtureHashes}:prior.testHashes,fixtureHashes,patchSha256:hash(patch),stashCount:27,stashesSha256:hash(original.stashes),protectedPaths:original.untracked.length,allProtectedPathsExist:true,manifests,trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({stage,owners:Object.keys(prior.ownerHashes).length,built:Object.keys(prior.built).length,retained:Object.keys(prior.testHashes).length,protected:original.untracked.length,stashes:27,patchSha256:data.patchSha256}));
