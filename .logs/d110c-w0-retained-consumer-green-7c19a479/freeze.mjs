import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const custody = read('custody-after.json');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
if (git('rev-parse', 'HEAD') !== custody.baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('HEAD/index drift');
for (const label of ['custody-before', 'custody-after', 'format-check', 'lint', 'diff-check', 'equivalence-accepted', 'typecheck-delta', 'consumers-accepted', 'collection']) if (read(label + '/status.json').code !== 0) throw Error('Static gate not accepted: ' + label);
const typeDelta = read('typecheck-delta.json');
if (typeDelta.newDiagnostics !== 0 || typeDelta.retainedDiagnostics !== 26) throw Error('Type baseline changed');
for (const [file, digest] of Object.entries({ ...custody.targetHashes, ...custody.protectedSources, ...custody.built })) if (hash(fs.readFileSync(path.join(root, file))) !== digest) throw Error('Source/build drift: ' + file);
const consumers = read('consumers-accepted.json');
const files = read('selected-files-accepted.json');
const redRoot = '.logs/d110c-w0-retained-consumer-red-b7e498bc';
const red = JSON.parse(fs.readFileSync(path.join(root, redRoot, 'runtime-roster.json')));
const redConsumers = JSON.parse(fs.readFileSync(path.join(root, redRoot, 'consumers-accepted.json')));
for (const key of ['tests', 'supplemental', 'sourceInspectionEdges', 'affected']) if (JSON.stringify(consumers[key]) !== JSON.stringify(redConsumers[key])) throw Error('Reverse consumer roster changed: ' + key);
const entries = JSON.parse(fs.readFileSync(path.join(out, 'collection/stdout'), 'utf8')).map(entry => ({ file: path.relative(root, entry.file), name: entry.name }));
const key = entry => entry.file + ' :: ' + entry.name;
if (entries.length !== 51 || new Set(entries.map(key)).size !== 51 || JSON.stringify(entries.map(key).sort()) !== JSON.stringify(red.entries.map(key).sort())) throw Error('Exact inherited RED collection mismatch');
if (JSON.stringify([...new Set(entries.map(entry => entry.file))].sort()) !== JSON.stringify([...files].sort())) throw Error('Collection file mismatch');
const program = read('program-identity-after.json');
const beforeProgram = read('program-identity-before.json');
for (const field of ['files', 'rootNames', 'options', 'compilerVersion']) if (JSON.stringify(program[field]) !== JSON.stringify(beforeProgram[field])) throw Error('Compiler profile drift: ' + field);
if (program.sources.length !== 909 || program.rootNames.length !== 16 || JSON.stringify(program.sources.map(source => source.physical)) !== JSON.stringify(beforeProgram.sources.map(source => source.physical))) throw Error('Compiler input identity mismatch');
const inputs = [...new Set([
  ...program.sources.map(source => source.physical), ...Object.keys(red.inputHashes),
  ...Object.keys(consumers.hashes).map(file => path.join(root, file)),
  ...custody.targets.map(file => path.join(root, file)),
  ...['vite.config.mts', 'pnpm-lock.yaml', 'package.json', 'tsconfig.json'].map(file => path.join(root, file)),
])].sort();
const inputHashes = Object.fromEntries(inputs.map(file => [file, hash(fs.readFileSync(file))]));
for (const source of program.sources) if (inputHashes[source.physical] !== source.sha256) throw Error('Compiler input changed: ' + source.file);
for (const [file, digest] of Object.entries(consumers.hashes)) if (inputHashes[path.join(root, file)] !== digest) throw Error('Consumer input changed: ' + file);
for (const [file, digest] of Object.entries(red.inputHashes)) if (!custody.targets.includes(path.relative(root, file)) && inputHashes[file] !== digest) throw Error('Non-owner RED input changed: ' + file);
const node = fs.realpathSync(process.execPath);
const vitest = fs.realpathSync(path.join(root, 'node_modules/vitest/vitest.mjs'));
const checkpointFiles = ['tests/phase-6b-d110c-0b1-boundaries.test.ts', 'tests/phase-6b-d110c-0b1-bounded-checkpoint-red.test.ts'];
const command = (selected, label) => [node, vitest, 'run', ...selected.map(file => path.join(root, file)), '--no-file-parallelism', '--coverage.enabled=false', '--reporter=default', '--reporter=json', '--outputFile=' + path.join(out, label, 'result.json')];
const checkpointEntries = entries.filter(entry => checkpointFiles.includes(entry.file));
if (checkpointEntries.length !== 7) throw Error('Checkpoint case count');
const gates = [
  { label: 'runtime-checkpoint', phase: 'GREEN', released: false, files: checkpointFiles, entries: checkpointEntries,
    command: command(checkpointFiles, 'runtime-checkpoint'), budgetMs: 120000,
    environmentUnset: ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC'],
    environmentSet: { D110C_0B1_EVIDENCE_PATH: path.join(out, 'runtime-checkpoint/diagnostic.json') },
    unchangedTimers: true, expensiveChildInvocations: 0, expectedPassed: 7, expectedFailed: 0,
    newFailurePolicy: 'Finish invocation, read-only diagnose and report, then await reslice authority. No edit, retry or next runtime gate.' },
  { label: 'runtime-consumers', phase: 'GREEN', released: false, files, entries,
    command: command(files, 'runtime-consumers'), budgetMs: 240000,
    environmentUnset: ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH'], environmentSet: {},
    unchangedTimers: true, genuineSkipBudgetChildRequiredOnce: true, expectedPassed: 51, expectedFailed: 0,
    requiresSuccessfulCheckpointAndSeparateRootRelease: true,
    newFailurePolicy: 'Finish invocation, read-only diagnose and report, then await reslice authority. No edit or retry.' },
];
const inheritedOptions = process.env.NODE_OPTIONS ?? '';
if (/--(?:cpu[-_]prof|heap[-_]prof|prof(?:\b|[-_]))/u.test(inheritedOptions) || process.env.NODE_V8_COVERAGE) throw Error('Inherited profiling environment');
const ports = [4174, 4175, 51000, 51002].map(port => {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (![0, 1].includes(result.status)) throw Error('Port query failed');
  const pids = result.stdout.trim().split(/\s/u).filter(value => /^\d+$/u.test(value)).map(Number);
  if (pids.length) throw Error('Occupied fixed port: ' + port);
  return { port, pids, noTcpListener: true };
});
const query = spawnSync('pgrep', ['-f', '(vitest|typescript/lib/tsc|eslint/bin|prettier/bin|quint|apalache|heap-prof|cpu-prof)'], { encoding: 'utf8' });
if (![0, 1].includes(query.status)) throw Error('Process query failed');
const processes = [];
for (const pid of query.stdout.trim().split(/\s/u).filter(value => /^\d+$/u.test(value)).map(Number).filter(value => value !== process.pid && value !== process.ppid)) {
  const status = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' });
  if (status.status === 1) continue;
  if (status.status !== 0) throw Error('Process status failed');
  const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const directories = cwd.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  const relevant = directories.some(directory => directory === root || directory.startsWith(root + '/'));
  processes.push({ pid, numericStatus: status.stdout.trim(), cwd: directories, relevant });
  if (relevant) throw Error('Competing task process: ' + pid);
}
const sourcePatchSha256 = hash(fs.readFileSync(path.join(out, 'green.patch')));
const runner = path.join(out, 'runtime.mjs');
const runtimeRunnerSha256 = hash(fs.readFileSync(runner));
write('readiness.json', { baseline: custody.baseline, checkedAt: new Date().toISOString(), sourceAndBuildHashesExact: true, compilerInputsExact: true, inheritedProfilingAbsent: true, nodeV8CoverageAbsent: true, noCompetingTaskProcesses: true, numericOnlyProcessInspection: true, processes, ports, runtimeNotReleased: true, requiresImmediatePreExecutionRecheck: true });
write('runtime-roster.json', { baseline: custody.baseline, signature: 'G', editableOwners: custody.targets, files, entries, inherited: red.inherited, added: red.added, supplemental: red.supplemental, counts: red.counts, gates, inputHashes, node, nodeSha256: hash(fs.readFileSync(node)), vitest, vitestSha256: hash(fs.readFileSync(vitest)), runtimeRunner: runner, runtimeRunnerSha256, sourcePatchSha256, noNewExclusions: true, noHistoricalRosterRepin: true, exactRedCaseIdentitiesPreserved: true, testExecutions: 0, wholeProgramTypecheckPass: false, typecheckBaselineEquivalent: true });
write('handoff.json', {
  status: 'GREEN source and static freeze READY; zero runtime test executions; root release pending', baseline: custody.baseline,
  sourcePatch: 'green.patch', sourcePatchSha256, sourceHashes: custody.targetHashes, sourceCommitted: false,
  static: { lintErrors: 0, lintWarnings: 0, formatPass: true, diffPass: true, equivalence: 'equivalence.json', greenHunksOnlyAndRedObserversPreserved: true,
    typecheck: { classification: typeDelta.classification, retainedDiagnostics: 26, newDiagnostics: 0, ownedDiagnostics: 3, inventory: 'typecheck-delta.json', wholeProgramPass: false, selectedRoots: 16, sourceInputs: 909 } },
  collection: { files: 14, cases: 51, inheritedCases: 46, addedCases: 2, supplementalCases: 3, result: 'collection/stdout', authoritativeRoster: 'runtime-roster.json', noDuplicateOrRelabeledIdentities: true, reverseImportGraph: 'consumers-accepted.json' },
  custody: { protectedSources: 11, builtIdentities: 7, stashes: 27, protectedPaths: 86522, manifests: Object.keys(custody.manifests).length, inheritedInputs: custody.inheritedInputCount, currentInputs: inputs.length, allPreserved: true },
  behaviorClaims: 'No GREEN runtime outcome claimed. Genuine skip-budget child and both cold-input lifecycle controls remain to be executed after explicit root release.',
  currentSuccessorControls: 'Existing 0c1b successful recovered handle and accepted issuance assertions; no observer callback API expansion.',
  proposedRuntime: gates.map(({ label, budgetMs, files, entries }) => ({ label, budgetMs, files: files.length, cases: entries.length, released: false })),
  corrections: 'static-corrections.json', reviewersLaunched: 0, buildsLaunched: 0, testsExecuted: 0,
});
console.log(JSON.stringify({ ready: true, runtimeReleased: false, files: files.length, cases: entries.length, inputs: inputs.length, sourcePatchSha256, runtimeRunnerSha256, checkpointBudgetMs: 120000, consumerBudgetMs: 240000 }));
