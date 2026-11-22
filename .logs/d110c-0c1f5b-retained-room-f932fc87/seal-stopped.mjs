import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname);
const read=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(fs.existsSync(path.join(out,'manifest.sha256')))throw Error('Already sealed');
if(git('rev-parse','HEAD')!=='f932fc87cab77e22b2d3994b8af288e9e491547a'||git('log','-1','--format=%G?')!=='G'||git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s+/u)[0]!=='f932fc87cab77e22b2d3994b8af288e9e491547a')throw Error('Signed pushed tests identity differs');
const result=read('result.json'),matrix=read('matrix.json'),before=read('custody-before.json'),after=read('custody-after.json'),ib=read('isolation-before.json'),ia=read('isolation-after.json');
if(result.classification!=='UNEXPECTED_MATRIX_STOP_NO_RERUN'||result.total!==20||result.passed!==2||result.failed!==18||result.intentionallyFiltered!==0||result.executionCount!==1||result.runnerStatus!==1||result.topLevel.length)throw Error('Stopped result differs');
for(const label of ['main-lint','main-format','tests-diff-check','isolated-clone','isolated-sparse','isolated-checkout','isolated-pristine','isolated-install','isolated-build','inherited-type-attribution','matrix-freeze','final-evidence-script-syntax','mock-identity-attribution','stopped-source-excerpts','stop-evidence-script-syntax','evidence-script-syntax'])if(read(label+'/status.json').code!==0)throw Error('Static/source gate failed '+label);
if(read('isolated-preflight/status.json').code!==1||!read('typecheck-inherited-attribution.json').identical||read('typecheck-inherited-attribution.json').editedSpanDiagnostics.length||read('typecheck.json').targetDiagnostics.length!==3||read('typecheck.json').externalDiagnostics.length!==1)throw Error('Inherited diagnostic attribution differs');
if(after.protectedPaths!==86522||after.stashCount!==27||!after.allOutsideAuthorizedSpansPreserved||!after.allProtectedPathsExist||after.syntaxDiagnostics!==0||JSON.stringify(before.productionHashes)!==JSON.stringify(after.productionHashes)||JSON.stringify(before.retainedHashes)!==JSON.stringify(after.retainedHashes))throw Error('Main custody differs');
if(JSON.stringify(ib.sourceHashes)!==JSON.stringify(ia.sourceHashes)||JSON.stringify(ib.runtimes)!==JSON.stringify(ia.runtimes)||ia.trackedStatus!=='')throw Error('Isolated custody differs');
for(const[f,h]of Object.entries(matrix.fileHashes))if(hash(fs.readFileSync(path.join(root,f)))!==h)throw Error('Frozen test/fixture drift');
if(JSON.stringify(read('focused-command.json').command)!==JSON.stringify(read('execution-start.json').command))throw Error('Frozen command differs');

const report=read('focused.json'),outcomes=result.outcomes;
const observedNames=outcomes.map(o=>o.file+' > '+o.name).sort(),expectedNames=matrix.entries.map(o=>o.file+' > '+o.name).sort();
if(report.testResults.length!==1||report.success!==false||JSON.stringify(observedNames)!==JSON.stringify(expectedNames))throw Error('Names/report identity differs');
const failureGroups={};for(const o of outcomes.filter(o=>o.status==='failed')){const first=o.failureMessages[0].split('\n')[0];failureGroups[first]=(failureGroups[first]??0)+1;}
if(failureGroups['TypeError: v3 room preparation failed: trust-open-failed']!==16||Object.values(failureGroups).reduce((a,b)=>a+b,0)!==18)throw Error('Stopped cause differs');
const identity=read('mock-identity-attribution.json');
if(identity.mappings.length!==7||identity.mismatches.length!==2)throw Error('Resolver attribution differs');
const nodeFile='/tmp/d110c-f5b-retained-room-hsBT3J/checkout/packages/node/src/v3-live.ts',nodeSource=fs.readFileSync(nodeFile,'utf8');
const ts=(await import('/tmp/d110c-f5b-retained-room-hsBT3J/checkout/node_modules/typescript/lib/typescript.js')).default;
const unit=ts.createSourceFile(nodeFile,nodeSource,ts.ScriptTarget.Latest,true),functions=['snapshotOpenedTrust','prepareV3LiveGeneration'].map(name=>{const fn=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!fn)throw Error('Missing function');return {name,source:fn.getText(unit)};});
fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify({tests:'f932fc87cab77e22b2d3994b8af288e9e491547a',signature:'G',pushed:true,classification:result.classification,accepted:false,executionCount:1,expected:{total:20,passed:20,failed:0},actual:{total:20,passed:2,failed:18,skipped:0},failureGroups,functions,sourceSha256:hash(nodeSource),allOtherAssertionsUnchanged:true,parentTestsUnchanged:true,productionPreserved:true,isolatedSourceRuntimePreserved:true,targetDiagnostics:3,externalDiagnostics:1,editedSpanDiagnostics:0,inheritedDiagnosticsIdenticalAfterExactMapping:true,typecheckClaimedPass:false,packageWideTypecheckClaimedGreen:false,protectedPaths:86522,stashCount:27,authorizedSpans:after.spans,retainedHashes:after.retainedHashes,immutable:after.immutable,noRuntimeRerun:true,requiresNewScopeAuthorization:true},null,2)+'\n',{flag:'wx'});

const files=[];function walk(dir){for(const row of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,row.name);if(row.isDirectory())walk(full);else if(row.isFile())files.push(path.relative(out,full));else throw Error('Unexpected link');}}walk(out);files.sort();
const manifest=files.map(f=>hash(fs.readFileSync(path.join(out,f)))+'  '+f).join('\n')+'\n';
fs.writeFileSync(path.join(out,'manifest.sha256'),manifest,{flag:'wx'});
console.log(JSON.stringify({entries:files.length,manifestSha256:hash(manifest),classification:result.classification}));
