import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1';
const cwd='/private/tmp/d110c-f5b0z-review-Kg6cuq/checkout';
const out=path.dirname(new URL(import.meta.url).pathname);
const promptFile=path.join(out,'prompt.md');
const prompt=fs.readFileSync(promptFile,'utf8');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const git=(...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:16*1024*1024}).trim();
if(git('rev-parse','HEAD')!=='7eb2a8dfcec8af9a533b3308b6d1f060f52a90b4'||git('status','--porcelain=v1'))throw Error('review checkout custody');
write(path.join(out,'custody.json'),{cwd,head:git('rev-parse','HEAD'),signature:git('log','--format=%h %G? %s','-1'),trackedStatus:git('status','--porcelain=v1'),main:root,partialParentOverlay:false});
const run=(name,command,args,stdin)=>new Promise(resolve=>{
  const dir=path.join(out,name);fs.mkdirSync(dir);
  const stdout=fs.openSync(path.join(dir,'events.jsonl'),'wx');
  const stderr=fs.openSync(path.join(dir,'stderr.log'),'wx');
  const start=new Date().toISOString();
  const child=spawn(command,args,{cwd,stdio:[stdin===undefined?'ignore':'pipe',stdout,stderr]});
  write(path.join(dir,'launch.json'),{command,args,cwd,start,pid:child.pid});
  console.log(JSON.stringify({name,pid:child.pid,start}));
  if(stdin!==undefined)child.stdin.end(stdin);
  child.on('error',error=>write(path.join(dir,'spawn-error.json'),{message:error.message}));
  child.on('close',(status,signal)=>{fs.closeSync(stdout);fs.closeSync(stderr);write(path.join(dir,'runner-status.json'),{status,signal,start,finish:new Date().toISOString()});console.log(JSON.stringify({name,status,signal}));resolve();});
});
await Promise.all([
  run('sol','codex',['exec','--ignore-user-config','--sandbox','read-only','--model','gpt-5.6-sol','-c','model_reasoning_effort="high"','-c','features.multi_agent=false','--json','--output-last-message',path.join(out,'sol','final.txt'),prompt]),
  run('grok-runner','python3',['/Users/aristotle/.codex/skills/grok/scripts/run_grok.py','--mode','review','--cwd',cwd,'--prompt-file',promptFile,'--output-dir',path.join(out,'grok'),'--model','grok-4.6','--reasoning-effort','high','--max-turns','40','--timeout-seconds','1800']),
  run('fable','zsh',['-f','-c',"alias claude-phel='CLAUDE_CONFIG_DIR=/Users/aristotle/.claude-phel claude'\neval 'claude-phel -p --restricted --strict-mcp-config --tools Read,Glob,Grep --model \"claude-fable-5-1[1m]\" --effort xhigh --output-format stream-json --verbose'"],prompt),
]);
console.log(JSON.stringify({complete:true}));
