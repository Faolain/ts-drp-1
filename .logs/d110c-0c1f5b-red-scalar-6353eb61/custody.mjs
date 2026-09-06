import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const read=file=>fs.readFileSync(path.join(root,file));
const baseline=JSON.parse(read('.logs/d110c-0c1f5b-green-57834387/custody-before.json'));
const stopped=JSON.parse(read('.logs/d110c-0c1f5b-green-d8cdb620/custody-stopped.json'));
for(const [file,digest] of Object.entries(stopped.ownerHashes)) if(hash(read(file))!==digest) throw Error('Production drift: '+file);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(stopped.ownerHashes)],{cwd:root});
if(!patch.equals(read('.logs/d110c-0c1f5b-green-d8cdb620/partial-production.patch')))throw Error('Stopped patch drift');
if(git('stash','list','--format=%H %gd %s')!==baseline.stashes.trim()) throw Error('Stash drift');
for(const file of baseline.untracked) if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
const immutable=[];
for(const name of ['d110c-0c1f5b0r-design-3a156aca','d110c-0c1f5b-green-d8cdb620','d110c-0c1f5b-red-observer-78e068a8']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}
const file='tests/phase-6b-d110c-0c1f5b-integration-red.test.ts',base=execFileSync('git',['show','5fc992bc41dd1d6430f99f887801dbbd7d4c6608:'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
const source=text=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const before=source(base),after=source(current);
if(after.parseDiagnostics.length)throw Error('Syntax diagnostics');
const find=s=>s.statements.find(row=>ts.isFunctionDeclaration(row)&&row.name.text==='ambiguousPlanIssue');
const oldFunction=find(before),newFunction=find(after);
if(base.slice(0,oldFunction.pos)!==current.slice(0,newFunction.pos)||base.slice(oldFunction.end)!==current.slice(newFunction.end))throw Error('Bytes outside ambiguousPlanIssue changed');
const protectedFunctions=before.statements.filter(ts.isFunctionDeclaration).filter(row=>row.name.text!=='ambiguousPlanIssue').map(row=>({name:row.name.text,sha256:hash(row.getText(before))}));
const tokens=text=>new Set(text.match(/F5B_[A-Z0-9_]+/gu));
const oldTokens=tokens(oldFunction.getText(before)),newTokens=tokens(newFunction.getText(after));
const removedTokens=[...oldTokens].filter(t=>!newTokens.has(t)),addedTokens=[...newTokens].filter(t=>!oldTokens.has(t));
if(JSON.stringify(removedTokens)!==JSON.stringify(['F5B_C25_EXACT_UNCOMMITTED_REPLACEMENT_PROGRESS']))throw Error('Meaningful token lost');
if(newFunction.getText(after).includes('required(priorEntry.replacementProgress)'))throw Error('Stale scalar progress');
const retainedHashes={};
for(const [name,digest]of Object.entries(stopped.testHashes)) if(name!==file){if(hash(read(name))!==digest)throw Error('Retained tests drift');retainedHashes[name]=digest;}
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,protectedFunctions,retainedHashes,syntaxDiagnostics:0,allOutsideFunctionBytesPreserved:true,removedTokens,addedTokens,immutable,testSha256:hash(read(file)),trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,protectedFunctions:protectedFunctions.length,removedTokens,addedTokens}));
