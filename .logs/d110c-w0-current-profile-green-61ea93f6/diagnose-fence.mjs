import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
const out=path.dirname(new URL(import.meta.url).pathname),read=f=>JSON.parse(fs.readFileSync(path.join(out,f))),start=Date.parse(read('focused/execution-start.json').startedAt),end=Date.parse(read('focused/status.json').endedAt);
const directories=fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('drp-d108b-replay-')).map(n=>path.join(os.tmpdir(),n)).filter(f=>{const s=fs.statSync(f);return s.birthtimeMs>=start-1000&&s.birthtimeMs<=end+1000;});
const result=[];for(const directory of directories){const files=fs.readdirSync(directory).filter(f=>f.includes('journal')&&f.endsWith('.sqlite'));for(const file of files){const database=path.join(directory,file),db=new DatabaseSync(database,{readOnly:true});try{const tables=db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();result.push({database,tables});}finally{db.close();}}}
fs.writeFileSync(path.join(out,'diagnose-fence-schema.json'),JSON.stringify({start,end,directories,result},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({start,end,directories,result},null,2));
