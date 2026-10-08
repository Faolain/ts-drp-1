import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import { root, out, baseline, oldRoot, repairRoot, hash, bytes, json, read, write, key, exact, custody, readiness } from './common.mjs';
const stage = process.argv[2];
if (!['collect', 'freeze'].includes(stage)) throw Error('Stage required');
const historic = json(oldRoot + '/control-observer-correction/runtime-roster.json');
const repair = json(repairRoot + '/runtime-roster.json');
const focused = historic.gates.find(gate => gate.label === 'focused');
const retained = historic.gates.find(gate => gate.label === 'retained');
if (focused.entries.length !== 7 || retained.entries.length !== 220 || repair.added.length !== 2 || repair.supplemental.length !== 3) throw Error('Historical identities count');
const files = [...new Set([...focused.files, ...retained.files, ...repair.supplemental.map(entry => entry.file)])];
const expected = [...focused.entries, ...retained.entries, ...repair.added, ...repair.supplemental];
if (expected.length !== 232 || new Set(expected.map(key)).size !== 232 || files.length !== 36) throw Error('Historical union');
const node = fs.realpathSync(process.execPath), vitest = fs.realpathSync(path.join(root, 'node_modules/vitest/vitest.mjs'));
if (stage === 'collect') {
  write('custody-before.json', custody());
  write('collection-readiness.json', readiness());
  write('selected-files.json', files);
  write('expected-roster.json', { focused: focused.entries, retainedHistorical: retained.entries, newClosureControls: repair.added, supplementalBootstrap: repair.supplemental, files, expected, historicalRosterSha256: hash(bytes(oldRoot + '/control-observer-correction/runtime-roster.json')), repairRosterSha256: hash(bytes(repairRoot + '/runtime-roster.json')) });
  // The prior accepted options are reused byte-for-byte; createProgram discovers current
  // inputs and import edges without requesting diagnostics or emitting any output.
  const priorProgram = json(oldRoot + '/control-observer-correction/program-identity-final.json');
  const rootNames = [...new Set([...priorProgram.rootNames, ...files.map(file => path.join(root, file)), ...repair.editableOwners.filter(file => file.endsWith('.ts')).map(file => path.join(root, file))])];
  const options = { ...priorProgram.options, noEmit: true, incremental: false };
  const program = ts.createProgram(rootNames, options);
  const sources = program.getSourceFiles().map(source => ({ file: source.fileName, physical: fs.realpathSync(source.fileName), sha256: hash(source.text) }));
  const edges = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(root + '/') || source.fileName.includes('/node_modules/')) continue;
    for (const imported of ts.preProcessFile(source.text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, source.fileName, options, ts.sys).resolvedModule;
      edges.push({ from: source.fileName, specifier: imported.fileName, to: resolved?.resolvedFileName ?? null });
    }
  }
  write('program-identity.json', { rootNames, options, sources, edges, compilerVersion: ts.version, noEmit: true, diagnosticsRequested: false, testExecutions: 0, optionsProvenance: oldRoot + '/control-observer-correction/program-identity-final.json', optionsProvenanceSha256: hash(bytes(oldRoot + '/control-observer-correction/program-identity-final.json')) });
  const specialEdges = json(repairRoot + '/consumers-accepted.json');
  write('consumer-inspection-edges.json', { source: repairRoot + '/consumers-accepted.json', sha256: hash(bytes(repairRoot + '/consumers-accepted.json')), dependencies: specialEdges.dependencies, sourceInspectionEdges: specialEdges.sourceInspectionEdges, allSourceHashesRevalidated: Object.entries(specialEdges.hashes).every(([file, digest]) => hash(bytes(file)) === digest) });
  fs.mkdirSync(path.join(out, 'collection'));
  const command = [node, vitest, 'list', ...files.map(file => path.join(root, file)), '--json', '--no-file-parallelism', '--coverage.enabled=false'];
  const budgetMs = 60000, started = Date.now();
  write('collection/command.json', { cwd: root, command, budgetMs, testsExecuted: 0 });
  const stdout = fs.openSync(path.join(out, 'collection/stdout'), 'wx'), stderr = fs.openSync(path.join(out, 'collection/stderr'), 'wx');
  const env = { ...process.env };
  for (const name of ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH']) delete env[name];
  const child = spawn(command[0], command.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', stdout, stderr] });
  let timedOut = false, spawnError;
  const signal = name => { if (!child.pid) return; try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, budgetMs);
  const hardTimer = setTimeout(() => { if (timedOut) signal('SIGKILL'); }, budgetMs + 2000);
  child.on('error', error => { spawnError = String(error); });
  child.on('close', (code, childSignal) => {
    clearTimeout(timer); clearTimeout(hardTimer); fs.closeSync(stdout); fs.closeSync(stderr);
    write('collection/status.json', { code, signal: childSignal, spawnError, timedOut, elapsedMs: Date.now() - started, ownedProcessGroup: child.pid, testsExecuted: 0 });
    console.log(JSON.stringify({ stage, code, timedOut, files: files.length, expectedCases: 232 }));
    process.exitCode = timedOut ? 124 : code ?? 1;
  });
} else {
  if (read('collection/status.json').code !== 0 || read('collection/status.json').timedOut) throw Error('Collection failed');
  const entries = JSON.parse(bytes(path.join(out, 'collection/stdout'))).map(entry => ({ file: path.relative(root, entry.file), name: entry.name }));
  if (!exact(entries, expected)) throw Error('Exact 232-identity collection mismatch');
  const after = custody(), before = read('custody-before.json');
  if (JSON.stringify(after) !== JSON.stringify(before)) throw Error('Custody changed during preparation');
  write('custody-after.json', after);
  const program = read('program-identity.json');
  const inputs = [...new Set([...program.sources.map(source => source.physical), ...Object.keys(historic.inputHashes), ...Object.keys(repair.inputHashes), ...files.map(file => path.join(root, file)), ...['vite.config.mts', 'tsconfig.json', 'package.json', 'pnpm-lock.yaml', 'node_modules/typescript/lib/typescript.js', 'node_modules/vitest/vitest.mjs'].map(file => fs.realpathSync(path.join(root, file)))])].sort();
  const inputHashes = Object.fromEntries(inputs.map(file => [file, hash(bytes(file))]));
  for (const source of program.sources) if (inputHashes[source.physical] !== source.sha256) throw Error('Compiler source drift');
  for (const [file, digest] of Object.entries(repair.inputHashes)) if (inputHashes[file] !== digest) throw Error('Repair runtime input drift');
  const make = (label, selected, cases, budgetMs, budgetRationale) => ({ label, files: selected, entries: cases, budgetMs, budgetRationale, maxInvocations: 1, released: false, command: [node, vitest, 'run', ...selected.map(file => path.join(root, file)), '--no-file-parallelism', '--coverage.enabled=false', '--reporter=default', '--reporter=json', '--outputFile=' + path.join(out, label, 'result.json')], environmentUnset: ['TS_DRP_D108E4M_PROFILE', 'TS_DRP_F5B_WIDE_DIAGNOSTIC', 'D110C_0B1_EVIDENCE_PATH'], environmentSet: {}, unchangedTestAndChildTimers: true, stopOnFailureNoRetryOrNextGate: true });
  const gates = [
    make('runtime-w0', focused.files, focused.entries, 300000, 'Historical corrected W0 elapsed 29681ms; unchanged two 120000ms explicit case ceilings plus 60000ms process/setup allowance. No test timer widened.'),
    make('runtime-retained', retained.files, [...retained.entries, ...repair.added], 360000, 'Historical full retained elapsed159623ms; latest repaired 51-consumer pass113947ms under240000ms. 360000ms whole-invocation ceiling provides bounded overhead for222 cases; existing150000ms child-test ceilings unchanged.'),
    make('runtime-bootstrap-supplement', [...new Set(repair.supplemental.map(entry => entry.file))], repair.supplemental, 60000, 'Three existing pure bootstrap controls were included in the repaired51 pass; separate60000ms process ceiling, no test timer change.'),
  ];
  const artifactHashes = Object.fromEntries(['common.mjs', 'runtime.mjs', 'prepare.mjs', 'program-identity.json', 'expected-roster.json', 'consumer-inspection-edges.json', 'custody-before.json', 'custody-after.json', 'selected-files.json', 'collection/command.json', 'collection/status.json', 'collection/stdout', 'collection/stderr'].map(file => [file, hash(bytes(path.join(out, file)))]));
  write('runtime-roster.json', { baseline, files, entries, historicalW0: focused.entries, historicalRetained: retained.entries, newClosureControls: repair.added, supplementalBootstrap: repair.supplemental, counts: { files: 36, total: 232, historicalW0: 7, historicalRetained: 220, newClosure: 2, actualRetained: 222, bootstrapSupplement: 3 }, gates, inputHashes, artifactHashes, node, nodeSha256: hash(bytes(node)), vitest, vitestSha256: hash(bytes(vitest)), compiler: fs.realpathSync(path.join(root, 'node_modules/typescript/lib/typescript.js')), sourcePatchSha256: after.sourcePatchSha256, noExcludedOrRelabeledIdentities: true, testsExecuted: 0, buildsExecuted: 0, reviewsExecuted: 0, typecheckClaim: 'No fresh diagnostics requested; prior repair baseline-equivalent26diagnostics is not whole-program GREEN.' });
  write('readiness.json', { ...readiness(), baseline, runtimeRosterSha256: hash(bytes(path.join(out, 'runtime-roster.json'))), requiresImmediatePreExecutionRecheck: true, allRuntimeReleased: false });
  write('handoff.json', { status: 'Readiness only; all runtime gates await separate root release artifacts', baseline, runtimeRosterSha256: hash(bytes(path.join(out, 'runtime-roster.json'))), counts: read('runtime-roster.json').counts, inputCount: inputs.length, compilerRoots: program.rootNames.length, compilerSources: program.sources.length, importEdges: program.edges.length, custody: { dirty: after.dirty.length, built: Object.keys(after.built).length, stashes: after.stashes, protectedPaths: after.protectedPaths, sealedRoots: Object.keys(after.manifests).length, sealedEntries: after.manifestEntries }, gates: gates.map(gate => ({ label: gate.label, files: gate.files.length, cases: gate.entries.length, budgetMs: gate.budgetMs, releaseFile: 'root-' + gate.label + '-release.json', command: [node, path.join(out, 'runtime.mjs'), gate.label] })), requiredReleaseFields: ['gate', 'baseline', 'runtimeRosterSha256', 'sourcePatchSha256', 'maxInvocations:1'], sourceEdits: 0, testsExecuted: 0, builds: 0, reviews: 0, noRetryAuthority: true, browserFreshSourceReviewsRemainRootOwned: true });
  console.log(JSON.stringify(read('handoff.json')));
}
