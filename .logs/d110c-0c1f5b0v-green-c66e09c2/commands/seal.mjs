import {readFileSync,readdirSync,writeFileSync,mkdirSync,cpSync,copyFileSync,lstatSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const work=dirname(new URL(import.meta.url).pathname),repo=resolve(work,'../..'),root=resolve(repo,'.logs/d110c-0c1f5b0v-green-c66e09c2');
const read=p=>JSON.parse(readFileSync(resolve(work,p),'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const exceptional=new Set(['focused-first','format-initial','lint-initial','source-audit','typechecks','isolated-typechecks','local-retained-10','local-retained-22','isolated-retained-10','isolated-retained-22']);
const commands=[];
for(const d of readdirSync(work,{withFileTypes:true}).filter(d=>d.isDirectory())){
 const status=read(`${d.name}/status.json`),command=read(`${d.name}/command.json`);
 if(status.code!==(exceptional.has(d.name)?1:0)||status.signal!==null||status.spawnError)throw Error(`unexpected command status: ${d.name}`);
 commands.push({label:d.name,command,status});
}
for(const name of exceptional)if(!commands.some(c=>c.label===name))throw Error(`missing expected diagnostic ${name}`);
const tests=[];
for(const label of ['focused-final','isolated-focused','source-governance','isolated-source-governance']){
 const j=read(`${label}/result.json`),focused=label.includes('focused');
 if(!j.success||j.numFailedTests!==0||j.numPassedTests!==(focused?6:4)||j.numPendingTests!==(focused?0:8)||j.numTotalTests!==(focused?6:12)||j.testResults.length!==(focused?2:1))throw Error(`invalid test selection ${label}`);
 tests.push({label,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,total:j.numTotalTests});
}
const baseline=resolve(repo,'.logs/d110c-0c1f5b0u-green-ea02487e/commands');
const failures=j=>j.testResults.flatMap(f=>f.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,failures:a.failureMessages.map(m=>m.split('\n')[0])})));
for(const prefix of ['local-retained','isolated-retained']){
 let passed=0,failed=0,total=0;
 for(let i=9;i<=23;i++){
  const label=`${prefix}-${String(i).padStart(2,'0')}`,j=read(`${label}/result.json`);
  const expected=i===10||i===22?failures(JSON.parse(readFileSync(resolve(baseline,i===22?'retained-22-corrected':'retained-10','result.json')))):[];
  if(j.numPendingTests!==0||j.testResults.length!==1||JSON.stringify(failures(j))!==JSON.stringify(expected))throw Error(`retained result mismatch: ${label}`);
  passed+=j.numPassedTests;failed+=j.numFailedTests;total+=j.numTotalTests;
 }
 if(passed!==104||failed!==19||total!==123)throw Error(`retained totals differ: ${prefix}`);
 tests.push({label:prefix,files:15,passed,failed,total,pending:0,inheritedFailuresOnly:true});
}
for(const label of ['typecheck-equivalence','isolated-typecheck-equivalence'])if(read(`${label}/stdout`).equal!==true)throw Error(label);
for(const label of ['source-audit-corrected','isolated-source-audit'])if(!read(`${label}/stdout`).results.every(r=>r.astEqual&&r.tokenEqual&&r.soleExactComment))throw Error(label);
const before=read('custody-before/stdout'),after=read('custody-final/stdout');
for(const key of ['protected','stashes','otherProtectedExistence'])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))throw Error(`custody ${key}`);
if(after.stashes.count!==27||after.trackedStatus!=='')throw Error('main custody');
const pristine=read('isolated-pristine/stdout'),final=read('isolated-final-custody/stdout');
if(pristine.preexistingArtifacts.length||pristine.overlay||final.overlay||final.trackedStatus!==''||JSON.stringify(pristine.hashes)!==JSON.stringify(final.hashes))throw Error('isolated custody');
const runtime=read('isolated-runtime/stdout').runtime;
for(const [name,value] of Object.entries(runtime.imports))if(!value.path.startsWith(pristine.root+'/')||value.sha256!==after.runtime.imports[name].sha256)throw Error(`isolated import ${name}`);
mkdirSync(root);
mkdirSync(resolve(root,'commands'));
for(const entry of readdirSync(work))if(entry!=='README.md')cpSync(resolve(work,entry),resolve(root,'commands',entry),{recursive:true,errorOnExist:true,force:false});
copyFileSync(resolve(work,'README.md'),resolve(root,'README.md'));
mkdirSync(resolve(root,'baseline'));
copyFileSync(resolve(baseline,'retained-10/result.json'),resolve(root,'baseline/retained-10.json'));
copyFileSync(resolve(baseline,'retained-22-corrected/result.json'),resolve(root,'baseline/retained-22.json'));
copyFileSync(resolve(baseline,'typechecks/stdout'),resolve(root,'baseline/typechecks.stdout'));
writeFileSync(resolve(root,'validation.json'),JSON.stringify({green:final.head,tree:final.tree,tests,commands,protectedPreserved:true,stashCount:27,sourceCommentsOnly:true,isolated:final,runtime,reviewersInvoked:false,remainingReview:'parent-owned final confirmation',validation:'PASS_WITH_EXACT_INHERITED_RETAINED_AND_TYPECHECK_DEBT'},null,2)+'\n',{flag:'wx'});
const files=(dir,prefix='')=>readdirSync(dir).sort().flatMap(name=>{const full=resolve(dir,name),p=prefix+name;if(lstatSync(full).isSymbolicLink())throw Error(`symlink ${p}`);return lstatSync(full).isDirectory()?files(full,p+'/'):[p]});
const entries=files(root);
writeFileSync(resolve(root,'manifest.sha256'),entries.map(p=>`${hash(resolve(root,p))}  ${p}\n`).join(''),{flag:'wx'});
const actual=files(root).filter(p=>p!=='manifest.sha256');
if(JSON.stringify(actual)!==JSON.stringify(entries))throw Error('manifest census');
for(const line of readFileSync(resolve(root,'manifest.sha256'),'utf8').trim().split('\n')){const match=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!match||hash(resolve(root,match[2]))!==match[1])throw Error('manifest hash');}
console.log(JSON.stringify({root,files:entries.length+1,manifestEntries:entries.length,manifestSha256:hash(resolve(root,'manifest.sha256')),tests},null,2));
