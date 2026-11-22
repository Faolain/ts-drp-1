import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const out=path.dirname(new URL(import.meta.url).pathname);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const read=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));
const result=read('result.json'),matrix=read('matrix.json');
assert.equal(result.classification,'ACCEPTED_CAUSAL_MAINTENANCE_DISCOVERY_RED');
assert.equal(result.executionCount,1);assert.deepEqual(result.violations,[]);
assert.equal(result.failed,14);assert.equal(result.passed,2);assert.equal(result.total,16);
assert.equal(result.outcomes.filter(x=>x.expectedToken==='F5B0Z_NEUTRAL_MAINTENANCE_DISCOVERY_REQUIRED').length,11);
assert.equal(result.outcomes.filter(x=>x.expectedToken==='F5B0Z_INCOMPATIBLE_REGISTRY_REFUSAL_REQUIRED').length,3);
assert.equal(hash(fs.readFileSync(path.join(out,'matrix.json'))),'464e04a81d2d3e798f9cdcb43321b28b0070009b4291f0ed1fd79c98ca7f422d');
assert.deepEqual(read('isolation-before.json').sourceHashes,read('isolation-after.json').sourceHashes);
assert.deepEqual(read('isolation-before.json').runtimes,read('isolation-after.json').runtimes);
assert.deepEqual(read('custody-before.json').productionHashes,read('custody-after.json').productionHashes);
const commandStatuses={};
for(const entry of fs.readdirSync(out,{withFileTypes:true}))if(entry.isDirectory()){
 const file=path.join(out,entry.name,'status.json');if(!fs.existsSync(file))continue;
 const status=JSON.parse(fs.readFileSync(file,'utf8'));commandStatuses[entry.name]=status.code;
 assert.equal(status.code,0,entry.name);
}
const mainRoot=read('signed-test.json').mainRoot;
const baseline=JSON.parse(fs.readFileSync(path.join(mainRoot,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'),'utf8'));
const protectedMissing=baseline.untracked.filter(file=>!fs.existsSync(path.join(mainRoot,file)));
assert.deepEqual(protectedMissing,[]);
const type=read('typecheck.json');assert.equal(type.targetDiagnostics.length,0);
const whitespace=read('evidence-diff-check.json');assert.equal(whitespace.fullStatus,2);assert.equal(whitespace.sourceAndOtherArtifactStatus,0);assert.equal(whitespace.testCommitWhitespaceStatus,0);
fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify({acceptedCausalRed:true,executionCount:1,testsCommit:result.head,selected:16,failed:14,passed:2,discoveryTokens:11,refusalTokens:3,topLevelErrors:0,skippedFilteredPending:0,matrixSha256:hash(fs.readFileSync(path.join(out,'matrix.json'))),exactFrozenCommand:matrix.command,commandStatuses,targetTypeDiagnostics:0,inheritedSourceMappedDiagnostics:type.externalDiagnostics,packageWideTypechecks:'storage pass; browser and Node existing diagnostics fully preserved, not claimed passed',protectedPaths:baseline.untracked.length,protectedMissing,parentFiles:7,stashes:27,noProductionOverlay:true,noCopiedDist:true,childStreamLimitation:'JSON reporter intercepts console.info; standalone child streams not retained; causal child-success/token assertions and native runtime hashes retained',evidenceMovedWithoutChangingFrozenOutputFile:true},null,2)+'\n',{flag:'wx'});
function walk(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);}
const files=walk(out).filter(file=>path.basename(file)!=='manifest.sha256').sort();
fs.writeFileSync(path.join(out,'manifest.sha256'),files.map(file=>`${hash(fs.readFileSync(file))}  ${path.relative(out,file)}`).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({manifestEntries:files.length,manifestSha256:hash(fs.readFileSync(path.join(out,'manifest.sha256'))),acceptedCausalRed:true,rawCaptureWhitespace:whitespace}));
