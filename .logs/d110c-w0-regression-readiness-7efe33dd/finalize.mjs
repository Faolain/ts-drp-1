import fs from 'node:fs';
import path from 'node:path';
import { root, out, baseline, hash, bytes, read, write, exact, custody, readiness } from './common.mjs';
const roster = read('runtime-roster.json');
const rosterSha256 = hash(bytes(path.join(out, 'runtime-roster.json')));
for (const [file, digest] of Object.entries(roster.artifactHashes)) if (hash(bytes(path.join(out, file))) !== digest) throw Error('Frozen artifact drift: ' + file);
for (const [file, digest] of Object.entries(roster.inputHashes)) if (hash(bytes(file)) !== digest) throw Error('Frozen input drift: ' + file);
const outcomes = roster.gates.map(gate => {
  const status = read(gate.label + '/status.json'), validation = read(gate.label + '/validation.json');
  const release = read('root-' + gate.label + '-release.json');
  if (release.gate !== gate.label || release.baseline !== baseline || release.maxInvocations !== 1 || release.runtimeRosterSha256 !== rosterSha256 || release.sourcePatchSha256 !== roster.sourcePatchSha256) throw Error('Release drift');
  const raw = read(gate.label + '/result.json');
  const assertions = raw.testResults.flatMap(suite => suite.assertionResults.map(assertion => ({ file: path.relative(root, suite.name), name: [...assertion.ancestorTitles, assertion.title].join(' > '), status: assertion.status })));
  if (!exact(assertions, gate.entries) || assertions.some(assertion => assertion.status !== 'passed') || !validation.green || !validation.exactRoster || !validation.postCustodyExact || !validation.allInputsExact || status.code !== 0 || status.timedOut || !status.quiescent || status.cleanup.length || status.remainingOwnedGroup.length) throw Error('Runtime gate not GREEN: ' + gate.label);
  return { label: gate.label, files: gate.files.length, tests: gate.entries.length, passed: validation.passed, failed: validation.failed, pendingSkippedTodoOrOther: validation.pendingSkippedTodoOrOther, exactRoster: true, invocations: 1, elapsedMs: status.elapsedMs, budgetMs: gate.budgetMs, timedOut: false, cleanup: [], quiescent: true, postCustodyExact: true, allInputsExact: true, releaseSha256: hash(bytes(path.join(out, 'root-' + gate.label + '-release.json'))), resultSha256: hash(bytes(path.join(out, gate.label + '/result.json'))), validationSha256: hash(bytes(path.join(out, gate.label + '/validation.json'))) };
});
const finalCustody = custody();
if (JSON.stringify(finalCustody) !== JSON.stringify(read('custody-after.json'))) throw Error('Final custody drift');
write('custody-final.json', { ...finalCustody, readiness: readiness(), runtimeInputCount: Object.keys(roster.inputHashes).length, allRuntimeInputsExact: true, allFrozenArtifactsExact: true });
const subset = bytes(path.join(out, 'readiness-manifest.sha256'));
for (const line of subset.toString().trim().split('\n')) {
  const [digest, file] = [line.slice(0, 64), line.slice(66)];
  if (hash(bytes(path.join(out, file))) !== digest) throw Error('Readiness subset changed: ' + file);
}
write('regression-handoff.json', {
  status: 'All three separately released regression gates GREEN; ready for root independent acceptance; broader W0 acceptance remains open',
  baseline, signature: 'G', sourceEdits: 0, commitsCreated: 0, sourcePatchSha256: roster.sourcePatchSha256,
  runtimeRoster: 'runtime-roster.json', runtimeRosterSha256: rosterSha256, counts: roster.counts,
  outcomes, totalCaseExecutions: 232, uniqueCaseIdentities: 232, runtimeInvocations: 3, retries: 0,
  historicalIdentityPolicy: 'Original W0 seven and retained220 preserved literally; two closure controls included in retained222; three bootstrap controls remain separately categorized, with no exclusions or relabeling.',
  custody: { dirtySources: finalCustody.dirty.length, protectedSourceHashes: Object.keys(finalCustody.sources).length, builtIdentities: Object.keys(finalCustody.built).length, stashes: finalCustody.stashes, protectedPaths: finalCustody.protectedPaths, sealedRoots: Object.keys(finalCustody.manifests).length, sealedEntries: finalCustody.manifestEntries, runtimeInputs: Object.keys(roster.inputHashes).length, allExact: true, finalRecord: 'custody-final.json' },
  compiler: { mode: 'Fresh no-emit input graph only; no diagnostics requested or build performed', roots: read('program-identity.json').rootNames.length, sourceInputs: read('program-identity.json').sources.length, priorTypecheckClassification: roster.typecheckClaim },
  readinessManifest: { file: 'readiness-manifest.sha256', role: 'Immutable17-file preparation subset, not an exact directory inventory', sha256: hash(subset) },
  finalManifest: { file: 'manifest.sha256', role: 'Final exact self-excluding directory inventory including all three releases, runtime results, readiness subset manifest and this handoff' },
  sourceFrozen: true, builtArtifactsUnchanged: true, buildsExecuted: 0, reviewersLaunched: 0,
  browserFreshSourceAndFormalReviews: 'Not executed here and remain root-owned; these runtime passes do not constitute full W0 acceptance.',
});
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const files = walk(out).filter(file => path.basename(file) !== 'manifest.sha256').sort();
write('manifest.sha256', files.map(file => hash(bytes(file)) + '  ' + path.relative(out, file)).join('\n') + '\n');
const finalFiles = walk(out).filter(file => file !== path.join(out, 'manifest.sha256')).sort();
if (JSON.stringify(files) !== JSON.stringify(finalFiles)) throw Error('Final file set changed');
for (const line of bytes(path.join(out, 'manifest.sha256')).toString().trim().split('\n')) if (hash(bytes(path.join(out, line.slice(66)))) !== line.slice(0, 64)) throw Error('Final manifest validation');
console.log(JSON.stringify({ sealed: true, manifestEntries: files.length, manifestSha256: hash(bytes(path.join(out, 'manifest.sha256'))), handoff: 'regression-handoff.json', handoffSha256: hash(bytes(path.join(out, 'regression-handoff.json'))), outcomes, custodyExact: true, noSourceEditsOrCommits: true }));
