import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const initial=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'),'utf8'));
const productionHashes=Object.fromEntries(git('diff','--name-only').split('\n').filter(Boolean).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes,stashCount:git('stash','list','--format=%H').split('\n').length,stashesSha256:hash(git('stash','list','--format=%H %gd %s')),initialProtectedBaselineHash:hash(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'))),status:git('status','--short','--untracked-files=no')};
if(Object.keys(productionHashes).length!==7||data.stashCount!==27)throw Error('Parent dirty paths/stashes differ');
for(const [file,digest]of Object.entries(productionHashes))if(initial.files[file]!==digest)throw Error('Parent production drift: '+file);
if(git('stash','list','--format=%H %gd %s')!==initial.stashes.trim())throw Error('Initial stash drift');
if(stage!=='before'){
 const before=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json'),'utf8'));
 for(const key of ['productionHashes','stashCount','stashesSha256','initialProtectedBaselineHash'])if(JSON.stringify(data[key])!==JSON.stringify(before[key]))throw Error('Custody drift: '+key);
}
fs.writeFileSync(path.join(out,`custody-${stage}.json`),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,parentFiles:7,stashes:27,preserved:true}));
