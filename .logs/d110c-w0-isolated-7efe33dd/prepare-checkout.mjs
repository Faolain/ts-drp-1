import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { root, out, baseline, custody, readiness, write, hash } from './common.mjs';
write('custody-before.json', custody());
write('preparation-readiness.json', readiness());
const started = Date.now();
const result = spawnSync('mktemp', ['-d', '/private/tmp/d110c-w0-isolated-XXXXXX'], { encoding: 'utf8', timeout: 5000 });
if (result.status !== 0) throw Error('Unique temporary directory creation failed');
const temp = result.stdout.trim();
if (!/^\/private\/tmp\/d110c-w0-isolated-[A-Za-z0-9]{6}$/u.test(temp) || fs.realpathSync(temp) !== temp) throw Error('Unexpected temporary directory');
const isolated = path.join(temp, 'checkout');
const patch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index'], { maxBuffer: 128 * 1024 * 1024 });
if (hash(patch) !== '138cb170776d5f2af780375adc78fee0c9029776656579cd1fb190a8d6fadda4') throw Error('Overlay changed');
write('source-overlay.patch', patch);
write('checkout.json', { main: root, root: isolated, temp, sourceHead: baseline, overlayArtifact: path.join(out, 'source-overlay.patch'), overlaySha256: hash(patch), noSharedNodeModulesOrDist: true, independentInstallationRequired: true });
write('mktemp.json', { command: ['mktemp', '-d', '/private/tmp/d110c-w0-isolated-XXXXXX'], budgetMs: 5000, elapsedMs: Date.now() - started, code: result.status, temp });
const operations = [
  { label: 'clone', cwd: temp, budgetMs: 120000, command: ['git', 'clone', '--shared', '--no-checkout', root, isolated] },
  { label: 'checkout', cwd: temp, budgetMs: 120000, command: ['git', '-C', isolated, 'checkout', '--detach', baseline] },
  { label: 'overlay-check', cwd: isolated, budgetMs: 30000, command: ['git', '-C', isolated, 'apply', '--check', path.join(out, 'source-overlay.patch')] },
  { label: 'overlay', cwd: isolated, budgetMs: 30000, command: ['git', '-C', isolated, 'apply', path.join(out, 'source-overlay.patch')] },
  { label: 'install', cwd: isolated, budgetMs: 180000, command: ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'] },
  { label: 'native-preparation', cwd: path.join(isolated, 'node_modules/.pnpm/node-datachannel@0.32.3/node_modules/node-datachannel'), budgetMs: 120000, command: [process.execPath, path.join(out, 'native-prepare.mjs')] },
  { label: 'build', cwd: isolated, budgetMs: 300000, command: ['pnpm', 'build:packages'] },
];
write('preparation-operations.json', { baseline, isolated, operations, noRetries: true, sourceEdits: 0, testsAuthorized: false });
console.log(JSON.stringify({ temp, isolated, overlaySha256: hash(patch), custody: '45 sealed roots preserved', runtimeTestsAuthorized: false }));
