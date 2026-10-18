import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2],head='f8ec9daf82c230b48ef615073979dcab7b14f149',hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f)),json=f=>JSON.parse(read(f)),git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',maxBuffer:128*1024*1024}).trim();
const prior=json('.logs/d110c-0c1f5b-green-transport-static-41686d6f/custody-final.json'),original=json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
if(git('rev-parse','HEAD')!==head||git('log','-1','--format=%G?')!=='G')throw Error('Signed plan identity');
const red=json('.logs/d110c-0c1f5b-red-fixture-exit-5aa22117/custody-after.json'),effective={...prior.testHashes,...red.fixtureHashes},allowed=['tests/fixtures/phase-3b-v3/certified-genesis-contract.ts','tests/phase-3g-v3-room-rebase-red.test.ts','tests/genesis-profile.test.ts','tests/phase-5d-pacemaker-red.test.ts'];
for(const map of [prior.ownerHashes,prior.built,effective])for(const[f,d]of Object.entries(map))if(!(stage==='after'&&allowed.includes(f))&&hash(read(f))!==d)throw Error('Custody drift '+f);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(prior.ownerHashes)],{cwd:root,maxBuffer:128*1024*1024});if(hash(patch)!==prior.patchSha256)throw Error('Patch drift');
if(git('stash','list','--format=%H %gd %gs')!==original.stashes.trim())throw Error('Stashes');
for(const f of original.untracked)if(!fs.existsSync(path.join(root,f)))throw Error('Protected missing '+f);
const manifests={...prior.manifests,'.logs/d110c-0c1f5b-red-fixture-exit-5aa22117':'d76cc65d165eda9f115e724e25a6ea490d5d4c4bf1f6a9d91e81722076300c99','.logs/d110c-0c1f5b-green-transport-static-41686d6f':hash(read('.logs/d110c-0c1f5b-green-transport-static-41686d6f/manifest.sha256'))};
for(const[dir,d]of Object.entries(manifests)){const m=read(dir+'/manifest.sha256');if(hash(m)!==d)throw Error('Manifest drift');for(const line of m.toString().trim().split('\n')){const[,h,f]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);if(hash(read(f.startsWith('.logs/')?f:dir+'/'+f))!==h)throw Error('Evidence drift '+f)}}
const fixtureFiles=['tests/genesis-profile.test.ts','tests/phase-5a-c-seal-safety-red.test.ts','tests/phase-5d-pacemaker-red.test.ts','tests/phase-3g-v3-room-rebase-red.test.ts','tests/fixtures/phase-3b-v3/certified-genesis-contract.ts','tests/fixtures/phase-5d-v3/pacemaker-fixture.ts'],fixtureHashes=Object.fromEntries(fixtureFiles.map(f=>[f,hash(read(f))]));
for(const f of fixtureFiles)fs.writeFileSync(path.join(out,path.basename(f)+'.'+stage),read(f),{flag:'wx'});
const data={stage,head,signature:'G',ownerHashes:prior.ownerHashes,built:prior.built,testHashes:{...effective,...fixtureHashes},fixtureHashes,effectiveMapExplicitlyMergesPrior81AndSixConsumers:true,patchSha256:hash(patch),stashCount:27,stashesSha256:hash(original.stashes),protectedPaths:original.untracked.length,allProtectedPathsExist:true,manifests,trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({stage,owners:Object.keys(prior.ownerHashes).length,built:Object.keys(prior.built).length,retained:Object.keys(prior.testHashes).length,protected:original.untracked.length,stashes:27,patchSha256:data.patchSha256}));
