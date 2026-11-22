import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const out=path.dirname(new URL(import.meta.url).pathname);
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024}).trim();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const before=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json'),'utf8'));
const changed=Object.entries(before.files).filter(([file,sha])=>hash(fs.readFileSync(file))!==sha).map(([file])=>file);
const expected=['examples/v3-room/src/index.ts','packages/node/src/creator-adoption.ts','packages/node/src/creator-close.ts','packages/node/src/internal/creator-transition-advance.ts','packages/node/src/v3-live.ts','packages/protocol-v3/src/creator-checkpoint.ts','packages/protocol-v3/src/creator-close.ts'];
if(JSON.stringify(changed)!==JSON.stringify(expected))throw Error('unexpected changed tracked paths');
if(git('rev-parse','HEAD')!==before.head||git('stash','list','--format=%H %gd %gs')!==before.stashes||git('diff','--cached')!=='')throw Error('custody drift');
const manifests=['.logs/d110c-0c1f5b0r-design-3a156aca','.logs/d110c-0c1f5b-red-cecde972','.logs/d110c-0c1f5b-red-review-b7751f72','.logs/d110c-0c1f5b-red-corrective-accepted-c1d04d31','.logs/d110c-0c1f5b0w-final-review-ad38e6c4'].map(dir=>{
  const bytes=fs.readFileSync(path.join(dir,'manifest.sha256'));
  for(const line of bytes.toString().trim().split('\n')){const [,sha,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/);if(hash(fs.readFileSync(path.join(dir,file)))!==sha)throw Error('manifest drift '+dir);}
  return {dir,sha256:hash(bytes),valid:true};
});
const untracked=git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean);
const missing=before.untracked.filter(file=>!fs.existsSync(file));
if(missing.length)throw Error('protected untracked path missing');
fs.writeFileSync(path.join(out,'partial-production.patch'),execFileSync('git',['diff','--binary'],{maxBuffer:16*1024*1024}),{flag:'wx'});
fs.writeFileSync(path.join(out,'custody-after.json'),JSON.stringify({head:before.head,stashesUnchanged:true,stashCount:before.stashes.split('\n').length,trackedChanges:changed,unchangedTrackedCount:Object.keys(before.files).length-changed.length,sourceHashes:Object.fromEntries(changed.map(file=>[file,hash(fs.readFileSync(file))])),allPriorUntrackedPathsPresent:missing.length===0,untrackedCount:untracked.length,manifests},null,2)+'\n',{flag:'wx'});
const entries=fs.readdirSync(out).filter(file=>file!=='manifest.sha256').sort();
fs.writeFileSync(path.join(out,'manifest.sha256'),entries.map(file=>hash(fs.readFileSync(path.join(out,file)))+'  '+file).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({entries:entries.length,manifestSha256:hash(fs.readFileSync(path.join(out,'manifest.sha256'))),changed}));
