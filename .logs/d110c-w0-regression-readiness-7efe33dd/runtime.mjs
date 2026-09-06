import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { root, out, baseline, hash, bytes, read, write, exact, custody, readiness } from './common.mjs';
const label = process.argv[2];
if (!['runtime-w0', 'runtime-retained', 'runtime-bootstrap-supplement'].includes(label)) throw Error('Exact gate required');
const release = read('root-' + label + '-release.json');
const rosterBytes = bytes(path.join(out, 'runtime-roster.json'));
const roster = JSON.parse(rosterBytes), gate = roster.gates.find(entry => entry.label === label);
if (release.gate !== label || release.baseline !== baseline || release.maxInvocations !== 1 || release.runtimeRosterSha256 !== hash(rosterBytes) || release.sourcePatchSha256 !== roster.sourcePatchSha256) throw Error('Root release scope/hash mismatch');
const expectedCount = { 'runtime-w0': 7, 'runtime-retained': 222, 'runtime-bootstrap-supplement': 3 }[label];
if (gate.entries.length !== expectedCount || gate.maxInvocations !== 1) throw Error('Gate scope mismatch');
for (const [file, digest] of Object.entries(roster.artifactHashes)) if (hash(bytes(path.join(out, file))) !== digest) throw Error('Frozen preparation artifact changed: ' + file);
if (label !== 'runtime-w0') {
  const prior = read('runtime-w0/validation.json');
  if (!prior.green || prior.passed !== 7 || !prior.exactRoster) throw Error('W0 GREEN required');
}
if (label === 'runtime-bootstrap-supplement') {
  const prior = read('runtime-retained/validation.json');
  if (!prior.green || prior.passed !== 222 || !prior.exactRoster) throw Error('Retained GREEN required');
}
const currentCustody = custody();
if (JSON.stringify(currentCustody) !== JSON.stringify(read('custody-after.json'))) throw Error('Frozen custody drift');
for (const [file, digest] of Object.entries(roster.inputHashes)) if (hash(bytes(file)) !== digest) throw Error('Runtime input drift: ' + file);
if (hash(bytes(roster.node)) !== roster.nodeSha256 || hash(bytes(roster.vitest)) !== roster.vitestSha256) throw Error('Runtime binary drift');
const ready = readiness();
const directory = path.join(out, label);
fs.mkdirSync(directory); // Exclusive directory is the single-invocation lock, never removed.
write(label + '/readiness.json', { ...ready, baseline, allFrozenInputsExact: true, inputCount: Object.keys(roster.inputHashes).length, custodyExact: true, releaseSha256: hash(bytes(path.join(out, 'root-' + label + '-release.json'))) });
write(label + '/command.json', { cwd: root, ...gate, runtimeRosterSha256: hash(rosterBytes) });
const env = { ...process.env };
for (const name of gate.environmentUnset) delete env[name];
Object.assign(env, gate.environmentSet);
const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'wx'), stderr = fs.openSync(path.join(directory, 'stderr.log'), 'wx');
const started = Date.now();
const child = spawn(gate.command[0], gate.command.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', stdout, stderr] });
let timedOut = false, spawnError;
const cleanup = [];
const groupMembers = () => {
  if (!child.pid) return [];
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('Owned group inspection failed');
  return result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u)).filter(fields => Number(fields[2]) === child.pid).map(([pid, ppid, pgid, status]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), status }));
};
const signalGroup = signal => {
  const members = groupMembers();
  if (!members.length) return;
  cleanup.push({ at: new Date().toISOString(), signal, group: child.pid, members });
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
write(label + '/execution-start.json', { baseline, startedAt: new Date(started).toISOString(), recorderPid: process.pid, childPid: child.pid, ownedProcessGroup: child.pid, cases: expectedCount });
console.log(JSON.stringify({ label, childPid: child.pid, ownedProcessGroup: child.pid, cases: expectedCount, budgetMs: gate.budgetMs }));
const timer = setTimeout(() => { timedOut = true; signalGroup('SIGTERM'); }, gate.budgetMs);
const hardTimer = setTimeout(() => { if (timedOut) signalGroup('SIGKILL'); }, gate.budgetMs + 2000);
child.on('error', error => { spawnError = String(error); });
child.on('close', async (code, signal) => {
  clearTimeout(timer); clearTimeout(hardTimer); fs.closeSync(stdout); fs.closeSync(stderr);
  if (groupMembers().length) {
    signalGroup('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1000));
    if (groupMembers().length) { signalGroup('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  const remainingOwnedGroup = groupMembers();
  const status = { code, signal, spawnError, timedOut, elapsedMs: Date.now() - started, cleanup, remainingOwnedGroup, quiescent: remainingOwnedGroup.length === 0 };
  write(label + '/status.json', status);
  let validation;
  try {
    const result = read(label + '/result.json');
    const assertions = result.testResults.flatMap(suite => suite.assertionResults.map(assertion => ({ file: path.relative(root, suite.name), name: [...assertion.ancestorTitles, assertion.title].join(' > '), status: assertion.status })));
    const passed = assertions.filter(entry => entry.status === 'passed').length;
    const failed = assertions.filter(entry => entry.status === 'failed').length;
    const other = assertions.length - passed - failed;
    const exactRoster = exact(assertions, gate.entries);
    const postCustodyExact = JSON.stringify(custody()) === JSON.stringify(currentCustody);
    const allInputsExact = Object.entries(roster.inputHashes).every(([file, digest]) => hash(bytes(file)) === digest);
    const postReadiness = readiness();
    write(label + '/post-readiness.json', postReadiness);
    validation = { exactRoster, passed, failed, pendingSkippedTodoOrOther: other, cases: assertions.length, expectedCases: expectedCount, assertions, postCustodyExact, allInputsExact, green: exactRoster && passed === expectedCount && failed === 0 && other === 0 && code === 0 && !timedOut && !spawnError && status.quiescent && postCustodyExact && allInputsExact };
  } catch (error) { validation = { green: false, error: String(error) }; }
  write(label + '/validation.json', validation);
  console.log(JSON.stringify({ label, ...status, green: validation.green, exactRoster: validation.exactRoster, passed: validation.passed, failed: validation.failed }));
  process.exitCode = validation.green ? 0 : timedOut ? 124 : code || 1;
});
