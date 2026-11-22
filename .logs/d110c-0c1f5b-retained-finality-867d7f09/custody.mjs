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
for(const name of [...Object.keys(stopped.manifests).map(n=>n.replace(/^\.logs\//u,'')),'d110c-0c1f5b-green-ab98cce6']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}

const baseHead='15c66947ea8ece4eb5bf0a9bc0e7632e749b209c',files=["tests/fixtures/phase-5-v3/seal-types.ts","tests/fixtures/phase-5e-v3/creator-actor-contract.ts","tests/phase-5e-creator-actor-red.test.ts"],spans=[];
const expected=['createRecoverableFinalitySigner','signCreatorAnchorRequest','signCreatorIssuanceRetirementRequest','signSealRegisteredDigest'];
for(const file of files){
 const base=execFileSync('git',['show',baseHead+':'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
 function span(text){const unit=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),arrays=[];if(unit.parseDiagnostics.length)throw Error('Syntax diagnostics');function visit(n){if(ts.isArrayLiteralExpression(n)&&n.elements[0]?.text==='createRecoverableFinalitySigner')arrays.push(n);ts.forEachChild(n,visit);}visit(unit);if(arrays.length!==1)throw Error('Array scope');return arrays[0];}
 const old=span(base),now=span(current);
 if(base.slice(0,old.pos)!==current.slice(0,now.pos)||base.slice(old.end)!==current.slice(now.end)||JSON.stringify(now.elements.map(n=>n.text))!==JSON.stringify(expected)||JSON.stringify(old.elements.map(n=>n.text))!==JSON.stringify(expected.filter(n=>n!=='signCreatorIssuanceRetirementRequest')))throw Error('Authorized array-only scope differs');
 spans.push({file,oldSpan:[old.pos,old.end],newSpan:[now.pos,now.end],before:base.slice(old.pos,old.end),after:current.slice(now.pos,now.end),allOutsideBytesPreserved:true,sha256:hash(read(file))});
}
const retainedHashes={};
for(const file of [...Object.keys(stopped.testHashes),'tests/phase-5a-c-seal-safety-red.test.ts','tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts','packages/seal/formal/seal-safety.qnt']){
 if(files.includes(file))continue;
 if(!read(file).equals(execFileSync('git',['show',baseHead+':'+file],{cwd:root})))throw Error('Protected source drift: '+file);
 retainedHashes[file]=hash(read(file));
}
const api='packages/keychain/src/finality.ts',signedApi=execFileSync('git',['show','d77ee315a7688cffb5fd55870c38231403ecc41f:'+api],{cwd:root});
if(!read(api).equals(signedApi))throw Error('Existing signed API differs');
const unit=ts.createSourceFile(api,signedApi.toString(),ts.ScriptTarget.Latest,true);
const exports=unit.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(n=>n.name.text).sort();
if(JSON.stringify(exports)!==JSON.stringify(expected))throw Error('Existing runtime export roster differs');
const data={stage,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,retainedHashes,spans,syntaxDiagnostics:0,allOutsideArrayBytesPreserved:true,immutable,sourceAttribution:{api,originalSignedCommit:'d77ee315a7688cffb5fd55870c38231403ecc41f',byteIdentical:true,sha256:hash(signedApi),exports,noNewApi:true},trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,allOutsideArrayBytesPreserved:true}));
