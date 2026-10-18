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
  'examples/v3-room/src/index.ts': [[1543,1557],[2248,2274],[2360,2455],[2468,2504],[3265,3305],[4199,4338]],
  'packages/node/src/v3-live.ts': [[6132,6154],[8611,8658],[8734,8779],[8962,8997]],
  'tests/phase-6b-d110c-0c1f5b-integration-red.test.ts': [[693,709],[1152,1169],[1608,1621],[1919,1938],[2434,2448]],
};
json('source-seams.json', Object.fromEntries(Object.entries(ranges).map(([file, selections]) => {
  const bytes = fs.readFileSync(path.join(root, file));
  const lines = bytes.toString().split('\n');
  return [file, {sha256: hash(bytes), excerpts: selections.map(([from,to]) => ({from,to,text: lines.slice(from-1,to).map((line,index) => `${from+index}: ${line}`).join('\n')}))}];
})));
json('seal-summary.json', {head: custody.head, ownerCount: owners.length, patchSha256: hash(patch), protectedPaths: custody.protectedPaths, testHashes: custody.testHashes, matrix: Object.fromEntries(Object.entries(matrix).map(([name, value]) => [name, {total:value.total,passed:value.passed,failed:value.failed,filtered:value.filtered,topLevelErrorCount:value.topLevelErrors.length}])), productionAccepted:false, signedByThisAgent:false});
const collect = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? collect(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const files = collect(out).filter(file => path.basename(file) !== 'manifest.sha256').sort();
write('manifest.sha256', files.map(file => hash(fs.readFileSync(file)) + '  ' + path.relative(out, file)).join('\n') + '\n');
console.log(JSON.stringify({files: files.length, manifestSha256: hash(fs.readFileSync(path.join(out, 'manifest.sha256'))), patchSha256: hash(patch)}));
