import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const events = n => fs.readFileSync(path.join(out, n, 'events.jsonl'), 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
const write = (f, v) => fs.writeFileSync(path.join(out, f), JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
const schema = json(path.join(out, 'schema.json'));
function check(value, rule) {
  if (rule.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Object schema');
    if (rule.required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !Object.hasOwn(rule.properties, k))) throw Error('Keys schema');
    for (const [k, v] of Object.entries(value)) check(v, rule.properties[k]);
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) throw Error('Array schema');
    value.forEach(v => check(v, rule.items));
  } else if (rule.type === 'integer') {
    if (!Number.isInteger(value) || value < rule.minimum) throw Error('Integer schema');
  } else if (typeof value !== rule.type) throw Error('Primitive schema');
  if (rule.enum && !rule.enum.includes(value)) throw Error('Enum schema');
}
const grokEvents = events('grok');
const grokEnd = grokEvents.at(-1);
const grokStatus = json(path.join(out, 'grok/status.json'));
if (grokEnd.type !== 'end' || grokEnd.stopReason !== 'end_turn' || grokStatus.exit_code !== 0 || grokStatus.timed_out) throw Error('Grok not normally terminal');
const publicText = grokEvents.filter(e => e.type === 'text').map(e => e.data).join('');
const start = publicText.lastIndexOf('{"verdict":');
if (start < 0) throw Error('No explicit Grok verdict');
const grok = JSON.parse(publicText.slice(start));
const fableEvents = events('fable');
const fableResult = fableEvents.at(-1);
if (fableResult.type !== 'result' || fableResult.is_error || fableResult.subtype !== 'success' || fableResult.stop_reason !== 'end_turn') throw Error('Fable terminal');
const fableValue = fableResult.structured_output ?? fableResult.result;
const fable = typeof fableValue === 'string' ? JSON.parse(fableValue) : fableValue;
const solEvents = events('sol');
if (solEvents.at(-1).type !== 'turn.completed') throw Error('Sol terminal');
const sol = json(path.join(out, 'sol/final.txt'));
for (const n of ['sol', 'fable']) if (json(path.join(out, n, 'runner-status.json')).status !== 0) throw Error('Runner status');
const verdicts = { grok, sol, fable };
for (const [n, v] of Object.entries(verdicts)) {
  check(v, schema);
  for (const severity of ['P0', 'P1', 'P2']) if (v[severity.toLowerCase() + '_count'] !== v.findings.filter(f => f.severity === severity).length) throw Error('Finding counts');
  if (v.p0_count || v.p1_count || !v.batch_ready || v.parent_ready || v.verdict !== 'PASS') throw Error('Closure matrix');
  write(n + '/validated-verdict.json', v);
}
const grokTools = [...new Set(grokEvents.filter(e => e.type === 'tool_call').map(e => e.title))];
const fableTools = [...new Set(fableEvents.flatMap(e => e.message?.content ?? []).filter(c => c.type === 'tool_use').map(c => c.name))];
if (grokTools.some(t => !['read_file', 'grep', 'list_dir'].includes(t)) || fableTools.some(t => !['Read', 'Grep', 'Glob'].includes(t))) throw Error('Unexpected reviewer tool');
const green = path.join(root, '.logs/d110c-0c1f5b-snapshot-fixture-green-dc2f8dc2');
const custody = json(path.join(green, 'custody-final.json'));
for (const map of [custody.ownerHashes, custody.built, json(path.join(green, 'effective-test-fixture-hashes.json'))]) for (const [f, h] of Object.entries(map)) if (hash(fs.readFileSync(path.join(root, f))) !== h) throw Error('Identity drift ' + f);
const patch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...Object.keys(custody.ownerHashes)], { maxBuffer: 128 * 1024 * 1024 });
if (hash(patch) !== custody.patchSha256) throw Error('Production overlay');
const original = json(path.join(root, '.logs/d110c-0c1f5b-green-57834387/custody-before.json'));
if (git('stash', 'list', '--format=%H %gd %gs') !== original.stashes.trim()) throw Error('Stashes');
for (const f of original.untracked) if (!fs.existsSync(path.join(root, f))) throw Error('Protected ' + f);
for (const [dir, expected] of Object.entries({ ...custody.manifests, '.logs/d110c-0c1f5b-snapshot-fixture-green-dc2f8dc2': 'ffc0675b98cd5c650a17d8f020c6e6cc437f82bd48bc7e220f7cd71684f9d201' })) {
  const raw = fs.readFileSync(path.join(root, dir, 'manifest.sha256'));
  if (hash(raw) !== expected) throw Error('Manifest identity');
  for (const line of raw.toString().trimEnd().split('\n')) {
    const [, h, f] = line.match(/^([a-f0-9]{64})\s+(.+)$/u) ?? [];
    if (!f || hash(fs.readFileSync(path.join(root, f.startsWith('.logs/') ? f : dir + '/' + f))) !== h) throw Error('Prior evidence');
  }
}
const head = git('rev-parse', 'HEAD');
if (head !== '248f40d05f2c4686699fa012eb5f82b57f4938f6' || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only') || git('ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0] !== head) throw Error('Signed/pushed custody');
write('validation.json', {
  valid: true, head, signature: 'G', originExact: true, schemaValid: true,
  blockingUnion: [], p2: [{ reviewer: 'fable', owner: 'root', disposition: 'Accepted: RED whitespace summary undercount already fully disclosed in plan; preserve sealed root. Future sealers enumerate actual staged raw-log exceptions.' }],
  grok: { sessionId: grokEnd.sessionId, modelStop: 'end_turn', modelExit: 0, wrapperStatus: grokStatus.classification, correctedClassification: 'TERMINAL_SCHEMA_PASS', reason: 'Wrapper run_grok.py:207 recognizes only prose markers VERDICT:/READY_TO_SIGN:/FINAL:/RESULT:, not the requested JSON schema. Actual explicit JSON validates; no cancellation, timeout, missing verdict or rerun.', tools: grokTools },
  sol: { sessionId: solEvents.find(e => e.type === 'thread.started').thread_id, terminal: 'turn.completed' },
  fable: { sessionId: fableResult.session_id, is_error: fableResult.is_error, stop_reason: fableResult.stop_reason, total_cost_usd: fableResult.total_cost_usd, tools: fableTools },
  sourceUnchanged: true, productionOwners: 8, builtOwners: 7, testFixtureIdentities: 95,
  patchSha256: hash(patch), stashes: 27, protectedPaths: original.untracked.length,
  priorEvidenceRevalidated: true, batchReady: true, parentReady: false, noRuntimeExecuted: true,
});
console.log(JSON.stringify({ valid: true, reviews: 3, p0: 0, p1: 0, p2: 1, batchReady: true, parentReady: false }));
