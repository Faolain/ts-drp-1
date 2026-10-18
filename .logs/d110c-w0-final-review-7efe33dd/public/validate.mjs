import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const out = path.dirname(new URL(import.meta.url).pathname);
const read = n => JSON.parse(fs.readFileSync(path.join(out, n)));
const text = n => fs.readFileSync(path.join(out, n), 'utf8');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (n, value) => fs.writeFileSync(path.join(out, n), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const schema = read('schema.json');
const validate = (s, value) => {
  if (s.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    for (const k of s.required ?? []) assert.ok(Object.hasOwn(value, k), k);
    if (s.additionalProperties === false) for (const k of Object.keys(value)) assert.ok(Object.hasOwn(s.properties, k), k);
    for (const [k, v] of Object.entries(value)) if (s.properties[k]) validate(s.properties[k], v);
  } else if (s.type === 'array') { assert.ok(Array.isArray(value)); for (const v of value) validate(s.items, v); }
  else if (s.type === 'integer') assert.ok(Number.isInteger(value));
  else assert.equal(typeof value, s.type);
  if (s.enum) assert.ok(s.enum.includes(value));
};
const events = n => text(n + '/events.jsonl').trim().split('\n').map(l => JSON.parse(l));
const solEvents = events('sol'), fableEvents = events('fable');
assert.ok(solEvents.some(e => e.type === 'turn.completed'));
assert.ok(!solEvents.some(e => e.type === 'turn.failed'));
const fableResults = fableEvents.filter(e => e.type === 'result');
assert.equal(fableResults.length, 1);
const fable = fableResults[0];
assert.equal(fable.is_error, false);
assert.equal(fable.subtype, 'success');
assert.equal(fable.stop_reason, 'end_turn');
const grok = read('grok/status.json'), grokPublic = text('grok/public.txt');
assert.equal(grok.exit_code, 0); assert.equal(grok.stop_reason, 'end_turn'); assert.equal(grok.timed_out, false);
const verdicts = {
  sol: read('sol/final.txt'),
  grok: JSON.parse(grokPublic.slice(grokPublic.lastIndexOf('{"verdict":'))),
  fable: fable.structured_output ?? JSON.parse(fable.result.trim().replace(/^```json\s*/u, '').replace(/\s*```$/u, '')),
};
fs.mkdirSync(path.join(out, 'public'));
const summary = {};
for (const [name, verdict] of Object.entries(verdicts)) {
  validate(schema, verdict);
  const status = read((name === 'grok' ? 'grok-runner' : name) + '/runner-status.json');
  assert.equal(status.timedOut, false); assert.equal(status.quiescent, true); assert.deepEqual(status.cleanup, []); assert.deepEqual(status.remaining, []);
  assert.equal(status.status, name === 'grok' ? 2 : 0);
  assert.equal(verdict.verdict, 'PASS');
  assert.equal(verdict.findings.filter(f => ['P0', 'P1'].includes(f.severity)).length, 0);
  write('public/' + name + '-verdict.json', verdict);
  write('public/' + name + '-runner-status.json', status);
  summary[name] = { classification: 'TERMINAL_SCHEMA_PASS', verdict: verdict.verdict, findings: verdict.findings.map(f => ({ severity: f.severity, title: f.title })), session: name === 'sol' ? solEvents.find(e => e.type === 'thread.started').thread_id : name === 'fable' ? fable.session_id : null, wrapperClassification: name === 'grok' ? grok.classification : null, rawEventsSha256: hash(fs.readFileSync(path.join(out, name, 'events.jsonl'))) };
}
const after = read('custody-after.json');
assert.equal(after.allFrozenInputsExact, true); assert.equal(after.allManifestsExact, true); assert.equal(after.indexEmpty, true);
for (const file of ['schema.json', 'requirements.md', 'prompt.md', 'source-capture.json', 'w0-green.patch', 'review-freeze.json', 'readiness.json', 'custody-before.json', 'custody-after.json', 'run.mjs', 'freeze.mjs', 'validate.mjs']) fs.copyFileSync(path.join(out, file), path.join(out, 'public', file), fs.constants.COPYFILE_EXCL);
write('public/grok-terminal-status.json', grok);
write('public/validation.json', { reviewHead: after.head, verdicts: summary, blockingFindingUnion: [], allFrozenInputsAndManifestsExactAfterReviews: true, runtimeReruns: 0, reviewReruns: 0, schemaValidatedRecursively: true, grokDisposition: 'Normal model exit 0/end_turn with schema-valid terminal JSON; wrapper prose-marker NO_VERDICT and exit 2 remain unchanged. No absent/cancelled/timed-out verdict was promoted.', rawStreamPolicy: 'Original complete streams remain locally retained and hashed. Public evidence contains terminal verdicts and execution/custody metadata, not private reasoning streams.' });
console.log(JSON.stringify({ allThreeExplicitSchemaPass: true, blockingFindings: 0, fableP3: verdicts.fable.findings.length, custodyExact: true, publicEvidence: path.join(out, 'public') }));
