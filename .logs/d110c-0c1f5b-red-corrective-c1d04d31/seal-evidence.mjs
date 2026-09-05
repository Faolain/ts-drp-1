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
const source = fs.readFileSync('examples/v3-room/src/index.ts', 'utf8').split('\n');
const protocol = fs.readFileSync('packages/protocol-v3/src/latched-acl.ts', 'utf8').split('\n');
write('source-attribution.json', {
  roomOwner: { file: 'examples/v3-room/src/index.ts', ranges: [{ start: 1379, lines: source.slice(1378, 1441) }, { start: 1647, lines: source.slice(1646, 1650) }] },
  protocolOwner: { file: 'packages/protocol-v3/src/latched-acl.ts', ranges: [{ start: 19, lines: protocol.slice(18, 23) }, { start: 239, lines: protocol.slice(238, 255) }] },
  mutation: 'None; read-only attribution after unexpected matrix, no threshold change or focused rerun.',
});
const verifiedManifests = [];
for (const dir of ['.logs/d110c-0c1f5b0r-design-3a156aca', '.logs/d110c-0c1f5b-red-cecde972', '.logs/d110c-0c1f5b-red-review-b7751f72', '.logs/d110c-0c1f5b0w-final-review-ad38e6c4']) {
  const bytes = fs.readFileSync(path.join(dir, 'manifest.sha256'));
  const lines = bytes.toString().trim().split('\n');
  for (const line of lines) {
    const [, expected, file] = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
    if (file === 'manifest.sha256' || hash(fs.readFileSync(path.join(dir, file))) !== expected) throw Error('Manifest mismatch ' + dir + '/' + file);
  }
  verifiedManifests.push({ directory: dir, entries: lines.length, sha256: hash(bytes), valid: true });
}
write('custody.json', {
  testsHead: git(['rev-parse', 'HEAD']), signature: git(['log', '-1', '--format=%G?']),
  remote: git(['ls-remote', 'origin', 'refs/heads/codex/phase3a1b-p6-golden-path']),
  trackedDiff: git(['diff', '--name-only']), stagedDiff: git(['diff', '--cached', '--name-only']),
  testsOnlyChangedPaths: git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'),
  stashes: git(['stash', 'list', '--format=%gd']).split('\n').length,
  frozenTestHashesUnchanged: true, verifiedManifests,
  noProductionChanges: true, noRerun: true, noCampaign: true, noReviewers: true,
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
