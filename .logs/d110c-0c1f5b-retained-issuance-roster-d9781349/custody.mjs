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
const stopped=JSON.parse(read('.logs/d110c-0c1f5b-green-ab98cce6/custody-stopped.json'));
for(const [file,digest] of Object.entries(stopped.ownerHashes)) if(hash(read(file))!==digest) throw Error('Production drift: '+file);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(stopped.ownerHashes)],{cwd:root});
if(!patch.equals(read('.logs/d110c-0c1f5b-green-ab98cce6/partial-production.patch')))throw Error('Stopped patch drift');
if(git('stash','list','--format=%H %gd %s')!==baseline.stashes.trim()) throw Error('Stash drift');
for(const file of baseline.untracked) if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
const immutable=[];
for(const name of [...Object.keys(stopped.manifests).map(n=>n.replace(/^\.logs\//u,'')),'d110c-0c1f5b-green-ab98cce6','d110c-0c1f5b-retained-finality-867d7f09','d110c-0c1f5b-green-finality-140a3053','d110c-0c1f5b-retained-room-f932fc87','d110c-0c1f5b-retained-room-mocks-e384a40c']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}



const baseHead='262e0096056bff29d52633469aec011c77e9c758',file='tests/phase-3a1b-p2-outbox-publication-contract.test.ts',base=execFileSync('git',['show',baseHead+':'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
function spans(text){const unit=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),nodes=[];function visit(n){if(ts.isArrayLiteralExpression(n)&&n.elements[0]?.text==='DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT')nodes.push(n);if(ts.isStringLiteral(n)&&['49ac5a1d2b44f69a6becc3f3bcd4e44c2d4e178512a0d8489ae28766fa636cf7','2e2d160f7e59d643d01fb4d10e321c573ace252bef43040156ff26d92e837042'].includes(n.text))nodes.push(n);ts.forEachChild(n,visit);}visit(unit);if(nodes.length!==2||unit.parseDiagnostics.length)throw Error('Scope/syntax differs');return {unit,nodes,ranges:nodes.map(n=>({start:n.getStart(unit),end:n.end,text:n.getText(unit)}))};}
const prior=spans(base),next=spans(current);
function mask(text,ranges){let result='',end=0;for(const n of ranges){result+=text.slice(end,n.start)+'<AUTHORIZED>';end=n.end;}return result+text.slice(end);}
if(mask(base,prior.ranges)!==mask(current,next.ranges))throw Error('Outside two spans drift');
const added=['SETTLEMENT_REPLACEMENT_DIGEST_LIMITS','SETTLEMENT_REPLACEMENT_MAX_INTENTS','assertSettlementPlanProgressTransition','settlementPlanHasExactEffectLink','settlementReplacementLastLogicalTime'];
const expected=[...prior.nodes[0].elements.map(n=>n.text),...added].sort(),actual=next.nodes[0].elements.map(n=>n.text);
if(actual.length!==35||JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Exact35 exports differ');
function titles(unit){const names=[];function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='it'&&ts.isStringLiteral(n.arguments[0]))names.push(n.arguments[0].text);ts.forEachChild(n,visit);}visit(unit);return names;}
const beforeTitles=titles(prior.unit),afterTitles=titles(next.unit);
if(beforeTitles.length!==10||JSON.stringify(beforeTitles)!==JSON.stringify(afterTitles))throw Error('Exact10 title drift');
const retainedHashes={};
for(const name of [...Object.keys(stopped.testHashes),'tests/phase-3g-v3-room-rebase-red.test.ts','tests/fixtures/phase-3a1b-p2-outbox-publication-contract.ts','tests/phase-5a-c-seal-safety-red.test.ts','tests/phase-5e-creator-actor-red.test.ts','tests/fixtures/phase-5-v3/seal-types.ts','tests/fixtures/phase-5e-v3/creator-actor-contract.ts','tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts']){
 if(name===file)continue;if(!read(name).equals(execFileSync('git',['show',baseHead+':'+name],{cwd:root})))throw Error('Retained source drift '+name);retainedHashes[name]=hash(read(name));
}
const contractFile='packages/issuance-store/src/contract.ts',contract=read(contractFile),legacy=execFileSync('git',['show','9fef8d24:'+contractFile],{cwd:root,encoding:'utf8'});
if(hash(contract)!=='2e2d160f7e59d643d01fb4d10e321c573ace252bef43040156ff26d92e837042'||!contract.equals(execFileSync('git',['show','9c1ec6c4:'+contractFile],{cwd:root})))throw Error('Signed current contract differs');
function declarations(text){const unit=ts.createSourceFile(contractFile,text,ts.ScriptTarget.Latest,true);return Object.fromEntries(unit.statements.filter(n=>ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n)).map(n=>[n.name.text,n.getText(unit)]));}
const oldOwners=declarations(legacy),owners=declarations(contract.toString()),unchanged=Object.keys(oldOwners).filter(n=>oldOwners[n]===owners[n]),changed=Object.keys(oldOwners).filter(n=>oldOwners[n]!==owners[n]),newOwners=Object.keys(owners).filter(n=>!oldOwners[n]);
if(unchanged.length!==20||JSON.stringify(changed)!==JSON.stringify(['cloneDurableIssueCommit','copySettlementPlanEffect','copySettlementPlanEntry','cloneSettlementPlan','applySettlementPlanEffect'])||JSON.stringify(newOwners)!==JSON.stringify(['settlementReplacementLastLogicalTime','copySettlementReplacementChunk','copySettlementReplacementProgress','assertSettlementPlanProgressTransition','settlementPlanHasExactEffectLink']))throw Error('Source declaration partition differs');
const unchangedOwners=Object.fromEntries(unchanged.map(n=>[n,{sha256:hash(owners[n]),byteIdentical:true}]));
const pins={'packages/issuance-store/src/terminal.ts':'a71b32967ca152c12b10adad4f3303696fb42d4379892cc27c4937af19d42a4a','packages/issuance-store/src/index.ts':'62b3b2c62e7cc230820ba56e8867be76f17861dde3b45d645c2855a11b6afa93'};
for(const[p,d]of Object.entries(pins))if(hash(read(p))!==d||!read(p).equals(execFileSync('git',['show','9fef8d24:'+p],{cwd:root})))throw Error('Legacy pin drift');
const claimOwners=['packages/issuance-store/src/conformance.ts','packages/storage-node/src/internal/node-issuance-store.ts','packages/storage-browser/src/internal/browser-issuance-store.ts','packages/storage-node/src/issuance.ts','packages/storage-browser/src/issuance.ts'];
const claimChecks=claimOwners.map(name=>{const text=read(name).toString(),matched=/peer receipt|remote admission|network exactly-once|exactly once/iu.test(text);if(matched)throw Error('New publication claim');return {file:name,sha256:hash(text),matched};});
const signedOwners=['ea02487e','9c1ec6c4','9fef8d24'].map(commit=>git('log','-1','--format=%H %G? %s',commit));if(signedOwners.some(line=>!line.includes(' G ')))throw Error('Source provenance signature differs');
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,retainedHashes,spans:next.ranges,priorSpans:prior.ranges,syntaxDiagnostics:0,allOutsideAuthorizedSpansPreserved:true,titles:afterTitles,immutable,testSha256:hash(read(file)),sourceAttribution:{contractFile,contractSha256:hash(contract),signedOwners,addedExports:added,expectedExports:expected,unchangedOwners,changed,newOwners,pins,claimChecks,noNewApi:true},trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,allOutsideAuthorizedSpansPreserved:true,titles:10,exports:35,legacyDeclarationsUnchanged:20}));
