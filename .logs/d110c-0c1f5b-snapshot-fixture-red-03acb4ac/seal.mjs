import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(out,f)),json=f=>JSON.parse(read(f)),write=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const expectedNonzero={format:1,lint:1,typecheck:1,readiness:1,focused:1,'validate-runtime':1},statuses={};
for(const entry of fs.readdirSync(out,{withFileTypes:true})){if(!entry.isDirectory())continue;const f=entry.name+'/status.json';assert.ok(fs.existsSync(path.join(out,f)),f);statuses[entry.name]=json(f);assert.equal(statuses[entry.name].code,expectedNonzero[entry.name]??0,entry.name);assert.equal(statuses[entry.name].signal,null,entry.name);}
for(const label of ['authored-check','custody-after','signed-source','validate-runtime-corrected','readiness-corrected','source-freeze','typecheck-matrix','tests-staged-check','tests-push'])assert.ok(statuses[label],label);
const source=json('source-freeze.json'),signed=json('signed-source.json'),custody=json('custody-after.json'),result=json('result.json'),program=json('program-identity.json');
assert.equal(custody.head,signed.head);assert.equal(custody.supplementalTestHash,source.sha256);assert.equal(hash(fs.readFileSync(path.join(root,source.file))),source.sha256);
for(const s of program.sources)assert.equal(hash(fs.readFileSync(s.file)),s.sha256,s.file);
const runtime=json('focused/command.json');assert.deepEqual([runtime.command,...runtime.args],source.command);assert.equal(runtime.cwd,root);
assert.equal(result.failed,1);assert.equal(result.controls.precedingAssertionsPassed,15);assert.equal(result.rawSha256,hash(read('focused.json')));
const inventory={statuses,expectedNonzero,compilerFailureDistinctFromMatrixPass:true,oneRuntimeExecution:true};write('command-status-inventory.json',inventory);
const whitespace=[];
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.relative(out,path.join(dir,e.name))]).sort();}
for(const f of walk(out)){const text=read(f).toString();text.split('\n').forEach((line,i)=>{if(/[ \t]+$/u.test(line))whitespace.push({file:f,line:i+1,rawOutput:f.endsWith('.log')});});}
assert.ok(whitespace.every(row=>row.rawOutput),'Unexpected authored whitespace');write('raw-whitespace.json',{authoredWhitespacePassed:true,rawOutputPreserved:true,exceptions:whitespace});
write('seal-summary.json',{testCommit:signed.head,testSha256:source.sha256,runtime:{total:1,passed:0,failed:1,skipped:0,token:result.token},compiler:{status:1,inherited:3,target:0,matrixStatus:0},custody:{production:8,built:7,retained:85,supplementalNewTest:1,stashes:27,protected:86522},rawSha256:result.rawSha256,authoredChecks:0,rawWhitespaceExceptions:whitespace.length,rootAcceptancePending:true});
const files=walk(out);assert.ok(!files.includes('manifest.sha256'));const manifest=files.map(f=>hash(read(f))+'  '+f).join('\n')+'\n';fs.writeFileSync(path.join(out,'manifest.sha256'),manifest,{flag:'wx'});
for(const line of manifest.trimEnd().split('\n')){const[,h,f]=line.match(/^([a-f0-9]{64})  (.+)$/u);assert.equal(hash(read(f)),h,f);}
console.log(JSON.stringify({entries:files.length,manifestSha256:hash(manifest),rawSha256:result.rawSha256,rawWhitespace:whitespace}));
