import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const evidence = path.dirname(new URL(import.meta.url).pathname);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const testsCommit = 'cecde972f4aac55714626d1af46dae32a1c7350c';
const focus = JSON.parse(fs.readFileSync(path.join(evidence, 'focused.json'), 'utf8'));
const list = JSON.parse(fs.readFileSync(path.join(evidence, 'list.json'), 'utf8'));
const expectedFile = path.join(root, 'tests/phase-6b-d110c-0c1f5b-integration-red.test.ts');
const exactFailure = 'Error: F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED: genuine settlement successor fails CERTIFIED_VALUE_MISMATCH before checkpoint production';
assert.equal(list.length, 2);
assert.deepEqual([...new Set(list.map(x => x.file))], [expectedFile]);
assert.equal(focus.testResults.length, 1);
assert.equal(focus.testResults[0].name, expectedFile);
assert.equal(focus.numTotalTests, 2);
assert.equal(focus.numFailedTests, 1);
assert.equal(focus.numPassedTests, 1);
assert.equal(focus.numPendingTests, 0);
assert.equal(focus.numTodoTests, 0);
assert.equal(focus.success, false);
assert.equal(focus.testResults[0].message, '');
assert.equal(focus.testResults[0].assertionResults.length, 2);
const [red, control] = focus.testResults[0].assertionResults;
assert.equal(red.status, 'failed');
assert.equal(control.status, 'passed');
assert.equal(red.failureMessages.length, 1);
assert.equal(red.failureMessages[0].split('\n')[0], exactFailure);
assert.equal(control.failureMessages.length, 0);
for (const result of [red, control]) assert.deepEqual(result.meta, {});
assert.equal(fs.readFileSync(path.join(evidence, 'stderr.log'), 'utf8'), '');
assert.equal(git('rev-parse', 'HEAD'), testsCommit);
assert.equal(git('rev-parse', '@{u}'), testsCommit);
assert.equal(git('log', '-1', '--format=%G?'), 'G');
assert.equal(git('status', '--porcelain=v1', '-uno'), '');
const stashes = git('stash', 'list', '--format=%H').split('\n');
assert.equal(stashes.length, 27);
const manifests = [
  '.logs/d110c-0c1f5b0r-design-3a156aca/manifest.sha256',
  '.logs/d110c-0c1f5b-red-1dcff170/manifest.sha256',
  '.logs/d110c-0c1f5b-red-8fcbc039/manifest.sha256',
];
for (const manifest of manifests) {
  for (const line of fs.readFileSync(path.join(root, manifest), 'utf8').trim().split('\n')) {
    const [digest, file] = line.split('  ');
    assert.equal(hash(path.join(root, path.dirname(manifest), file)), digest);
  }
}
const files = [
  'tests/phase-6b-d110c-0c1f5b-integration-red.test.ts',
  'tests/fixtures/phase-4b-v3/live-snapshot.ts',
  'examples/v3-room/src/index.ts', 'examples/v3-chat/src/index.ts',
  'packages/issuance-store/src/types.ts', 'packages/issuance-store/src/contract.ts',
  'packages/storage-browser/src/internal/browser-issuance-store.ts',
  'packages/storage-browser/src/internal/idb-adapter.ts', 'packages/storage/src/adapter.ts',
  'packages/node/src/creator-adoption-activate.ts', 'packages/node/src/creator-adoption.ts',
  'packages/node/src/creator-close.ts', 'packages/node/src/v3-live.ts',
  'packages/node/src/internal/closed-epoch-cleanup.ts',
  'packages/node/src/internal/creator-transition-advance.ts',
  'packages/protocol-v3/src/creator-close.ts', 'packages/protocol-v3/src/creator-checkpoint.ts',
  'vite.config.mts', 'tsconfig.json', 'pnpm-lock.yaml', ...manifests,
];
const protectedPaths = ['.agents', '.claude', 'skills-lock.json',
  'packages/protocol-v2/tests/author-sequence-0g2.test.ts',
  'packages/protocol-v2/tests/local-author-sequence-issuance-0g2.test.ts'];
for (const file of protectedPaths) assert.equal(fs.existsSync(path.join(root, file)), true);
const inputs = { testsCommit, sourceTree: git('rev-parse', 'HEAD^{tree}'),
  files: files.map(file => ({ path: file, sha256: hash(path.join(root, file)) })),
  runtime: { node: process.version, pnpm: execFileSync('pnpm', ['--version'], {encoding:'utf8'}).trim() },
  custody: { stashes, protectedPaths, trackedTreeClean: true, signedPushedTestsCommit: true },
};
const result = { classification: 'ACCEPTED_CAUSAL_RED_PENDING_REVIEW', executionCount: 1,
  runnerStatus: 1, selectedTests: 2, selectedFiles: 1, failed: 1, passed: 1, skipped: 0, todo: 0,
  topLevelErrors: [], additionalSoftFailures: [], exactFailure,
  assertions: focus.testResults[0].assertionResults,
  reporterStartEpochMs: focus.startTime, testsStartEpochMs: focus.testResults[0].startTime,
  testsFinishEpochMs: focus.testResults[0].endTime,
  warning: 'Post-causal settlement continuations and wide workload did not execute; no GREEN or golden-path claim.',
};
fs.writeFileSync(path.join(evidence, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const roster = fs.readdirSync(evidence).filter(file => file !== 'manifest.sha256').sort();
fs.writeFileSync(path.join(evidence, 'manifest.sha256'), roster.map(file => `${hash(path.join(evidence,file))}  ${file}\n`).join(''));
for (const line of fs.readFileSync(path.join(evidence,'manifest.sha256'),'utf8').trim().split('\n')) {
  const [digest,file] = line.split('  ');
  assert.equal(hash(path.join(evidence,file)),digest);
}
console.log(JSON.stringify({ classification:result.classification, files:roster.length,
  manifestSha256:hash(path.join(evidence,'manifest.sha256')) },null,2));
