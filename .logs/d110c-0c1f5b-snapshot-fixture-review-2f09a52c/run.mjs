import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const expectedHead = process.argv[2];
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
if (!/^[a-f0-9]{40}$/u.test(expectedHead ?? '') || git('rev-parse', 'HEAD') !== expectedHead || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('Signed review HEAD/index');
if (git('ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/u)[0] !== expectedHead) throw Error('Pushed ref');
const green = path.join(root, '.logs/d110c-0c1f5b-snapshot-fixture-green-dc2f8dc2');
const manifest = fs.readFileSync(path.join(green, 'manifest.sha256'));
for (const line of manifest.toString().trimEnd().split('\n')) {
  const [, digest, file] = line.match(/^([a-f0-9]{64})  (.+)$/u) ?? [];
  if (!file || hash(fs.readFileSync(path.join(green, file))) !== digest) throw Error('GREEN manifest');
}
const custody = JSON.parse(fs.readFileSync(path.join(green, 'custody-final.json')));
for (const map of [custody.ownerHashes, custody.built, custody.testHashes]) {
  if (!map || typeof map !== 'object') throw Error('Missing live custody map');
  for (const [file, digest] of Object.entries(map)) if (hash(fs.readFileSync(path.join(root, file))) !== digest) throw Error('Live identity drift: ' + file);
}
const overlay = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...Object.keys(custody.ownerHashes)], { maxBuffer: 128 * 1024 * 1024 });
if (hash(overlay) !== custody.patchSha256) throw Error('Production overlay drift');
for (const prefix of ['', 'isolated/']) for (const kind of ['focused', 'retained']) {
  const status = JSON.parse(fs.readFileSync(path.join(green, prefix + kind + '/status.json')));
  if (status.code !== 0 || status.signal || !status.quiescent) throw Error('Runtime not successfully quiescent');
}
const promptFile = path.join(out, 'prompt.md');
const prompt = fs.readFileSync(promptFile, 'utf8');
const ports = [4174, 4175, 51000, 51002].map(port => {
  const r = spawnSync('lsof', ['-nP', '-i:' + port, '-t'], { encoding: 'utf8' });
  if (![0, 1].includes(r.status) || r.stdout.trim()) throw Error('Port not clear: ' + port);
  return { port, clear: true };
});
const candidates = spawnSync('pgrep', ['-f', '(vitest|quint|apalache|heap-prof|cpu-prof)'], { encoding: 'utf8' });
if (![0, 1].includes(candidates.status)) throw Error('Numeric process query');
const processes = [];
for (const pid of candidates.stdout.trim().split(/\s+/u).filter(v => /^\d+$/u.test(v)).map(Number).filter(p => p !== process.pid && p !== process.ppid)) {
  const status = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' });
  if (status.status === 1) continue;
  if (status.status !== 0) throw Error('Process status');
  const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const relevant = cwd.stdout.split('\n').filter(v => v.startsWith('n')).some(v => v.slice(1) === root || v.slice(1).startsWith(root + '/') || /^\/(?:private\/)?tmp\/d110c-f5b-/u.test(v.slice(1)));
  processes.push({ pid, status: status.stdout.trim(), relevant });
  if (relevant) throw Error('Competing runtime PID ' + pid);
}
write('readiness.json', { ports, processes, numericOnly: true, workloadNotRun: true });
write('custody.json', { head: expectedHead, signature: 'G', originExact: true, greenManifestSha256: hash(manifest), promptSha256: hash(prompt), status: git('status', '--short', '--untracked-files=no'), source: '2f09a52ce58e81000850d73594ca1f3ab4c9309a', runtimeNotExecuted: true });

const run = (name, command, args, stdin) => new Promise(resolve => {
  const dir = path.join(out, name);
  fs.mkdirSync(dir);
  const stdout = fs.openSync(path.join(dir, 'events.jsonl'), 'wx');
  const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'wx');
  const start = new Date().toISOString();
  const child = spawn(command, args, { cwd: root, stdio: [stdin === undefined ? 'ignore' : 'pipe', stdout, stderr] });
  write(name + '/launch.json', { command, args, cwd: root, start, pid: child.pid });
  console.log(JSON.stringify({ name, pid: child.pid, start }));
  if (stdin !== undefined) child.stdin.end(stdin);
  child.on('error', error => write(name + '/spawn-error.json', { message: error.message }));
  child.on('close', (status, signal) => {
    fs.closeSync(stdout); fs.closeSync(stderr);
    write(name + '/runner-status.json', { status, signal, start, finish: new Date().toISOString() });
    console.log(JSON.stringify({ name, status, signal })); resolve();
  });
});
await Promise.all([
  run('sol', 'codex', ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-c', 'features.multi_agent=false', '--json', '--output-schema', path.join(out, 'schema.json'), '--output-last-message', path.join(out, 'sol/final.txt'), prompt]),
  run('grok-runner', 'python3', ['/Users/aristotle/.codex/skills/grok/scripts/run_grok.py', '--mode', 'review', '--cwd', root, '--prompt-file', promptFile, '--output-dir', path.join(out, 'grok'), '--model', 'grok-4.6', '--reasoning-effort', 'high', '--max-turns', '40', '--timeout-seconds', '1800']),
  run('fable', 'zsh', ['-f', '-c', "alias claude-phel='CLAUDE_CONFIG_DIR=/Users/aristotle/.claude-phel claude'\neval 'claude-phel -p --restricted --strict-mcp-config --tools Read,Glob,Grep --allowedTools Read,Glob,Grep --model \"claude-fable-5-1[1m]\" --effort xhigh --output-format stream-json --verbose'"], prompt)
]);
console.log(JSON.stringify({ complete: true }));
