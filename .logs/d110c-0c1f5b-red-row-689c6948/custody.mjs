import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const out=path.dirname(new URL(import.meta.url).pathname), root=process.cwd();
const stage=process.argv[2];
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const stopped=path.join(root,'.logs/d110c-0c1f5b-green-f031b166');
const prior=JSON.parse(fs.readFileSync(path.join(stopped,'custody-after.json'),'utf8'));
const patch=execFileSync('git',['diff','--',...prior.changed],{encoding:'utf8'});
if(patch!==fs.readFileSync(path.join(stopped,'partial-production.patch'),'utf8')) throw Error('Partial production differs from immutable stopped patch');
if(git('stash','list','--format=%H %gd %s')!==prior.stashes.trim()) throw Error('Stashes differ');
const test='tests/phase-6b-d110c-0c1f5b-integration-red.test.ts';
const base=execFileSync('git',['show','ac7fb4f1:'+test],{encoding:'utf8'});
const current=fs.readFileSync(test,'utf8');
const begin='\texpect(boundary.row, "F5B_C25_EXACT_DURABLE_ROW_AT_AMBIGUITY").toEqual(committed ? boundary.candidate : null);';
const first='\tconst candidate = boundary.candidate;';
const end='\texpect(boundary.lineage.next, "F5B_C25_ATOMIC_LINEAGE_WITH_ROW_AND_LINK")';
if(base.slice(0,base.indexOf(begin))!==current.slice(0,current.indexOf(first)) || base.slice(base.indexOf(end))!==current.slice(current.indexOf(end))) throw Error('Assertion outside authorized replacement changed');
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionFiles:prior.changed,productionHashes:Object.fromEntries(prior.changed.map(file=>[file,hash(fs.readFileSync(file))])),partialPatchSha256:hash(patch),stashesSha256:hash(prior.stashes),stashCount:27,case25Only:true,testSha256:hash(current),staged:git('diff','--cached','--name-only'),status:git('status','--short','--untracked-files=no'),stoppedManifestSha256:hash(fs.readFileSync(path.join(stopped,'manifest.sha256')))};
if(stage!=='before'){
 const initial=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json'),'utf8'));
 if(JSON.stringify(initial.productionHashes)!==JSON.stringify(data.productionHashes)) throw Error('Production custody changed');
}
fs.writeFileSync(path.join(out,`custody-${stage}.json`),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,head:data.head,case25Only:true,productionPreserved:true,stashCount:27}));
