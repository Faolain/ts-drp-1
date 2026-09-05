import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const read=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(fs.existsSync(path.join(out,'manifest.sha256')))throw Error('Already sealed');
const tests='6353eb617bc889365c6ab62494a18311d2ea5338';
if(git('rev-parse','HEAD')!==tests||git('log','-1','--format=%G?')!=='G')throw Error('Wrong HEAD');
if(git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s+/u)[0]!==tests)throw Error('Tests not pushed');
const result=read('result.json'),matrix=read('matrix.json');
if(result.classification!=='ACCEPTED_CAUSAL_SCALAR_RED'||result.executionCount!==1||result.violations.length||result.failed!==23||result.passed!==5||result.intentionallyFiltered!==17)throw Error('Unexpected matrix');
const expected=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-red-observer-78e068a8/matrix.json'),'utf8'));
if(JSON.stringify(matrix.entries)!==JSON.stringify(expected.entries))throw Error('Inherited matrix changed');
if(result.total!==45||matrix.selected!==28||matrix.entries.filter(row=>row.name.includes('snapshot oracle')).length!==2)throw Error('Oracle/total count differs');
if(read('typecheck.json').targetDiagnostics.length)throw Error('Target typecheck failed');
for(const label of ['main-lint','main-format','isolated-clone','isolated-sparse','isolated-checkout','isolated-pristine','isolated-install','isolated-build','isolated-preflight','tests-diff-check']){
 if(read(`${label}/status.json`).code!==0)throw Error('Gate failed: '+label);
}
for(const [file,value]of Object.entries(matrix.fileHashes))if(hash(fs.readFileSync(path.join(root,file)))!==value)throw Error('Test/helper changed');
const initial=read('custody-before.json'),final=read('custody-after.json');
if(JSON.stringify(initial.productionHashes)!==JSON.stringify(final.productionHashes)||final.stashCount!==27)throw Error('Main custody failed');
const isolatedBefore=read('isolation-before.json'),isolatedAfter=read('isolation-after.json');
if(JSON.stringify(isolatedBefore.sourceHashes)!==JSON.stringify(isolatedAfter.sourceHashes)||JSON.stringify(isolatedBefore.runtimes)!==JSON.stringify(isolatedAfter.runtimes)||isolatedAfter.trackedStatus!=='')throw Error('Isolation custody failed');
if(final.protectedPaths!==86522 || !final.allProtectedPathsExist || !final.allOutsideFunctionBytesPreserved || final.syntaxDiagnostics!==0)throw Error('Protected scope violation');
const command=read('focused-command.json');
if(JSON.stringify(command.command)!==JSON.stringify(read('execution-start.json').command))throw Error('Frozen command drift');
const immutable=[];
for(const name of ['d110c-0c1f5b-green-57834387','d110c-0c1f5b-green-d8cdb620','d110c-0c1f5b-red-observer-78e068a8','d110c-0c1f5b0r-design-3a156aca']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const match=/^([a-f0-9]{64})\s+(.+)$/.exec(line);
  if(!match||hash(fs.readFileSync(path.join(directory,match[2])))!==match[1])throw Error('Immutable evidence differs: '+name);
 }
 immutable.push({name,manifestSha256:hash(manifest),entries:manifest.trim().split('\n').length});
}
fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify({tests,signature:'G',pushed:true,classification:result.classification,executionCount:1,exactInheritedMatrix:true,protectedFunctions:final.protectedFunctions,allOutsideFunctionBytesPreserved:final.allOutsideFunctionBytesPreserved,syntaxDiagnostics:final.syntaxDiagnostics,removedTokens:final.removedTokens,addedTokens:final.addedTokens,protectedPaths:final.protectedPaths,allProtectedPathsExist:final.allProtectedPathsExist,retainedHashes:final.retainedHashes,productionPreserved:true,isolatedSourceAndRuntimePreserved:true,stashCount:27,immutable},null,2)+'\n',{flag:'wx'});
const files=[];
function walk(directory){for(const row of fs.readdirSync(directory,{withFileTypes:true})){const full=path.join(directory,row.name);if(row.isDirectory())walk(full);else if(row.isFile())files.push(path.relative(out,full));else throw Error('Unexpected evidence link');}}
walk(out);files.sort();
const manifest=files.map(file=>`${hash(fs.readFileSync(path.join(out,file)))}  ${file}`).join('\n')+'\n';
fs.writeFileSync(path.join(out,'manifest.sha256'),manifest,{flag:'wx'});
console.log(JSON.stringify({entries:files.length,manifestSha256:hash(manifest),classification:result.classification}));
