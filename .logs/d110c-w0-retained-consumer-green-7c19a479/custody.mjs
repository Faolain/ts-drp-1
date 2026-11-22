import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const stage = process.argv[2];
const baseline = '7c19a4792eb63eecb85e4ac7a1484df88c77c984';
const targets = [
  'packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs',
  'tests/fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.ts',
  'tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts',
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(path.resolve(root, file));
const json = file => JSON.parse(read(file));
const write = (file, value) => fs.writeFileSync(path.join(out, file), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
if (!['before', 'after'].includes(stage)) throw Error('stage');
const priorRoot = '.logs/d110c-w0-current-profile-green-61ea93f6';
const prior = json(priorRoot + '/control-observer-correction/custody-after.json');
const original = json('.logs/d110c-0c1f5b-green-57834387/custody-before.json');
if (git('rev-parse', 'HEAD') !== baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('HEAD/signature/index');
const protectedSources = { ...prior.ownerHashes, ...prior.targetHashes };
for (const [file, digest] of Object.entries({ ...protectedSources, ...prior.built })) {
  if (hash(read(file)) !== digest) throw Error('Protected source/build drift: ' + file);
}
const parentPatch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...Object.keys(prior.ownerHashes)], { maxBuffer: 128 * 1024 * 1024 });
if (hash(parentPatch) !== prior.patchSha256) throw Error('Parent patch');
if (git('stash', 'list', '--format=%H %gd %gs') !== original.stashes.trim()) throw Error('Stashes');
for (const file of original.untracked) if (!fs.existsSync(path.join(root, file))) throw Error('Protected path missing: ' + file);
const manifests = { ...prior.manifests, [priorRoot]: hash(read(priorRoot + '/manifest.sha256')), ['.logs/d110c-w0-retained-consumer-red-b7e498bc']: 'd8f841e7815fbd95c566368776941cdf1f2a56dcae92b9885b9f9650a8fcad6d' };
for (const [directory, digest] of Object.entries(manifests)) {
  const manifest = read(directory + '/manifest.sha256');
  if (hash(manifest) !== digest) throw Error('Manifest changed: ' + directory);
  for (const line of manifest.toString().trim().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
    if (!match) throw Error('Manifest syntax: ' + directory);
    const [, expected, file] = match;
    if (hash(read(file.startsWith('.logs/') ? file : directory + '/' + file)) !== expected) throw Error('Evidence changed: ' + file);
  }
}
const inheritedInputs = json('.logs/d110c-w0-retained-consumer-red-b7e498bc/runtime-roster.json').inputHashes;
for (const [file, digest] of Object.entries(inheritedInputs)) {
  if (!targets.includes(path.relative(root, file)) && hash(read(file)) !== digest) throw Error('Inherited input drift: ' + file);
}
const dirty = git('diff', '--name-only').split('\n').filter(Boolean);
for (const file of dirty) if (!Object.hasOwn(protectedSources, file) && !(stage === 'after' && targets.includes(file))) throw Error('Unexpected dirty owner: ' + file);
if (stage === 'before') {
  for (const file of targets) {
    if (hash(read(file)) !== hash(execFileSync('git', ['-C', root, 'show', baseline + ':' + file]))) throw Error('Target not signed baseline: ' + file);
    const snapshot = 'before/' + file;
    fs.mkdirSync(path.dirname(path.join(out, snapshot)), { recursive: true });
    write(snapshot, read(file));
  }
} else {
  const before = JSON.parse(fs.readFileSync(path.join(out, 'custody-before.json')));
  if (JSON.stringify(before.manifests) !== JSON.stringify(manifests)) throw Error('Manifest roots drift');
  write('green.patch', execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index', '--', ...targets], { maxBuffer: 128 * 1024 * 1024 }));
}
const targetHashes = Object.fromEntries(targets.map(file => [file, hash(read(file))]));
write('custody-' + stage + '.json', { stage, baseline, signature: 'G', indexEmpty: true, targets, targetHashes, protectedSources, built: prior.built, parentPatchSha256: hash(parentPatch), manifests, stashCount: 27, protectedPaths: original.untracked.length, allProtectedPathsExist: true, inheritedInputCount: Object.keys(inheritedInputs).length, allNonTargetInheritedInputsPreserved: true, trackedStatus: git('status', '--short', '--untracked-files=no') });
console.log(JSON.stringify({ stage, baseline, protectedSources: Object.keys(protectedSources).length, built: Object.keys(prior.built).length, stashes: 27, protectedPaths: original.untracked.length, manifests: Object.keys(manifests).length, inheritedInputs: Object.keys(inheritedInputs).length, targetHashes }));
