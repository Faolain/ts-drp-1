import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const out = path.dirname(new URL(import.meta.url).pathname);
const read = name => JSON.parse(fs.readFileSync(path.join(out, name)));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validation = read('validation.json');
assert.equal(validation.green, true); assert.equal(validation.passed, 24);
assert.equal(validation.custodyExact, true); assert.equal(validation.allInputHashesExact, true);
const roster = read('runtime-roster.json');
for (const [file, digest] of Object.entries(roster.inputHashes)) assert.equal(hash(fs.readFileSync(file)), digest, file);
const handoff = {
  status: 'Main-workspace browser gate passed; source-built isolation and formal reviews remain open',
  baseline: roster.baseline,
  passed: 24,
  projects: ['chromium', 'firefox', 'webkit'],
  exactHistoricalRoster: true,
  invocationCount: 1,
  failed: 0,
  skipped: 0,
  flaky: 0,
  retries: 0,
  elapsedMs: validation.elapsedMs,
  globalTimeout: roster.globalTimeout,
  externalProcessCeiling: roster.budgetMs,
  inputCount: Object.keys(roster.inputHashes).length,
  runtimeRosterSha256: hash(fs.readFileSync(path.join(out, 'runtime-roster.json'))),
  sourcePatchSha256: roster.sourcePatchSha256,
  custodyExact: true,
  shimAbsentBeforeAndAfter: true,
  ownedGroupQuiescent: true,
  cleanupSignals: validation.cleanup.length,
  sourceEdits: 0,
  packageBuilds: 0,
  reviewers: 0,
  actualBrowserGate: 'Existing Playwright configuration and in-memory test server; not interactive browser substitution',
  staticScope: 'Collection and input discovery only; no fresh diagnostics requested in this browser gate',
  rootVerification: '../d110c-w0-current-profile-acceptance-61ea93f6/browser-result-verify',
  manifest: 'manifest.sha256',
};
fs.writeFileSync(path.join(out, 'runtime-handoff.json'), JSON.stringify(handoff, null, 2) + '\n', { flag: 'wx' });
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
assert.equal(fs.existsSync(path.join(out, 'manifest.sha256')), false);
const files = walk(out).sort();
const manifest = files.map(file => hash(fs.readFileSync(file)) + '  ' + path.relative(out, file)).join('\n') + '\n';
fs.writeFileSync(path.join(out, 'manifest.sha256'), manifest, { flag: 'wx' });
console.log(JSON.stringify({ entries: files.length, exactFiles: files.length + 1, manifestSha256: hash(manifest), passed: 24, allInputsExact: true }));
