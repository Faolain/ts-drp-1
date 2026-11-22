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
const stopped=JSON.parse(read('.logs/d110c-0c1f5b-green-issuance-roster-623c415e/custody-after.json'));
for(const [file,digest] of Object.entries(stopped.ownerHashes)) if(hash(read(file))!==digest) throw Error('Production drift: '+file);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(stopped.ownerHashes)],{cwd:root});
if(!patch.equals(read('.logs/d110c-0c1f5b-green-ab98cce6/partial-production.patch')))throw Error('Stopped patch drift');
if(git('stash','list','--format=%H %gd %s')!==baseline.stashes.trim()) throw Error('Stash drift');
for(const file of baseline.untracked) if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
const immutable=[];
for(const name of [...Object.keys(stopped.manifests).map(n=>n.replace(/^\.logs\//u,'')),'d110c-0c1f5b-green-issuance-roster-623c415e','d110c-0c1f5b-green-ab98cce6','d110c-0c1f5b-retained-finality-867d7f09','d110c-0c1f5b-green-finality-140a3053','d110c-0c1f5b-retained-room-f932fc87','d110c-0c1f5b-retained-room-mocks-e384a40c']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}



const baseHead='febfcf77bdd5a90650d1ba2bf1ed61b9d9d75ae0',file='tests/d110c-0c1f5b0a-corrective-red.test.ts',base=execFileSync('git',['show',baseHead+':'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
function spans(text){const unit=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),nodes=[];function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='proofCandidates'){function cut(x){if(ts.isObjectLiteralExpression(x)&&x.properties.some(p=>p.name?.getText(unit)==='kind'&&p.initializer?.text==='drp-hard-epoch-cut'))nodes.push(x);ts.forEachChild(x,cut)}cut(n)}if(ts.isVariableDeclaration(n)&&['currentAcl','successorAcl'].includes(n.name.getText(unit)))nodes.push(n.initializer);ts.forEachChild(n,visit)}visit(unit);if(nodes.length!==3||unit.parseDiagnostics.length)throw Error('Scope/syntax differs');return {unit,nodes,ranges:nodes.map(n=>({start:n.getStart(unit),end:n.end,text:n.getText(unit)}))};}
const prior=spans(base),next=spans(current);
function mask(text,ranges){let result='',end=0;for(const n of ranges){result+=text.slice(end,n.start)+'<AUTHORIZED>';end=n.end}return result+text.slice(end);}
if(mask(base,prior.ranges)!==mask(current,next.ranges))throw Error('Outside three spans drift');
const cutText=prior.ranges[0].text.replace('epoch: 0,','epoch: 0,\n\t\t\thistoryRoot: "7".repeat(64),\n\t\t\thistorySize: 1,');
if(next.ranges[0].text!==cutText)throw Error('Exact history addition differs');
for(const [index,epoch]of [[1,0],[2,1]]){const expected='Object.freeze({\n\t\t\tepoch: '+epoch+',\n\t\t\tkind: "drp-v3-latched-acl",\n\t\t\tmembers: Object.freeze([\n\t\t\t\tObject.freeze({ author: AUTHOR, finalityKey: AUTHOR, groups: Object.freeze(["admin", "finality", "writer"]) }),\n\t\t\t]),\n\t\t\tobjectId: anchorContract.objectId,\n\t\t\tpermissionless: false,\n\t\t\tversion: 3,\n\t\t})';if(next.ranges[index].text!==expected)throw Error('Exact ACL initializer differs');}
function titles(unit){const result=[];function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='it'&&ts.isStringLiteral(n.arguments[0]))result.push(n.arguments[0].text);ts.forEachChild(n,visit)}visit(unit);return result}
const beforeTitles=titles(prior.unit),afterTitles=titles(next.unit);if(beforeTitles.length!==4||JSON.stringify(beforeTitles)!==JSON.stringify(afterTitles))throw Error('Titles differ');
const retainedHashes={};for(const [name,digest]of Object.entries(stopped.testHashes)){if(name===file)continue;if(hash(read(name))!==digest)throw Error('Retained drift '+name);retainedHashes[name]=digest}
const oldBuilt=JSON.parse(read('.logs/d110c-0c1f5b-green-ab98cce6/runtime-test-custody-after.json')).built,built={};for(const [name,row]of Object.entries(oldBuilt)){if(hash(read(name))!==row.sha256)throw Error('Main runtime drift '+name);built[name]=row.sha256}
const sourceFile='packages/node/src/internal/creator-transition-advance.ts';
const source=read(sourceFile).toString(),signed=execFileSync('git',['show',baseHead+':'+sourceFile],{cwd:root,encoding:'utf8'}),historic=execFileSync('git',['show','93585bf3:'+sourceFile],{cwd:root,encoding:'utf8'});
function named(text,name){const unit=ts.createSourceFile(sourceFile,text,ts.ScriptTarget.Latest,true),node=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!node)throw Error('Missing source owner '+name);return node.getText(unit)}
const owners=['exactSettlementRecord','exactSettlementArray','exactSettlementAcl','exactSettlementFrontierArray','settlementMembers','settlementFrontiers','inspectCreatorAuthorSettlementAdvance'];
const ownerIdentity=Object.fromEntries(owners.map(name=>{const a=named(source,name),b=named(signed,name),c=named(historic,name);if(a!==b||b!==c)throw Error('Signed validator drift '+name);return [name,{sha256:hash(a),byteIdenticalTo93585bf3:true}]}));
const sourceAttribution={sourceFile,sourceSha256:hash(source),signedSourceSha256:hash(signed),historicSignature:git('log','-1','--format=%H %G? %s','93585bf3'),ownerIdentity,openedSettlement:{signed:named(signed,'openedSettlement'),pending:named(source,'openedSettlement')},classification:'Source-supported attribution; abbreviated old reporter does not expose complete failure reasons.',notGenuineRoomRolloverProof:true};
if(!sourceAttribution.historicSignature.includes(' G '))throw Error('Source signature differs');
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,retainedHashes,retainedCount:77,built,spans:next.ranges,priorSpans:prior.ranges,syntaxDiagnostics:0,allOutsideAuthorizedSpansPreserved:true,titles:afterTitles,immutable,testSha256:hash(read(file)),sourceAttribution,trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,allOutsideAuthorizedSpansPreserved:true,titles:4,unchangedRetained:Object.keys(retainedHashes).length,built:Object.keys(built).length,validators:owners.length}));
