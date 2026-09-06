import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const files=walk(out).filter(f=>path.basename(f)!=='manifest.sha256').sort();
const manifest=files.map(f=>hash(fs.readFileSync(f))+'  '+path.relative(out,f)).join('\n')+'\n';
fs.writeFileSync(path.join(out,'manifest.sha256'),manifest,{flag:'wx'});
for(const line of manifest.trim().split('\n')){const[,expected,file]=line.match(/^([a-f0-9]{64})  (.+)$/u);if(hash(fs.readFileSync(path.join(out,file)))!==expected)throw Error('Manifest '+file);}
console.log(JSON.stringify({files:files.length,selfExcluding:true,manifestSha256:hash(manifest),verified:true}));
