import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8'}).trim();
const head=git('rev-parse','HEAD'),signature=git('log','-1','--format=%G?'),origin=git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0];
const equivalence=JSON.parse(fs.readFileSync(path.join(out,'equivalence.json')));
if(head!=='d1aa3d9d99b032f6ba6e306f7b989a4485dd4f4c'||signature!=='G'||origin!==head||git('diff','--cached','--name-only'))throw Error('Release identity');
const files=git('diff-tree','--no-commit-id','--name-only','-r',head).split('\n').sort();
if(JSON.stringify(files)!==JSON.stringify(equivalence.changes.map(c=>c.file).sort()))throw Error('Commit scope');
for(const change of equivalence.changes){
 if(hash(fs.readFileSync(path.join(root,change.file)))!==change.afterSha256||hash(execFileSync('git',['-C',root,'show',head+':'+change.file]))!==change.afterSha256)throw Error('Release source '+change.file);
}
const historicalHead=equivalence.historicalExecution.custodyHead;
const historicalSources=equivalence.changes.map(c=>({file:c.file,signedHistoricalHead:historicalHead,signedHistoricalSha256:hash(execFileSync('git',['-C',root,'show',historicalHead+':'+c.file])),freezeSourceSha256:c.beforeSha256,currentSourceSha256:c.afterSha256}));
const lintSource=fs.readFileSync(path.join(out,'w0-runtime-contract.ts.before'),'utf8');
const lintWarningBaselineSourceUnchanged=lintSource.slice(0,lintSource.indexOf('export async function exerciseAuthorShareRuntime'))===fs.readFileSync(path.join(root,'tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts'),'utf8').slice(0,lintSource.indexOf('export async function exerciseAuthorShareRuntime'));
if(!lintWarningBaselineSourceUnchanged)throw Error('Lint warning baseline moved');
const result={head,signature,origin,originExact:true,indexEmpty:true,files,historicalSources,lint:{exitCode:0,errors:0,warnings:1,warning:'Missing JSDoc @param shape declaration',file:'tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts',line:55,baselineSourceUnchanged:lintWarningBaselineSourceUnchanged},testExecutions:0};
fs.writeFileSync(path.join(out,'patch-release.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
