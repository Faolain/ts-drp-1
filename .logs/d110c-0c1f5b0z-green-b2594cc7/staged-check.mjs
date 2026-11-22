import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const main='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const relative=path.relative(main,out);
const rawExceptions=['baseline-typecheck-storage/stdout','browser-process-preflight/stdout','initial-typecheck-storage/stdout','main-eslint/stdout','production.patch','signed-typecheck-storage/stdout'];
function run(args){const result=spawnSync('git',args,{cwd:main,encoding:'utf8'});return{command:['git',...args],status:result.status,stdout:result.stdout,stderr:result.stderr};}
const full=run(['diff','--cached','--check','--',relative]);
const scoped=run(['diff','--cached','--check','--',relative,...rawExceptions.map(file=>`:(exclude)${relative}/${file}`)]);
assert.equal(full.status,2);assert.equal(scoped.status,0);
assert.equal(full.stderr,'');assert.equal(scoped.stderr,'');
const result={full,scoped,rawExceptions,disposition:'Only exact captured output and patch whitespace are exempt. Production owners, docs, scripts and all other evidence must pass; published process output has separately recorded credential redaction.'};
if(process.argv[2]!=='verify-only')fs.writeFileSync(path.join(out,'staged-whitespace-check.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({fullStatus:full.status,scopedStatus:scoped.status,rawExceptions}));
