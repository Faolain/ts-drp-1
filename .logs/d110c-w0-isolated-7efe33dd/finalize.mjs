import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root as main, out, baseline, read, write, bytes, hash, custody, readiness, exact } from './common.mjs';
const roster = read('runtime-roster.json'), preparation = read('handoff.json');
const rosterSha256 = hash(bytes(path.join(out, 'runtime-roster.json')));
const isolated = read('checkout.json').root;
const results = [];
const allAssertions = [];
for (const gate of roster.gates) {
  const label = gate.label, status = read(label + '/status.json'), validation = read(label + '/validation.json');
  const result = read(label + '/result.json'), release = read('root-' + label + '-release.json');
  const assertions = result.testResults.flatMap(suite => suite.assertionResults.map(assertion => ({ file: path.relative(isolated, suite.name), name: [...assertion.ancestorTitles, assertion.title].join(' > '), status: assertion.status })));
  if (!validation.green || !validation.exactRoster || !validation.postCustodyExact || !validation.isolatedCustodyExact || !validation.allInputsExact || status.code !== 0 || status.timedOut || !status.quiescent || status.cleanup.length || !exact(assertions, gate.entries) || assertions.some(assertion => assertion.status !== 'passed') || result.numFailedTests !== 0 || result.numPendingTests !== 0 || result.numTodoTests !== 0 || result.numTotalTests !== gate.entries.length) throw Error('Incomplete exact GREEN gate: ' + label);
  if (release.baseline !== baseline || release.runtimeRosterSha256 !== rosterSha256 || release.sourcePatchSha256 !== roster.sourcePatchSha256 || release.maxInvocations !== 1) throw Error('Released source identity changed');
  allAssertions.push(...assertions);
  results.push({ label, files: gate.files.length, tests: gate.entries.length, passed: assertions.length, failed: 0, pending: 0, skipped: 0, todo: 0, exactRoster: true, elapsedMs: status.elapsedMs, budgetMs: gate.budgetMs, invocations: 1, timedOut: false, cleanup: status.cleanup, quiescent: true, postMainCustodyExact: true, postIsolatedCustodyExact: true, allInputsExact: true, releaseSha256: hash(bytes(path.join(out, 'root-' + label + '-release.json'))), resultSha256: hash(bytes(path.join(out, label, 'result.json'))), validationSha256: hash(bytes(path.join(out, label, 'validation.json'))) });
}
if (!exact(allAssertions, roster.entries) || allAssertions.length !== 232) throw Error('Combined isolated roster changed');
for (const [file, digest] of Object.entries(roster.inputHashes)) if (hash(bytes(file)) !== digest) throw Error('Frozen isolated input changed');
for (const [file, digest] of Object.entries(roster.artifactHashes)) if (hash(bytes(path.join(out, file))) !== digest) throw Error('Frozen preparation artifact changed');
if (hash(bytes(roster.node)) !== roster.nodeSha256 || hash(bytes(roster.vitest)) !== roster.vitestSha256) throw Error('Runtime binary changed');
const sourceIsolation = read('source-isolation.json');
for (const link of sourceIsolation.symlinks) if (fs.realpathSync(path.join(isolated, link.file)) !== link.physical) throw Error('Independent dependency link changed');
const git = (...args) => execFileSync('git', ['-C', isolated, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
if (git('rev-parse', 'HEAD') !== baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('Isolated HEAD/index changed');
const mainBefore = read('custody-before.json');
if (JSON.stringify(git('diff', '--name-only').split('\n').sort()) !== JSON.stringify(mainBefore.dirty)) throw Error('Isolated overlay owner set changed');
const patch = execFileSync('git', ['-C', isolated, 'diff', '--binary', '--full-index'], { maxBuffer: 128 * 1024 * 1024 });
if (hash(patch) !== roster.sourcePatchSha256) throw Error('Isolated overlay patch changed');
const mainFinal = custody();
if (JSON.stringify(mainFinal) !== JSON.stringify(mainBefore)) throw Error('Main custody changed during isolated acceptance');
const ready = readiness();
write('custody-final.json', { main: mainFinal, isolatedRoot: isolated, isolatedBaseline: baseline, isolatedSignature: 'G', isolatedIndexEmpty: true, exactOverlaySha256: hash(patch), allFrozenInputHashesExact: true, frozenInputCount: Object.keys(roster.inputHashes).length, allFrozenArtifactHashesExact: true, dependencyLinksExact: sourceIsolation.symlinks.length, freshBuiltFilesExact: sourceIsolation.builtFiles.length, runtimeBinariesExact: true, runtimeGroupsQuiescent: true, sourceEditsBeyondFrozenOverlay: 0, finalReadiness: ready });
const native = read('native-target.json'), nativeArtifacts = read('native-artifacts.json');
const typecheck = read('typecheck-disposition.json'), graph = read('graph-comparison.json');
write('isolated-handoff.json', {
  status: 'All three separately released independent source-built W0 acceptance gates GREEN; ready for root verification and formal review',
  baseline, signature: 'G', mainWorkspace: main, isolatedRoot: isolated,
  sourceOverlay: 'source-overlay.patch', sourceOverlaySha256: roster.sourcePatchSha256, overlayOwnerCount: 11, noSourceEditsBeyondFrozenOverlay: true, mainSourceEdits: 0, commitsCreated: 0,
  runtimeRoster: 'runtime-roster.json', runtimeRosterSha256: rosterSha256, counts: roster.counts, outcomes: results,
  runtimeInvocations: results.length, totalCaseExecutions: allAssertions.length, uniqueCaseIdentities: allAssertions.length, retries: 0, skipped: 0, pending: 0, todo: 0, historicalIdentityPolicy: 'Original W0 seven and all retained220 preserved literally, two closure controls included in retained222, three bootstrap cases separate; no omitted or relabeled cases.',
  independentPreparation: { clone: 'Shared Git object database only; detached exact signed HEAD, then exact eleven-owner source overlay', install: 'One independent pnpm install --offline --frozen-lockfile --ignore-scripts', native: 'One locked prebuild-install7.1.3 public GitHub NAPI8 download for node-datachannel0.32.3 into a fresh cache', nativeUrl: native.url, nativeArtifacts: nativeArtifacts.artifacts, build: 'One pnpm build:packages inside fresh checkout only', noCopiedMainNodeModulesDistOrNative: true, internalDependencyLinks: sourceIsolation.symlinks.length, freshBuiltFiles: sourceIsolation.builtFiles.length, isolatedRuntimeInputHashes: Object.keys(roster.inputHashes).length, commonMappedRuntimeInputs: sourceIsolation.remappedRuntimeInputs.length },
  compiler: { scope: 'Fresh current-source strict forty-root main baseline compared with independently resolved isolated forty-root program', mainSources: graph.mainSourceCount, isolatedSources: graph.isolatedSourceCount, roots: graph.rootCount, normalizedEdges: graph.isolatedEdges, commonSourceHashesExact: true, actualMainOnlyAncestorDeclarationCount: graph.mainOnlySources.length, environmentOnlyDeltaDerivedFromActualSets: true, noOld381AcceptanceAssumption: true, compilerOptionsIdenticalAfterOnlyCheckoutRelocation: true, independentCompilerPath: roster.compiler, noTypesTypeRootsOrAmbientInjection: true, noMainOrAncestorSourceResolvedByIsolated: true, classification: typecheck.classification, mainCurrentBaselineDiagnostics: typecheck.mainBaselineDiagnostics, isolatedDiagnostics: typecheck.isolatedDiagnostics, targetedDiagnostics: typecheck.targetedDiagnostics.length, newDiagnostics: 0, wholeProgramPass: false, olderZeroAnd26DiagnosticScopesNotReused: true },
  static: preparation.static,
  custody: { file: 'custody-final.json', mainDirtySources: 11, protectedSourceHashes: 14, mainBuiltIdentities: 7, stashes: 27, protectedPaths: 86522, mainSealedRoots: Object.keys(mainFinal.manifests).length, mainSealedEntries: mainFinal.manifestEntries, allMainAndIsolatedIdentitiesPreserved: true, runtimeGroupsQuiescent: true, cleanupSignals: 0, indexEmpty: true },
  rootPrelaunchCorrection: { classification: 'Root corrected a baseline-typing typo before the bootstrap invocation; not a failed runtime or retry', record: '.logs/d110c-w0-current-profile-acceptance-61ea93f6/isolated-bootstrap-release-verify/', files: ['command.json', 'stdout', 'status.json'], rootOwnedUnsealedAcceptanceEvidenceNotModifiedOrSealedHere: true },
  preparationHandoffAndFrozenArtifactsPreserved: true, standaloneBuilds: 1, reviewerInvocations: 0, browserRerunInvocations: 0, furtherRuntimeReleased: false, retainedCheckoutPreserved: true,
  nextOwner: 'Root for independent sealed-evidence verification, source/plan acceptance and frozen formal reviews; no commit or campaign authorized by this handoff.',
  finalManifest: { file: 'manifest.sha256', role: 'Exact self-excluding directory inventory preserving every preparation/runtime/status artifact and this final disposition' },
});
console.log(JSON.stringify({ readyToSeal: true, gates: results.length, cases: allAssertions.length, passed: allAssertions.length, allMainAndIsolatedCustodyExact: true, isolatedInputs: Object.keys(roster.inputHashes).length, typecheck: '92/92 baseline-equivalent; not clean', runtimeGroupsQuiescent: true }));
