import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const initial=JSON.parse(fs.readFileSync('.logs/d110c-0c1f5b-red-row-689c6948/custody-before.json','utf8'));
for(const [file,digest]of Object.entries(initial.productionHashes))if(hash(fs.readFileSync(file))!==digest)throw Error('Production drift: '+file);
const stopped=JSON.parse(fs.readFileSync('.logs/d110c-0c1f5b-green-f031b166/custody-after.json','utf8'));
if(git('stash','list','--format=%H %gd %s')!==stopped.stashes.trim())throw Error('Stash drift');
const files=['tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts'];
const base=file=>execFileSync('git',['show',`43141513:${file}`],{encoding:'utf8'});
const parse=(file,text)=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function functions(file,text){const source=parse(file,text);return new Map(source.statements.filter(ts.isFunctionDeclaration).map(row=>[row.name.text,row.getText(source)]));}
const permitted=new Set(['assertRetainedRollbackPair','sixtyFourWriterGoldenPath']);
const protectedFunctions=[];
for(const file of files){
 const before=functions(file,base(file)),after=functions(file,fs.readFileSync(file,'utf8'));
 for(const [name,text]of before)if(!permitted.has(name)){
  const actual=after.get(name);
  const expected=name==='positiveAuthenticatedPruning' ? text.replace('assertRetainedRollbackPair(peer, epoch + 1)', 'assertRetainedRollbackPair(peer)').replace('// First adoption has only one rollback parent; second establishes\n\t\t\t\t// the full window but has no older prefix outside that window.', '// Physical rollback custody is already complete; no authenticated\n\t\t\t\t// older issuance prefix is deletable at these logical boundaries.') : text;
  if(actual!==expected)throw Error('Unrelated function changed: '+name);
  protectedFunctions.push({file,name,sha256:hash(text)});
 }
}
const file=files[0],old=base(file),current=fs.readFileSync(file,'utf8');
const tail='\texpect(contributions, "F5B_64_EXACT_256_CURRENT_EPOCH_APPLICATION_ISSUES")';
const end='async function positiveAuthenticatedPruning()';
if(old.slice(old.indexOf(tail),old.indexOf(end))!==current.slice(current.indexOf(tail),current.indexOf(end)))throw Error('Open epoch3 final accounting/reopen altered');
const knownAuthoringDiagnostics={initialLint:{status:1,errors:['sort-imports SnapshotOracleVertex member order'],warnings:['five missing helper JSDoc param/returns tags']},initialCustody:{status:1,error:'Unrelated function changed: positiveAuthenticatedPruning',correction:'Recognize only the authorized rollback-helper argument removal and corrected physical-generation comment; all pruning assertions must remain exact.'},disposition:'Corrected before commit/freeze; no runtime consumed.'};
fs.writeFileSync(path.join(out,`custody-${stage}.json`),JSON.stringify({stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:initial.productionHashes,productionPreserved:true,stashesSha256:hash(stopped.stashes),stashCount:27,protectedFunctions,openEpoch3TailUnchanged:true,knownAuthoringDiagnostics,status:git('status','--short','--untracked-files=no')},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedFunctions:protectedFunctions.length,openEpoch3TailUnchanged:true}));
