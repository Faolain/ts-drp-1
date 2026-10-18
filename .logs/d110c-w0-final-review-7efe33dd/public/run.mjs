import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readiness } from '../d110c-w0-isolated-7efe33dd/common.mjs';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const read = name => JSON.parse(fs.readFileSync(path.join(out, name)));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
const freeze = read('review-freeze.json');
assert.equal(git('rev-parse', 'HEAD'), freeze.head);
assert.equal(git('log', '-1', '--format=%G?'), 'G');
assert.equal(git('diff', '--cached', '--name-only'), '');
assert.equal(git('ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0], freeze.head);
const capture = read('source-capture.json');
const verify = () => {
  assert.equal(git('rev-parse', 'HEAD'), freeze.head);
  assert.equal(git('diff', '--cached', '--name-only'), '');
  for (const [file, digest] of Object.entries(freeze.inputs)) assert.equal(hash(fs.readFileSync(path.resolve(root, file))), digest, file);
  for (const [directory, digest] of Object.entries(freeze.manifests)) {
    const manifest = fs.readFileSync(path.join(root, directory, 'manifest.sha256'));
    assert.equal(hash(manifest), digest, directory);
    for (const line of manifest.toString().trimEnd().split('\n')) {
      const [, sum, file] = line.match(/^([a-f0-9]{64})  (.+)$/u) ?? [];
      assert.ok(file);
      assert.equal(hash(fs.readFileSync(file.startsWith('.logs/') ? path.join(root, file) : path.join(root, directory, file))), sum, file);
    }
  }
  for (const [file, digest] of Object.entries(capture.sourceHashes)) assert.equal(hash(fs.readFileSync(path.join(root, file))), digest);
  assert.equal(hash(execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index'])), freeze.sourcePatchSha256);
  assert.equal(git('stash', 'list', '--format=%H %gd %gs'), freeze.stashes);
  for (const file of freeze.protectedPaths) assert.ok(fs.existsSync(path.join(root, file)), file);
};
verify();
write('readiness.json', readiness());
const promptFile = path.join(out, 'prompt.md'), prompt = fs.readFileSync(promptFile, 'utf8');
write('custody-before.json', { head: freeze.head, sourcePatchSha256: freeze.sourcePatchSha256, allFrozenInputsExact: true, allManifestsExact: true, indexEmpty: true });
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
write('custody-after.json', { head: freeze.head, allFrozenInputsExact: true, allManifestsExact: true, indexEmpty: true, sourcePatchSha256: freeze.sourcePatchSha256 });
console.log(JSON.stringify({ complete: true, terminalVerdictsRequireSeparateInspection: true }));
