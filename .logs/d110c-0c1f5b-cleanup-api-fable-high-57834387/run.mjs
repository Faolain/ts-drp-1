import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const command = [
  'zsh', '-f', '-c',
  "alias claude-phel='CLAUDE_CONFIG_DIR=/Users/aristotle/.claude-phel claude'\n" +
  "eval 'claude-phel -p --restricted --strict-mcp-config --tools Read,Glob,Grep --model \"claude-fable-5-1[1m]\" --effort high --output-format stream-json --verbose'",
];
const write = (name, value) => fs.writeFileSync(path.join(out, name),
  JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const stdout = fs.openSync(path.join(out, 'events.jsonl'), 'wx');
const stderr = fs.openSync(path.join(out, 'stderr.log'), 'wx');
const start = new Date().toISOString();
const child = spawn(command[0], command.slice(1), { cwd: root, stdio: ['pipe', stdout, stderr] });
write('start.json', { command, cwd: root, start, pid: child.pid,
  requestedModel: 'claude-fable-5-1[1m]', requestedEffort: 'high',
  purpose: 'one-off user-authorized cleanup API/private-boundary consultation',
  sourceAnchor: '57834387c6222189757fce0e7e125914f8d181d8' });
console.log(JSON.stringify({ running: true, pid: child.pid, start }));
child.stdin.end(fs.readFileSync(path.join(out, 'prompt.md')));
child.on('error', error => write('spawn-error.json', { error: error.message }));
child.on('close', (status, signal) => {
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  write('status.json', { status, signal, start, finish: new Date().toISOString() });
  console.log(JSON.stringify({ completed: true, status, signal }));
  process.exitCode = status ?? 1;
});
