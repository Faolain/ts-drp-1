import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const plan='docs/production-hardening/production-hardening-tdd-plan-v2.md';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8',maxBuffer:128*1024*1024}).trimEnd();
const prior=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'),'utf8'));
const source=git('diff','--name-only','--','packages','examples').split('\n').filter(Boolean);
if(source.length!==7||git('diff','--',...source)!==prior.diff||git('stash','list','--format=%H %gd %gs')!==prior.stashes||git('diff','--cached'))throw Error('custody');
const commands=[];
for(const [command,args,env] of [
  ['pnpm',['exec','vitest','--help','--coverage'],process.env],
  ['git',['-C',root,'diff','--check'],process.env],
  ['pnpm',['exec','prettier','--check',plan,path.relative(root,path.join(out,'amendment.md'))],{...process.env,NODE_OPTIONS:'--max-old-space-size=12288'}],
]){
  const start=new Date().toISOString(),r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024});
  commands.push({command,args,nodeOptions:env.NODE_OPTIONS??null,start,finish:new Date().toISOString(),status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});
}
const supported=commands[0].stdout.includes('--coverage.enabled');
const audit={head:git('rev-parse','HEAD'),signature:git('log','--format=%h %G? %s','-1'),coverageFlagSupported:supported,productionPatchUnchanged:true,stashCount:prior.stashes.split('\n').length,commands,planHash:hash(fs.readFileSync(path.join(root,plan))),newTestRuns:0};
fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
if(!supported||commands.some(x=>x.status!==0))throw Error('static failure; preserved');
const lines=fs.readdirSync(out).filter(n=>n!=='manifest.sha256').sort().map(n=>hash(fs.readFileSync(path.join(out,n)))+'  '+n);
fs.writeFileSync(path.join(out,'manifest.sha256'),lines.join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({head:audit.head,coverageFlagSupported:supported,commands:commands.map(x=>({command:x.command,status:x.status})),manifest:hash(fs.readFileSync(path.join(out,'manifest.sha256')))},null,2));
