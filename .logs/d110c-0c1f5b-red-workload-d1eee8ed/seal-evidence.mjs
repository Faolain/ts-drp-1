import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
if (fs.existsSync(path.join(out, 'manifest.sha256'))) throw Error('Evidence already sealed');
const matrix = JSON.parse(fs.readFileSync(path.join(out, 'matrix.json'), 'utf8'));
for (const [file, expected] of Object.entries(matrix.fileHashes)) if (hash(fs.readFileSync(file)) !== expected) throw Error('Post-run test mutation');
const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
if (result.violations.length || result.classification !== 'ACCEPTED_CAUSAL_WORKLOAD_RED') throw Error('No exact RED');
const verifiedManifests = [];
for (const dir of ['.logs/d110c-0c1f5b0r-design-3a156aca', '.logs/d110c-0c1f5b-red-corrective-c1d04d31', '.logs/d110c-0c1f5b-red-corrective-accepted-c1d04d31', '.logs/d110c-0c1f5b-workload-plan-confirmation-d836fc3d']) {
  const bytes = fs.readFileSync(path.join(dir, 'manifest.sha256'));
  const lines = bytes.toString().trim().split('\n');
  for (const line of lines) {
    const [, expected, file] = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
    if (file === 'manifest.sha256' || hash(fs.readFileSync(path.join(dir, file))) !== expected) throw Error('Manifest mismatch ' + dir + '/' + file);
  }
  verifiedManifests.push({ directory: dir, entries: lines.length, sha256: hash(bytes), valid: true });
}
const stashes = git(['stash', 'list', '--format=%gd']).split('\n').length;
if (stashes !== 27) throw Error('Stash custody changed');
const productionChanges = git(['diff', 'a6a3f738', 'HEAD', '--name-only', '--', 'packages', 'examples']);
if (productionChanges) throw Error('Production changed');
write('custody.json', {
  testsHead: git(['rev-parse', 'HEAD']), signature: git(['log', '-1', '--format=%G?']),
  remote: git(['ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path']),
  trackedDiff: git(['diff', '--name-only']), stagedDiff: git(['diff', '--cached', '--name-only']),
  testsOnlyChangedPaths: git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'),
  stashes, frozenTestHashesUnchanged: true, verifiedManifests,
  productionChanges, noRerun: true, noCampaign: true, noReviewers: true,
  canonicalCalculatorSource: { path: 'packages/canonical/src/index.ts', sha256: hash(fs.readFileSync('packages/canonical/src/index.ts')), command: 'node --import=tsx .logs/d110c-0c1f5b-red-workload-working-a6a3f738/bounds.mjs', status: 0 },
  note: 'Working evidence directory was renamed to this tests-SHA root without changing frozen contents before the sole focused execution.',
});
const inventory = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (entry.name !== 'manifest.sha256') inventory.push(path.relative(out, full));
  }
}
visit(out);
const manifest = inventory.sort().map(file => `${hash(fs.readFileSync(path.join(out, file)))}  ${file}`).join('\n') + '\n';
fs.writeFileSync(path.join(out, 'manifest.sha256'), manifest);
console.log(JSON.stringify({ evidenceRoot: path.relative(root, out), entries: inventory.length, manifestSha256: hash(manifest) }));
