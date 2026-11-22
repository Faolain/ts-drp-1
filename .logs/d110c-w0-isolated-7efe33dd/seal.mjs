import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const out = path.dirname(new URL(import.meta.url).pathname);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const handoff = JSON.parse(fs.readFileSync(path.join(out, 'isolated-handoff.json')));
if (handoff.runtimeInvocations !== 3 || handoff.totalCaseExecutions !== 232 || !handoff.custody.runtimeGroupsQuiescent || !handoff.custody.indexEmpty) throw Error('Final isolated acceptance incomplete');
const files = [];
const visit = directory => {
  for (const entry of fs.readdirSync(path.join(out, directory), { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && file !== 'manifest.sha256') files.push(file);
    else throw Error('Unexpected evidence entry: ' + file);
  }
};
visit('');
for (const gate of ['runtime-w0', 'runtime-retained', 'runtime-bootstrap-supplement']) if (!files.includes('root-' + gate + '-release.json')) throw Error('Missing root release artifact');
const manifest = files.sort().map(file => hash(fs.readFileSync(path.join(out, file))) + '  ' + file).join('\n') + '\n';
fs.writeFileSync(path.join(out, 'manifest.sha256'), manifest, { flag: 'wx' });
for (const line of manifest.trim().split('\n')) {
  const [expected, file] = line.split('  ');
  if (hash(fs.readFileSync(path.join(out, file))) !== expected) throw Error('Seal verification failed: ' + file);
}
console.log(JSON.stringify({ sealedFiles: files.length, totalDirectoryFiles: files.length + 1, manifestSha256: hash(manifest), selfExcluding: true, everyEntryVerified: true, finalHandoff: 'isolated-handoff.json' }));
