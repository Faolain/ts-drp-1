import fs from 'node:fs';
import path from 'node:path';
import { root as main, out, baseline, read, write, hash, custody, readiness, exact } from './common.mjs';
const { root } = read('checkout.json');
const prior = JSON.parse(fs.readFileSync(path.join(main, '.logs/d110c-w0-regression-readiness-7efe33dd/runtime-roster.json')));
for (const name of ['clone', 'checkout', 'overlay-check', 'overlay', 'install', 'native-preparation', 'build', 'main-typecheck', 'isolated-typecheck', 'lint', 'format', 'diff', 'collection', 'isolation-inventory']) {
  const status = read(name + '/status.json');
  if (status.code !== 0 || status.timedOut || !status.quiescent) throw Error('Preparation operation failed: ' + name);
}
const graph = read('graph-comparison.json'), typecheck = read('typecheck-disposition.json');
if (!graph.valid || typecheck.newDiagnostics !== 0 || !typecheck.exactMessagesLocationsAndSourceAnchors) throw Error('Static disposition incomplete');
const entries = JSON.parse(fs.readFileSync(path.join(out, 'collection/stdout'))).map(entry => ({ file: path.relative(root, entry.file), name: entry.name }));
if (!exact(entries, prior.entries) || entries.length !== 232) throw Error('Exact isolated 232-case collection mismatch');
const files = read('selected-files.json');
if (JSON.stringify([...new Set(entries.map(entry => entry.file))].sort()) !== JSON.stringify([...files].sort())) throw Error('Collection file set differs');
const mainCustody = custody();
if (JSON.stringify(mainCustody) !== JSON.stringify(read('custody-before.json'))) throw Error('Main custody changed');
write('custody-ready-main.json', mainCustody);
const isolatedCustody = read('custody-ready.json');
if (!isolatedCustody.noSourceEditsBeyondExactOverlay || !isolatedCustody.noSharedDependenciesOrBuilds) throw Error('Isolated custody incomplete');
const isolation = read('source-isolation.json');
const program = read('program-identity-isolated.json');
const native = read('native-target.json'), nativeArtifacts = read('native-artifacts.json');
const inputSet = new Set([
  ...program.sources.map(source => source.physical),
  ...isolation.remappedRuntimeInputs.map(source => source.physical),
  ...isolation.builtFiles.map(source => source.physical),
  ...files.map(file => path.join(root, file)),
  ...Object.keys(native.inputHashes).map(file => path.join(root, file)), native.native,
]);
const inputHashes = {};
for (const file of [...inputSet].sort()) {
  const physical = fs.realpathSync(file);
  if (!physical.startsWith(root + '/')) throw Error('Frozen isolated input escaped checkout');
  inputHashes[physical] = hash(fs.readFileSync(physical));
}
for (const source of [...program.sources, ...isolation.remappedRuntimeInputs, ...isolation.builtFiles]) if (inputHashes[source.physical] !== source.sha256) throw Error('Fresh source/build input drift');
for (const artifact of Object.values(nativeArtifacts.artifacts)) if (hash(fs.readFileSync(artifact.source)) !== artifact.sha256) throw Error('Native artifact drift');
const node = fs.realpathSync(process.execPath), vitest = fs.realpathSync(path.join(root, 'node_modules/vitest/vitest.mjs'));
const gates = prior.gates.map(gate => ({ ...gate, released: false, command: [node, vitest, 'run', ...gate.files.map(file => path.join(root, file)), '--no-file-parallelism', '--coverage.enabled=false', '--reporter=default', '--reporter=json', '--outputFile=' + path.join(out, gate.label, 'result.json')], budgetRationale: 'Same bounded process ceiling and unchanged test/child timers as the separately passed main regression gate; independently installed and source-built checkout.' }));
const artifactFiles = ['common.mjs', 'runtime.mjs', 'freeze.mjs', 'checkout.json', 'source-overlay.patch', 'custody-before.json', 'custody-ready.json', 'custody-ready-main.json', 'source-isolation.json', 'graph-comparison.json', 'program-identity-main.json', 'program-identity-isolated.json', 'typecheck-main.json', 'typecheck-isolated.json', 'typecheck-disposition.json', 'native-target.json', 'native-artifacts.json', 'selected-files.json', 'targeted-static-files.json', 'preparation-operations.json', 'static-operations.json', 'collection/stdout', 'collection/stderr', 'collection/status.json', 'collection/command.json'];
const artifactHashes = Object.fromEntries(artifactFiles.map(file => [file, hash(fs.readFileSync(path.join(out, file)))]));
write('runtime-roster.json', { baseline, isolatedRoot: root, files, entries, historicalW0: prior.historicalW0, historicalRetained: prior.historicalRetained, newClosureControls: prior.newClosureControls, supplementalBootstrap: prior.supplementalBootstrap, counts: prior.counts, gates, inputHashes, artifactHashes, node, nodeSha256: hash(fs.readFileSync(node)), vitest, vitestSha256: hash(fs.readFileSync(vitest)), compiler: program.compilerPath, sourcePatchSha256: mainCustody.sourcePatchSha256, mainRegressionRosterSha256: hash(fs.readFileSync(path.join(main, '.logs/d110c-w0-regression-readiness-7efe33dd/runtime-roster.json'))), noExcludedOrRelabeledIdentities: true, testsExecuted: 0, independentInstallCount: 1, independentNativePreparationCount: 1, independentBuildCount: 1, reviewsExecuted: 0, typecheckClaim: typecheck.classification });
const runtimeRosterSha256 = hash(fs.readFileSync(path.join(out, 'runtime-roster.json')));
write('readiness.json', { ...readiness(), baseline, isolatedRoot: root, runtimeRosterSha256, requiresImmediatePreExecutionRecheck: true, allRuntimeReleased: false });
const lint = JSON.parse(fs.readFileSync(path.join(out, 'lint/stdout')));
write('handoff.json', { status: 'Independent source-built W0 acceptance READY; no isolated runtime test executed; all three gates require separate root releases', baseline, isolatedRoot: root, sourcePatchSha256: mainCustody.sourcePatchSha256, runtimeRosterSha256, counts: prior.counts, inputCount: Object.keys(inputHashes).length,
  isolation: { independentInstallCount: 1, independentNativeDownloadCount: 1, independentBuildCount: 1, dependenciesInsideCheckout: true, sourceAndBuildsNotCopiedFromMain: true, freshBuiltFiles: isolation.builtFiles.length, dependencyLinks: isolation.symlinks.length, actualCommonRuntimeInputs: isolation.remappedRuntimeInputs.length, environmentOnlyOmissions: isolation.environmentOnlyInputOmissions.length, proof: 'source-isolation.json' },
  compiler: { mainRoots: 40, mainSources: graph.mainSourceCount, mainEdges: graph.mainEdges, isolatedRoots: 40, isolatedSources: graph.isolatedSourceCount, isolatedEdges: graph.isolatedEdges, actualDerivedEnvironmentOnlyDelta: graph.mainOnlySources.length, allCommonHashesExact: true, optionsOnlyRootRemapped: true, noAmbientInjection: true, disposition: typecheck.classification, mainCurrentBaselineDiagnostics: typecheck.mainBaselineDiagnostics, isolatedDiagnostics: typecheck.isolatedDiagnostics, targetedDiagnostics: typecheck.targetedDiagnostics.length, newDiagnostics: 0, wholeProgramPass: false },
  static: { lintErrors: lint.reduce((sum, file) => sum + file.errorCount, 0), lintWarnings: lint.reduce((sum, file) => sum + file.warningCount, 0), warningDisposition: 'One inherited W0 JSDoc missing shape parameter declaration; untouched source and same prior warning', format: 'pass', diff: 'pass', exactCollection: true, typeDebtRepaired: false },
  custody: { mainDirty: 11, protectedSources: 14, mainBuilt: 7, stashes: 27, protectedPaths: 86522, sealedRoots: Object.keys(mainCustody.manifests).length, sealedEntries: mainCustody.manifestEntries, mainPreserved: true, isolatedExactOverlay: true },
  gates: gates.map(gate => ({ label: gate.label, files: gate.files.length, cases: gate.entries.length, budgetMs: gate.budgetMs, command: [node, path.join(out, 'runtime.mjs'), gate.label], releaseFile: 'root-' + gate.label + '-release.json' })), requiredReleaseFields: ['gate', 'baseline', 'runtimeRosterSha256', 'sourcePatchSha256', 'maxInvocations:1'], sourceEdits: 0, testExecutions: 0, runtimeTestsReleased: false, commits: 0, reviewers: 0, noRetries: true, browserRerunRequested: false });
console.log(JSON.stringify({ ready: true, runtimeRosterSha256, isolatedRoot: root, files: files.length, cases: entries.length, isolatedInputHashes: Object.keys(inputHashes).length, mainDiagnostics: typecheck.mainBaselineDiagnostics, isolatedDiagnostics: typecheck.isolatedDiagnostics, runtimeTestsExecuted: 0 }));
