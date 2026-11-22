import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync, execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1';
const out=path.dirname(new URL(import.meta.url).pathname);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:128*1024*1024}).trim();
const write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const prior=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-d8cdb620/custody-stopped.json')));
const owners=Object.keys(prior.ownerHashes);
const accepted=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-red-scalar-6353eb61/matrix.json')));
if(process.argv[2]==='custody'){
 const stage=process.argv[3];
 const old=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json')));
 for(const file of old.untracked)if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
 if(git('stash','list','--format=%H %gd %gs')!==old.stashes.trim())throw Error('Stash drift');
 const manifests={};
 for(const relative of ['.logs/d110c-0c1f5b0r-design-3a156aca','.logs/d110c-0c1f5b-red-observer-78e068a8','.logs/d110c-0c1f5b-red-scalar-6353eb61','.logs/d110c-0c1f5b-green-d8cdb620']){
  const bytes=fs.readFileSync(path.join(root,relative,'manifest.sha256'));
  for(const line of bytes.toString().trim().split('\n')){
   const match=/^([a-f0-9]{64})\s+(.+)$/u.exec(line);
   const file=match[2].startsWith('.logs/')?path.join(root,match[2]):path.join(root,relative,match[2]);
   if(hash(fs.readFileSync(file))!==match[1])throw Error('Manifest drift: '+file);
  }
  manifests[relative]=hash(bytes);
 }
 for(const [file,digest]of Object.entries(accepted.fileHashes))if(hash(fs.readFileSync(path.join(root,file)))!==digest)throw Error('Test drift: '+file);
 const ownerHashes=Object.fromEntries(owners.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
 const patch=execFileSync('git',['-C',root,'diff','--binary','--full-index','--',...owners],{maxBuffer:128*1024*1024});
 if(stage==='before'){
  if(hash(patch)!=='2b0a99efc83ceb91f2d7cc39b0b5f74eaab2fa97aa01ee7248bbba54ab88a20a')throw Error('Prior patch drift');
  for(const file of owners)if(ownerHashes[file]!==prior.ownerHashes[file])throw Error('Prior owner drift');
  fs.writeFileSync(path.join(out,'inherited-production.patch'),patch,{flag:'wx'});
 }
 write('custody-'+stage+'.json',{head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),ownerHashes,patchSha256:hash(patch),status:git('status','--short','--untracked-files=no'),stashes:old.stashes,protectedPaths:old.untracked.length,manifests,testHashes:accepted.fileHashes});
 console.log(JSON.stringify({stage,protectedPaths:old.untracked.length,stashes:27,manifests}));
}else{
 const [name,cwd,binary,...args]=process.argv.slice(2);
 const dir=path.join(out,name);fs.mkdirSync(dir);
 write(name+'/command.json',{cwd,command:[binary,...args],startedAt:new Date().toISOString(),head:git('rev-parse','HEAD'),ownerHashes:Object.fromEntries(owners.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))});
 const stdout=fs.openSync(path.join(dir,'stdout'),'wx'),stderr=fs.openSync(path.join(dir,'stderr'),'wx');
 const result=spawnSync(binary,args,{cwd,env:process.env,stdio:['ignore',stdout,stderr]});
 fs.closeSync(stdout);fs.closeSync(stderr);
 write(name+'/status.json',{status:result.status,signal:result.signal,error:result.error?.message,endedAt:new Date().toISOString()});
 console.log(JSON.stringify({name,status:result.status,signal:result.signal}));process.exitCode=result.status??1;
}
