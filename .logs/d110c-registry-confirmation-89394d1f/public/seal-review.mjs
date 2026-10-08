import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(fileURLToPath(import.meta.url));
const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
const freeze = read('review-freeze.json');
assert.equal(git('rev-parse', 'HEAD'), freeze.head);
assert.equal(git('log', '-1', '--format=%G?'), 'G');
assert.equal(git('diff', '--cached', '--name-only'), '');
assert.equal(hash(execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index'])), freeze.sourcePatchSha256);
for (const [file, digest] of Object.entries(freeze.inputs)) assert.equal(hash(fs.readFileSync(path.resolve(root, file))), digest, file);
const prior = JSON.parse(fs.readFileSync(path.join(root, '.logs/d110c-w0-final-review-7efe33dd/review-freeze.json')));
assert.equal(git('stash', 'list', '--format=%H %gd %gs'), prior.stashes);
for (const file of prior.protectedPaths) assert.ok(fs.existsSync(path.join(root, file)), file);
let sealedEntries = 0;
for (const [directory, digest] of Object.entries(freeze.manifests)) {
  const manifest = fs.readFileSync(path.join(root, directory, 'manifest.sha256'));
  assert.equal(hash(manifest), digest);
  for (const line of manifest.toString().trimEnd().split('\n')) {
    const [, sum, file] = line.match(/^([a-f0-9]{64})  (.+)$/u) ?? [];
    assert.ok(file);
    assert.equal(hash(fs.readFileSync(file.startsWith('.logs/') ? path.join(root, file) : path.join(root, directory, file))), sum, file); sealedEntries++;
  }
}
const exactKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
function validate(value) {
  exactKeys(value, ['verdict', 'findings', 'checked_requirements', 'limitations']);
  assert.ok(['PASS', 'FAIL', 'NO_VERDICT'].includes(value.verdict));
  assert.ok(Array.isArray(value.findings));
  for (const item of value.findings) {
    exactKeys(item, ['severity', 'file', 'line', 'title', 'evidence', 'violated_requirement']);
    assert.ok(['P0', 'P1', 'P2', 'P3'].includes(item.severity));
    assert.ok(Number.isInteger(item.line));
    for (const key of ['file', 'title', 'evidence', 'violated_requirement']) assert.equal(typeof item[key], 'string');
  }
  for (const key of ['checked_requirements', 'limitations']) { assert.ok(Array.isArray(value[key])); assert.ok(value[key].every(item => typeof item === 'string')); }
  return value;
}
const sol = validate(JSON.parse(fs.readFileSync(path.join(out, 'sol/final.txt'))));
const grokText = fs.readFileSync(path.join(out, 'grok/public.txt'), 'utf8');
const grokMatch = grokText.match(/```json\s*([\s\S]+?)\s*```/u); assert.ok(grokMatch);
const grok = validate(JSON.parse(grokMatch[1]));
const fableEvents = fs.readFileSync(path.join(out, 'fable/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const fableTerminal = fableEvents.filter(event => event.type === 'result'); assert.equal(fableTerminal.length, 1);
assert.equal(fableTerminal[0].is_error, false); assert.equal(fableTerminal[0].stop_reason, 'end_turn');
const match = fableTerminal[0].result.match(/```json\s*([\s\S]+?)\s*```/u); assert.ok(match);
const fable = validate(JSON.parse(match[1]));
const grokStatus = read('grok/status.json'); assert.equal(grokStatus.exit_code, 0); assert.equal(grokStatus.stop_reason, 'end_turn'); assert.equal(grokStatus.timed_out, false);
const statuses = Object.fromEntries(['sol', 'grok-runner', 'fable'].map(name => [name, read(name + '/runner-status.json')]));
const launches = Object.fromEntries(Object.keys(statuses).map(name => [name, read(name + '/launch.json')]));
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }); assert.equal(ps.status, 0);
const processRows = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u));
for (const [name, status] of Object.entries(statuses)) {
  assert.equal(status.quiescent, true); assert.equal(status.timedOut, false); assert.deepEqual(status.cleanup, []);
  assert.deepEqual(status.remaining, []); assert.equal(status.signal, null);
  assert.equal(status.status, name === 'grok-runner' ? 2 : 0);
  assert.equal(processRows.some(row => Number(row[2]) === launches[name].ownedGroup), false);
}
assert.equal(grok.verdict, 'PASS');
assert.equal(sol.verdict, 'PASS');
assert.equal(fable.verdict, 'PASS');
assert.equal(sol.findings.length, 0); assert.equal(grok.findings.length, 0);
assert.equal(fable.findings.length, 4); assert.ok(fable.findings.every(item => item.severity === 'P3'));
const publicDir = path.join(out, 'public'); fs.mkdirSync(publicDir);
const write = (name, value) => fs.writeFileSync(path.join(publicDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
write('grok.json', grok); write('sol.json', sol); write('fable.json', fable);
write('execution.json', { statuses, fableSession: fableTerminal[0].session_id, solSession: JSON.parse(fs.readFileSync(path.join(out, 'sol/events.jsonl'), 'utf8').split('\n').find(line => line.includes('"type":"thread.started"'))).thread_id, grokOriginalWrapper: grokStatus, grokRootClassification: 'Schema-valid terminal PASS with no findings from normal end_turn; original wrapper NO_VERDICT/status 2 preserved unchanged. All three substantive verdicts PASS; Fable P3 clarifications dispositioned for RED authoring only.', noTestsBuildsOrCompilersRun: true, noCleanupOrTimeouts: true, allOwnedGroupsQuiescentNow: true });
write('custody.json', { head: freeze.head, signature: 'G', sourcePatchSha256: freeze.sourcePatchSha256, frozenInputCount: Object.keys(freeze.inputs).length, allFrozenInputsExact: true, inheritedManifestCount: Object.keys(freeze.manifests).length, sealedEntries, allSealedEntriesExact: true, indexEmpty: true, stashesExact: true, protectedPathsPresent: prior.protectedPaths.length });
const privateEvidence = {};
for (const file of ['review-freeze.json', 'readiness.json', 'custody-after.json', 'sol/events.jsonl', 'sol/stderr.log', 'grok/events.jsonl', 'grok/public.txt', 'grok/status.json', 'fable/events.jsonl', 'fable/stderr.log']) privateEvidence[file] = hash(fs.readFileSync(path.join(out, file)));
write('retained-evidence-hashes.json', privateEvidence);
for (const file of ['prompt.md', 'schema.json', 'root-dispositions.md', 'seal-review.mjs', 'run.mjs', 'candidate-gate-roster.json']) write(file, fs.readFileSync(path.join(out, file), 'utf8'));
fs.mkdirSync(path.join(publicDir, 'spec'));
for (const name of ['README.md', 'derive-inventory.mjs', 'inventory.json', 'oracle-construction.mjs', 'oracle-vectors.json', 'runner.sh', 'gate-plan.mjs', 'verification.md', 'typecheck.mjs', 'consumer-supersession.md']) write('spec/' + name, fs.readFileSync(path.join(root, 'specs/current-registry-governance', name), 'utf8'));
write('current-owner-map-v2.md', fs.readFileSync(path.join(root, '.logs/d110c-registry-current-contract-preparation-8d81c8f4/current-owner-map-v2.md'), 'utf8'));
write('runtime-budget-audit.md', fs.readFileSync(path.join(root, '.logs/d110c-registry-corrected-preparation-89394d1f/runtime-budget-audit.md'), 'utf8'));
const publicFiles = fs.readdirSync(publicDir, { recursive: true }).filter(name => fs.statSync(path.join(publicDir, name)).isFile()).sort();
const entries = publicFiles.map(name => `${hash(fs.readFileSync(path.join(publicDir, name)))}  ${name}\n`).join('');
write('manifest.sha256', entries);
console.log(JSON.stringify({ publicEntries: publicFiles.length, manifestSha256: hash(entries), substantiveVerdicts: { grok: grok.verdict, sol: sol.verdict, fable: fable.verdict }, findings: [grok, sol, fable].flatMap(value => value.findings).reduce((counts, item) => ({ ...counts, [item.severity]: (counts[item.severity] ?? 0) + 1 }), {}), frozenInputs: Object.keys(freeze.inputs).length, inheritedSealedEntries: sealedEntries }));
