import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from '@playwright/test';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const prior = '.logs/d110c-w0-current-profile-green-61ea93f6/browser-handoff.json';
const old = JSON.parse(fs.readFileSync(path.join(root, prior)));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(head, '7efe33dd350deab922c3fea7e9fcd1c968f4e474');
assert.equal(execFileSync('git', ['-C', root, 'log', '-1', '--format=%G?'], { encoding: 'utf8' }).trim(), 'G');
for (const [file, digest] of Object.entries(old.sourceHashes)) assert.equal(hash(path.join(root, file)), digest, file);
assert.equal(old.entries.length, 24);
assert.equal(new Set(old.entries.map(entry => JSON.stringify([entry.file, entry.title, entry.project]))).size, 24);
const absent = file => { try { fs.lstatSync(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
for (const file of [old.shim.root, old.shim.parent]) assert.ok(absent(path.join(root, file)), file);
const binaries = [chromium, firefox, webkit].map(browser => {
  const file = browser.executablePath();
  assert.ok(fs.existsSync(file), file);
  return { name: browser.name(), executable: file, sha256: hash(file) };
});
const result = {
  status: 'Read-only preparation only; no browser or collection executed; runtime not released',
  baseline: head,
  signature: 'G',
  historicalHandoff: prior,
  historicalHandoffSha256: hash(path.join(root, prior)),
  sourceHashes: old.sourceHashes,
  historicalEntries: old.entries,
  expectedCases: 24,
  projects: old.projects,
  retries: 0,
  workers: 1,
  globalTimeout: 300000,
  binaries,
  shim: { ...old.shim, rootAbsentNow: true, parentAbsentNow: true },
  bundleWrite: false,
  externalServerCommand: null,
  rootPreparationCorrection: 'The root package does not expose bare playwright as a direct dependency; metadata is read from the installed @playwright/test exports. No installation, source edit or runtime retry.',
  prerequisites: ['Original W0 gate accepted', 'Complete retained gate accepted', 'Supplemental bootstrap controls accounted for', 'Fresh exact collection and input freeze', 'Immediate readiness and custody recheck', 'Root one-shot runtime release'],
};
fs.writeFileSync(path.join(out, 'preparation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ baseline: head, historicalCases: 24, sourceHashesExact: Object.keys(old.sourceHashes).length, installedBrowserExecutables: binaries.map(entry => entry.name), shimAbsent: true, runtimeExecuted: false }));
