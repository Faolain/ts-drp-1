// Focused command evidence; no review/acceptance is inferred from process exit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { collectGridSourceHashes } from '../../tests/fixtures/grid-memory-custody.mjs';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const [label, seconds, command, ...args] = process.argv.slice(2);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const ceiling = Number(seconds) * 1000;
assert.ok(Number.isSafeInteger(ceiling) && ceiling > 0 && ceiling <= 3600000 && command);
const dir = path.join(out, label); fs.mkdirSync(dir);
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const built = ['packages/node/dist/src/creator-adoption.js', 'packages/node/dist/src/creator-close.js', 'packages/node/dist/src/internal/creator-transition-advance.js', 'packages/node/dist/src/v3-live.js', 'packages/protocol-v3/dist/src/creator-checkpoint.js', 'packages/protocol-v3/dist/src/creator-close.js', 'packages/node/dist/src/internal/closed-epoch-cleanup.js'];
const additional = ['tests/fixtures/phase-3a1b/grid-room-head-authority.ts', 'tests/fixtures/grid-room-workload.ts', 'tests/phase-6b-grid-100-transition-diagnostic.test.ts', 'tests/phase-6b-grid-successor-state-red.test.ts', 'examples/grid/src/zone-state.js', 'examples/grid/src/zone-state.d.ts', 'packages/protocol-v3/dist/src/index.js', 'packages/compaction/dist/src/blueprint-fold.js', 'packages/live-journal/dist/src/contract.js'].filter(file => fs.existsSync(path.join(root, file)));
const dependencyLifecycle = ['package.json', 'pnpm-lock.yaml', 'patches/fake-indexeddb@6.2.5.patch', 'tests/fake-indexeddb-terminal-lifecycle-red.test.ts', 'tests/fixtures/fake-indexeddb-lifecycle/probe.mjs', 'tests/fixtures/fake-indexeddb-lifecycle/probe.mts', 'node_modules/fake-indexeddb/build/esm/FDBTransaction.js', 'node_modules/fake-indexeddb/build/esm/lib/Database.js', 'node_modules/fake-indexeddb/build/cjs/FDBTransaction.js', 'node_modules/fake-indexeddb/build/cjs/lib/Database.js'].filter(file => fs.existsSync(path.join(root, file)));
const attributionSources = ["tests/fixtures/grid-transition-workload.ts","tests/fixtures/grid-memory-storage-census.ts","tests/fixtures/grid-memory-profiler.ts","tests/fixtures/grid-heap-analyze.mjs","tests/fixtures/grid-heap-analyzer-control.mjs","tests/fixtures/grid-heap-analyzer-assert.mjs","tests/grid-memory-attribution-contract.test.ts","tests/grid-memory-profiler-smoke.test.ts","tests/phase-6b-grid-30-transition-attribution.test.ts","specs/grid-memory-attribution/README.md","specs/grid-memory-attribution/slices/01-capture.md"].filter(file => fs.existsSync(path.join(root, file)));
const required = ['.logs/grid-memory-attribution/run.mjs', '.logs/grid-memory-attribution/completed100-workload-baseline.ts', '.logs/grid-memory-attribution/completed100-fixture-baseline.ts', '.logs/grid-memory-attribution/completed100-v3-live-baseline.ts', 'tests/fixtures/grid-memory-custody.mjs', 'tests/grid-memory-custody.test.ts', 'tests/grid-memory-runtime-owners.test.ts', 'packages/node/src/v3-live.ts', 'tests/fixtures/grid-transition-workload.ts', 'tests/fixtures/grid-memory-profiler.ts', 'tests/fixtures/grid-memory-storage-census.ts', 'tests/phase-6b-grid-30-transition-attribution.test.ts', 'tests/fixtures/grid-heap-compare.mjs', 'tests/fixtures/grid-heap-store-ownership.mjs', 'tests/fixtures/grid-heap-store-ownership-control.mjs'];
const sources = [...new Set([...required, ...built, ...additional, ...attributionSources, ...dependencyLifecycle, 'examples/grid/src/v3-zone.ts', 'examples/grid/src/index.ts', 'tests/fixtures/phase-4b-v3/live-snapshot.ts', 'tests/phase-6b-grid-workload-network-observer.test.ts'])];
sources.push('tests/grid-memory-storage-lineage.test.ts', 'tests/grid-memory-snapshot-errors.test.ts');
sources.push('tests/grid-memory-startup-barrier.test.ts', 'tests/grid-memory-boundary-prefix.test.ts', '.logs/grid-memory-attribution/completed100-room-baseline.ts');
sources.push('tests/grid-memory-async-assertion-retention.test.ts', 'tests/fixtures/grid-expected-publication-failure.ts');
sources.push('tests/grid-memory-terminal-readiness.test.ts');
sources.push(...args.filter(arg => arg.endsWith('.test.ts') && fs.existsSync(path.join(root, arg))));
const custody = () => collectGridSourceHashes(root, sources);
const before = custody();
const start = new Date().toISOString(), started = performance.now();
write('command.json', { root, command, args, start, ceilingMs: ceiling, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources: before });
const stdout = fs.openSync(path.join(dir, 'stdout.log'), 'wx'), stderr = fs.openSync(path.join(dir, 'stderr.log'), 'wx');
const child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', stdout, stderr] });
write('launch.json', { pid: child.pid, pgid: child.pid });
let timedOut = false, spawnError;
const members = () => execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => line.trim().split(/\s+/)).filter(parts => Number(parts[2]) === child.pid);
const stop = signal => {
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    // macOS may report EPERM when the group has exited or contains only zombies.
    // Never suppress failure to signal a still-live member.
    if (error.code === 'EPERM' && members().every(parts => parts[3].startsWith('Z'))) return;
    throw error;
  }
};
const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, ceiling);
const hard = setTimeout(() => { if (timedOut) stop('SIGKILL'); }, ceiling + 2000);
child.on('error', error => { spawnError = String(error); });
child.on('close', async (code, signal) => {
  clearTimeout(timer); clearTimeout(hard); fs.closeSync(stdout); fs.closeSync(stderr);
  const cleanup = [];
  if (members().length) { cleanup.push('SIGTERM'); stop('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  if (members().length) { cleanup.push('SIGKILL'); stop('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  const remaining = members(), after = custody();
  const sourceCustodyExact = JSON.stringify(before) === JSON.stringify(after);
  const result = { code, signal, timedOut, spawnError, cleanup, remaining, sourceCustodyExact, start, finish: new Date().toISOString(), elapsedMs: performance.now() - started };
  write('status.json', result); console.log(JSON.stringify(result));
  process.exitCode = timedOut || remaining.length || !sourceCustodyExact ? 2 : code ?? 1;
});
