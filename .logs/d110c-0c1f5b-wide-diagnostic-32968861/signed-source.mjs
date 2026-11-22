import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim(),head=git('rev-parse','HEAD'),file='tests/phase-6b-d110c-0c1f5b-integration-red.test.ts',eq=JSON.parse(fs.readFileSync(path.join(out,'equivalence.json'))),custody=JSON.parse(fs.readFileSync(path.join(out,'custody-after.json')));
if(git('log','-1','--format=%G?')!=='G'||git('rev-parse','HEAD^')!=='32968861f84883ff37179dbf0afff5f235345394'||git('diff-tree','--no-commit-id','--name-only','-r','HEAD')!==file||git('diff','--cached','--name-only')||git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0]!==head)throw Error('Signed source boundary');
if(hash(fs.readFileSync(path.join(root,file)))!==eq.files[0].afterSha256||hash(execFileSync('git',['show',head+':'+file],{cwd:root}))!==eq.files[0].afterSha256)throw Error('Source drift');
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(custody.ownerHashes)],{cwd:root,maxBuffer:128*1024*1024});if(hash(patch)!==custody.patchSha256)throw Error('Production drift');
fs.writeFileSync(path.join(out,'signed-source.json'),JSON.stringify({head,signature:'G',originExact:true,indexEmpty:true,file,sha256:eq.files[0].afterSha256,parentPatchSha256:hash(patch)},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({head,signature:'G',originExact:true,sourceSha256:eq.files[0].afterSha256,parentPatchSha256:hash(patch)}));
