import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
const working=dirname(new URL(import.meta.url).pathname);
const repo=resolve(working,'../..');
const green='ea02487e9c80d25ab6e7038cdf35330b72f29de6';
const target=resolve(repo,'.logs/d110c-0c1f5b0u-green-ea02487e');
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(readFileSync(resolve(working,p)));
const fileRows=j=>j.testResults.flatMap(f=>f.assertionResults.map(a=>({title:a.fullName,status:a.status,failures:a.failureMessages.map(m=>m.split('\n')[0])})));
const summary=j=>({total:j.numTotalTests,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,files:j.testResults.length,success:j.success,assertions:fileRows(j)});
for(const p of ['focused-final','isolated-focused']){const j=json(`${p}/result.json`);assert.equal(j.numTotalTests,70);assert.equal(j.numPassedTests,70);assert.equal(j.numFailedTests,0);assert.equal(j.numPendingTests,0);assert.equal(j.success,true);assert.equal(j.testResults.length,5);}
const local=[],isolated=[];
for(let i=1;i<=27;i++){
 const suffix=String(i).padStart(2,'0');
 const label=i===22?'retained-22-corrected':`retained-${suffix}`;
 const a=json(`${label}/result.json`),b=json(`isolated-retained-${suffix}/result.json`);
 assert.deepEqual(fileRows(a),fileRows(b),`isolated retained matrix changed ${suffix}`);
 if(i!==10 && i!==22){assert.equal(a.success,true);assert.equal(b.success,true);assert.equal(a.numFailedTests+b.numFailedTests,0);}
 local.push({label,...summary(a)});isolated.push({label:`isolated-retained-${suffix}`,...summary(b)});
}
assert.deepEqual(fileRows(json('retained-10/result.json')),fileRows(json('parent-retained-10/result.json')));
const parent22=fileRows(json('parent-retained-22/result.json')).filter(r=>r.status==='failed');
assert.deepEqual(fileRows(json('retained-22-corrected/result.json')).filter(r=>r.status==='failed'),parent22);
const browser=[];
for(const p of ['chromium-expanded','isolated-chromium']){
 const j=json(`${p}/stdout`);assert.deepEqual(j.errors,[]);assert.equal(j.stats.expected,1);assert.equal(j.stats.skipped+j.stats.unexpected+j.stats.flaky,0);
 const r=j.suites[0].specs[0].tests[0].results[0];assert.deepEqual(r.errors,[]);assert.equal(r.status,'passed');
 const attachment=JSON.parse(Buffer.from(r.attachments[0].body,'base64'));
 assert.deepEqual(attachment.result.map(v=>v.name),['zero-origin','nonempty-origin','partial','final','stale-revision','inexact-revision']);
 browser.push({label:p,stats:j.stats,...attachment});
}
const normalized=p=>readFileSync(resolve(working,p,'stdout'),'utf8').split('\n').filter(l=>l.includes('error TS')).map(l=>l.replaceAll(repo,'ROOT').replaceAll('/private/tmp/d110c-f5b0u-parent-Mdi0UL/checkout','ROOT').replaceAll('/private/tmp/d110c-f5b0u-green-75Jm2F/checkout','ROOT').replace(/\(\d+,\d+\)/g,'(LINE,COL)')).sort();
const parentDiagnostics=normalized('parent-typechecks');assert.equal(parentDiagnostics.length,231);
assert.deepEqual(normalized('typechecks'),parentDiagnostics);assert.deepEqual(normalized('isolated-typechecks'),parentDiagnostics);
const pre=json('custody-before-corrected/stdout'),post=json('custody-final/stdout'),clean=json('isolated-custody/stdout');
assert.deepEqual(pre.protected,post.protected);assert.deepEqual(pre.stashes,post.stashes);assert.equal(post.stashes.count,27);assert.equal(post.head,green);assert.equal(post.trackedStatus,'');assert.equal(clean.head,green);assert.equal(clean.trackedStatus,'');
for(const name of Object.keys(clean.runtime.imports))assert.equal(clean.runtime.imports[name].sha256,post.runtime.imports[name].sha256);
for(const label of ['builds','isolated-builds','lint-final','format-final','diff-check','source-audit-final','isolated-source-audit','isolated-freshness','isolated-install','isolated-final-status'])assert.equal(json(`${label}/status.json`).code,0,label);
mkdirSync(target);
cpSync(working,resolve(target,'commands'),{recursive:true,errorOnExist:true,force:false});
cpSync(resolve(repo,'.logs/d110c-0c1f5b0u-green-working-a787b649'),resolve(target,'prior-diagnostics'),{recursive:true,errorOnExist:true,force:false});
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
writeFileSync(resolve(target,'production.diff'),git('show','--format=fuller','--binary',green),{flag:'wx'});
writeFileSync(resolve(target,'production-identity.json'),JSON.stringify({commit:green,tree:git('rev-parse',`${green}^{tree}`).trim(),signature:git('log','--format=%G?','-1',green).trim(),remote:git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').trim(),paths:git('diff-tree','--no-commit-id','--name-only','-r',green).trim().split('\n')},null,2)+'\n',{flag:'wx'});
const totals=rows=>rows.reduce((a,r)=>({total:a.total+r.total,passed:a.passed+r.passed,failed:a.failed+r.failed,pending:a.pending+r.pending}),{total:0,passed:0,failed:0,pending:0});
writeFileSync(resolve(target,'results.json'),JSON.stringify({green,focused:summary(json('focused-final/result.json')),isolatedFocused:summary(json('isolated-focused/result.json')),browser,localRetained:{totals:totals(local),files:local},isolatedRetained:{totals:totals(isolated),files:isolated},typechecks:{issuanceStore:'pass',room:'pass',node:'inherited failure',storageBrowser:'inherited failure',storageNode:'inherited failure',normalizedDiagnosticCount:231,normalizedDiagnosticSha256:hash(parentDiagnostics.join('\n')),noNewDiagnosticHeaders:true,normalization:'Absolute checkout roots and line/column positions only; exact diagnostic text/multiplicity preserved.'},remainingDebt:['Retained phase-3g mocked room fixtures: 18 inherited canonical parameter decode failures before settlement, exact untouched-parent comparison.','Retained creator-successor product unsupported-cold-composition expectation: one inherited failure, exact untouched-parent comparison.','Package-wide Node/browser/node-storage test configuration/type debt:231 identical normalized diagnostic headers.','Parent f5b owns authenticated checkpoint frontier, successful settlement-profile close/adoption and migration activation, current hot-successor declaration custody,64-writer3-close and long-horizon gates.','Formal final review and plan closure are parent-owned and have not occurred.'],noNewFailure:true,scope:{testEdits:false,planEdits:false,productionPaths:9,reviewersRun:false,workloadOrThresholdChange:false}},null,2)+'\n',{flag:'wx'});
writeFileSync(resolve(target,'typecheck-normalized.txt'),parentDiagnostics.join('\n')+'\n',{flag:'wx'});
function files(dir){return readdirSync(dir).sort().flatMap(n=>{const p=resolve(dir,n);return statSync(p).isDirectory()?files(p):[p];});}
const manifest=files(target).map(p=>`${hash(readFileSync(p))}  ${relative(target,p)}`).join('\n')+'\n';
writeFileSync(resolve(target,'manifest.sha256'),manifest,{flag:'wx'});
for(const line of manifest.trim().split('\n')){const [expected,p]=line.split('  ');assert.equal(hash(readFileSync(resolve(target,p))),expected);}
assert.equal(files(target).length,manifest.trim().split('\n').length+1);
console.log(JSON.stringify({root:target,files:files(target).length,manifestSha256:hash(manifest),localRetained:totals(local),isolatedRetained:totals(isolated),status:'validated; formal review pending'},null,2));
