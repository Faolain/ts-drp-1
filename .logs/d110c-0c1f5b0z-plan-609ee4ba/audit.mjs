import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const plan = 'docs/production-hardening/production-hardening-tdd-plan-v2.md';
const git = (...args) => execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:128*1024*1024}).trimEnd();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prior = JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'),'utf8'));
const paths = git('diff','--name-only','--','packages','examples').split('\n').filter(Boolean);
if (paths.length !== 7 || git('diff','--',...paths) !== prior.diff || git('stash','list','--format=%H %gd %gs') !== prior.stashes || git('diff','--cached')) throw Error('custody');
const commands = [];
for (const [command,args,env] of [
  ['git',['-C',root,'diff','--check'],process.env],
  ['pnpm',['exec','prettier','--check',plan,path.relative(root,path.join(out,'design.md'))],{...process.env,NODE_OPTIONS:'--max-old-space-size=12288'}],
]) {
  const start = new Date().toISOString();
  const result = spawnSync(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024});
  commands.push({command,args,nodeOptions:env.NODE_OPTIONS??null,start,finish:new Date().toISOString(),status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr});
}
const sourcePaths = ['packages/storage/src/maintenance.ts','packages/storage-browser/src/internal/ahe-reclamation.ts','packages/storage-node/src/internal/ahe-reclamation.ts','packages/issuance-store/src/maintenance.ts','packages/storage/src/types.ts','packages/storage/package.json','packages/storage-browser/package.json','packages/storage-node/package.json'];
const sourceHashes = Object.fromEntries(sourcePaths.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
const audit = {head:git('rev-parse','HEAD'),signature:git('log','--format=%h %G? %s','-1'),branch:git('branch','--show-current'),productionPatchUnchanged:true,productionPaths:paths,stashesUnchanged:true,stashCount:prior.stashes.split('\n').length,untrackedNamesHash:hash(git('ls-files','--others','--exclude-standard','-z')),sourceHashes,planHash:hash(fs.readFileSync(path.join(root,plan))),commands,newProductionEdits:0,newTestRuns:0};
fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
if(commands.some(command=>command.status!==0))throw Error('static failure; evidence preserved');
const entries=fs.readdirSync(out).filter(name=>name!=='manifest.sha256').sort().map(name=>hash(fs.readFileSync(path.join(out,name)))+'  '+name);
fs.writeFileSync(path.join(out,'manifest.sha256'),entries.join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({head:audit.head,commands:commands.map(x=>({command:x.command,status:x.status})),entries:entries.length,manifest:hash(fs.readFileSync(path.join(out,'manifest.sha256')))},null,2));
