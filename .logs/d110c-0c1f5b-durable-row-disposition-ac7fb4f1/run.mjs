import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const output = path.dirname(new URL(import.meta.url).pathname);
const [name, binary, ...args] = process.argv.slice(2);
const start = new Date().toISOString();
const result = spawnSync(binary, args, {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify({
  command: [binary, ...args], cwd: root, start,
  finish: new Date().toISOString(), status: result.status,
  signal: result.signal, error: result.error?.message,
  stdout: result.stdout, stderr: result.stderr,
}, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ name, status: result.status, signal: result.signal,
  stdout: result.stdout?.slice(-3000), stderr: result.stderr?.slice(-3000) }));
process.exitCode = result.status ?? 1;
