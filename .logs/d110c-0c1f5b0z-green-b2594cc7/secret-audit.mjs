import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const main='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const privateRoot='/tmp/d110c-f5b0z-green-private-vE5I6v';
const source=fs.readFileSync(path.join(privateRoot,'process-stdout.raw'),'utf8');
const secrets=[...new Set([...source.matchAll(/--api-key(?:=|\s+)([^\s]+)/gu)].map(row=>row[1]).filter(value=>!value.includes('*')))];
assert.equal(fs.statSync(privateRoot).mode&0o777,0o700);
for(const file of fs.readdirSync(privateRoot))assert.equal(fs.statSync(path.join(privateRoot,file)).mode&0o777,0o600);
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
const staged=execFileSync('git',['diff','--cached','--name-only'],{cwd:main,encoding:'utf8'}).trim().split('\n').filter(Boolean);
for(const file of staged)assert.equal(file.startsWith('.logs/d110c-0c1f5b0z-green-b2594cc7/'),true,'Unexpected staged path');
let scanned=0;
for(const file of files(out)){
 const text=fs.readFileSync(file,'utf8');
 for(const secret of secrets)assert.equal(text.includes(secret),false,'Credential found in evidence file');
 scanned++;
}
for(const file of staged){
 const text=execFileSync('git',['show',`:${file}`],{cwd:main,encoding:'utf8'});
 for(const secret of secrets)assert.equal(text.includes(secret),false,'Credential found in staged blob');
}
const result={scannedEvidenceFiles:scanned,scannedStagedBlobs:staged.length,allStagedPathsEvidenceOnly:true,observedCredentialValuesAbsent:true,privateRawPermissionsVerified:true,secretValuesNeverPrinted:true};
if(process.argv[2]!=='verify-only')fs.writeFileSync(path.join(out,'staged-secret-scan.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
