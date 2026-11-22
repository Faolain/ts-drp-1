import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),prior=path.join(root,'.logs/d110c-0c1f5b-green-ab98cce6'),accepted=path.join(root,'.logs/d110c-0c1f5b-retained-transport-native-a430272a');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>JSON.parse(fs.readFileSync(f)),write=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8',maxBuffer:128*1024*1024}).trim();
const base=read(path.join(prior,'custody-stopped.json')),matrix=read(path.join(accepted,'matrix.json'));
const currentHead='e122e2806eee036404e812080c658f9804df7852';
function custody(stage){
 if(git('rev-parse','HEAD')!==currentHead||git('log','-1','--format=%G?')!=='G')throw Error('HEAD drift');
 for(const [f,h]of Object.entries(base.ownerHashes))if(hash(fs.readFileSync(path.join(root,f)))!==h)throw Error('Owner drift '+f);
 const patch=execFileSync('git',['-C',root,'diff','--binary','--full-index','--',...Object.keys(base.ownerHashes)],{maxBuffer:128*1024*1024});
 if(hash(patch)!=='245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed')throw Error('Patch drift');
 const old=read(path.join(root,'.logs/d110c-0c1f5b-green-57834387/custody-before.json'));
 if(git('stash','list','--format=%H %gd %gs')!==old.stashes.trim())throw Error('Stash drift');
 for(const f of old.untracked)if(!fs.existsSync(path.join(root,f)))throw Error('Protected missing '+f);
 const manifests={...Object.fromEntries(read(path.join(accepted,'custody-after.json')).immutable.map(v=>['.logs/'+v.name,v.manifestSha256])),'.logs/d110c-0c1f5b-retained-transport-native-a430272a':'6ede5fcfebd419cecb1045e461fa836fff169fee87767bd2a7f11ebc21031775'};
 for(const [dir,expected]of Object.entries(manifests)){
  const bytes=fs.readFileSync(path.join(root,dir,'manifest.sha256'));if(hash(bytes)!==expected)throw Error('Manifest changed '+dir);
  for(const line of bytes.toString().trim().split('\n')){const match=/^([a-f0-9]{64})\s+(.+)$/u.exec(line),file=match[2].startsWith('.logs/')?path.join(root,match[2]):path.join(root,dir,match[2]);if(hash(fs.readFileSync(file))!==match[1])throw Error('Evidence changed '+file);}
 }
 const priorRuntime=read(path.join(prior,'runtime-test-custody-after.json'));
 const testHashes={...read(path.join(accepted,'custody-after.json')).retainedHashes,...matrix.fileHashes};
 for(const [f,h]of Object.entries(testHashes))if(hash(fs.readFileSync(path.join(root,f)))!==h)throw Error('Test drift '+f);
 for(const [f,r]of Object.entries(priorRuntime.built))if(hash(fs.readFileSync(path.join(root,f)))!==r.sha256)throw Error('Built owner drift '+f);
 const finality='packages/keychain/dist/src/finality.js',finalityHash=hash(fs.readFileSync(path.join(root,finality)));
 if(finalityHash!=='c6af8eb21bebf9f0a89a0e30c39b6bd8d10c02a16b4e66fee5e2aa41c625b621')throw Error('Finality runtime mismatch');
 const finalitySource='packages/keychain/src/finality.ts',finalitySourceHash=hash(fs.readFileSync(path.join(root,finalitySource)));
 if(finalitySourceHash!==hash(execFileSync('git',['-C',root,'show','d77ee315a7688cffb5fd55870c38231403ecc41f:'+finalitySource])))throw Error('Finality source changed');
 write('custody-'+stage+'.json',{head:currentHead,signature:'G',ownerHashes:base.ownerHashes,patchSha256:hash(patch),stashCount:27,protectedPaths:old.untracked.length,manifests,testHashes,builtOwners:priorRuntime.built,finality:{file:finality,sha256:finalityHash,source:finalitySource,sourceSha256:finalitySourceHash,sourceMatchesSignedD77:true},status:git('status','--short','--untracked-files=no')});
 return patch;
}
if(process.argv[2]==='before'){
 const diagnosticArgs=['show','--check','e122e2806eee036404e812080c658f9804df7852'];
 const diagnostic=spawnSync('git',diagnosticArgs,{cwd:root,encoding:'utf8'});
 write('accepted-evidence-diff-check.json',{command:['git',...diagnosticArgs],cwd:root,status:diagnostic.status,signal:diagnostic.signal,stdout:diagnostic.stdout,stderr:diagnostic.stderr,disposition:'Signed isolated evidence whitespace check passes; this is not a blanket parent source/static pass.'});
 if(diagnostic.status!==0)throw Error('Unexpected accepted evidence diagnostic status');
 const patch=custody('before');write('patch-reference.json',{immutable:'.logs/d110c-0c1f5b-green-ab98cce6/partial-production.patch',actualGitDiffSha256:hash(patch)});
 const oldRows=[70].flatMap(n=>read(path.join(prior,'retained-'+n,'result.json')).testResults.flatMap(s=>s.assertionResults.map(a=>path.relative(root,s.name)+'\0'+[...a.ancestorTitles,a.title].join(' > ')))).sort();
 const entries=matrix.entries.map(e=>e.file+'\0'+e.name).sort();if(JSON.stringify(oldRows)!==JSON.stringify(entries)||entries.length!==24)throw Error('Title drift');
 write('matrix.json',{...matrix,head:currentHead,classification:'PARENT_GREEN_RETAINED_TRANSPORT_CORRECTION_ONLY',priorTitleMultisetMatches:true,collectionRepeated:false});
 write('command.json',{cwd:root,command:['pnpm','exec','vitest','run',...matrix.files,'--no-file-parallelism','--coverage.enabled=false','--reporter=json','--outputFile='+path.join(out,'focused.json')],head:currentHead,expected:{total:24,passed:24,failed:0,skipped:0}});
 console.log(JSON.stringify({custody:true,selected:24,files:1,retainedRoster:78,sharedFixtureAdditional:1,builtOwnerHashesUnchanged:true,finalityMatchesIsolated:true}));
}else if(process.argv[2]==='run'){
 write('execution-start.json',{at:new Date().toISOString(),head:git('rev-parse','HEAD'),recorderPid:process.pid});
 console.log(JSON.stringify({recorderPid:process.pid,stage:'launching sole frozen runtime'}));
 const command=read(path.join(out,'command.json')),stdout=fs.openSync(path.join(out,'stdout.log'),'wx'),stderr=fs.openSync(path.join(out,'stderr.log'),'wx');
 const result=spawnSync(command.command[0],command.command.slice(1),{cwd:root,env:process.env,stdio:['ignore',stdout,stderr]});fs.closeSync(stdout);fs.closeSync(stderr);
 write('status.json',{status:result.status,signal:result.signal,error:result.error?.message,endedAt:new Date().toISOString()});
 console.log(JSON.stringify({status:result.status,signal:result.signal}));process.exitCode=result.status??1;
}else if(process.argv[2]==='after'){
 custody('after');const report=read(path.join(out,'focused.json')),status=read(path.join(out,'status.json'));
 const assertions=report.testResults.flatMap(s=>s.assertionResults.map(a=>({file:path.relative(root,s.name),...a})));
 const actual=assertions.map(a=>a.file+'\0'+[...a.ancestorTitles,a.title].join(' > ')).sort(),expected=matrix.entries.map(e=>e.file+'\0'+e.name).sort();
 const exactNames=JSON.stringify(actual)===JSON.stringify(expected),exactFiles=JSON.stringify(report.testResults.map(s=>path.relative(root,s.name)).sort())===JSON.stringify([...matrix.files].sort());
 const valid=status.status===0&&report.success===true&&exactNames&&exactFiles&&report.numTotalTests===24&&report.numPassedTests===24&&report.numFailedTests===0&&report.numPendingTests===0&&!report.numRuntimeErrorTestSuites&&!report.numUnhandledErrors&&report.testResults.every(s=>!s.message&&!s.testExecError)&&assertions.every(a=>a.status==='passed'&&a.failureMessages.length===0);
 write('validation.json',{valid,exactNames,exactFiles,status,success:report.success,total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,skipped:report.numPendingTests,numRuntimeErrorTestSuites:report.numRuntimeErrorTestSuites??null,numUnhandledErrors:report.numUnhandledErrors??null,suites:report.testResults.map(s=>({file:s.name,message:s.message,testExecError:s.testExecError??null})),assertions,reporterSha256:hash(fs.readFileSync(path.join(out,'focused.json')))});
 console.log(JSON.stringify({valid,total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,skipped:report.numPendingTests}));if(!valid)process.exitCode=1;
}else throw Error('Unknown mode');
