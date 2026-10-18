import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const main = '/Users/aristotle/Documents/Projects/ts-drp-1';
const evidence = path.join(main, '.logs/d110c-w0-isolated-7efe33dd');
const read = name => JSON.parse(fs.readFileSync(path.join(evidence, name)));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const roster = read('runtime-roster.json');
const root = roster.isolatedRoot;
const identities = entries => entries.map(e => JSON.stringify([e.file, e.name])).sort();
assert.equal(hash(path.join(evidence, 'runtime-roster.json')), '74032e771abc2b90c42ffaf16628152d4960fd7f0c523946833b0a7537820a6d');
for (const [file, digest] of Object.entries(roster.inputHashes)) {
  assert.ok(fs.realpathSync(file).startsWith(root + '/'), file);
  assert.equal(hash(file), digest, file);
}
for (const [file, digest] of Object.entries(roster.artifactHashes)) assert.equal(hash(path.join(evidence, file)), digest, file);
assert.equal(hash(roster.node), roster.nodeSha256);
assert.equal(hash(roster.vitest), roster.vitestSha256);
const prior = JSON.parse(fs.readFileSync(path.join(main, '.logs/d110c-w0-regression-readiness-7efe33dd/runtime-roster.json')));
assert.deepEqual(identities(roster.entries), identities(prior.entries));
assert.equal(new Set(identities(roster.entries)).size, 232);
for (const gate of roster.gates) {
  const old = prior.gates.find(g => g.label === gate.label);
  assert.deepEqual(identities(gate.entries), identities(old.entries));
  assert.equal(gate.budgetMs, old.budgetMs);
  assert.equal(gate.maxInvocations, 1);
}
const mp = read('program-identity-main.json'), ip = read('program-identity-isolated.json');
const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(root, main));
assert.deepEqual(normalize(ip.options), mp.options);
assert.deepEqual(normalize(ip.rootNames), mp.rootNames);
assert.deepEqual(normalize(ip.edges), mp.edges);
assert.equal(ip.rootNames.length, 40);
const ms = new Map(mp.sources.map(s => [s.physical, s.sha256]));
for (const source of ip.sources) {
  assert.equal(ms.get(source.physical.replace(root, main)), source.sha256);
  assert.equal(hash(source.physical), source.sha256);
}
assert.ok(ip.compilerPath.startsWith(root + '/node_modules/'));
for (const link of read('source-isolation.json').symlinks) {
  assert.ok(link.physical.startsWith(root + '/'));
  assert.equal(fs.realpathSync(path.join(root, link.file)), link.physical);
}
for (const repo of [main, root]) {
  const patch = execFileSync('git', ['-C', repo, 'diff', '--binary', '--full-index']);
  assert.equal(crypto.createHash('sha256').update(patch).digest('hex'), roster.sourcePatchSha256);
}
const disposition = read('typecheck-disposition.json');
assert.equal(disposition.newDiagnostics, 0);
assert.equal(disposition.removedDiagnostics, 0);
assert.equal(disposition.wholeProgramPass, false);
const label = process.argv[2];
if (label) {
  const gate = roster.gates.find(g => g.label === label);
  assert.ok(gate);
  const result = read(label + '/result.json'), status = read(label + '/status.json');
  const actual = result.testResults.flatMap(file => file.assertionResults.map(test => {
    assert.equal(test.status, 'passed');
    assert.deepEqual(test.failureMessages, []);
    return { file: path.relative(root, file.name), name: [...test.ancestorTitles, test.title].join(' > ') };
  }));
  assert.deepEqual(identities(actual), identities(gate.entries));
  assert.equal(new Set(identities(actual)).size, actual.length);
  assert.equal(result.numTotalTests, actual.length);
  assert.equal(result.numPassedTests, actual.length);
  assert.equal(result.numFailedTests + result.numPendingTests + result.numTodoTests, 0);
  assert.equal(result.success, true);
  assert.equal(status.code, 0);
  assert.equal(status.timedOut, false);
  assert.equal(status.quiescent, true);
  assert.deepEqual(status.cleanup, []);
  assert.deepEqual(status.remainingOwnedGroup, []);
  assert.ok(status.elapsedMs < gate.budgetMs);
  const v = read(label + '/validation.json');
  for (const k of ['green', 'exactRoster', 'postCustodyExact', 'isolatedCustodyExact', 'allInputsExact']) assert.equal(v[k], true);
  console.log(JSON.stringify({ label, passed: actual.length, elapsedMs: status.elapsedMs, verified: true }));
}
console.log(JSON.stringify({ ready: true, inputs: Object.keys(roster.inputHashes).length, cases: roster.entries.length, compilerRoots: ip.rootNames.length, commonSources: ip.sources.length, dependencyLinks: read('source-isolation.json').symlinks.length, wholeProgramPass: false }));
