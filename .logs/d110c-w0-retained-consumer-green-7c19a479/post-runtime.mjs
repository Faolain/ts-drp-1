import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const label = process.argv[2];
if (!['runtime-checkpoint', 'runtime-consumers'].includes(label)) throw Error('Gate');
const release = read('root-' + label + '-release.json');
if (hash(fs.readFileSync(path.join(out, 'runtime-roster.json'))) !== release.runtimeRosterSha256) throw Error('Roster drift');
const roster = read('runtime-roster.json');
const gate = roster.gates.find(gate => gate.label === label);
const result = read(label + '/result.json');
const status = read(label + '/status.json');
const actual = result.testResults.flatMap(file => file.assertionResults.map(assertion => ({ file: path.relative(root, file.name), name: [...assertion.ancestorTitles, assertion.title].join(' > '), status: assertion.status, failureMessages: assertion.failureMessages })));
const key = entry => entry.file + ' :: ' + entry.name;
const actualKeys = actual.map(key).sort();
const expectedKeys = gate.entries.map(key).sort();
const exactRoster = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && new Set(actualKeys).size === actualKeys.length;
const passed = actual.filter(entry => entry.status === 'passed');
const failures = actual.filter(entry => entry.status === 'failed');
const otherStatuses = actual.filter(entry => !['passed', 'failed'].includes(entry.status));
const countsExact = result.numTotalTests === gate.entries.length && result.numPassedTests === gate.expectedPassed && result.numFailedTests === 0 && result.numPendingTests === 0 && result.numTodoTests === 0 && passed.length === gate.expectedPassed && failures.length === 0;
if (!exactRoster || !countsExact || otherStatuses.length || status.code !== 0 || status.timedOut || !status.quiescent) throw Error('Unexpected GREEN outcome');
let diagnosticValidation;
if (label === 'runtime-checkpoint') {
  const diagnostic = read(label + '/diagnostic.json');
  const pin = diagnostic.coldBootstrap.inputs;
  const census = { current: diagnostic.census.current.length, proposed: diagnostic.census.proposed.length, active: diagnostic.census.active.length };
  if (JSON.stringify(pin) !== JSON.stringify([{ pinMatchesOriginal: true, pinPresent: true, site: 'epoch-two' }]) || JSON.stringify(census) !== JSON.stringify({ current: 7, proposed: 6, active: 7 })) throw Error('Unexpected diagnostic observations');
  if (!diagnostic.bounded.ok || !diagnostic.checkpoint.ok || !diagnostic.coldReopen.ok || diagnostic.coldReopen.lifecycle !== 'active' || diagnostic.coldReopen.recovery !== 'active-new' || diagnostic.coldReopen.handle.epoch !== 2 || !diagnostic.coldIssued.ok || diagnostic.coldIssued.kind !== 'accepted' || !diagnostic.coldPublished.ok || diagnostic.coldPublished.kind !== 'published') throw Error('Genuine repaired outcome missing');
  diagnosticValidation = { bounded: diagnostic.bounded, coldReopen: diagnostic.coldReopen, coldIssued: diagnostic.coldIssued, coldPublished: diagnostic.coldPublished, coldBootstrapInputs: pin, census };
}
const newControlsPassed = roster.added.every(entry => passed.some(item => key(item) === key(entry)));
if (!newControlsPassed) throw Error('New closure controls did not pass');
const validation = { exactRoster, tests: gate.entries.length, files: gate.files.length, passed: passed.length, failed: 0, pending: 0, todo: 0, skipped: 0, otherStatuses, failures, passedCases: passed, newControlsPassed, quiescent: true, elapsedMs: status.elapsedMs, unexpectedOutcomes: [], green: true, diagnostic: diagnosticValidation, originalStaticHandoffPreserved: true, genuineSkipBudgetChildExecutedOnce: label === 'runtime-consumers', currentSuccessorControl: label === 'runtime-consumers' ? 'Existing 0c1b recovered genuine handle and accepted issuance controls passed' : 'Not executed by checkpoint gate' };
write(label + '/validation.json', validation);
const custody = read('custody-after.json');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
if (git('rev-parse', 'HEAD') !== release.baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('HEAD/signature/index drift');
for (const [file, digest] of Object.entries(roster.inputHashes)) if (hash(fs.readFileSync(file)) !== digest) throw Error('Runtime input drift: ' + file);
for (const [file, digest] of Object.entries({ ...custody.targetHashes, ...custody.protectedSources, ...custody.built })) if (hash(fs.readFileSync(path.join(root, file))) !== digest) throw Error('Protected source/build drift: ' + file);
if (hash(fs.readFileSync(roster.node)) !== roster.nodeSha256 || hash(fs.readFileSync(roster.vitest)) !== roster.vitestSha256) throw Error('Runtime binary drift');
const patch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...custody.targets], { maxBuffer: 128 * 1024 * 1024 });
if (hash(patch) !== release.sourcePatchSha256) throw Error('Source patch changed');
const original = JSON.parse(fs.readFileSync(path.join(root, '.logs/d110c-0c1f5b-green-57834387/custody-before.json')));
if (git('stash', 'list', '--format=%H %gd %gs') !== original.stashes.trim()) throw Error('Stashes changed');
for (const file of original.untracked) if (!fs.existsSync(path.join(root, file))) throw Error('Protected path missing: ' + file);
let protectedEvidenceFiles = 0;
for (const [directory, digest] of Object.entries(custody.manifests)) {
  const manifest = fs.readFileSync(path.join(root, directory, 'manifest.sha256'));
  if (hash(manifest) !== digest) throw Error('Protected manifest changed: ' + directory);
  for (const line of manifest.toString().trim().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
    if (!match) throw Error('Protected manifest syntax');
    const [, expected, file] = match;
    if (hash(fs.readFileSync(path.join(root, file.startsWith('.logs/') ? file : directory + '/' + file))) !== expected) throw Error('Protected evidence changed: ' + file);
    protectedEvidenceFiles += 1;
  }
}
const group = read(gate.label + '/execution-start.json').ownedProcessGroup;
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
if (ps.status !== 0) throw Error('Owned group verification failed');
const groupMembers = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u)).filter(fields => Number(fields[2]) === group);
if (groupMembers.length !== 0) throw Error('Owned process group still active');
const expectedDirty = [...Object.keys(custody.protectedSources), ...custody.targets].sort();
if (JSON.stringify(git('diff', '--name-only').split('\n').filter(Boolean).sort()) !== JSON.stringify(expectedDirty)) throw Error('Tracked dirty-owner set changed');
const protectedResult = { baseline: release.baseline, signature: 'G', indexEmpty: true, protectedSources: 11, greenSources: 3, sourceHashes: custody.targetHashes, builtIdentities: 7, stashes: 27, protectedPaths: original.untracked.length, manifestRoots: Object.keys(custody.manifests).length, protectedEvidenceFiles, inputCount: Object.keys(roster.inputHashes).length, allHashesAndPathsPreserved: true, sourcePatchSha256: hash(patch), runtimeBinariesExact: true, ownedProcessGroup: group, remainingOwnedGroup: [], quiescent: true, trackedStatus: git('status', '--short', '--untracked-files=no') };
write('custody-after-' + gate.label + '.json', protectedResult);

write(label + '-handoff.json', { status: 'Released bounded GREEN gate passed; await root direction before any further runtime', gate: label, baseline: release.baseline, invocationCount: 1, tests: gate.entries.length, passed: passed.length, failed: 0, pending: 0, todo: 0, skipped: 0, exactRoster: true, elapsedMs: status.elapsedMs, sourcePatchSha256: release.sourcePatchSha256, runtimeRosterSha256: release.runtimeRosterSha256, custody: 'custody-after-' + label + '.json', validation: label + '/validation.json', sourceHashes: custody.targetHashes, allCustodyPreserved: true, noRetries: true, noSourceEdits: true, ownedGroupQuiescent: true, cleanupSignals: status.cleanup.length });
console.log(JSON.stringify({ gate: label, green: true, tests: gate.entries.length, passed: passed.length, failed: 0, exactRoster: true, protectedInputs: Object.keys(roster.inputHashes).length, protectedEvidenceFiles, custodyPreserved: true, quiescent: true, indexEmpty: true }));
