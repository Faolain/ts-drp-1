import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const evidence = '.logs/d110c-0c1f5b-red-observer-78e068a8';
const plan = 'docs/production-hardening/production-hardening-tdd-plan-v2.md';
const read = file => fs.readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8', maxBuffer:128*1024*1024}).trimEnd();
const manifest = read(evidence + '/manifest.sha256').toString();
const entries = manifest.trim().split('\n');
for (const row of entries) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
  if (!match || hash(read(evidence + '/' + match[2])) !== match[1]) throw Error('manifest: ' + row);
}
if (entries.length !== 63) throw Error('manifest count');
const report = json(evidence + '/focused.json'), result = json(evidence + '/result.json'), isolation = json(evidence + '/isolation-before.json');
const rows = report.testResults.flatMap(file => file.assertionResults);
const counts = Object.fromEntries(['passed','failed','skipped'].map(status => [status,rows.filter(row => row.status === status).length]));
if (rows.length !== 45 || report.testResults.length !== 2 || counts.passed !== 5 || counts.failed !== 23 || counts.skipped !== 17 || result.executionCount !== 1 || result.violations.length || result.topLevel.length) throw Error('matrix');
for (const outcome of result.outcomes) {
  const row = rows.find(row => row.fullName === outcome.name);
  if (!row || row.status !== outcome.status || JSON.stringify(row.failureMessages) !== JSON.stringify(outcome.failureMessages)) throw Error(outcome.name);
}
for (const [file, digest] of Object.entries(isolation.sourceHashes)) {
  const committed = execFileSync('git', ['-C', root, 'show', isolation.head + ':' + file], {maxBuffer:32*1024*1024});
  if (hash(committed) !== digest || hash(fs.readFileSync(path.join(isolation.root,file))) !== digest) throw Error('isolated source: ' + file);
}
const before = json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
const productionPaths = git('diff','--name-only','--','packages','examples').split('\n').filter(Boolean);
if (productionPaths.length !== 7 || git('diff','--',...productionPaths) !== before.diff || git('stash','list','--format=%H %gd %gs') !== before.stashes || git('diff','--cached')) throw Error('custody');
const head = git('rev-parse','HEAD'), remote = git('ls-remote','origin','refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/)[0];
if (head !== remote) throw Error('remote');
const commands = [];
for (const [command,args,env] of [
  ['git',['-C',root,'diff','--check','--',plan],process.env],
  ['pnpm',['exec','prettier','--check',plan],{...process.env,NODE_OPTIONS:'--max-old-space-size=12288'}],
]) {
  const start = new Date().toISOString();
  const run = spawnSync(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024});
  commands.push({command,args,nodeOptions:env.NODE_OPTIONS ?? null,start,finish:new Date().toISOString(),status:run.status,signal:run.signal,stdout:run.stdout,stderr:run.stderr});
}
const audit = {head,remote,signature:git('log','--format=%h %G? %s','-1'),evidence,manifest:hash(manifest),entries:entries.length,files:report.testResults.length,total:rows.length,counts,executionCount:result.executionCount,rawOutcomesMatch:true,isolatedSourceMatchesSignedTree:true,isolatedRoot:isolation.root,testCommit:isolation.head,sourceFiles:Object.keys(isolation.sourceHashes).length,reporterHash:hash(read(evidence+'/focused.json')),productionPatchUnchanged:true,stashCount:before.stashes.split('\n').length,stashesUnchanged:true,commands,planHash:hash(read(plan)),newRuntimeRuns:0,newReviewRuns:0};
fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
if (commands.some(command => command.status !== 0)) throw Error('static failure; preserved');
const sealed = fs.readdirSync(out).filter(name => name !== 'manifest.sha256').sort().map(name=>hash(fs.readFileSync(path.join(out,name)))+'  '+name).join('\n')+'\n';
fs.writeFileSync(path.join(out,'manifest.sha256'),sealed,{flag:'wx'});
console.log(JSON.stringify({head,remote,entries:entries.length,counts,commands:commands.map(command=>({command:command.command,status:command.status})),manifest:hash(sealed)},null,2));
