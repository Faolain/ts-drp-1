import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),json=f=>JSON.parse(fs.readFileSync(path.join(out,f)));
if(fs.existsSync(path.join(out,'manifest.sha256')))throw Error('Already sealed');
for(const prefix of ['main-78/','isolated/']){const v=json(prefix+'validation.json'),s=json(prefix+'status.json');if(!v.valid||!v.exactNames||!v.exactFiles||!v.observationsValid||v.total!==78||v.passed!==78||v.failed!==0||v.skipped!==0||s.status!==0)throw Error('Runtime validation');}
if(json('isolated/custody-after/status.json').code!==0||json('final-custody-corrected/status.json').status!==0)throw Error('Final custody missing');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const statuses=walk(out).filter(f=>path.basename(f)==='status.json').sort().map(f=>({file:path.relative(out,f),...JSON.parse(fs.readFileSync(f))}));
fs.writeFileSync(path.join(out,'command-status-inventory.json'),JSON.stringify(statuses,null,2)+'\n',{flag:'wx'});
const files=walk(out).filter(f=>path.basename(f)!=='manifest.sha256').sort(),lines=files.map(f=>hash(fs.readFileSync(f))+'  '+path.relative(out,f));
fs.writeFileSync(path.join(out,'manifest.sha256'),lines.join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({entries:files.length,manifestSha256:hash(fs.readFileSync(path.join(out,'manifest.sha256'))),commands:statuses.length,nonzero:statuses.filter(s=>(s.status??s.code)!==0).map(s=>({file:s.file,status:s.status??s.code})),custody:'custody-final.json'}));
