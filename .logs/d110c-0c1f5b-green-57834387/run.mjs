import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
const out = path.dirname(new URL(import.meta.url).pathname);
const git = (...args) => execFileSync('git', args, {encoding:'utf8', maxBuffer:64*1024*1024}).trim();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(out,name), JSON.stringify(value,null,2)+'\n',{flag:'wx'});
if (process.argv[2] === 'custody') {
  write('custody-before.json', {head:git('rev-parse','HEAD'), diff:git('diff'), staged:git('diff','--cached'), stashes:git('stash','list','--format=%H %gd %gs'), files:Object.fromEntries(git('ls-files','-z').split('\0').filter(Boolean).map(file=>[file,hash(fs.readFileSync(file))])), untracked:git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean)});
} else {
  const [name, binary, ...args] = process.argv.slice(2);
  const startedAt = new Date().toISOString();
  const result = spawnSync(binary,args,{encoding:'utf8',maxBuffer:128*1024*1024,env:process.env});
  write(name+'.json',{command:[binary,...args],startedAt,endedAt:new Date().toISOString(),status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr});
  console.log(JSON.stringify({name,status:result.status,stdout:result.stdout?.slice(-4000),stderr:result.stderr?.slice(-4000)}));
  process.exitCode = result.status ?? 1;
}
