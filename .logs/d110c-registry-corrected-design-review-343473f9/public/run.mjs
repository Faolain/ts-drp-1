import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readiness } from '../d110c-w0-isolated-7efe33dd/common.mjs';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const expectedHead = '343473f96243885d379da28a0f62c53bc03984ac';
const expectedPatch = '6d0fd99cfcb383b82f3becae421b4691bb945639ef9d60b76e9968715df765cb';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
const prior = JSON.parse(fs.readFileSync(path.join(root, '.logs/d110c-w0-final-review-7efe33dd/review-freeze.json')));
prior.manifests['.logs/d110c-registry-current-contract-design-review-8d81c8f4/public'] = 'e309e567d4fd7487dd883794e091d8644c45515bd7503f0f54c6875013ab0765';
const plan = 'docs/production-hardening/production-hardening-tdd-plan-v2.md';
for (const [file, digest] of Object.entries(prior.inputs)) {
  if (file !== plan) assert.equal(hash(fs.readFileSync(path.resolve(root, file))), digest, file);
}
const inputs = Object.fromEntries(Object.keys(prior.inputs).map(file => [file, hash(fs.readFileSync(path.resolve(root, file)))]));
for (const file of git('ls-files').split('\n').filter(file => /^(?:packages\/protocol-v3\/(?:registry|conformance|formal|scripts|supplements)\/|tests\/(?:protocol-v3-|phase-5[ad]-|phase-3a1b-p4-live-journal|fixtures\/phase-(?:n1prime|0[op]|5|6b-d110c))|\.github\/workflows\/|docs\/protocol\/|CODEOWNERS$|vite\.config\.mts$|vitest\.workspace\.ts$)/u.test(file))) {
  inputs[file] = hash(fs.readFileSync(path.join(root, file)));
}
const specFiles = ['README.md', 'derive-inventory.mjs', 'inventory.json', 'oracle-construction.mjs', 'oracle-vectors.json', 'runner.sh', 'gate-plan.mjs', 'verification.md', 'typecheck.mjs'];
assert.deepEqual(fs.readdirSync(path.join(root, 'specs/current-registry-governance')).sort(), [...specFiles].sort());
for (const file of [...specFiles.map(name => 'specs/current-registry-governance/' + name), '.logs/d110c-registry-current-contract-preparation-8d81c8f4/current-owner-map-v2.md', path.relative(root, path.join(out, 'prompt.md')), path.relative(root, path.join(out, 'run.mjs'))]) inputs[file] = hash(fs.readFileSync(path.join(root, file)));
const verify = () => {
  assert.equal(git('rev-parse', 'HEAD'), expectedHead);
  assert.equal(git('log', '-1', '--format=%G?'), 'G');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.equal(hash(execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index'])), expectedPatch);
  assert.equal(git('stash', 'list', '--format=%H %gd %gs'), prior.stashes);
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(fs.readFileSync(path.resolve(root, file))), digest, file);
  for (const file of prior.protectedPaths) assert.ok(fs.existsSync(path.join(root, file)), file);
  for (const [directory, digest] of Object.entries(prior.manifests)) {
    const manifest = fs.readFileSync(path.join(root, directory, 'manifest.sha256'));
    assert.equal(hash(manifest), digest, directory);
    for (const line of manifest.toString().trimEnd().split('\n')) {
      const [, sum, file] = line.match(/^([a-f0-9]{64})  (.+)$/u) ?? [];
      assert.ok(file);
      assert.equal(hash(fs.readFileSync(file.startsWith('.logs/') ? path.join(root, file) : path.join(root, directory, file))), sum, file);
    }
  }
};
verify();
assert.equal(git('ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0], expectedHead);
write('readiness.json', readiness());
write('candidate-gate-roster.json', (await import('../../specs/current-registry-governance/gate-plan.mjs')).plan);
inputs[path.relative(root, path.join(out, 'candidate-gate-roster.json'))] = hash(fs.readFileSync(path.join(out, 'candidate-gate-roster.json')));
write('review-freeze.json', { head: expectedHead, sourcePatchSha256: expectedPatch, inputs, manifests: prior.manifests, inheritedProtectedPathCount: prior.protectedPaths.length, planChange: 'Signed first design-review rejection since prior W0 review; corrected spec is an untracked frozen candidate, no production edits.', scope: 'Read-only design candidate review; not implementation acceptance.' });
const schemaFile = path.join(root, '.logs/d110c-w0-final-review-7efe33dd/schema.json');
write('schema.json', JSON.parse(fs.readFileSync(schemaFile)));
const promptFile = path.join(out, 'prompt.md'), prompt = fs.readFileSync(promptFile, 'utf8');
const members = pgid => {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  return result.stdout.trim().split('\n').map(s => s.trim().split(/\s+/u)).filter(s => Number(s[2]) === pgid).map(([pid, ppid, group, stat]) => ({ pid: Number(pid), ppid: Number(ppid), group: Number(group), stat }));
};
const run = (name, command, args, stdin) => new Promise(resolve => {
  const dir = path.join(out, name); fs.mkdirSync(dir);
  const stdout = fs.openSync(path.join(dir, 'events.jsonl'), 'wx'), stderr = fs.openSync(path.join(dir, 'stderr.log'), 'wx');
  const start = new Date().toISOString();
  const child = spawn(command, args, { cwd: root, detached: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', stdout, stderr] });
  let timedOut = false, spawnError;
  const cleanup = [];
  const signal = value => {
    const active = members(child.pid); if (!active.length) return;
    cleanup.push({ signal: value, members: active });
    try { process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  write(name + '/launch.json', { command, args, cwd: root, start, pid: child.pid, ownedGroup: child.pid, ceilingMs: 1800000 });
  console.log(JSON.stringify({ name, pid: child.pid, start }));
  if (stdin !== undefined) child.stdin.end(stdin);
  const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, 1800000);
  const hard = setTimeout(() => { if (timedOut) signal('SIGKILL'); }, 1802000);
  child.on('error', error => { spawnError = String(error); });
  child.on('close', async (status, terminalSignal) => {
    clearTimeout(timer); clearTimeout(hard); fs.closeSync(stdout); fs.closeSync(stderr);
    if (members(child.pid).length) {
      signal('SIGTERM'); await new Promise(r => setTimeout(r, 1000));
      if (members(child.pid).length) { signal('SIGKILL'); await new Promise(r => setTimeout(r, 1000)); }
    }
    const remaining = members(child.pid);
    write(name + '/runner-status.json', { status, signal: terminalSignal, timedOut, spawnError, cleanup, remaining, quiescent: !remaining.length, start, finish: new Date().toISOString(), verdictNotInferredFromExitCode: true });
    console.log(JSON.stringify({ name, status, timedOut, quiescent: !remaining.length })); resolve();
  });
});
await Promise.all([
  run('sol', 'codex', ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-c', 'features.multi_agent=false', '--json', '--output-schema', path.join(out, 'schema.json'), '--output-last-message', path.join(out, 'sol/final.txt'), prompt]),
  run('grok-runner', 'python3', ['/Users/aristotle/.codex/skills/grok/scripts/run_grok.py', '--mode', 'review', '--cwd', root, '--prompt-file', promptFile, '--output-dir', path.join(out, 'grok'), '--model', 'grok-4.6', '--reasoning-effort', 'high', '--max-turns', '40', '--timeout-seconds', '1800']),
  run('fable', 'zsh', ['-f', '-c', "alias claude-phel='CLAUDE_CONFIG_DIR=/Users/aristotle/.claude-phel claude'\neval 'claude-phel -p --restricted --strict-mcp-config --tools Read,Glob,Grep --allowedTools Read,Glob,Grep --model \"claude-fable-5-1[1m]\" --effort xhigh --output-format stream-json --verbose'"], prompt)
]);
verify();
write('custody-after.json', { head: expectedHead, sourcePatchSha256: expectedPatch, frozenInputCount: Object.keys(inputs).length, allFrozenInputsExact: true, allInheritedManifestsExact: true, indexEmpty: true, protectedPathsPresent: prior.protectedPaths.length });
console.log(JSON.stringify({ complete: true, terminalVerdictsRequireSeparateInspection: true }));

