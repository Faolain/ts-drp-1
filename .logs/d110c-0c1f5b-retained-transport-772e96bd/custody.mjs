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
const stopped=JSON.parse(read('.logs/d110c-0c1f5b-green-settlement-codec-0240e9ea/custody-after.json'));
for(const [file,digest] of Object.entries(stopped.ownerHashes)) if(hash(read(file))!==digest) throw Error('Production drift: '+file);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(stopped.ownerHashes)],{cwd:root});
if(!patch.equals(read('.logs/d110c-0c1f5b-green-ab98cce6/partial-production.patch')))throw Error('Stopped patch drift');
if(git('stash','list','--format=%H %gd %s')!==baseline.stashes.trim()) throw Error('Stash drift');
for(const file of baseline.untracked) if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
const immutable=[];
for(const name of [...Object.keys(stopped.manifests).map(n=>n.replace(/^\.logs\//u,'')),'d110c-0c1f5b-green-settlement-codec-0240e9ea','d110c-0c1f5b-green-issuance-roster-623c415e','d110c-0c1f5b-green-ab98cce6','d110c-0c1f5b-retained-finality-867d7f09','d110c-0c1f5b-green-finality-140a3053','d110c-0c1f5b-retained-room-f932fc87','d110c-0c1f5b-retained-room-mocks-e384a40c']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}



const baseHead='18e6454593c8774c605bbba9359d4a89d50b7465',file='tests/phase-3a1b-p3-live-transport-red.test.ts',base=execFileSync('git',['show',baseHead+':'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
const baselineReport='.logs/d110c-0c1f5b-green-ab98cce6/retained-70/result.json',report=JSON.parse(read(baselineReport));
const selectedNames=report.testResults.flatMap(s=>s.assertionResults.filter(t=>t.status==='failed').map(t=>t.title));
if(selectedNames.length!==3)throw Error('Baseline failure roster differs');
function assertions(body,unit){const list=[];function visit(n){if(ts.isExpressionStatement(n)&&/^(?:await )?expect(?:\(|ClosedFrozenActivationFailure\()/.test(n.getText(unit)))list.push(n.getText(unit));ts.forEachChild(n,visit)}visit(body);return list}
function scope(text){const unit=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),nodes=[],runtimeAssertions=[],sourceAssertions=[],titles=[];function visit(n){if(ts.isFunctionDeclaration(n)&&['fakeIssuanceStore','outboxRecord'].includes(n.name?.text))nodes.push(n);if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='it'&&ts.isStringLiteral(n.arguments[0])){titles.push(n.arguments[0].text);const index=selectedNames.indexOf(n.arguments[0].text);if(index>=0){const body=n.arguments[1].body;nodes.push(body);(index<2?runtimeAssertions:sourceAssertions).push(...assertions(body,unit))}}ts.forEachChild(n,visit)}visit(unit);if(nodes.length!==5||unit.parseDiagnostics.length||titles.length!==24)throw Error('Scope/syntax/title count differs');return {unit,nodes,ranges:nodes.map(n=>({start:n.getStart(unit),end:n.end,text:n.getText(unit)})),runtimeAssertions,sourceAssertions,titles}}
const prior=scope(base),next=scope(current);
function mask(text,ranges){let result='',end=0;for(const n of ranges){result+=text.slice(end,n.start)+'<AUTHORIZED>';end=n.end}return result+text.slice(end)}
if(mask(base,prior.ranges)!==mask(current,next.ranges)||JSON.stringify(prior.runtimeAssertions)!==JSON.stringify(next.runtimeAssertions)||prior.runtimeAssertions.length!==123||JSON.stringify(prior.titles)!==JSON.stringify(next.titles))throw Error('Outside spans/runtime assertions differ');
const oldSource=prior.sourceAssertions.filter(s=>!s.startsWith('expect(count(liveSource, /extractAdmittedReceivedVertex')&&!s.includes('/extractAdmittedReceivedVertex'));
const newSource=next.sourceAssertions.filter(s=>!s.startsWith('expect(extractorOwners')&&!s.startsWith('expect(ingressExtractor'));
if(JSON.stringify(oldSource)!==JSON.stringify(newSource))throw Error('Unrelated source predicates differ');
const retainedHashes={};for(const[name,d]of Object.entries(stopped.testHashes)){if(name===file)continue;if(hash(read(name))!==d)throw Error('Retained drift '+name);retainedHashes[name]=d}
const oldBuilt=JSON.parse(read('.logs/d110c-0c1f5b-green-ab98cce6/runtime-test-custody-after.json')).built,built={};for(const[name,row]of Object.entries(oldBuilt)){if(hash(read(name))!==row.sha256)throw Error('Main runtime drift '+name);built[name]=row.sha256}
const sourceFile='packages/node/src/v3-live.ts',source=read(sourceFile).toString(),signed=execFileSync('git',['show',baseHead+':'+sourceFile],{cwd:root,encoding:'utf8'});
function named(text,name){const unit=ts.createSourceFile(sourceFile,text,ts.ScriptTarget.Latest,true),node=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!node)throw Error('Missing owner '+name);return node.getText(unit)}
const names=['extractAuthorizedV3Vertex','authenticatedPinnedGenesisOutboxRow','authenticatedCoveredHistoricalOutboxRow','authenticatedOutboxRow'];
const ownerIdentity=Object.fromEntries(names.map(name=>{const a=named(source,name),b=named(signed,name);if(a!==b)throw Error('Parent owner drift '+name);return [name,{sha256:hash(a),unchangedByParent:true,body:a}]}));
const unit=ts.createSourceFile(sourceFile,source,ts.ScriptTarget.Latest,true),callOwners=[];function calls(node){if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='extractAdmittedReceivedVertex'){let owner=node.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;callOwners.push(owner?.name?.text??'<unowned>')}ts.forEachChild(node,calls)}calls(unit);
if(JSON.stringify(callOwners.sort())!==JSON.stringify(names.slice(0,3).sort()))throw Error('Exact extractor ownership differs');
const signedProvenance=['efe7cee7','420fd240','5bf872b6'].map(commit=>git('log','-1','--format=%H %G? %s',commit));if(signedProvenance.some(s=>!s.includes(' G ')))throw Error('Source signature differs');
const sharedFixture='tests/fixtures/phase-3a1b-p3/live-fixture.ts';if(!read(sharedFixture).equals(execFileSync('git',['show',baseHead+':'+sharedFixture],{cwd:root})))throw Error('Shared fixture changed');
const sourceAttribution={sourceFile,sourceSha256:hash(source),signedSourceSha256:hash(signed),ownerIdentity,callOwners,signedProvenance,sharedFixtureSha256:hash(read(sharedFixture)),fixedRosterIndependentOfOutboxPages:true,sequence1SharedWithIngress:true,notCompleteProductionIssuedHistory:true,oldBaseline:{file:baselineReport,sha256:hash(read(baselineReport)),total:24,passed:21,failed:3}};
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,retainedHashes,retainedCount:78,built,spans:next.ranges,priorSpans:prior.ranges,syntaxDiagnostics:0,allOutsideAuthorizedSpansPreserved:true,unchangedRuntimeAssertions:123,runtimeAssertions:next.runtimeAssertions,unchangedSourcePredicates:oldSource,titles:next.titles,immutable,testSha256:hash(read(file)),sourceAttribution,trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,allOutsideAuthorizedSpansPreserved:true,titles:24,unchangedRuntimeAssertions:123,unchangedRetained:Object.keys(retainedHashes).length,built:Object.keys(built).length,owners:names.length}));
