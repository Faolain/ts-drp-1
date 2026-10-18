import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
export const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
export const out = path.dirname(new URL(import.meta.url).pathname);
export const baseline = '7efe33dd350deab922c3fea7e9fcd1c968f4e474';
export const oldRoot = '.logs/d110c-w0-current-profile-green-61ea93f6';
export const repairRoot = '.logs/d110c-w0-retained-consumer-green-7c19a479';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const bytes = file => fs.readFileSync(path.resolve(root, file));
export const json = file => JSON.parse(bytes(file));
export const read = file => json(path.join(out, file));
export const write = (file, value) => fs.writeFileSync(path.join(out, file), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
export const key = entry => JSON.stringify([entry.file, entry.name]);
export function exact(actual, expected) {
  const a = actual.map(key).sort(), b = expected.map(key).sort();
  return a.length === new Set(a).size && JSON.stringify(a) === JSON.stringify(b);
}
export function custody() {
  const prior = json(repairRoot + '/custody-after.json');
  const original = json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
  if (git('rev-parse', 'HEAD') !== baseline || git('rev-parse', '@{u}') !== baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('HEAD/signature/upstream/index drift');
  const sources = { ...prior.protectedSources, ...prior.targetHashes };
  for (const [file, digest] of Object.entries({ ...sources, ...prior.built })) if (hash(bytes(file)) !== digest) throw Error('Protected input drift: ' + file);
  const dirty = git('diff', '--name-only').split('\n').filter(Boolean).sort();
  if (JSON.stringify(dirty) !== JSON.stringify(Object.keys(prior.protectedSources).sort())) throw Error('Dirty owner set drift');
  if (git('stash', 'list', '--format=%H %gd %gs') !== original.stashes.trim()) throw Error('Stash drift');
  for (const file of original.untracked) if (!fs.existsSync(path.join(root, file))) throw Error('Protected path missing: ' + file);
  const manifests = { ...prior.manifests, [repairRoot]: '32c97c2e3382b738c4a0697ce6bcd61ee36bcb5f08fc4d571c2bfa4995fce5d8', ['.logs/d110c-w0-regression-readiness-7efe33dd']: '7c50bb00d2160a7f0d4bf48d0713e9ba3cbec81d1c349e544095d6cae01afe10', ['.logs/d110c-w0-browser-7efe33dd']: '97fad32967e5756fa26c4395804d4def75f8a5ec262a3cc70963cb483e533926' };
  let manifestEntries = 0;
  for (const [directory, digest] of Object.entries(manifests)) {
    const manifest = bytes(directory + '/manifest.sha256');
    if (hash(manifest) !== digest) throw Error('Protected manifest drift: ' + directory);
    for (const line of manifest.toString().trim().split('\n')) {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
      if (!match) throw Error('Manifest syntax');
      if (hash(bytes(match[2].startsWith('.logs/') ? match[2] : directory + '/' + match[2])) !== match[1]) throw Error('Sealed evidence drift: ' + match[2]);
      manifestEntries++;
    }
  }
  const inherited = json(repairRoot + '/runtime-roster.json').inputHashes;
  for (const [file, digest] of Object.entries(inherited)) if (hash(bytes(file)) !== digest) throw Error('Inherited input drift: ' + file);
  const patch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...dirty], { maxBuffer: 128 * 1024 * 1024 });
  if (hash(patch) !== '138cb170776d5f2af780375adc78fee0c9029776656579cd1fb190a8d6fadda4') throw Error('Full eleven-owner overlay drift');
  return { baseline, signature: 'G', upstreamMatches: true, indexEmpty: true, dirty, sources, built: prior.built, manifests, manifestEntries, sourcePatchSha256: hash(patch), stashes: 27, protectedPaths: original.untracked.length, inheritedInputCount: Object.keys(inherited).length, allProtectedPathsPresent: true, allSealedEntriesExact: true };
}
export function readiness() {
  if (/--(?:cpu[-_]prof|heap[-_]prof|prof(?:\b|[-_]))/u.test(process.env.NODE_OPTIONS ?? '') || process.execArgv.some(value => /--(?:cpu[-_]prof|heap[-_]prof|prof(?:\b|[-_]))/u.test(value)) || process.env.NODE_V8_COVERAGE) throw Error('Inherited profiling rejected');
  const ports = [4174, 4175, 51000, 51002].map(port => {
    const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (![0, 1].includes(result.status)) throw Error('Listener inspection failed');
    const pids = result.stdout.trim().split(/\s+/u).filter(value => /^\d+$/u.test(value)).map(Number);
    if (pids.length) throw Error('Fixed listener occupied: ' + port);
    return { port, pids };
  });
  const result = spawnSync('pgrep', ['-f', '(vitest|playwright|vite/bin|typescript/lib/tsc|eslint/bin|prettier/bin|quint|apalache|heap-prof|cpu-prof)'], { encoding: 'utf8' });
  if (![0, 1].includes(result.status)) throw Error('PID inspection failed');
  const processes = [];
  for (const pid of result.stdout.trim().split(/\s+/u).filter(value => /^\d+$/u.test(value)).map(Number).filter(value => value !== process.pid && value !== process.ppid)) {
    const status = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' });
    if (status.status === 1) continue;
    if (status.status !== 0) throw Error('PID status failed');
    const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const directories = cwd.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    const relevant = directories.some(directory => directory === root || directory.startsWith(root + '/') || /^\/(?:private\/)?tmp\/d110c-/u.test(directory));
    processes.push({ pid, numericStatus: status.stdout.trim(), cwd: directories, relevant });
    if (relevant) throw Error('Competing task process: ' + pid);
  }
  return { checkedAt: new Date().toISOString(), ports, processes, noArgvCommOrEnvironmentDump: true, noCompetingTaskProcesses: true, inheritedProfilingAbsent: true };
}
