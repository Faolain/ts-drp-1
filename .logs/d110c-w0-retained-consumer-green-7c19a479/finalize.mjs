import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const out = path.dirname(new URL(import.meta.url).pathname);
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const staticHandoff = read('handoff.json');
const focused = read('runtime-checkpoint/validation.json');
const consumers = read('runtime-consumers/validation.json');
const custody = read('custody-after-runtime-consumers.json');
if (!focused.green || !consumers.green || focused.passed !== 7 || consumers.passed !== 51 || !focused.exactRoster || !consumers.exactRoster || !custody.allHashesAndPathsPreserved || !custody.quiescent || !custody.indexEmpty) throw Error('GREEN evidence incomplete');
for (const label of ['post-runtime-checkpoint', 'post-runtime-consumers']) if (read(label + '/status.json').code !== 0) throw Error('Post runtime custody failed');
const timingLines = fs.readFileSync(path.join(out, 'runtime-consumers/stdout.log'), 'utf8').split('\n').filter(line => line.startsWith('D108E4L_TIMING '));
if (timingLines.length !== 1) throw Error('Expected one genuine bounded child timing record');
const timing = JSON.parse(timingLines[0].slice('D108E4L_TIMING '.length));
if (timing.outcome !== 'proof' || timing.memberCountErrors.length !== 0) throw Error('Child proof incomplete');
const requiredCases = [
  'fresh Node predecessor recovery enforces one cumulative authenticated future-row skip budget per recovery',
  'fresh Node closes the D.108e4 authenticated oracle and per-reopen budget debt',
  'refuses a pre-bound close after a durable issue is omitted from live admission',
];
for (const name of requiredCases) if (!consumers.passedCases.some(entry => entry.name.endsWith(' > ' + name))) throw Error('Required genuine consumer missing: ' + name);
const ports = [4174, 4175, 51000, 51002].map(port => {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (![0, 1].includes(result.status) || result.stdout.trim()) throw Error('Port not free: ' + port);
  return { port, pids: [], noTcpListener: true };
});
const runtimeRosterSha256 = hash(fs.readFileSync(path.join(out, 'runtime-roster.json')));
for (const label of ['runtime-checkpoint', 'runtime-consumers']) {
  const release = read('root-' + label + '-release.json');
  if (release.runtimeRosterSha256 !== runtimeRosterSha256 || release.sourcePatchSha256 !== custody.sourcePatchSha256) throw Error('Release drift');
}
write('runtime-handoff.json', {
  status: 'Bounded retained-consumer GREEN repair passed and ready for root independent acceptance; W0 broader gates remain open',
  baseline: staticHandoff.baseline, sourceCommitted: false, evidenceCommitted: false,
  sourcePatch: 'green.patch', sourcePatchSha256: custody.sourcePatchSha256, sourceHashes: staticHandoff.sourceHashes,
  runtimeRoster: 'runtime-roster.json', runtimeRosterSha256,
  invocationCount: 2, totalCaseExecutions: 58, uniqueConsumerCases: 51,
  gates: [focused, consumers].map((value, index) => ({ label: index === 0 ? 'runtime-checkpoint' : 'runtime-consumers', files: value.files, tests: value.tests, passed: value.passed, failed: 0, pending: 0, todo: 0, skipped: 0, exactRoster: true, elapsedMs: value.elapsedMs })),
  consumerClasses: { inherited: 46, newClosureControls: 2, explicitBootstrapSupplements: 3, noRelabelsOrExclusions: true },
  bootstrap: { epochTwo: 'Dynamic same-input pinPresent and pinMatchesOriginal both true; active-new epoch-two handle recovered; post-reopen issue accepted and publication published.', currentSuccessor: 'Existing 0c1b control genuinely recovered an ok:true object handle and accepted issuance with sequence delta1 and one target row; observer remains same-input and no callback API was added.' },
  boundedClosure: 'Existing checkpoint and full unfiltered transition authenticate before exact digest/byteLength auxiliary reference projection; genuine and hostile closure controls pass; durable census 7/6/7 retained and bounded predicate census 5/4 asserted by passing tests.',
  publicStoreShape: 'Existing genuine child passed ordered eight-key/descriptors, preserved settlement function identities, distinct six overrides, no extra keys/symbols, plus cumulative-skip/materialization/mismatch/reuse/publication/equality assertions.',
  child: { genuineCumulativeSkipChildInvocations: 1, proofTimingRecords: timingLines.length, wallTimeMs: timing.wallTimeMs, outcome: timing.outcome, memberCountErrors: timing.memberCountErrors, originalTimingTelemetryPreserved: true, diagnosticProfilingEnabled: false },
  static: staticHandoff.static,
  custody: { result: 'custody-after-runtime-consumers.json', protectedSources: 11, greenOwners: 3, builtIdentities: 7, stashes: 27, protectedPaths: 86522, sealedManifestRoots: custody.manifestRoots, sealedEvidenceFiles: custody.protectedEvidenceFiles, runtimeInputs: custody.inputCount, allPreserved: true },
  processGroupsQuiescent: true, cleanupSignals: 0, ports, indexEmpty: true,
  retries: 0, additionalRuntimeReleased: false, productionEdits: 0, testAssertionEdits: 0, reviewerInvocations: 0, standaloneBuildInvocations: 0,
  failedStaticAttemptsPreserved: 'static-corrections.json; original and corrected equivalence/freeze scripts, stdout/stderr/status are all included',
  previousStaticHandoffAndFreezePreserved: true,
  nextOwner: 'Root for independent verification and signed checkpoint; original W0 seven cases, retained full roster, browser, fresh-source acceptance and frozen three-model formal review remain outside this bounded handoff.',
  manifest: 'manifest.sha256',
});
console.log(JSON.stringify({ readyToSeal: true, gates: 2, totalCaseExecutions: 58, uniqueConsumerCases: 51, cumulativeSkipChildInvocations: 1, allCustodyPreserved: true, quiescent: true }));
