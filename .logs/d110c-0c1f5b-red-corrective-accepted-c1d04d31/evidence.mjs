import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import ts from 'typescript';
import { loadConfigFromFile } from 'vite';

const root = process.cwd();
const out = path.dirname(new URL(import.meta.url).pathname);
const relativeOut = path.relative(root, out);
const old = '.logs/d110c-0c1f5b-red-corrective-c1d04d31';
const head = 'fff5f0b5527a6c5c251472772afc1e2c5e3714d9';
const testsCommit = 'c1d04d31149cd4ed1e8631203213df99852036a2';
const rejectedCommit = 'e9015cff673b070b672571e3064517dd542d45b7';
const branch = 'codex/phase3a1b-p6-golden-path';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const assert = (ok, message) => { if (!ok) throw Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const previous = read(path.join(old, 'matrix.json'));
const files = previous.files;
function manifest(directory, expectedHash) {
  const bytes = fs.readFileSync(path.join(directory, 'manifest.sha256'));
  if (expectedHash) assert(hash(bytes) === expectedHash, 'Manifest identity drift: ' + directory);
  const lines = bytes.toString().trim().split('\n');
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
    assert(match && match[2] !== 'manifest.sha256', 'Invalid manifest');
    assert(hash(fs.readFileSync(path.join(directory, match[2]))) === match[1], 'Manifest entry drift: ' + match[2]);
  }
  return { directory, entries: lines.length, sha256: hash(bytes), valid: true };
}
function custody() {
  assert(git(['rev-parse', 'HEAD']) === head, 'HEAD drift');
  assert(git(['branch', '--show-current']) === branch, 'Branch drift');
  assert(git(['diff', '--name-only']) === '' && git(['diff', '--cached', '--name-only']) === '', 'Tracked/staged mutation');
  const signatures = Object.fromEntries([head, testsCommit, rejectedCommit].map(commit => [commit, git(['log', '-1', '--format=%G?', commit])]));
  assert(Object.values(signatures).every(value => value === 'G'), 'Signature verification failed');
  for (const commit of [testsCommit, rejectedCommit]) git(['merge-base', '--is-ancestor', commit, head]);
  const remote = git(['ls-remote', 'origin', 'refs/heads/' + branch]);
  assert(remote.split(/\s+/u)[0] === head, 'Origin mismatch');
  const stashes = git(['stash', 'list', '--format=%H %gd %gs']).split('\n');
  assert(stashes.length === 27, 'Stash count drift');
  const trackedFiles = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const sourceHashes = Object.fromEntries(trackedFiles.map(file => [file, hash(fs.readFileSync(file))]));
  const runtimeHashes = Object.fromEntries(['packages/canonical/dist/src/index.js', 'node_modules/.pnpm/@vitest+runner@3.1.1/node_modules/@vitest/runner/dist/index.js'].map(file => [file, hash(fs.readFileSync(file))]));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(file => file && !file.startsWith(relativeOut + '/')).sort();
  const rejectedManifest = manifest(old, 'acc11788eb3fafcc358fb6178fc8bdecc3740d9c97653163d51d6032016eedad');
  for (const [file, expected] of Object.entries(previous.fileHashes)) {
    assert(sourceHashes[file] === expected, 'Test hash mismatch: ' + file);
    assert(hash(execFileSync('git', ['show', testsCommit + ':' + file])) === expected, 'Test commit mismatch');
  }
  return { head, testsCommit, rejectedCommit, branch, signatures, remote, stashes, sourceHashes, runtimeHashes, untracked, rejectedManifest };
}
function sameCustody(before, after) {
  for (const key of Object.keys(before)) assert(equal(before[key], after[key]), 'Custody changed: ' + key);
}

if (process.argv[2] === 'preflight') {
  assert(!fs.existsSync(path.join(out, 'custody-before.json')), 'Preflight already begun');
  write('custody-before.json', custody());
  const checks = [];
  function command(binary, args) {
    const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    checks.push({ command: [binary, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr });
    assert(result.status === 0, 'Preflight failed: ' + args.join(' '));
    return result.stdout;
  }
  command('git', ['diff', '--check']);
  command('git', ['diff', '--check', testsCommit + '^', testsCommit]);
  assert(equal(git(['diff-tree', '--no-commit-id', '--name-only', '-r', testsCommit]).split('\n'), files), 'Tests-only commit paths drift');
  assert(git(['diff', '--name-only', testsCommit, head, '--', 'packages', 'examples', 'tests', '*config*', '*lock*', '*package.json']) === '', 'Source/config delta since tests commit');
  command('pnpm', ['exec', 'eslint', ...files]);
  command('pnpm', ['exec', 'prettier', '--check', ...files]);
  const selected = JSON.parse(command('pnpm', ['exec', 'vitest', 'list', ...files, '-t', previous.filter, '--json']));
  const all = JSON.parse(command('pnpm', ['exec', 'vitest', 'list', ...files, '--json']));
  write('preflight-commands.json', checks);
  write('list.json', selected);
  write('all-list.json', all);
  assert(equal(selected, read(path.join(old, 'list.json'))) && equal(all, read(path.join(old, 'all-list.json'))), 'Exact collection drift');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  assert(!config.error, 'TypeScript config error');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const paths = { ...parsed.options.paths };
  function typeEntry(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value.types === 'string') return value.types;
    return typeEntry(value.import) ?? typeEntry(value.default);
  }
  for (const group of ['packages', 'examples']) for (const dir of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, group, dir.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = read(file);
    if (!pkg.name) continue;
    if (pkg.types) paths[pkg.name] = [path.resolve(path.dirname(file), pkg.types)];
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const entry = typeEntry(value);
      if (key.startsWith('.') && entry) paths[pkg.name + (key === '.' ? '' : key.slice(1))] = [path.resolve(path.dirname(file), entry)];
    }
  }
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.mts'));
  assert(loaded, 'Vite aliases unavailable');
  for (const [key, value] of Object.entries(loaded.config.resolve.alias)) paths[key] = [value];
  const program = ts.createProgram(files.map(file => path.join(root, file)), {
    ...parsed.options, paths, noEmit: true, composite: false, declaration: false, declarationMap: false, target: ts.ScriptTarget.ES2022,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
    file: d.file && path.relative(root, d.file.fileName), code: d.code,
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  const targetDiagnostics = diagnostics.filter(d => files.includes(d.file));
  const typecheck = { targetDiagnostics, externalDiagnostics: diagnostics.filter(d => !targetDiagnostics.includes(d)) };
  write('typecheck.json', typecheck);
  assert(equal(typecheck, read(path.join(old, 'typecheck.json'))) && targetDiagnostics.length === 0, 'Typecheck delta');
  const originalText = execFileSync('git', ['show', previous.base + ':' + files[0]], { encoding: 'utf8' });
  const currentText = fs.readFileSync(files[0], 'utf8');
  const controlMarker = '\tit("keeps the genuine v1 room issue, close, adoption and cold reopen control unchanged"';
  assert(originalText.includes(controlMarker) && originalText.slice(originalText.indexOf(controlMarker)) === currentText.slice(currentText.indexOf(controlMarker)), 'v1 control mutation');
  write('control-custody.json', { comparedWith: previous.base, completeV1TailSha256: hash(currentText.slice(currentText.indexOf(controlMarker))), byteIdentical: true });
  const priorOutcomes = read(path.join(old, 'result.json')).outcomes;
  const entries = previous.entries.map(entry => {
    const wide = entry.name.includes('composes 64 active writers');
    const prior = priorOutcomes.find(row => row.file === entry.file && row.name === entry.name);
    assert(prior, 'Missing diagnosed error path');
    return { ...entry, token: wide ? 'canonical value exceeds item limit' : entry.token, expectedFailureMessages: prior.failureMessages };
  });
  const filteredEntries = all.filter(row => !selected.some(item => equal(item, row))).map(row => ({ file: path.relative(root, row.file), name: row.name.replaceAll(' > ', ' '), allowedStatuses: ['pending', 'skipped'] }));
  assert(entries.length === 26 && filteredEntries.length === 17 && entries.filter(row => row.token === 'F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED').length === 19, 'Freeze counts');
  const matrix = { ...previous, frozenAt: new Date().toISOString(), executionHead: head, testsCommit, rejectedCommit, entries, filteredEntries,
    causalClasses: { successorCodec: 19, room64WriterAclItemLimit: 1, privateHoldProvenance: 1, closedPrecedence: 2, unchangedControls: 3 },
    failurePathPolicy: 'Exact diagnosed failure messages and complete stacks, frozen prospectively; no normalization or post-run repair.',
    authorization: 'Latest frontier and parent disposition at fff5f0b5 authorize one new invocation. Prior e9015cff remains rejected and immutable.',
  };
  sameCustody(read(path.join(out, 'custody-before.json')), custody());
  write('matrix.json', matrix);
  console.log(JSON.stringify({ preflight: 'PASS', targetDiagnostics: 0, unchangedExternalDiagnostics: diagnostics.length, matrixSha256: hash(fs.readFileSync(path.join(out, 'matrix.json'))), classes: matrix.causalClasses }));
} else if (process.argv[2] === 'run') {
  assert(!fs.existsSync(path.join(out, 'execution-start.json')), 'Sole invocation consumed');
  const matrix = read(path.join(out, 'matrix.json'));
  sameCustody(read(path.join(out, 'custody-before.json')), custody());
  const args = ['exec', 'vitest', 'run', ...files, '-t', matrix.filter, '--reporter=json', '--outputFile=' + path.join(out, 'focused.json')];
  write('execution-start.json', { head, testsCommit, matrixSha256: hash(fs.readFileSync(path.join(out, 'matrix.json'))), command: ['pnpm', ...args], startedAt: new Date().toISOString(), executionCount: 1 });
  const result = spawnSync('pnpm', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, 'stdout.log'), result.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'stderr.log'), result.stderr ?? '', { flag: 'wx' });
  const report = fs.existsSync(path.join(out, 'focused.json')) ? read(path.join(out, 'focused.json')) : null;
  const assertions = report?.testResults.flatMap(suite => suite.assertionResults.map(row => ({ file: path.relative(root, suite.name), ...row }))) ?? [];
  const violations = [];
  const outcomes = [];
  for (const expected of matrix.entries) {
    const matches = assertions.filter(row => row.file === expected.file && row.fullName === expected.name);
    if (matches.length !== 1) { violations.push({ reason: 'Missing/duplicate selected test', expected, count: matches.length }); continue; }
    const row = matches[0];
    outcomes.push({ file: row.file, name: row.fullName, status: row.status, duration: row.duration, failureMessages: row.failureMessages, expectedToken: expected.token });
    if (row.status !== expected.expectedStatus || !equal(row.failureMessages, expected.expectedFailureMessages)) violations.push({ reason: 'Status/token/path/soft-failure anomaly', expected, actual: row });
  }
  const filtered = assertions.filter(row => !matrix.entries.some(entry => entry.file === row.file && entry.name === row.fullName));
  for (const expected of matrix.filteredEntries) {
    const rows = filtered.filter(row => row.file === expected.file && row.fullName === expected.name);
    if (rows.length !== 1 || !expected.allowedStatuses.includes(rows[0].status) || rows[0].failureMessages.length !== 0) violations.push({ reason: 'Filtered test anomaly', expected, rows });
  }
  const topLevel = [...(report?.unhandledErrors ?? []), ...(report?.testResults.filter(suite => suite.message).map(suite => suite.message) ?? [])];
  if (result.status !== 1 || result.signal || result.error || report?.numTotalTests !== 43 || report?.numFailedTests !== 23 || report?.numPassedTests !== 3 || report?.numPendingTests !== 17 || report?.numTodoTests !== 0 || assertions.length !== 43 || filtered.length !== 17 || report?.testResults.length !== 2 || topLevel.length) violations.push({ reason: 'Runner/count/top-level anomaly', status: result.status, signal: result.signal, error: String(result.error ?? ''), topLevel });
  const anomalyText = [result.stderr ?? '', ...outcomes.flatMap(row => row.failureMessages)].join('\n');
  if (/timed out|test timeout|hook timeout|Cannot find module|Failed to load url|Unhandled Error|Unhandled Rejection|Uncaught Exception/iu.test(anomalyText)) violations.push({ reason: 'Timeout/loader/unhandled anomaly' });
  try { sameCustody(read(path.join(out, 'custody-before.json')), custody()); } catch (error) { violations.push({ reason: 'Postrun custody anomaly', error: String(error) }); }
  write('result.json', { classification: violations.length ? 'REJECTED_MATRIX_STOPPED_NO_RERUN' : 'ACCEPTED_CAUSAL_CORRECTIVE_RED', head, testsCommit, executionCount: 1, runnerStatus: result.status, selected: 26, failed: report?.numFailedTests, passed: report?.numPassedTests, intentionallyFiltered: filtered.length, topLevel, violations, outcomes, finishedAt: new Date().toISOString(), warning: 'No production GREEN, successor continuation, completed 64-writer proof, or long-horizon completion is claimed.' });
  console.log(JSON.stringify({ classification: violations.length ? 'REJECTED_MATRIX_STOPPED_NO_RERUN' : 'ACCEPTED_CAUSAL_CORRECTIVE_RED', failures: report?.numFailedTests, passes: report?.numPassedTests, filtered: filtered.length, violations }, null, 2));
  process.exitCode = violations.length ? 2 : 0;
} else if (process.argv[2] === 'seal') {
  const after = custody();
  sameCustody(read(path.join(out, 'custody-before.json')), after);
  write('custody-after.json', after);
  const verifiedManifests = read(path.join(old, 'custody.json')).verifiedManifests.map(item => manifest(item.directory, item.sha256));
  write('custody-summary.json', { exactTrackedHashesUnchanged: Object.keys(after.sourceHashes).length, exactStashIdentitiesUnchanged: 27, exactExistingUntrackedInventoryUnchanged: after.untracked.length, runtimeHashesUnchanged: true, verifiedManifests, rejectedManifest: after.rejectedManifest, noProductionChanges: true, noTestsChanges: true, noDocsChanges: true, noTimeoutConfigDependencyChanges: true, noRerun: true, noCampaign: true, noReviewers: true, noSubagents: true });
  const attribution = read(path.join(old, 'source-attribution.json'));
  for (const owner of [attribution.roomOwner, attribution.protocolOwner]) {
    const lines = fs.readFileSync(owner.file, 'utf8').split('\n');
    for (const range of owner.ranges) assert(equal(lines.slice(range.start - 1, range.start - 1 + range.lines.length), range.lines), 'Source attribution changed');
  }
  write('source-attribution.json', { ...attribution, mutation: 'None. Prospectively diagnosed room item-limit failure and successor/P2 paths reproduced on unchanged source/test hashes.', roomSourceSha256: after.sourceHashes[attribution.roomOwner.file], protocolSourceSha256: after.sourceHashes[attribution.protocolOwner.file] });
  const inventory = fs.readdirSync(out).filter(file => file !== 'manifest.sha256').sort();
  const content = inventory.map(file => `${hash(fs.readFileSync(path.join(out, file)))}  ${file}`).join('\n') + '\n';
  fs.writeFileSync(path.join(out, 'manifest.sha256'), content, { flag: 'wx' });
  console.log(JSON.stringify({ evidenceRoot: relativeOut, entries: inventory.length, manifestSha256: hash(content) }));
} else throw Error('Expected preflight, run, or seal');
