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
for (const label of ['custody-before', 'custody-after', 'format-check', 'lint-accepted', 'diff-check', 'equivalence-accepted', 'typecheck-delta-accepted', 'collection', 'whitespace-diagnostic-final']) {
  if (read(label + '/status.json').code !== 0) throw Error('Static gate not accepted: ' + label);
}
const typeDelta = read('typecheck-delta-accepted.json');
if (typeDelta.newDiagnostics !== 0 || typeDelta.retainedDiagnostics !== 26) throw Error('Type baseline changed');
for (const [file, digest] of Object.entries({ ...custody.targetHashes, ...custody.protectedSources, ...custody.built })) if (hash(fs.readFileSync(path.join(root, file))) !== digest) throw Error('Source/build drift: ' + file);
const consumers = read('consumers-accepted.json');
const files = read('selected-files-accepted.json');
const entries = JSON.parse(fs.readFileSync(path.join(out, 'collection/stdout'), 'utf8')).map(entry => ({ file: path.relative(root, entry.file), name: entry.name }));
const key = entry => entry.file + ' :: ' + entry.name;
if (entries.length !== 51 || new Set(entries.map(key)).size !== entries.length || JSON.stringify([...new Set(entries.map(entry => entry.file))].sort()) !== JSON.stringify([...files].sort())) throw Error('Exact collection mismatch');
const historic = JSON.parse(fs.readFileSync(path.join(root, '.logs/d110c-w0-current-profile-green-61ea93f6/control-observer-correction/runtime-roster.json')));
const historicKeys = new Set(historic.entries.map(key));
const inherited = entries.filter(entry => historicKeys.has(key(entry)));
const supplemental = entries.filter(entry => consumers.supplemental.includes(entry.file));
const added = entries.filter(entry => !historicKeys.has(key(entry)) && !consumers.supplemental.includes(entry.file));
if (inherited.length !== 46 || supplemental.length !== 3 || added.length !== 2) throw Error('Roster classes');
const program = read('program-identity-final2.json');
const inputs = [...new Set([
  ...program.sources.map(source => source.physical),
  ...Object.keys(historic.inputHashes),
  ...Object.keys(consumers.hashes).map(file => path.join(root, file)),
  ...custody.targets.map(file => path.join(root, file)),
  ...['vite.config.mts', 'pnpm-lock.yaml', 'package.json', 'tsconfig.json'].map(file => path.join(root, file)),
])].sort();
const inputHashes = Object.fromEntries(inputs.map(file => [file, hash(fs.readFileSync(file))]));
for (const source of program.sources) if (inputHashes[source.physical] !== source.sha256) throw Error('Compiler source no longer exact: ' + source.file);
for (const [file, digest] of Object.entries(consumers.hashes)) if (inputHashes[path.join(root, file)] !== digest) throw Error('Consumer source no longer exact: ' + file);
const node = fs.realpathSync(process.execPath);
const vitest = fs.realpathSync(path.join(root, 'node_modules/vitest/vitest.mjs'));
const checkpointFiles = ['tests/phase-6b-d110c-0b1-boundaries.test.ts', 'tests/phase-6b-d110c-0b1-bounded-checkpoint-red.test.ts'];
const command = (selected, label) => [node, vitest, 'run', ...selected.map(file => path.join(root, file)), '--no-file-parallelism', '--coverage.enabled=false', '--reporter=default', '--reporter=json', '--outputFile=' + path.join(out, label, 'result.json')];
const checkpointEntries = entries.filter(entry => checkpointFiles.includes(entry.file));
if (checkpointEntries.length !== 7) throw Error('Checkpoint case count');
const gates = [
  {
    label: 'runtime-checkpoint', phase: 'RED', released: false, files: checkpointFiles, entries: checkpointEntries,
    command: command(checkpointFiles, 'runtime-checkpoint'), budgetMs: 120000,
    environmentUnset: ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC'],
    environmentSet: { D110C_0B1_EVIDENCE_PATH: path.join(out, 'runtime-checkpoint/diagnostic.json') },
    unchangedTimers: true, expensiveChildInvocations: 0,
    predictedPassed: 4, predictedFailed: 3,
    predictedFailureNames: [
      'D.110c-0b1 bounded protocol and control boundaries > retires exactly the stale Cut QC and predecessor ACL from the genuine staged closure',
      'D.110c-0b1 bounded checkpoint and control-proof GREEN > retires the stale proof pair and predecessor ACL under the bounded advance',
      'D.110c-0b1 bounded checkpoint and control-proof GREEN > cold reopens the genuine active epoch-two room through the bounded checkpoint owner',
    ],
    newFailurePolicy: 'Stop, diagnose, and reslice before replay; no campaign.',
  },
  {
    label: 'future-green-consumers', phase: 'GREEN proposal only', released: false, requiresFreshGreenSourceAndInputFreeze: true,
    files, entries, command: command(files, 'future-green-consumers'), budgetMs: 240000,
    environmentUnset: ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH'],
    unchangedTimers: true, genuineSkipBudgetChildRequiredOnce: true,
  },
];
const inheritedOptions = process.env.NODE_OPTIONS ?? '';
if (/--(?:cpu[-_]prof|heap[-_]prof|prof(?:\b|[-_]))/u.test(inheritedOptions) || process.env.NODE_V8_COVERAGE) throw Error('Inherited profiling environment');
const ports = [4174, 4175, 51000, 51002].map(port => {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (![0, 1].includes(result.status)) throw Error('Port query failed');
  const pids = result.stdout.trim().split(/\s/u).filter(value => /^\d+$/u.test(value)).map(Number);
  if (pids.length !== 0) throw Error('Occupied fixed port: ' + port);
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
write('readiness.json', { baseline: custody.baseline, sourceAndBuildHashesExact: true, compilerInputsExact: true, inheritedProfilingAbsent: true, nodeV8CoverageAbsent: true, noCompetingTaskProcesses: true, numericOnlyProcessInspection: true, processes, ports, runtimeNotReleased: true, requiresImmediatePreExecutionRecheck: true });
const sourcePatchSha256 = hash(fs.readFileSync(path.join(out, 'red.patch')));
write('runtime-roster.json', { baseline: custody.baseline, signature: 'G', editableOwners: custody.targets, files, entries, inherited, added, supplemental, counts: { files: files.length, cases: entries.length, inherited: inherited.length, added: added.length, supplemental: supplemental.length }, gates, inputHashes, node, nodeSha256: hash(fs.readFileSync(node)), vitest, vitestSha256: hash(fs.readFileSync(vitest)), sourcePatchSha256, noNewExclusions: true, noHistoricalRosterRepin: true, testExecutions: 0, wholeProgramTypecheckPass: false, typecheckBaselineEquivalent: true });
write('handoff.json', {
  status: 'RED observation/assertion source and static freeze ready; zero runtime test executions; root release pending', baseline: custody.baseline,
  sourcePatch: 'red.patch', sourcePatchSha256, sourceHashes: custody.targetHashes, sourceCommitted: false,
  static: { lintErrors: 0, lintWarnings: 0, formatPass: true, diffPass: true, sixOwnerObservationAssertionEquivalence: true, childImplementationByteIdentical: true, bothColdInputExpressionsUnchanged: true, typecheck: { classification: typeDelta.classification, retainedDiagnostics: 26, newDiagnostics: 0, ownedDiagnostics: 3, inventory: 'typecheck-delta-accepted.json', wholeProgramPass: false } },
  collection: { files: 14, cases: 51, inheritedCases: 46, addedCases: 2, supplementalCases: 3, result: 'collection/stdout', authoritativeRoster: 'runtime-roster.json', noDuplicateOrRelabeledIdentities: true },
  custody: { protectedSources: 11, builtIdentities: 7, stashes: 27, protectedPaths: 86522, manifests: Object.keys(custody.manifests).length, inheritedInputs: custody.inheritedInputCount, currentInputs: inputs.length, allPreserved: true },
  causalRed: { expensiveChild: 'Historical boundedStoreShape:false retained failure; observation-only implementation equivalence; no heavy child replay.', checkpoint: 'Historical TRUST_CLOSURE_INVALID and predecessor admission-rejected failures; new seven-case runtime not yet released.', currentSuccessorBootstrap: 'Static-only same-input observer at failure-recovery site; no dynamic provenance claimed.', epochTwoBootstrap: 'Dynamic provenance assertions written; not yet executed.' },
  proposedRedRuntime: { gate: 'runtime-checkpoint', files: 2, cases: 7, budgetMs: 120000, predictedPassed: 4, predictedFailed: 3, released: false },
  separateGreenOwners: [custody.targets[0], custody.targets[2], custody.targets[5]],
  greenRequirements: ['Spread real raw store before unchanged six overrides.', 'Authenticate unfiltered checkpoint/transition before projecting exact retirement and aggregate refs.', 'Supply the same originalBootstrap.operationBytes value at both cold-input sites; retain same-input observers.', 'Fresh GREEN source/input freeze, all 51 consumers including genuine skip-budget child once, then original W0 and retained gates with added cases distinguished.'],
  corrections: 'static-corrections.json', reviewersLaunched: 0, buildsLaunched: 0, testsExecuted: 0,
});
console.log(JSON.stringify({ frozen: true, runtimeReleased: false, files: files.length, cases: entries.length, inputs: inputs.length, sourcePatchSha256, redGate: { cases: 7, budgetMs: 120000 }, greenProposal: { cases: 51, budgetMs: 240000 } }));
