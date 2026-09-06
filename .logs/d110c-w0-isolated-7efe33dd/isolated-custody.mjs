import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root as main, baseline, read, write, hash, custody } from './common.mjs';
const stage = process.argv[2];
if (!['before-install', 'before-build', 'built', 'ready'].includes(stage)) throw Error('Stage');
const { root } = read('checkout.json');
const mainCustody = read('custody-before.json');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
if (git('rev-parse', 'HEAD') !== baseline || git('log', '-1', '--format=%G?') !== 'G' || git('diff', '--cached', '--name-only')) throw Error('Isolated signed HEAD/index drift');
if (JSON.stringify(git('diff', '--name-only').split('\n').sort()) !== JSON.stringify(mainCustody.dirty)) throw Error('Isolated overlay owner set drift');
const patch = execFileSync('git', ['-C', root, 'diff', '--binary', '--full-index'], { maxBuffer: 128 * 1024 * 1024 });
if (hash(patch) !== mainCustody.sourcePatchSha256) throw Error('Isolated overlay patch drift');
const sources = {};
for (const [file, expected] of Object.entries(mainCustody.sources)) {
  const physical = fs.realpathSync(path.join(root, file));
  if (!physical.startsWith(root + '/') || hash(fs.readFileSync(physical)) !== expected) throw Error('Isolated source identity mismatch: ' + file);
  sources[file] = { physical, sha256: expected };
}
const configs = {};
for (const file of ['pnpm-lock.yaml', 'package.json', 'vite.config.mts', 'tsconfig.json', '.npmrc', 'scripts/ensure-native-deps.mjs']) {
  const value = fs.readFileSync(path.join(root, file));
  if (!value.equals(execFileSync('git', ['-C', root, 'show', baseline + ':' + file]))) throw Error('Isolated configuration drift');
  configs[file] = hash(value);
}
const dependencies = {};
if (stage === 'before-install') {
  if (fs.existsSync(path.join(root, 'node_modules'))) throw Error('Dependencies existed before independent installation');
} else {
  for (const name of ['typescript', 'vite', 'vitest', 'eslint', 'prettier']) {
    const physical = fs.realpathSync(path.join(root, 'node_modules', name));
    if (!physical.startsWith(root + '/')) throw Error('Shared main dependency: ' + name);
    dependencies[name] = physical;
  }
}
const built = {};
for (const [file, mainHash] of Object.entries(mainCustody.built)) {
  const target = path.join(root, file);
  if (['before-install', 'before-build'].includes(stage)) {
    if (fs.existsSync(target)) throw Error('Built owner existed before independent build: ' + file);
  } else {
    const physical = fs.realpathSync(target);
    if (!physical.startsWith(root + '/')) throw Error('Shared built owner: ' + file);
    const sha256 = hash(fs.readFileSync(physical));
    if (sha256 !== mainHash) throw Error('Fresh built owner differs from frozen main build: ' + file);
    built[file] = { physical, sha256 };
  }
}
if (['before-build', 'built', 'ready'].includes(stage)) {
  const native = read('native-target.json'), artifacts = read('native-artifacts.json');
  if (!fs.realpathSync(native.native).startsWith(root + '/')) throw Error('Shared native artifact');
  for (const artifact of Object.values(artifacts.artifacts)) if (hash(fs.readFileSync(artifact.source)) !== artifact.sha256) throw Error('Native artifact changed');
}
const mainAfter = custody();
if (JSON.stringify(mainAfter) !== JSON.stringify(mainCustody)) throw Error('Main custody changed during independent preparation');
write('custody-' + stage + '.json', { stage, root, baseline, signature: 'G', indexEmpty: true, sources, configs, dependencies, built, sourcePatchSha256: hash(patch), noSourceEditsBeyondExactOverlay: true, noSharedDependenciesOrBuilds: true, mainCustody: mainAfter, testsExecuted: 0 });
console.log(JSON.stringify({ stage, sources: Object.keys(sources).length, builtIdentities: Object.keys(built).length, mainCustodyPreserved: true, isolatedRoot: root }));
