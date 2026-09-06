import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const targets=['tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts','tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts','tests/fixtures/phase-6a-v3/creator-adoption-contract.ts'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f)),json=f=>JSON.parse(read(f));
const write=(f,v)=>fs.writeFileSync(path.join(out,f),typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8',maxBuffer:128*1024*1024}).trim();
if(!['before','after','final'].includes(stage))throw Error('stage');
const prior=json('.logs/d110c-0c1f5b-snapshot-fixture-green-dc2f8dc2/custody-final.json');
const original=json('.logs/d110c-0c1f5b-green-57834387/custody-before.json'),head=git('rev-parse','HEAD');
if(git('log','-1','--format=%G?')!=='G'||git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0]!==head||git('diff','--cached','--name-only')||(stage==='before'&&head!=='61ea93f69d055b96bd1e8776480a26f9ef83cfb3'))throw Error('HEAD/remote/index');
for(const map of [prior.ownerHashes,prior.built,prior.testHashes,prior.fixtureHashes])for(const[f,h]of Object.entries(map))if(!targets.includes(f)&&hash(read(f))!==h)throw Error('Custody '+f);
const patch=execFileSync('git',['-C',root,'diff','--binary','--full-index','--',...Object.keys(prior.ownerHashes)],{maxBuffer:128*1024*1024});
if(hash(patch)!==prior.patchSha256)throw Error('Parent patch');
if(git('stash','list','--format=%H %gd %gs')!==original.stashes.trim())throw Error('Stashes');
for(const f of original.untracked)if(!fs.existsSync(path.join(root,f)))throw Error('Protected '+f);
const manifests={...prior.manifests,'.logs/d110c-w0-current-profile-red-0bca5b6d':hash(read('.logs/d110c-w0-current-profile-red-0bca5b6d/manifest.sha256')),'.logs/d110c-0c1f5b-snapshot-fixture-green-dc2f8dc2':hash(read('.logs/d110c-0c1f5b-snapshot-fixture-green-dc2f8dc2/manifest.sha256'))};
if(stage!=='before'){
 const initial=JSON.parse(fs.readFileSync(path.join(out,'../custody-before.json')));
 if(JSON.stringify(manifests)!==JSON.stringify(initial.manifests))throw Error('Manifest roots drift');
}
for(const[dir,h]of Object.entries(manifests)){
 const m=read(dir+'/manifest.sha256');if(hash(m)!==h)throw Error('Manifest '+dir);
 for(const line of m.toString().trim().split('\n')){
  const match=line.match(/^([a-f0-9]{64})\s+(.+)$/u);if(!match)throw Error('Manifest syntax '+dir);
  const[,d,f]=match;if(hash(read(f.startsWith('.logs/')?f:dir+'/'+f))!==d)throw Error('Evidence '+f);
 }
}
for(const f of git('diff','--name-only').split('\n').filter(Boolean))if(!Object.hasOwn(prior.ownerHashes,f)&&!(stage!=='before'&&targets.includes(f)))throw Error('Dirty '+f);
const targetHashes=Object.fromEntries(targets.map(f=>[f,hash(read(f))]));
const shared='tests/fixtures/phase-6a-v3/creator-adoption-contract.ts';
if(stage==='before'&&hash(read(shared))!=='c252edbdbb66507aba291563038fbf3781cdb4ed2f16de3dec0ecdab9e33dea9')throw Error('Shared fixture changed');
if(stage==='before')for(const f of targets){
 if(hash(read(f))!==hash(execFileSync('git',['-C',root,'show',head+':'+f])))throw Error('Signed target');
 write(path.basename(f)+'.before',read(f));
}
const result={stage,head,signature:'G',originExact:true,indexEmpty:true,ownerHashes:prior.ownerHashes,built:prior.built,targetHashes,sharedHelperSha256:hash(read(shared)),patchSha256:hash(patch),manifests,stashCount:27,protectedPaths:original.untracked.length,allProtectedPathsExist:true,trackedStatus:git('status','--short','--untracked-files=no')};
write('custody-'+stage+'.json',result);
console.log(JSON.stringify({stage,head,owners:8,built:7,stashes:27,protected:original.untracked.length,manifestRoots:Object.keys(manifests).length,targetHashes}));
