import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),[label,command,...args]=process.argv.slice(2),dir=path.join(out,label);
fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'command.json'),JSON.stringify({cwd:root,command:[command,...args],startedAt:new Date().toISOString(),recorderPid:process.pid},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({label,recorderPid:process.pid}));
const stdout=fs.openSync(path.join(dir,'stdout.log'),'wx'),stderr=fs.openSync(path.join(dir,'stderr.log'),'wx'),r=spawnSync(command,args,{cwd:root,env:process.env,stdio:['ignore',stdout,stderr]});fs.closeSync(stdout);fs.closeSync(stderr);
fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message,endedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({label,status:r.status,signal:r.signal}));process.exitCode=r.status??1;
