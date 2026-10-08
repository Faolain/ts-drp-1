import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import { custody, readiness } from '../d110c-w0-regression-readiness-7efe33dd/common.mjs';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const regression = path.join(root, '.logs/d110c-w0-regression-readiness-7efe33dd');
const readPath = file => JSON.parse(fs.readFileSync(file));
const read = file => readPath(path.join(out, file));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const preparation = read('preparation.json');
const commandStage = process.argv[2];
assert.ok(['collect', 'freeze', 'run'].includes(commandStage));
const shimAbsent = () => {
  for (const relative of [preparation.shim.root, preparation.shim.parent]) {
    try { fs.lstatSync(path.join(root, relative)); throw Error('Caller-owned shim path exists: ' + relative); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
};
const prerequisites = () => {
  for (const gate of ['runtime-w0', 'runtime-retained', 'runtime-bootstrap-supplement']) {
    const result = readPath(path.join(regression, gate, 'validation.json'));
    assert.equal(result.green, true, gate);
    assert.equal(result.exactRoster, true, gate);
  }
};
const entries = suites => suites.flatMap(suite => [
  ...(suite.specs ?? []).flatMap(spec => spec.tests.map(test => ({ file: spec.file, title: spec.title, project: test.projectName, timeout: test.timeout, expectedStatus: test.expectedStatus, status: test.status, results: test.results }))),
  ...entries(suite.suites ?? []),
]);
const identity = entry => JSON.stringify([entry.file, entry.title, entry.project]);
const exactEntries = actual => {
  assert.equal(actual.length, 24);
  assert.equal(new Set(actual.map(identity)).size, 24);
  assert.deepEqual(actual.map(identity).sort(), preparation.historicalEntries.map(identity).sort());
  for (const entry of actual) { assert.equal(entry.timeout, 60000); assert.equal(entry.expectedStatus, 'passed'); }
};
async function invoke(label, command, env, budgetMs) {
  fs.mkdirSync(path.join(out, label));
  write(label + '/command.json', { cwd: root, command, budgetMs, environmentUnset: ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH'], jsonOutput: env.PLAYWRIGHT_JSON_OUTPUT_FILE });
  const stdout = fs.openSync(path.join(out, label, 'stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(out, label, 'stderr.log'), 'wx');
  const started = Date.now();
  const child = spawn(command[0], command.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', stdout, stderr] });
  const cleanup = [];
  const members = () => {
    if (!child.pid) return [];
    const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
    assert.equal(ps.status, 0);
    return ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u)).filter(fields => Number(fields[2]) === child.pid).map(([pid, ppid, pgid, status]) => ({ pid: +pid, ppid: +ppid, pgid: +pgid, status }));
  };
  const signal = name => {
    const owned = members();
    if (!owned.length) return;
    cleanup.push({ signal: name, ownedProcessGroup: child.pid, members: owned });
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  write(label + '/execution-start.json', { startedAt: new Date(started).toISOString(), recorderPid: process.pid, childPid: child.pid, ownedProcessGroup: child.pid });
  console.log(JSON.stringify({ label, childPid: child.pid, budgetMs }));
  let timedOut = false, spawnError;
  const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, budgetMs);
  const hardTimer = setTimeout(() => { if (timedOut) signal('SIGKILL'); }, budgetMs + 2000);
  child.on('error', error => { spawnError = String(error); });
  const outcome = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(hardTimer); fs.closeSync(stdout); fs.closeSync(stderr);
  if (members().length) { signal('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  if (members().length) { signal('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  const remainingOwnedGroup = members();
  const status = { ...outcome, spawnError, timedOut, elapsedMs: Date.now() - started, cleanup, remainingOwnedGroup, quiescent: remainingOwnedGroup.length === 0 };
  write(label + '/status.json', status);
  assert.equal(status.code, 0); assert.equal(status.timedOut, false); assert.equal(status.quiescent, true);
  return status;
}
const require = createRequire(path.join(root, 'package.json'));
const node = fs.realpathSync(process.execPath);
const cli = fs.realpathSync(require.resolve('@playwright/test/cli'));
const config = 'packages/storage-browser/playwright.phase-6a-creator-successor-activation.config.ts';
const environment = () => {
  const env = { ...process.env };
  for (const key of ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR', 'PLAYWRIGHT_JSON_OUTPUT_NAME']) delete env[key];
  return env;
};
if (commandStage === 'collect') {
  prerequisites(); shimAbsent();
  write('custody-before.json', custody());
  write('collection-readiness.json', readiness());
  for (const [file, digest] of Object.entries(preparation.sourceHashes)) assert.equal(hash(path.join(root, file)), digest);
  const priorProgram = readPath(path.join(regression, 'program-identity.json'));
  const browserRoots = Object.keys(preparation.sourceHashes).filter(file => file.endsWith('.ts')).map(file => path.join(root, file));
  const roots = [...new Set([...priorProgram.rootNames, ...browserRoots])];
  const program = ts.createProgram(roots, priorProgram.options);
  const sources = program.getSourceFiles().map(source => ({ file: source.fileName, physical: fs.realpathSync(source.fileName), sha256: hash(fs.realpathSync(source.fileName)) }));
  write('program-identity.json', { rootNames: roots, options: priorProgram.options, compilerVersion: ts.version, sources, diagnosticsRequested: false, noEmit: true });
  await invoke('collection', [node, cli, 'test', '--config', config, '--list', '--reporter=json'], environment(), 60000);
  shimAbsent();
} else if (commandStage === 'freeze') {
  assert.equal(read('collection/status.json').code, 0);
  const collection = read('collection/stdout.log');
  assert.deepEqual(collection.errors, []);
  const actual = entries(collection.suites); exactEntries(actual);
  for (const entry of actual) assert.deepEqual(entry.results, []);
  assert.equal(collection.config.workers, 1); assert.equal(collection.config.globalTimeout, 300000);
  for (const project of collection.config.projects) assert.equal(project.retries, 0);
  const current = custody(); assert.deepEqual(current, read('custody-before.json')); shimAbsent();
  const main = readPath(path.join(regression, 'runtime-roster.json'));
  const program = read('program-identity.json');
  const files = new Set([...Object.keys(main.inputHashes), ...program.sources.map(source => source.physical), ...Object.keys(preparation.sourceHashes).map(file => path.join(root, file)), node, cli]);
  for (const directory of fs.readdirSync(path.join(root, 'packages'))) {
    const manifest = path.join(root, 'packages', directory, 'package.json');
    if (fs.existsSync(manifest)) files.add(manifest);
  }
  for (const binary of preparation.binaries) { assert.equal(hash(binary.executable), binary.sha256); files.add(binary.executable); }
  const shell = '/Users/aristotle/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  assert.ok(fs.existsSync(shell)); files.add(shell);
  const coreManifest = createRequire(require.resolve('@playwright/test/package.json')).resolve('playwright-core/package.json');
  files.add(coreManifest); files.add(path.join(path.dirname(coreManifest), 'browsers.json'));
  const inputHashes = Object.fromEntries([...files].sort().map(file => [file, hash(file)]));
  for (const [file, digest] of Object.entries(main.inputHashes)) assert.equal(inputHashes[file], digest, file);
  const artifactPaths = ['gate.mjs', 'prepare.mjs', 'preparation.json', 'program-identity.json', 'custody-before.json', 'collection/stdout.log', 'collection/status.json'];
  const artifactHashes = Object.fromEntries(artifactPaths.map(file => [file, hash(path.join(out, file))]));
  artifactHashes['../d110c-w0-regression-readiness-7efe33dd/common.mjs'] = hash(path.join(regression, 'common.mjs'));
  const roster = { baseline: preparation.baseline, entries: preparation.historicalEntries, inputHashes, artifactHashes, sourcePatchSha256: current.sourcePatchSha256, node, cli, config, budgetMs: 330000, globalTimeout: 300000, processCleanupAllowanceMs: 30000, maxInvocations: 1, command: [node, cli, 'test', '--config', config, '--reporter=line,json', '--output=' + path.join(out, 'runtime/browser-output')], testsExecuted: 0 };
  write('runtime-roster.json', roster);
  write('handoff.json', { status: '24-case browser collection exact; runtime awaits root release', baseline: preparation.baseline, runtimeRosterSha256: hash(path.join(out, 'runtime-roster.json')), sourcePatchSha256: current.sourcePatchSha256, cases: 24, inputCount: files.size, compilerSources: program.sources.length, shimAbsent: true, testsExecuted: 0 });
  console.log(JSON.stringify(read('handoff.json')));
} else {
  prerequisites(); shimAbsent();
  const roster = read('runtime-roster.json'), release = read('root-runtime-release.json');
  assert.equal(release.baseline, roster.baseline); assert.equal(release.maxInvocations, 1); assert.equal(release.gate, 'browser-24');
  assert.equal(release.runtimeRosterSha256, hash(path.join(out, 'runtime-roster.json')));
  assert.equal(release.sourcePatchSha256, roster.sourcePatchSha256);
  for (const [file, digest] of Object.entries(roster.artifactHashes)) assert.equal(hash(path.join(out, file)), digest, file);
  for (const [file, digest] of Object.entries(roster.inputHashes)) assert.equal(hash(file), digest, file);
  assert.deepEqual(custody(), read('custody-before.json'));
  write('runtime-readiness.json', readiness());
  const env = environment(); env.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(out, 'runtime/result.json');
  const status = await invoke('runtime', roster.command, env, roster.budgetMs);
  const result = read('runtime/result.json'), actual = entries(result.suites); exactEntries(actual);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.expected, 24); assert.equal(result.stats.unexpected + result.stats.flaky + result.stats.skipped, 0);
  for (const entry of actual) { assert.equal(entry.status, 'expected'); assert.equal(entry.results.length, 1); assert.equal(entry.results[0].status, 'passed'); }
  shimAbsent(); assert.deepEqual(custody(), read('custody-before.json'));
  for (const [file, digest] of Object.entries(roster.inputHashes)) assert.equal(hash(file), digest, file);
  write('post-readiness.json', readiness());
  write('validation.json', { green: true, exactRoster: true, passed: 24, failed: 0, skipped: 0, flaky: 0, retries: 0, elapsedMs: status.elapsedMs, cleanup: status.cleanup, quiescent: status.quiescent, shimAbsent: true, custodyExact: true, allInputHashesExact: true, tests: actual.map(({ results, ...entry }) => ({ ...entry, resultStatus: results[0].status })) });
  console.log(JSON.stringify({ green: true, passed: 24, elapsedMs: status.elapsedMs, custodyExact: true }));
}
