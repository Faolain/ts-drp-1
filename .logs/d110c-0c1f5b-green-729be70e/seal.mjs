import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', maxBuffer: 128 * 1024 * 1024});
const write = (file, value) => fs.writeFileSync(path.join(out, file), value, {flag: 'wx'});
const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
const custody = JSON.parse(fs.readFileSync(path.join(out, 'custody-stopped.json')));
if (git('rev-parse', 'HEAD').trim() !== custody.head) throw Error('HEAD drift');
const owners = Object.keys(custody.ownerHashes);
for (const file of owners) if (hash(fs.readFileSync(path.join(root, file))) !== custody.ownerHashes[file]) throw Error('Owner drift: ' + file);
const patch = git('diff', '--binary', '--full-index', '--', ...owners);
write('partial-production.patch', patch);
write('partial-production.patch.sha256', hash(patch) + '  partial-production.patch\n');
const matrix = {};
for (const name of ['focused-01', 'focused-02']) {
  const result = JSON.parse(fs.readFileSync(path.join(out, name, 'result.json')));
  const assertions = result.testResults.flatMap(file => file.assertionResults.map(row => ({file: file.name, ...row})));
  matrix[name] = {
    total: assertions.length,
    passed: assertions.filter(row => row.status === 'passed').length,
    failed: assertions.filter(row => row.status === 'failed').length,
    filtered: assertions.filter(row => row.status === 'skipped' || row.status === 'pending').length,
    topLevelErrors: result.testResults.filter(file => file.testExecError).map(file => ({file: file.name, error: file.testExecError})),
    success: result.success,
    assertions,
  };
}
json('stopped-matrix.json', matrix);
const ledger = [];
for (const entry of fs.readdirSync(out, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory() || !fs.existsSync(path.join(out, entry.name, 'command.json'))) continue;
  ledger.push({name: entry.name, command: JSON.parse(fs.readFileSync(path.join(out, entry.name, 'command.json'))), status: JSON.parse(fs.readFileSync(path.join(out, entry.name, 'status.json'))), stdout: entry.name + '/stdout', stderr: entry.name + '/stderr'});
}
json('command-ledger.json', ledger);
const ranges = {
  'examples/v3-room/src/index.ts': [[1543,1557],[1594,1615],[1939,1994],[2300,2325],[2450,2510],[2732,2754],[2999,3038],[4290,4385],[4460,4508]],
  'packages/node/src/v3-live.ts': [[5382,5405],[6132,6155],[6490,6507],[6845,6861],[8611,8658],[8734,8780],[8962,8997]],
  'packages/node/src/creator-close.ts': [[260,267],[706,730]],
  'packages/node/src/internal/creator-transition-advance.ts': [[275,295],[937,956]],
  'packages/protocol-v3/src/creator-author-issuance-frontiers.ts': [[444,453],[821,831]],
  'packages/storage/src/values.ts': [[77,90]],
  'tests/phase-6b-d110c-0c1f5b-integration-red.test.ts': [[1340,1358],[1393,1402],[1499,1510],[1590,1604]],
};
json('source-seams.json', Object.fromEntries(Object.entries(ranges).map(([file, selections]) => {
  const bytes = fs.readFileSync(path.join(root, file));
  const lines = bytes.toString().split('\n');
  return [file, {sha256: hash(bytes), excerpts: selections.map(([from,to]) => ({from,to,text: lines.slice(from-1,to).map((line,index) => `${from+index}: ${line}`).join('\n')}))}];
})));
const signedFile = 'packages/node/src/internal/creator-transition-advance.ts';
const signedSource = git('show', custody.head + ':' + signedFile);
const signedLines = signedSource.split('\n');
json('signed-source-custody.json', {
 head: custody.head,
 file: signedFile,
 sha256: hash(signedSource),
 excerpt: signedLines.slice(836,857).map((line,index) => `${837+index}: ${line}`).join('\n'),
 blame: git('blame','-L','850,858',custody.head,'--',signedFile),
 actualBlobDomain: 'ts-drp-storage/blob/v1',
 testWholeRecordDomain: 'ts-drp/creator-author-settlement/v1',
 resolution: 'Root confirmed stale expected digest domain; preserve production candidate-ref binding.'
});
json('seal-summary.json', {head: custody.head, ownerCount: owners.length, patchSha256: hash(patch), protectedPaths: custody.protectedPaths, testHashes: custody.testHashes, matrix: Object.fromEntries(Object.entries(matrix).map(([name, value]) => [name, {total:value.total,passed:value.passed,failed:value.failed,filtered:value.filtered,topLevelErrorCount:value.topLevelErrors.length}])), productionAccepted:false, signedByThisAgent:false});
const collect = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? collect(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const files = collect(out).filter(file => path.basename(file) !== 'manifest.sha256').sort();
write('manifest.sha256', files.map(file => hash(fs.readFileSync(file)) + '  ' + path.relative(out, file)).join('\n') + '\n');
console.log(JSON.stringify({files: files.length, manifestSha256: hash(fs.readFileSync(path.join(out, 'manifest.sha256'))), patchSha256: hash(patch)}));
