import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2],head='09aa220919babdf4d869effcfee6ccdacb49c4a1',target='tests/phase-6b-d110c-0c1f5b-integration-red.test.ts',priorDir='.logs/d110c-0c1f5b-green-fixture-exit-f8ec9daf',hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f)),json=f=>JSON.parse(read(f)),git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8',maxBuffer:128*1024*1024}).trim(),write=(f,v)=>fs.writeFileSync(path.join(out,f),v,{flag:'wx'});
if(!['final'].includes(stage))throw Error('stage');
const prior=json('.logs/d110c-0c1f5b-wide-cpu-ae67fe3f/custody-final.json'),original=json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
if(git('rev-parse','HEAD')!==head||git('log','-1','--format=%G?')!=='G'||git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0]!==head||git('diff','--cached','--name-only'))throw Error('HEAD/remote/index');
const tests={...prior.testHashes};if(stage==='final')tests[target]=JSON.parse(fs.readFileSync(path.join(out,'equivalence.json'))).files[0].afterSha256;
for(const map of [prior.ownerHashes,prior.built,tests])for(const[f,h]of Object.entries(map))if(hash(read(f))!==h)throw Error('Custody '+f);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(prior.ownerHashes)],{cwd:root,maxBuffer:128*1024*1024});if(hash(patch)!==prior.patchSha256)throw Error('Parent patch');
if(git('stash','list','--format=%H %gd %gs')!==original.stashes.trim())throw Error('Stashes');for(const f of original.untracked)if(!fs.existsSync(path.join(root,f)))throw Error('Protected '+f);
const manifests={...prior.manifests,'.logs/d110c-0c1f5b-wide-cpu-ae67fe3f':'e0299cf4a4076f9aebc98d77f5412446f881690898ab751a063691f13423de10','.logs/d110c-0c1f5b-wide-diagnostic-32968861':'8651cc2ff0883b24ecfdf709d99aa29a54ed14d2770d1c6dbd7bee4a75040846','.logs/d110c-0c1f5b-green-wide-budget-48f6877d':'9194385277408758e320263928babd093786d4170a1f1cdfb851b3088d152826','.logs/d110c-0c1f5b-green-71bca5d5':'93a9dec116d7061d341f9d6e3e205a28f609b64122d11a96549019c6a9551b32',[priorDir]:'e8a41ccb8c1129f0ef86d04e1ad59feec0faf07c3b35110c53fb496e534ccdf0','.logs/d110c-0c1f5b-green-replay-budget-1809157e':'68b94317a4062b7ead8100854109dca1df9924373715a7266c4c1a81ffe21e06'};
for(const[dir,h]of Object.entries(manifests)){const m=read(dir+'/manifest.sha256');if(hash(m)!==h)throw Error('Manifest '+dir);for(const line of m.toString().trim().split('\n')){const[,d,f]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);if(hash(read(f.startsWith('.logs/')?f:dir+'/'+f))!==d)throw Error('Evidence '+f)}}
for(const f of git('diff','--name-only').split('\n'))if(!Object.hasOwn(prior.ownerHashes,f)&&!(stage==='final'&&f===target))throw Error('Dirty '+f);
if(stage==='before'&&hash(read(target))!==hash(execFileSync('git',['show',head+':'+target],{cwd:root})))throw Error('Signed target');

write('source-'+stage+'.ts',read(target));
write('custody-'+stage+'.json',JSON.stringify({stage,head,signature:'G',originExact:true,indexEmpty:true,ownerHashes:prior.ownerHashes,built:prior.built,testHashes:tests,patchSha256:hash(patch),manifests,stashCount:27,protectedPaths:original.untracked.length,allProtectedPathsExist:true,trackedStatus:git('status','--short','--untracked-files=no')},null,2)+'\n');
console.log(JSON.stringify({stage,owners:8,built:7,tests:Object.keys(tests).length,stashes:27,protected:original.untracked.length,patchSha256:hash(patch)}));
