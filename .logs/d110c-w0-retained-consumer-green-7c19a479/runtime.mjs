import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const requestedGate = process.argv[2];
if (!['runtime-checkpoint', 'runtime-consumers'].includes(requestedGate)) throw Error('Gate required');
const release = read('root-' + requestedGate + '-release.json');
if (release.gate !== requestedGate) throw Error('Release gate mismatch');
const rosterBytes = fs.readFileSync(path.join(out, 'runtime-roster.json'));
if (hash(rosterBytes) !== release.runtimeRosterSha256) throw Error('Released roster hash mismatch');
const roster = JSON.parse(rosterBytes);
const gate = roster.gates.find(entry => entry.label === release.gate);
const expected = requestedGate === 'runtime-checkpoint' ? { files: 2, cases: 7, budgetMs: 120000 } : { files: 14, cases: 51, budgetMs: 240000 };
if (!gate || gate.phase !== 'GREEN' || gate.files.length !== expected.files || gate.entries.length !== expected.cases || gate.budgetMs !== expected.budgetMs || release.maxInvocations !== 1) throw Error('Release scope mismatch');
if (hash(fs.readFileSync(new URL(import.meta.url))) !== roster.runtimeRunnerSha256) throw Error('Frozen runner changed');
if (requestedGate === 'runtime-consumers') {
  const previous = read('runtime-checkpoint/validation.json');
  if (!previous.green || !previous.exactRoster || previous.passed !== 7 || previous.failed !== 0) throw Error('Successful focused gate required');
}
const directory = path.join(out, gate.label);
fs.mkdirSync(directory);
const custody = read('custody-after.json');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
if (git('rev-parse', 'HEAD') !== release.baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('HEAD/signature/index drift');
for (const [file, digest] of Object.entries(roster.inputHashes)) if (hash(fs.readFileSync(file)) !== digest) throw Error('Runtime input drift: ' + file);
for (const [file, digest] of Object.entries({ ...custody.targetHashes, ...custody.protectedSources, ...custody.built })) if (hash(fs.readFileSync(path.join(root, file))) !== digest) throw Error('Protected source/build drift: ' + file);
if (hash(fs.readFileSync(roster.node)) !== roster.nodeSha256 || hash(fs.readFileSync(roster.vitest)) !== roster.vitestSha256) throw Error('Runtime binary drift');
const patch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...custody.targets], { maxBuffer: 128 * 1024 * 1024 });
if (hash(patch) !== release.sourcePatchSha256) throw Error('Released source patch drift');
const original = JSON.parse(fs.readFileSync(path.join(root, '.logs/d110c-0c1f5b-green-57834387/custody-before.json')));
if (git('stash', 'list', '--format=%H %gd %gs') !== original.stashes.trim()) throw Error('Stash drift');
for (const file of original.untracked) if (!fs.existsSync(path.join(root, file))) throw Error('Protected path missing: ' + file);
for (const [directory, digest] of Object.entries(custody.manifests)) if (hash(fs.readFileSync(path.join(root, directory, 'manifest.sha256'))) !== digest) throw Error('Protected manifest drift: ' + directory);
const inherited = process.env.NODE_OPTIONS ?? '';
if (/--(?:cpu[-_]prof|heap[-_]prof|prof(?:\b|[-_]))/u.test(inherited) || process.env.NODE_V8_COVERAGE) throw Error('Inherited profiling environment');
const ports = [4174, 4175, 51000, 51002].map(port => {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (![0, 1].includes(result.status)) throw Error('Port query failed');
  const pids = result.stdout.trim().split(/\s/u).filter(value => /^\d+$/u.test(value)).map(Number);
  if (pids.length) throw Error('Fixed listener occupied: ' + port);
  return { port, pids };
});
const candidates = spawnSync('pgrep', ['-f', '(vitest|typescript/lib/tsc|eslint/bin|prettier/bin|quint|apalache|heap-prof|cpu-prof)'], { encoding: 'utf8' });
if (![0, 1].includes(candidates.status)) throw Error('Process query failed');
const processes = [];
for (const pid of candidates.stdout.trim().split(/\s/u).filter(value => /^\d+$/u.test(value)).map(Number).filter(value => value !== process.pid && value !== process.ppid)) {
  const status = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' });
  if (status.status === 1) continue;
  if (status.status !== 0) throw Error('Process status failed');
  const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const directories = cwd.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  const relevant = directories.some(directory => directory === root || directory.startsWith(root + '/'));
  processes.push({ pid, numericStatus: status.stdout.trim(), cwd: directories, relevant });
  if (relevant) throw Error('Competing task process: ' + pid);
}
const env = { ...process.env };
for (const key of gate.environmentUnset) delete env[key];
Object.assign(env, gate.environmentSet);
write(gate.label + '/readiness.json', { checkedAt: new Date().toISOString(), head: release.baseline, signature: 'G', indexEmpty: true, inputCount: Object.keys(roster.inputHashes).length, allInputsAndProtectedSourcesExact: true, runtimeBinariesExact: true, sourcePatchExact: true, stashes: 27, protectedPaths: original.untracked.length, manifestRoots: Object.keys(custody.manifests).length, inheritedProfilingAbsent: true, ports, processes, numericOnlyProcessInspection: true, noCompetingTaskProcesses: true });
write(gate.label + '/command.json', { cwd: root, command: gate.command, environmentUnset: gate.environmentUnset, environmentSet: gate.environmentSet, budgetMs: gate.budgetMs, runtimeRosterSha256: release.runtimeRosterSha256 });
const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'wx');
const stderr = fs.openSync(path.join(directory, 'stderr.log'), 'wx');
const started = Date.now();
const child = spawn(gate.command[0], gate.command.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', stdout, stderr] });
write(gate.label + '/execution-start.json', { head: release.baseline, recorderPid: process.pid, childPid: child.pid, ownedProcessGroup: child.pid, startedAt: new Date(started).toISOString(), files: expected.files, cases: expected.cases, heavyChildReleased: requestedGate === 'runtime-consumers' });
console.log(JSON.stringify({ gate: gate.label, childPid: child.pid, ownedProcessGroup: child.pid, cases: expected.cases, budgetMs: gate.budgetMs }));
let timedOut = false;
let spawnError;
const cleanup = [];
const groupMembers = () => {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('Owned group query failed');
  return result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u)).filter(fields => Number(fields[2]) === child.pid).map(([pid, ppid, pgid, status]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), status }));
};
const signalGroup = signal => {
  const members = groupMembers();
  if (!members.length) return;
  cleanup.push({ at: new Date().toISOString(), signal, group: child.pid, members });
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const timer = setTimeout(() => { timedOut = true; signalGroup('SIGTERM'); }, gate.budgetMs);
const hardTimer = setTimeout(() => { if (timedOut) signalGroup('SIGKILL'); }, gate.budgetMs + 2000);
child.on('error', error => { spawnError = String(error); });
child.on('close', async (code, signal) => {
  clearTimeout(timer);
  clearTimeout(hardTimer);
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  if (groupMembers().length) {
    signalGroup('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (groupMembers().length) {
      signalGroup('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const remaining = groupMembers();
  const result = { code, signal, spawnError, timedOut, elapsedMs: Date.now() - started, endedAt: new Date().toISOString(), cleanup, remainingOwnedGroup: remaining, quiescent: remaining.length === 0 };
  write(gate.label + '/status.json', result);
  console.log(JSON.stringify({ gate: gate.label, ...result }));
  process.exitCode = timedOut ? 124 : code ?? 1;
});
