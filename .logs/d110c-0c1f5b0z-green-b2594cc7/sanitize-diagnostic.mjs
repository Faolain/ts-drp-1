import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const out=path.dirname(new URL(import.meta.url).pathname);
const quarantine='/tmp/d110c-f5b0z-green-private-vE5I6v';
assert.equal(fs.statSync(quarantine).isDirectory(),true);
fs.chmodSync(quarantine,0o700);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const processFile=path.join(out,'browser-process-preflight/stdout');
const diagnosticFile=path.join(out,'evidence-whitespace.json');
const processBytes=fs.readFileSync(processFile),diagnosticBytes=fs.readFileSync(diagnosticFile);
const secrets=[...processBytes.toString().matchAll(/--api-key(?:=|\s+)([^\s]+)/gu)].map(row=>row[1]).filter(value=>!value.includes('*'));
function redact(text){let result=text;for(const secret of secrets)result=result.replaceAll(secret,'[REDACTED]');return result;}
let omitted=0;
const sanitized=processBytes.toString().split('\n').map((line,index)=>{
 if(index===0||line==='')return line;
 const match=line.match(/^(\s*\d+\s+\d+\s+\S+\s+)(.*)$/u);
 assert.ok(match,'Unexpected process line');
 if(/ts-drp-1|d110c-f5b0z|node \(vitest/u.test(match[2]))return match[1]+redact(match[2]);
 omitted++;
 return match[1]+'[unrelated process command omitted]';
}).join('\n');
for(const [source,name]of [[processFile,'process-stdout.raw'],[diagnosticFile,'whitespace-diagnostic.raw.json']]){
 const destination=path.join(quarantine,name);
 assert.equal(fs.existsSync(destination),false);
 fs.renameSync(source,destination);fs.chmodSync(destination,0o600);
}
fs.writeFileSync(processFile,sanitized,{flag:'wx'});
fs.writeFileSync(diagnosticFile,redact(diagnosticBytes.toString()),{flag:'wx'});
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
for(const file of files(out)){
 const bytes=fs.readFileSync(file,'utf8');
 for(const secret of secrets)assert.equal(bytes.includes(secret),false,'Unredacted credential remains in '+path.relative(out,file));
}
fs.writeFileSync(path.join(out,'diagnostic-redaction.json'),JSON.stringify({quarantine,permissions:{directory:'0700',files:'0600'},rawProcessSha256:hash(processBytes),rawWhitespaceDiagnosticSha256:hash(diagnosticBytes),sanitizedProcessSha256:hash(sanitized),omittedUnrelatedCommands:omitted,credentialOccurrencesRedacted:secrets.length,allEvidenceScannedAgainstObservedSecrets:true,rawTestBuildNativeStreamsUnchanged:true,redactionScope:['browser-process-preflight/stdout','evidence-whitespace.json'],reason:'Unrelated process command arguments contained credentials. Raw newly generated diagnostics retained privately outside repository; no such artifact was committed or pushed.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sanitized:true,omittedUnrelatedCommands:omitted,allEvidenceScanned:true,quarantinePermissions:'0700/0600'}));
