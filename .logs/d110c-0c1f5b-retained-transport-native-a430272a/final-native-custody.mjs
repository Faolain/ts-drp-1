import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const out=path.dirname(new URL(import.meta.url).pathname),read=n=>JSON.parse(fs.readFileSync(path.join(out,n),'utf8')),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const target=read('native-target.json'),artifacts=read('native-artifacts.json'),checks={};
for(const[name,a]of Object.entries(artifacts.artifacts)){for(const file of [a.source,path.join(out,a.retained)])if(hash(fs.readFileSync(file))!==a.sha256)throw Error('Native artifact drift');checks[name]={sha256:a.sha256,bytes:a.bytes,originalAndRetainedMatch:true}}
for(const[f,d]of Object.entries(target.inputHashes))if(hash(fs.readFileSync(path.join(target.root,f)))!==d)throw Error('Installer/package input drift');
const oldOut='/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b-retained-transport-772e96bd',old=JSON.parse(fs.readFileSync(path.join(oldOut,'isolation-after.json')));
for(const[f,d]of Object.entries(old.sourceHashes))if(hash(fs.readFileSync(path.join(old.root,f)))!==d)throw Error('Stopped checkout source drift');
for(const[f,r]of Object.entries(old.runtimes))if(hash(fs.readFileSync(path.join(old.root,f)))!==r.sha256)throw Error('Stopped checkout runtime drift');
if(fs.existsSync(path.join(old.root,'node_modules/.pnpm/node-datachannel@0.32.3/node_modules/node-datachannel/build/Release/node_datachannel.node')))throw Error('Stopped checkout native binary changed');
const result=read('result.json'),reportBytes=fs.readFileSync(path.join(out,'focused.json')),report=JSON.parse(reportBytes);
if(result.passed!==24||result.failed!==0||result.intentionallyFiltered!==0||result.topLevel.length||result.violations.length||!report.success)throw Error('Runtime not exact24');
const data={classification:'ACCEPTED_RETAINED_TRANSPORT_NATIVE_BASELINE',artifacts:checks,installerInputsUnchanged:true,stoppedCheckout:{root:old.root,sourcesAndRuntimesUnchanged:true,nativeBinaryStillAbsent:true},reporterSha256:hash(reportBytes),total:24,passed:24,failed:0,skipped:0,executionCount:1,topLevel:result.topLevel,stderr:fs.readFileSync(path.join(out,'stderr.log'),'utf8'),typecheckPassed:false,inheritedTargetDiagnostics:13,externalDiagnostics:0,rootAcceptancePending:true,separateParentGreenPending:true};
fs.writeFileSync(path.join(out,'final-native-custody.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({classification:data.classification,reporterSha256:data.reporterSha256,artifacts:checks,stoppedCheckoutPreserved:true}));
