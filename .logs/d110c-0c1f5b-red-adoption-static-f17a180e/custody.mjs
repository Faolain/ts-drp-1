import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2],head='f17a180eef2e8b96dd6d4f6305dd64ba254814f2',hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f)),json=f=>JSON.parse(read(f)),git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',maxBuffer:128*1024*1024}).trim();
const prior=json('.logs/d110c-0c1f5b-green-room-guard-db8a8615/custody-after.json'),original=json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
if(git('rev-parse','HEAD')!==head||git('log','-1','--format=%G?')!=='G')throw Error('Signed plan identity');
for(const map of [prior.ownerHashes,prior.built,prior.testHashes])for(const[f,d]of Object.entries(map))if(hash(read(f))!==d)throw Error('Custody drift '+f);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(prior.ownerHashes)],{cwd:root,maxBuffer:128*1024*1024});if(hash(patch)!==prior.patchSha256)throw Error('Patch drift');
if(git('stash','list','--format=%H %gd %gs')!==original.stashes.trim())throw Error('Stashes');
for(const f of original.untracked)if(!fs.existsSync(path.join(root,f)))throw Error('Protected missing '+f);
const manifests={...prior.manifests,'.logs/d110c-0c1f5b-green-room-guard-db8a8615':hash(read('.logs/d110c-0c1f5b-green-room-guard-db8a8615/manifest.sha256'))};
for(const[dir,d]of Object.entries(manifests)){const m=read(dir+'/manifest.sha256');if(hash(m)!==d)throw Error('Manifest drift');for(const line of m.toString().trim().split('\n')){const[,h,f]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);if(hash(read(f.startsWith('.logs/')?f:dir+'/'+f))!==h)throw Error('Evidence drift '+f)}}
const fixtureFiles=['tests/fixtures/phase-6a-v3/creator-adoption-contract.ts','tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts'],fixtureHashes=Object.fromEntries(fixtureFiles.map(f=>[f,hash(read(f))]));
if(stage==='before')for(const f of fixtureFiles)fs.writeFileSync(path.join(out,path.basename(f)+'.before'),read(f),{flag:'wx'});
const data={stage,head,signature:'G',ownerHashes:prior.ownerHashes,built:prior.built,testHashes:prior.testHashes,fixtureHashes,patchSha256:hash(patch),stashCount:27,stashesSha256:hash(original.stashes),protectedPaths:original.untracked.length,allProtectedPathsExist:true,manifests,trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({stage,owners:Object.keys(prior.ownerHashes).length,built:Object.keys(prior.built).length,retained:Object.keys(prior.testHashes).length,protected:original.untracked.length,stashes:27,patchSha256:data.patchSha256}));
