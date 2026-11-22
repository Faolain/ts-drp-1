import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const release = read('root-runtime-release.json');
if (hash(fs.readFileSync(path.join(out, 'runtime-roster.json'))) !== release.runtimeRosterSha256) throw Error('Roster drift');
const roster = read('runtime-roster.json');
const gate = roster.gates.find(gate => gate.label === 'runtime-checkpoint');
const result = read('runtime-checkpoint/result.json');
const status = read('runtime-checkpoint/status.json');
const diagnostic = read('runtime-checkpoint/diagnostic.json');
const actual = result.testResults.flatMap(file => file.assertionResults.map(assertion => ({ file: path.relative(root, file.name), name: [...assertion.ancestorTitles, assertion.title].join(' > '), status: assertion.status, failureMessages: assertion.failureMessages })));
const key = entry => entry.file + ' :: ' + entry.name;
const actualKeys = actual.map(key).sort();
const expectedKeys = gate.entries.map(key).sort();
const exactRoster = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && new Set(actualKeys).size === actualKeys.length;
const passed = actual.filter(entry => entry.status === 'passed');
const failures = actual.filter(entry => entry.status === 'failed');
const otherStatuses = actual.filter(entry => !['passed', 'failed'].includes(entry.status));
const exactFailures = JSON.stringify(failures.map(entry => entry.name).sort()) === JSON.stringify([...gate.predictedFailureNames].sort());
const newControlNames = roster.added.map(entry => entry.name);
const newControlsPassed = newControlNames.every(name => passed.some(entry => entry.name === name));
const countsExact = result.numTotalTests === 7 && result.numPassedTests === 4 && result.numFailedTests === 3 && result.numPendingTests === 0 && result.numTodoTests === 0 && passed.length === 4 && failures.length === 3;
if (!exactRoster || !exactFailures || !newControlsPassed || !countsExact || otherStatuses.length || status.code !== 1 || status.timedOut || !status.quiescent) throw Error('Unexpected RED outcome');
const pin = diagnostic.coldBootstrap.inputs;
const census = { current: diagnostic.census.current.length, proposed: diagnostic.census.proposed.length, active: diagnostic.census.active.length };
if (JSON.stringify(pin) !== JSON.stringify([{ pinMatchesOriginal: false, pinPresent: false, site: 'epoch-two' }]) || JSON.stringify(census) !== JSON.stringify({ current: 7, proposed: 6, active: 7 })) throw Error('Unexpected diagnostic observations');
if (diagnostic.bounded.ok !== false || diagnostic.bounded.reason !== 'TRUST_CLOSURE_INVALID' || diagnostic.coldReopen.ok !== false || diagnostic.coldReopen.kind !== 'recovery-rejected' || diagnostic.coldReopen.detail !== 'creator predecessor recovery failed: admission-rejected') throw Error('Causal boundary changed');
const coldFailure = failures.find(entry => entry.name.endsWith('cold reopens the genuine active epoch-two room through the bounded checkpoint owner'));
if (coldFailure.failureMessages.length !== 2 || !coldFailure.failureMessages[0].includes('pinMatchesOriginal: false') || !coldFailure.failureMessages[1].includes('handle: { epoch: 2 }')) throw Error('Cold soft and original failure evidence incomplete');
const validation = { exactRoster, exactFailureSet: exactFailures, newControlsPassed, tests: 7, passed: 4, failed: 3, pending: 0, todo: 0, skipped: 0, otherStatuses, failures, passedCases: passed, quiescent: true, elapsedMs: status.elapsedMs, unexpectedOutcomes: [], green: false, validCausalRed: true, diagnostic: { bounded: diagnostic.bounded, coldReopen: diagnostic.coldReopen, coldBootstrapInputs: pin, census }, originalStaticHandoffPreserved: true, noHeavyChildReplay: true };
write('runtime-checkpoint/validation.json', validation);
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
const group = read('runtime-checkpoint/execution-start.json').ownedProcessGroup;
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
if (ps.status !== 0) throw Error('Owned group verification failed');
const groupMembers = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u)).filter(fields => Number(fields[2]) === group);
if (groupMembers.length !== 0) throw Error('Owned process group still active');
const expectedDirty = [...Object.keys(custody.protectedSources), ...custody.targets].sort();
if (JSON.stringify(git('diff', '--name-only').split('\n').filter(Boolean).sort()) !== JSON.stringify(expectedDirty)) throw Error('Tracked dirty-owner set changed');
const protectedResult = { baseline: release.baseline, signature: 'G', indexEmpty: true, protectedSources: 11, redSources: 6, sourceHashes: custody.targetHashes, builtIdentities: 7, stashes: 27, protectedPaths: original.untracked.length, manifestRoots: Object.keys(custody.manifests).length, protectedEvidenceFiles, inputCount: Object.keys(roster.inputHashes).length, allHashesAndPathsPreserved: true, sourcePatchSha256: hash(patch), runtimeBinariesExact: true, ownedProcessGroup: group, remainingOwnedGroup: [], quiescent: true, trackedStatus: git('status', '--short', '--untracked-files=no') };
write('custody-after-runtime.json', protectedResult);
write('runtime-handoff.json', {
  status: 'Bounded consumer RED proven; separate GREEN required', baseline: release.baseline, sourceCommitted: false, evidenceCommitted: false,
  invocationCount: 1, gate: 'runtime-checkpoint', runtimeRosterSha256: release.runtimeRosterSha256, command: 'runtime-checkpoint/command.json', result: 'runtime-checkpoint/result.json', diagnostic: 'runtime-checkpoint/diagnostic.json', validation: 'runtime-checkpoint/validation.json',
  tests: 7, passed: 4, failed: 3, pending: 0, todo: 0, skipped: 0, elapsedMs: status.elapsedMs, exactRoster: true, exactPredictedFailureSet: true, newAggregateControlsPassed: true, failureNames: failures.map(entry => entry.name),
  bootstrap: { epochTwo: 'Genuine original epoch-zero bootstrap validated; actual supplied pin absent and unequal; original predecessor admission-rejected failure also preserved.', currentSuccessor: 'Static-only observer wiring; no dynamic execution of the failure-recovery site claimed.' },
  publicStoreShape: 'Historical retained boundedStoreShape:false remains causal RED; added observer not runtime-replayed; sameStoreShape and boundedRecoveryStore implementation bytes unchanged.',
  custody: 'custody-after-runtime.json', sourcePatch: 'red.patch', sourcePatchSha256: release.sourcePatchSha256, protectedInputs: 942, allProtectedSourcesBuildsStashesPathsEvidencePreserved: true,
  static: { lint: 'pass', format: 'pass', diff: 'pass', observationAssertionEquivalence: 'pass', typecheck: '26 baseline diagnostics, zero new; not whole-program pass' },
  priorStaticHandoffAndRosterUnmodified: true, retries: 0, heavyChildInvocations: 0, otherTestsExecuted: 0, builds: 0, reviewers: 0, indexEmpty: true, processGroupQuiescent: true,
  nextOwner: 'Root for documentation/signing/push, then separate GREEN agent for only the three frozen fixture implementation corrections.',
  noMoreRuntimeReleased: true, futureGreenRoster: { files: 14, cases: 51, requiresNewSourceAndInputFreeze: true }, manifest: 'manifest.sha256',
});
console.log(JSON.stringify({ validCausalRed: true, tests: 7, passed: 4, failed: 3, pending: 0, skipped: 0, custodyPreserved: true, protectedInputs: 942, protectedEvidenceFiles, quiescent: true, indexEmpty: true }));
