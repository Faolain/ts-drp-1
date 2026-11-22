import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const suffix = ['final', 'accepted'].includes(process.argv[2]) ? '-' + process.argv[2] : '';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = execFileSync('rg', ['--files', 'tests', 'packages', 'scripts', '-g', '*.ts', '-g', '*.mjs', '-g', '!**/dist/**', '-g', '!**/node_modules/**', '-g', '!**/.logs/**'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const dependencies = new Map(files.map(file => [file, []]));
const seeds = [
  'packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs',
  'tests/fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.ts',
  'tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts',
];
const sourceInspectionEdges = [];
for (const file of files) {
  const contents = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of contents.matchAll(/(?:from\s*|import\s*\(|new URL\(\s*)\s*["']([^"']+)["']/gu)) {
    if (!match[1].startsWith('.')) continue;
    const dependency = path.normalize(path.join(path.dirname(file), match[1])).replace(/\.js$/u, '.ts');
    if (dependencies.has(dependency)) dependencies.get(file).push(dependency);
  }
  for (const seed of seeds) if (file !== seed && contents.includes('"' + seed + '"')) {
    dependencies.get(file).push(seed);
    sourceInspectionEdges.push({ file, source: seed, reason: 'exact repository-relative source path literal' });
  }
}
const affected = new Set(seeds);
let changed = true;
while (changed) {
  changed = false;
  for (const [file, imports] of dependencies) if (!affected.has(file) && imports.some(dependency => affected.has(dependency))) {
    affected.add(file);
    changed = true;
  }
}
const tests = [...affected].filter(file => file.endsWith('.test.ts')).sort();
const supplemental = ['tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts'];
const result = {
  seeds, tests, supplemental, sourceInspectionEdges,
  affected: [...affected].sort(),
  dependencies: Object.fromEntries([...affected].sort().map(file => [file, [...new Set(dependencies.get(file))].sort()])),
  hashes: Object.fromEntries([...affected, ...supplemental].sort().map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
  refinement: 'The prior eight-file/19-case proposal omitted the unchanged 11-case child-source inspection suite; this is a prospective dependency refinement, not a historic roster replacement.',
};
fs.writeFileSync(path.join(out, 'consumers' + suffix + '.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(out, 'selected-files' + suffix + '.json'), JSON.stringify([...tests, ...supplemental], null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ seeds, tests, supplemental, affectedCount: affected.size }));
