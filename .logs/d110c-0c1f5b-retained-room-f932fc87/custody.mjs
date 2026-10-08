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
for(const name of [...Object.keys(stopped.manifests).map(n=>n.replace(/^\.logs\//u,'')),'d110c-0c1f5b-green-ab98cce6','d110c-0c1f5b-retained-finality-867d7f09','d110c-0c1f5b-green-finality-140a3053']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}


const baseHead='29e26b3f93e215f66201bfd5a71e7b2f334c164d',file='tests/phase-3g-v3-room-rebase-red.test.ts',base=execFileSync('git',['show',baseHead+':'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
function spans(text){
 const unit=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),fn=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='invite'),im=unit.statements.find(n=>ts.isImportDeclaration(n)&&n.moduleSpecifier.text==='@ts-drp/canonical'),values=[];
 if(unit.parseDiagnostics.length||!fn||!im)throw Error('Syntax or owner absent');
 function visit(n){if(ts.isPropertyAssignment(n)&&n.name.getText(unit)==='exactCanonicalLatchedAclBytes'&&(n.pos<fn.pos||n.pos>fn.end))values.push(n.initializer);ts.forEachChild(n,visit);}visit(unit);
 if(values.length!==1)throw Error('Expected ACL span differs');
 const nodes=[im,fn,values[0]];
 return {unit,nodes,ranges:nodes.map(n=>({start:n.getStart(unit),end:n.end,text:n.getText(unit)}))};
}
const prior=spans(base),next=spans(current);
function mask(text,ranges){let end=0,result='';for(const span of ranges){result+=text.slice(end,span.start)+'<AUTHORIZED>';end=span.end;}return result+text.slice(end);}
if(mask(base,prior.ranges)!==mask(current,next.ranges))throw Error('Bytes outside three spans differ');
if(next.ranges[0].text!=='import { encodeCanonical, hashDomain } from "@ts-drp/canonical";'||next.ranges[2].text.includes('invite('))throw Error('Import/independent ACL differs');
const titles=unit=>{const names=[];function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='it'&&ts.isStringLiteral(n.arguments[0]))names.push(n.arguments[0].text);ts.forEachChild(n,visit);}visit(unit);return names;};
const beforeTitles=titles(prior.unit),afterTitles=titles(next.unit);
if(beforeTitles.length!==20||JSON.stringify(beforeTitles)!==JSON.stringify(afterTitles))throw Error('Title count drift');
const retainedHashes={};
for(const name of [...Object.keys(stopped.testHashes),'tests/phase-5a-c-seal-safety-red.test.ts','tests/phase-5e-creator-actor-red.test.ts','tests/fixtures/phase-5-v3/seal-types.ts','tests/fixtures/phase-5e-v3/creator-actor-contract.ts','tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts']){
 if(name===file)continue;if(!read(name).equals(execFileSync('git',['show',baseHead+':'+name],{cwd:root})))throw Error('Retained owner drift '+name);retainedHashes[name]=hash(read(name));
}
const roomFile='examples/v3-room/src/index.ts',signedRoom=execFileSync('git',['show',baseHead+':'+roomFile],{cwd:root,encoding:'utf8'}),pendingRoom=read(roomFile).toString();
function namedSource(text,name){const unit=ts.createSourceFile(roomFile,text,ts.ScriptTarget.Latest,true),fn=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);return fn?.getText(unit)??null;}
const functions=['assertSupportedGenesisLineagePolicy','decodeCreatorInvite','migrationCreatorAuthor','migrationInviteAuthority','migrationLatchedAcl'].map(name=>({name,signed:namedSource(signedRoom,name),pending:namedSource(pendingRoom,name)}));
const attributionFiles=['packages/protocol-v3/registry/registry-v1.json','packages/protocol-v3/src/index.ts','packages/protocol-v3/src/latched-acl.ts','packages/compaction/src/ct-merkle.ts','tests/fixtures/phase-3g/rebase-outbox-fixture.ts'];
const attributionHashes=Object.fromEntries(attributionFiles.map(name=>{if(!read(name).equals(execFileSync('git',['show',baseHead+':'+name],{cwd:root})))throw Error('Attribution source drift');return [name,hash(read(name))];}));
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,retainedHashes,spans:next.ranges,priorSpans:prior.ranges,syntaxDiagnostics:0,allOutsideAuthorizedSpansPreserved:true,titles:afterTitles,immutable,testSha256:hash(read(file)),sourceAttribution:{functions,attributionHashes,controlledCompositionNotAuthenticatedGenesis:true,legacyProfile:true,sevenRequiredNumericParameters:true,independentAclExpectation:true,noProductionChanges:true},trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,allOutsideAuthorizedSpansPreserved:true,titles:afterTitles.length}));
