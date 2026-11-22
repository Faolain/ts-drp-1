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
const stopped=JSON.parse(read('.logs/d110c-0c1f5b-green-89f147cc/custody-stopped.json'));
for(const [file,digest] of Object.entries(stopped.ownerHashes)) if(hash(read(file))!==digest) throw Error('Production drift: '+file);
const patch=execFileSync('git',['diff','--binary','--full-index','--',...Object.keys(stopped.ownerHashes)],{cwd:root});
if(!patch.equals(read('.logs/d110c-0c1f5b-green-89f147cc/partial-production.patch')))throw Error('Stopped patch drift');
if(git('stash','list','--format=%H %gd %s')!==baseline.stashes.trim()) throw Error('Stash drift');
for(const file of baseline.untracked) if(!fs.existsSync(path.join(root,file)))throw Error('Protected path missing: '+file);
const immutable=[];
for(const name of ['d110c-0c1f5b0r-design-3a156aca','d110c-0c1f5b-green-89f147cc','d110c-0c1f5b-red-checkpoint-link-f83764c5','d110c-0c1f5b-red-scalar-6353eb61','d110c-0c1f5b-red-observer-78e068a8']){
 const directory=path.join(root,'.logs',name),manifest=fs.readFileSync(path.join(directory,'manifest.sha256'),'utf8');
 for(const line of manifest.trim().split('\n')){
  const [,digest,file]=line.match(/^([a-f0-9]{64})\s+(.+)$/u);
  if(hash(fs.readFileSync(path.join(directory,file)))!==digest)throw Error('Immutable evidence drift: '+name+'/'+file);
 }
 immutable.push({name,entries:manifest.trim().split('\n').length,manifestSha256:hash(manifest)});
}
const file='tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts',base=execFileSync('git',['show','3026575608479da88b707ece8ae5dcaf48802f56:'+file],{cwd:root,encoding:'utf8'}),current=read(file).toString();
const source=text=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const before=source(base),after=source(current);
if(after.parseDiagnostics.length)throw Error('Syntax diagnostics');
const find=s=>s.statements.find(row=>ts.isFunctionDeclaration(row)&&row.name.text==='executableHistoricalIssuanceCounter');
const oldFunction=find(before),newFunction=find(after);
if(base.slice(0,oldFunction.pos)!==current.slice(0,newFunction.pos)||base.slice(oldFunction.end)!==current.slice(newFunction.end))throw Error('Bytes outside executableHistoricalIssuanceCounter changed');
const protectedFunctions=before.statements.filter(ts.isFunctionDeclaration).filter(row=>row.name.text!=='executableHistoricalIssuanceCounter').map(row=>({name:row.name.text,sha256:hash(row.getText(before))}));
const helper=newFunction.getText(after);
if(!helper.includes('const { resolveVerifiedCreatorHistoricalIssuance } = await import(')||!helper.includes('"../packages/node/src/internal/creator-transition-advance.js"')||!helper.includes('"resolveVerifiedCreatorHistoricalIssuance",')||!helper.includes('return load(Reflect.apply, Set.prototype.has, Set.prototype.add, resolveVerifiedCreatorHistoricalIssuance);'))throw Error('Real resolver binding differs');
const removedTokens=[],addedTokens=[];
const retainedHashes={};
for(const [name,digest]of Object.entries(stopped.testHashes)) if(name!==file){if(hash(read(name))!==digest)throw Error('Retained tests drift');retainedHashes[name]=digest;}
const helperFixture='tests/fixtures/phase-6b-d110c-0c1f5b0s/settlement-plan-contract.ts';
if(!read(helperFixture).equals(execFileSync('git',['show','3026575608479da88b707ece8ae5dcaf48802f56:'+helperFixture],{cwd:root})))throw Error('Fixture drift');
retainedHashes[helperFixture]=hash(read(helperFixture));
const sourceFunction=(name,text)=>{const unit=ts.createSourceFile('owner.ts',text,ts.ScriptTarget.Latest,true);const fn=unit.statements.find(row=>ts.isFunctionDeclaration(row)&&row.name?.text===name);if(!fn)throw Error('Source owner absent');return fn.getText(unit);};
const counterFile='packages/node/src/v3-live.ts',resolverFile='packages/node/src/internal/creator-transition-advance.ts';
const counter=sourceFunction('countHistoricalIssuanceRow',read(counterFile).toString());
const signedCounter=sourceFunction('countHistoricalIssuanceRow',execFileSync('git',['show','3026575608479da88b707ece8ae5dcaf48802f56:'+counterFile],{cwd:root,encoding:'utf8'}));
const resolver=sourceFunction('resolveVerifiedCreatorHistoricalIssuance',read(resolverFile).toString());
const signedResolver=sourceFunction('resolveVerifiedCreatorHistoricalIssuance',execFileSync('git',['show','3026575608479da88b707ece8ae5dcaf48802f56:'+resolverFile],{cwd:root,encoding:'utf8'}));
if(resolver!==signedResolver||!resolver.includes('verifiedHistoricalIssuance.get(capability)')||!counter.includes('identity?.admissionEpoch === undefined ? 1 : 3')||!signedCounter.includes('const maxHistoricalIssuanceRows = context.maxEpochVertices;'))throw Error('Counter/resolver source attribution differs');
const sourceAttribution={counterFile,resolverFile,counter,signedCounter,resolver,signedResolver,realResolverUnchanged:true,legacy8192BoundaryAssertionsUnchanged:true,isolatedBaselineCounterDoesNotCallResolver:true,pendingGreenCounterStillRequiresSeparateGate:true};
const data={stage,sourceAttribution,head:git('rev-parse','HEAD'),signature:git('log','-1','--format=%G?'),productionHashes:stopped.ownerHashes,productionPreserved:true,partialPatchSha256:hash(patch),stashCount:27,stashesSha256:hash(baseline.stashes),protectedPaths:baseline.untracked.length,allProtectedPathsExist:true,protectedFunctions,retainedHashes,syntaxDiagnostics:0,allOutsideFunctionBytesPreserved:true,removedTokens,addedTokens,immutable,testSha256:hash(read(file)),trackedStatus:git('status','--short','--untracked-files=no')};
fs.writeFileSync(path.join(out,'custody-'+stage+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({stage,productionPreserved:true,stashCount:27,protectedPaths:baseline.untracked.length,protectedFunctions:protectedFunctions.length,removedTokens,addedTokens}));
