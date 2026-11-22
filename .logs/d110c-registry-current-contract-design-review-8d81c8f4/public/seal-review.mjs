import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
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
const solInitial = validate(JSON.parse(fs.readFileSync(path.join(out, 'sol/final.txt'))));
const sol = validate(JSON.parse(fs.readFileSync(path.join(out, 'sol-continuation/final.txt'))));
const grokText = fs.readFileSync(path.join(out, 'grok/public.txt'), 'utf8');
const grokStart = grokText.indexOf('{"verdict":'); assert.ok(grokStart >= 0);
const grok = validate(JSON.parse(grokText.slice(grokStart).trim()));
const fableEvents = fs.readFileSync(path.join(out, 'fable/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const fableTerminal = fableEvents.filter(event => event.type === 'result'); assert.equal(fableTerminal.length, 1);
assert.equal(fableTerminal[0].is_error, false); assert.equal(fableTerminal[0].stop_reason, 'end_turn');
const match = fableTerminal[0].result.match(/```json\s*([\s\S]+?)\s*```/u); assert.ok(match);
const fable = validate(JSON.parse(match[1]));
const grokStatus = read('grok/status.json'); assert.equal(grokStatus.exit_code, 0); assert.equal(grokStatus.stop_reason, 'end_turn'); assert.equal(grokStatus.timed_out, false);
const statuses = Object.fromEntries(['sol', 'sol-continuation', 'grok-runner', 'fable'].map(name => [name, read(name + '/runner-status.json')]));
const launches = Object.fromEntries(Object.keys(statuses).map(name => [name, read(name + '/launch.json')]));
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }); assert.equal(ps.status, 0);
const processRows = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u));
for (const [name, status] of Object.entries(statuses)) {
  assert.equal(status.quiescent, true); assert.equal(status.timedOut, false); assert.deepEqual(status.cleanup, []);
  assert.deepEqual(status.remaining, []); assert.equal(status.signal, null);
  assert.equal(status.status, name === 'grok-runner' ? 2 : 0);
  assert.equal(processRows.some(row => Number(row[2]) === launches[name].ownedGroup), false);
}
assert.equal(solInitial.verdict, 'NO_VERDICT');
for (const verdict of [grok, sol, fable]) assert.equal(verdict.verdict, 'FAIL');
const publicDir = path.join(out, 'public'); fs.mkdirSync(publicDir);
const write = (name, value) => fs.writeFileSync(path.join(publicDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
write('grok.json', grok); write('sol.json', sol); write('fable.json', fable); write('sol-initial-no-verdict.json', solInitial);
write('execution.json', { statuses, fableSession: fableTerminal[0].session_id, solSession: launches['sol-continuation'].session, sameSolSessionContinuation: true, grokOriginalWrapper: grokStatus, grokRootClassification: 'Schema-valid terminal FAIL from normal end_turn; original wrapper NO_VERDICT/status 2 preserved unchanged.', noTestsBuildsOrCompilersRun: true, noCleanupOrTimeouts: true, allOwnedGroupsQuiescentNow: true });
write('custody.json', { head: freeze.head, signature: 'G', sourcePatchSha256: freeze.sourcePatchSha256, frozenInputCount: Object.keys(freeze.inputs).length, allFrozenInputsExact: true, inheritedManifestCount: Object.keys(freeze.manifests).length, sealedEntries, allSealedEntriesExact: true, indexEmpty: true, stashesExact: true, protectedPathsPresent: prior.protectedPaths.length });
const privateEvidence = {};
for (const file of ['review-freeze.json', 'readiness.json', 'custody-after.json', 'sol/events.jsonl', 'sol/stderr.log', 'sol-continuation/events.jsonl', 'sol-continuation/stderr.log', 'grok/events.jsonl', 'grok/public.txt', 'grok/status.json', 'fable/events.jsonl', 'fable/stderr.log']) privateEvidence[file] = hash(fs.readFileSync(path.join(out, file)));
write('retained-evidence-hashes.json', privateEvidence);
for (const file of ['prompt.md', 'sol-continuation.md', 'prelaunch-correction.md', 'schema.json', 'root-dispositions.md', 'seal-review.mjs']) write(file, fs.readFileSync(path.join(out, file), 'utf8'));
for (const [name, file] of [['reviewed-design.md', 'current-contract-design.md'], ['red-proposal.md', 'red-proposal.md']]) write(name, fs.readFileSync(path.join(root, '.logs/d110c-registry-current-contract-preparation-8d81c8f4', file), 'utf8'));
const entries = fs.readdirSync(publicDir).sort().map(name => `${hash(fs.readFileSync(path.join(publicDir, name)))}  ${name}\n`).join('');
write('manifest.sha256', entries);
console.log(JSON.stringify({ publicEntries: fs.readdirSync(publicDir).length - 1, manifestSha256: hash(entries), substantiveVerdicts: { grok: grok.verdict, sol: sol.verdict, fable: fable.verdict }, findings: [grok, sol, fable].flatMap(value => value.findings).reduce((counts, item) => ({ ...counts, [item.severity]: (counts[item.severity] ?? 0) + 1 }), {}), frozenInputs: Object.keys(freeze.inputs).length, inheritedSealedEntries: sealedEntries }));
