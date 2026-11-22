import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { root, out, read, write, readiness, hash, bytes } from './common.mjs';
if (read('build/status.json').code !== 0 || !read('build/status.json').quiescent) throw Error('Fresh build incomplete');
const label = process.argv[2];
const plan = read('static-operations.json');
const operation = plan.operations.find(entry => entry.label === label);
if (!operation) throw Error('Unreleased preparation operation');
const index = plan.operations.indexOf(operation);
for (const previous of plan.operations.slice(0, index)) if (read(previous.label + '/status.json').code !== 0 || read(previous.label + '/status.json').timedOut) throw Error('Prior operation failed');
const mainCustody = read('custody-before.json');
for (const [file, digest] of Object.entries({ ...mainCustody.sources, ...mainCustody.built })) if (hash(bytes(file)) !== digest) throw Error('Main source/build drift');
const directory = path.join(out, label);
fs.mkdirSync(directory);
write(label + '/readiness.json', readiness());
const env = { ...process.env };
const environmentUnset = ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH'];
for (const name of environmentUnset) delete env[name];
write(label + '/command.json', { ...operation, environmentUnset, testsExecuted: 0 });
const stdout = fs.openSync(path.join(directory, 'stdout'), 'wx');
const stderr = fs.openSync(path.join(directory, 'stderr'), 'wx');
const started = Date.now();
const child = spawn(operation.command[0], operation.command.slice(1), { cwd: operation.cwd, env, detached: true, stdio: ['ignore', stdout, stderr] });
write(label + '/execution-start.json', { recorderPid: process.pid, childPid: child.pid, ownedProcessGroup: child.pid, startedAt: new Date(started).toISOString() });
console.log(JSON.stringify({ label, childPid: child.pid, ownedProcessGroup: child.pid, budgetMs: operation.budgetMs }));
let timedOut = false, spawnError;
const cleanup = [];
const groupMembers = () => {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('Owned group inspection failed');
  return result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u)).filter(fields => Number(fields[2]) === child.pid).map(([pid, ppid, pgid, status]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), status }));
};
const signalGroup = signal => {
  if (!child.pid) return;
  const members = groupMembers();
  if (!members.length) return;
  cleanup.push({ at: new Date().toISOString(), signal, group: child.pid, members });
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const timer = setTimeout(() => { timedOut = true; signalGroup('SIGTERM'); }, operation.budgetMs);
const hardTimer = setTimeout(() => { if (timedOut) signalGroup('SIGKILL'); }, operation.budgetMs + 2000);
child.on('error', error => { spawnError = String(error); });
child.on('close', async (code, signal) => {
  clearTimeout(timer); clearTimeout(hardTimer); fs.closeSync(stdout); fs.closeSync(stderr);
  if (groupMembers().length) {
    signalGroup('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1000));
    if (groupMembers().length) { signalGroup('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  const remainingOwnedGroup = groupMembers();
  const result = { code, signal, spawnError, timedOut, elapsedMs: Date.now() - started, endedAt: new Date().toISOString(), cleanup, remainingOwnedGroup, quiescent: remainingOwnedGroup.length === 0, testsExecuted: 0 };
  write(label + '/status.json', result);
  console.log(JSON.stringify({ label, ...result }));
  process.exitCode = timedOut ? 124 : code ?? 1;
});
