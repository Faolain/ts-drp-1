import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const plan = 'docs/production-hardening/production-hardening-tdd-plan-v2.md';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', maxBuffer: 128 * 1024 * 1024}).trimEnd();
const before = JSON.parse(fs.readFileSync(path.join(root, '.logs/d110c-0c1f5b-green-57834387/custody-before.json'), 'utf8'));
const changed = Object.entries(before.files).filter(([file, digest]) => hash(fs.readFileSync(path.join(root, file))) !== digest).map(([file]) => file);
if (changed.length !== 1 || changed[0] !== plan) throw Error('unexpected tracked changes: ' + changed);
const sourcePaths = git('diff', '--name-only', '--', 'packages', 'examples').split('\n').filter(Boolean);
const patch = git('diff', '--', ...sourcePaths);
if (patch !== before.diff || git('stash', 'list', '--format=%H %gd %gs') !== before.stashes || git('diff', '--cached')) throw Error('patch/stash/index custody');
const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
const untracked = new Set(git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean));
const missing = before.untracked.filter(file => !untracked.has(file) && !(tracked.has(file) && file.startsWith('.logs/d110c-0c1f5b-green-57834387/')));
if (missing.length) throw Error('untracked custody: ' + missing.join(','));
const verified = [];
for (const directory of ['.logs/d110c-0c1f5b0r-design-3a156aca', '.logs/d110c-0c1f5b-green-57834387', '.logs/d110c-0c1f5b-red-oracle-97c0836b', '.logs/d110c-0c1f5b-cleanup-api-fable-high-57834387']) {
  const manifest = fs.readFileSync(path.join(root, directory, 'manifest.sha256'), 'utf8');
  const rows = manifest.trim().split('\n');
  for (const row of rows) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
    if (!match || hash(fs.readFileSync(path.join(root, directory, match[2]))) !== match[1]) throw Error('manifest: ' + row);
  }
  verified.push({directory, entries: rows.length, manifest: hash(manifest)});
}
const commands = [];
for (const [command, args, env] of [
  ['git', ['-C', root, 'diff', '--check', '--', plan], process.env],
  ['pnpm', ['exec', 'prettier', '--check', plan], {...process.env, NODE_OPTIONS: '--max-old-space-size=12288'}],
]) {
  const start = new Date().toISOString();
  const run = spawnSync(command, args, {cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  commands.push({command, args, nodeOptions: env.NODE_OPTIONS ?? null, start, finish: new Date().toISOString(), status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr});
}
const head = git('rev-parse', 'HEAD');
const remote = git('ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path').split(/\s/)[0];
const result = {head, remote, signature: git('log', '--format=%h %G? %s', '-1'), changed, sourcePaths, productionPatchUnchanged: true, stashCount: before.stashes.split('\n').length, stashesUnchanged: true, inheritedUntrackedCount: before.untracked.length, missingUntracked: missing, verified, commands, planHash: hash(fs.readFileSync(path.join(root, plan))), runtimeRuns: 0, newReviewRuns: 0};
fs.writeFileSync(path.join(out, 'audit.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
if (head !== remote || commands.some(run => run.status !== 0)) throw Error('remote/static gate failed; evidence preserved');
const entries = fs.readdirSync(out).filter(name => name !== 'manifest.sha256').sort().map(name => hash(fs.readFileSync(path.join(out, name))) + '  ' + name);
fs.writeFileSync(path.join(out, 'manifest.sha256'), entries.join('\n') + '\n', {flag: 'wx'});
console.log(JSON.stringify({head, remote, commands: commands.map(run => ({command: run.command, status: run.status})), verified, stashCount: result.stashCount, inheritedUntrackedCount: result.inheritedUntrackedCount, manifest: hash(fs.readFileSync(path.join(out, 'manifest.sha256')))}, null, 2));
