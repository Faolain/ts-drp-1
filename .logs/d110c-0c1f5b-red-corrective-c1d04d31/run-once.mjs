import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';

const root = process.cwd();
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const matrix = JSON.parse(fs.readFileSync(path.join(out, 'matrix.json'), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (fs.existsSync(path.join(out, 'execution-start.json'))) throw Error('Sole execution already consumed');
const head = git(['rev-parse', 'HEAD']);
if (!head.startsWith('c1d04d31')) throw Error('Unexpected signed tests HEAD');
if (git(['log', '-1', '--format=%G?']) !== 'G') throw Error('Bad signature');
const remote = git(['ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path']).split(/\s+/u)[0];
if (remote !== head) throw Error('Tests HEAD not pushed');
for (const [file, expected] of Object.entries(matrix.fileHashes)) if (hash(fs.readFileSync(file)) !== expected) throw Error('Frozen tests drift: ' + file);
if (git(['diff', '--name-only']) !== '' || git(['diff', '--cached', '--name-only']) !== '') throw Error('Tracked worktree dirty');
const command = ['exec', 'vitest', 'run', ...matrix.files, '-t', matrix.filter, '--reporter=json', '--outputFile=' + path.join(out, 'focused.json')];
write('execution-start.json', { head, remote, signature: 'G', matrixSha256: hash(fs.readFileSync(path.join(out, 'matrix.json'))), command: ['pnpm', ...command], executionCount: 1, startedAt: new Date().toISOString() });
const result = spawnSync('pnpm', command, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
fs.writeFileSync(path.join(out, 'stdout.log'), result.stdout ?? '');
fs.writeFileSync(path.join(out, 'stderr.log'), result.stderr ?? '');
const report = fs.existsSync(path.join(out, 'focused.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'focused.json'), 'utf8')) : null;
const assertions = report?.testResults.flatMap(suite => suite.assertionResults.map(row => ({ file: path.relative(root, suite.name), ...row }))) ?? [];
const violations = [];
const outcomes = [];
for (const expected of matrix.entries) {
  const matches = assertions.filter(row => row.file === expected.file && row.fullName === expected.name);
  if (matches.length !== 1) { violations.push({ expected, reason: 'Missing or repeated assertion', count: matches.length }); continue; }
  const row = matches[0];
  const failures = row.failureMessages ?? [];
  const outcome = { file: row.file, name: row.fullName, status: row.status, duration: row.duration, failureMessages: failures, expectedToken: expected.token };
  outcomes.push(outcome);
  if (row.status !== expected.expectedStatus || failures.length !== (expected.token ? 1 : 0) || (expected.token && !failures[0]?.includes(expected.token))) violations.push({ reason: 'Unexpected selected matrix', expected, actual: outcome });
}
const filtered = assertions.filter(row => !matrix.entries.some(expected => row.file === expected.file && row.fullName === expected.name));
if (filtered.length !== matrix.intentionallyFiltered || filtered.some(row => !['pending', 'skipped'].includes(row.status))) violations.push({ reason: 'Unexpected filtered matrix', filtered: filtered.map(row => ({ name: row.fullName, status: row.status })) });
if (result.status !== 1 || report?.numFailedTests !== 23 || report?.numPassedTests !== 3) violations.push({ reason: 'Runner/count mismatch', status: result.status, failed: report?.numFailedTests, passed: report?.numPassedTests });
const topLevel = report?.unhandledErrors ?? report?.testResults.flatMap(suite => suite.message && !suite.assertionResults.some(row => row.failureMessages?.some(message => suite.message.includes(message))) ? [suite.message] : []) ?? [];
if (topLevel.length) violations.push({ reason: 'Top-level errors', topLevel });
if (outcomes.some(row => row.failureMessages.some(message => /timed out|test timeout|hook timeout|Cannot find module|Failed to load url/iu.test(message)))) violations.push({ reason: 'Timeout or loader failure' });
write('result.json', { classification: violations.length ? 'REJECTED_MATRIX_STOPPED_NO_RERUN' : 'ACCEPTED_CAUSAL_CORRECTIVE_RED_PENDING_REVIEW', executionCount: 1, head, runnerStatus: result.status, total: report?.numTotalTests, selected: matrix.selected, failed: report?.numFailedTests, passed: report?.numPassedTests, intentionallyFiltered: filtered.length, topLevel, violations, outcomes, finishedAt: new Date().toISOString(), warning: 'No production GREEN, post-codec continuation, complete 64-writer transition or long-horizon completion is claimed.' });
console.log(JSON.stringify({ classification: violations.length ? 'REJECTED_MATRIX_STOPPED_NO_RERUN' : 'ACCEPTED_CAUSAL_CORRECTIVE_RED_PENDING_REVIEW', failed: report?.numFailedTests, passed: report?.numPassedTests, intentionallyFiltered: filtered.length, violations }, null, 2));
process.exitCode = violations.length ? 2 : 0;
