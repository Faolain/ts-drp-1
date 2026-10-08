import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [directory, expectedDigest] = process.argv.slice(2);
const root = path.resolve(directory);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = fs.readFileSync(path.join(root, 'manifest.sha256'));
assert.equal(hash(manifest), expectedDigest);
const entries = manifest.toString().trimEnd().split('\n').map(line => {
  const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
  assert.ok(match, line);
  const file = path.resolve(root, match[2]);
  assert.ok(file.startsWith(root + '/'));
  assert.equal(hash(fs.readFileSync(file)), match[1], match[2]);
  return path.relative(root, file);
});
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  assert.ok(!e.isSymbolicLink());
  const file = path.join(dir, e.name);
  return e.isDirectory() ? walk(file) : [path.relative(root, file)];
});
assert.equal(new Set(entries).size, entries.length);
assert.deepEqual([...entries, 'manifest.sha256'].sort(), walk(root).sort());
console.log(JSON.stringify({ directory, manifestSha256: expectedDigest, entries: entries.length, exactFileSet: true }));
