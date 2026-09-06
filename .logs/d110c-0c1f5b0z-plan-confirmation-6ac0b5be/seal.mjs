import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const read=n=>fs.readFileSync(path.join(out,n),'utf8'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const final=JSON.parse(read('final.txt')),status=JSON.parse(read('runner-status.json'));
if(status.status!==0||status.signal!==null||final.verdict!=='PASS'||final.p0_count||final.p1_count||!final.original_p1_closed||!final.ready_for_red)throw Error('confirmation');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:128*1024*1024}).trimEnd();
const prior=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'),'utf8'));
const source=git('diff','--name-only','--','packages','examples').split('\n').filter(Boolean);
if(source.length!==7||git('diff','--',...source)!==prior.diff||git('stash','list','--format=%H %gd %gs')!==prior.stashes||git('diff','--cached'))throw Error('custody');
const configHash=hash(fs.readFileSync(path.join(root,'vite.config.mts')));
if(configHash!==hash(execFileSync('git',['-C',root,'show','7eb2a8df:vite.config.mts'])))throw Error('coverage config changed');
const commands=[];
for(const [command,args,env] of [
  ['git',['-C',root,'diff','--check'],process.env],
  ['pnpm',['exec','prettier','--check','docs/production-hardening/production-hardening-tdd-plan-v2.md'],{...process.env,NODE_OPTIONS:'--max-old-space-size=12288'}],
]){const r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024});commands.push({command,args,nodeOptions:env.NODE_OPTIONS??null,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});}
const audit={head:git('rev-parse','HEAD'),signature:git('log','--format=%h %G? %s','-1'),final,commands,rootCoverageConfigUnchanged:true,configHash,productionPatchUnchanged:true,stashesUnchanged:true,stashCount:27,newTestRuns:0};
fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
if(commands.some(x=>x.status!==0))throw Error('static gate; preserved');
const lines=fs.readdirSync(out).filter(n=>n!=='manifest.sha256').sort().map(n=>hash(fs.readFileSync(path.join(out,n)))+'  '+n);
fs.writeFileSync(path.join(out,'manifest.sha256'),lines.join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({accepted:true,entries:lines.length,manifest:hash(read('manifest.sha256')),commands:commands.map(x=>({command:x.command,status:x.status}))},null,2));
