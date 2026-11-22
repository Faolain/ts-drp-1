import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync, execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1';
const out=path.dirname(new URL(import.meta.url).pathname);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:128*1024*1024}).trim();
const write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const owners=['examples/v3-room/src/index.ts','packages/node/src/creator-adoption.ts','packages/node/src/creator-close.ts','packages/node/src/internal/creator-transition-advance.ts','packages/node/src/v3-live.ts','packages/protocol-v3/src/creator-checkpoint.ts','packages/protocol-v3/src/creator-close.ts','packages/node/src/internal/closed-epoch-cleanup.ts'];
if(process.argv[2]==='custody'){
 const stage=process.argv[3];
 const old=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json')));
 for(const file of old.untracked)if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
 if(git('stash','list','--format=%H %gd %gs')!==old.stashes.trim())throw Error('Stash drift');
 const manifests={};
 for(const relative of ['.logs/d110c-0c1f5b0r-design-3a156aca','.logs/d110c-0c1f5b-red-observer-78e068a8']){
  const bytes=fs.readFileSync(path.join(root,relative,'manifest.sha256'));
  for(const line of bytes.toString().trim().split('\n')){
   const match=/^([a-f0-9]{64})\s+(.+)$/u.exec(line);
   const file=match[2].startsWith('.logs/')?path.join(root,match[2]):path.join(root,relative,match[2]);
   if(hash(fs.readFileSync(file))!==match[1])throw Error('Manifest drift: '+file);
  }
  manifests[relative]=hash(bytes);
 }
 const matrix=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-red-observer-78e068a8/matrix.json')));
 for(const [file,digest]of Object.entries(matrix.fileHashes))if(hash(fs.readFileSync(path.join(root,file)))!==digest)throw Error('Test drift: '+file);
 write('custody-'+stage+'.json',{head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),ownerHashes:Object.fromEntries(owners.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])),diff:git('diff','--',...owners),status:git('status','--short','--untracked-files=no'),stashes:old.stashes,protectedPaths:old.untracked.length,manifests,testHashes:matrix.fileHashes});
 console.log(JSON.stringify({stage,protectedPaths:old.untracked.length,stashes:27,manifests}));
}else{
 const [name,cwd,binary,...args]=process.argv.slice(2);
 const dir=path.join(out,name); fs.mkdirSync(dir);
 write(name+'/command.json',{cwd,command:[binary,...args],startedAt:new Date().toISOString(),head:git('rev-parse','HEAD'),ownerHashes:Object.fromEntries(owners.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))});
 const stdout=fs.openSync(path.join(dir,'stdout'),'wx'),stderr=fs.openSync(path.join(dir,'stderr'),'wx');
 const result=spawnSync(binary,args,{cwd,env:process.env,stdio:['ignore',stdout,stderr]});
 fs.closeSync(stdout);fs.closeSync(stderr);
 write(name+'/status.json',{status:result.status,signal:result.signal,error:result.error?.message,endedAt:new Date().toISOString()});
 console.log(JSON.stringify({name,status:result.status,signal:result.signal}));
 process.exitCode=result.status??1;
}
