// Design-time inventory derivation only. Does not execute project code or checkers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = file => fs.readFileSync(path.join(root, file));
const read = file => JSON.parse(bytes(file));
const inputs = [
  ['root', 'packages/protocol-v3/conformance/freeze-policy-v3.json', 'protectedPaths'],
  ['historical-successor', 'packages/protocol-v3/conformance/freeze-successor-v1/freeze-policy.json', 'protectedArtifacts'],
  ['ed25519', 'packages/protocol-v3/conformance/freeze-policy-ed25519-profile-v1.json', 'protectedArtifacts'],
  ['blueprint-artifact', 'packages/protocol-v3/conformance/freeze-policy-blueprint-artifact-profile-v1.json', 'protectedArtifacts'],
  ['seal', 'packages/protocol-v3/supplements/seal-digest-identity-v1/freeze-policy.json', 'protectedArtifacts'],
  ['pacemaker', 'packages/protocol-v3/supplements/pacemaker-profile-v1/freeze-policy.json', 'protectedArtifacts'],
  ['author-authorization', 'packages/protocol-v3/supplements/author-authorization-v1/freeze-policy.json', 'protectedArtifacts'],
];
const workflows = [
  'registry', 'seal-digest-identity', 'pacemaker-profile', 'ed25519-profile',
  'blueprint-artifact-profile', 'author-authorization', 'blueprint-operation-budget',
  'blueprint-work-budget', 'equivocation-author-projection', 'equivocation-gossip-budget',
  'equivocation-acl-reputation',
].map(name => `.github/workflows/protocol-v3-${name}.yml`);
const tests = [
  'protocol-v3-registry-spec-n1prime-b', 'protocol-v3-codec-grammar-decision-n1prime-b2b',
  'protocol-v3-independent-reference-vectors-n1prime-c2', 'protocol-v3-regenerated-reference-n1prime-d',
  'protocol-v3-regenerated-reference-remediation-n1prime-d2', 'protocol-v3-freeze-governance-n1prime-e',
  'protocol-v3-freeze-governance-n1prime-e2', 'protocol-v3-freeze-governance-n1prime-e3',
  'protocol-v3-freeze-governance-n1prime-e4', 'protocol-v3-freeze-successor-v1-red',
  'protocol-v3-blueprint-work-budget-0p0', 'protocol-v3-blueprint-operation-budget-0p2',
  'protocol-v3-equivocation-gossip-budget-0o-b2', 'protocol-v3-equivocation-author-projection-0o-b1b',
  'protocol-v3-equivocation-acl-reputation-0o-b3', 'phase-5a-seal-digest-law-red',
  'phase-5d-pacemaker-law-red', 'phase-3a1b-p4-live-journal-parity-governance-red',
  'protocol-v3-anchor-trust-3a0', 'protocol-v3-ed25519-acceptance-profile-0g2s',
  'protocol-v3-blueprint-runtime-0j-b', 'protocol-v3-current-epoch-author-authorization-p6-red',
].map(name => `tests/${name}.test.ts`);
const checkers = [
  'packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs',
  'packages/protocol-v3/scripts/check-ed25519-profile-freeze.mjs',
  'packages/protocol-v3/scripts/check-blueprint-artifact-profile-freeze.mjs',
  'packages/protocol-v3/supplements/seal-digest-identity-v1/check-freeze.mjs',
  'packages/protocol-v3/supplements/pacemaker-profile-v1/check-freeze.mjs',
  'packages/protocol-v3/supplements/author-authorization-v1/check-freeze.mjs',
];
const helpers = [
  'tests/fixtures/phase-3a1b-p6/author-authorization-governance-analyzer.ts',
  'tests/fixtures/phase-3a1b-p6/author-authorization-freeze-harness.ts',
  'tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json',
];
const proposedNew = [
  'tests/protocol-v3-current-registry-contract-d110c-red.test.ts',
  'tests/fixtures/phase-6b-d110c-registry-current/current-registry-contract.json',
  'tests/fixtures/phase-6b-d110c-registry-current/parameters-oracle.mjs',
  'tests/fixtures/phase-6b-d110c-registry-current/current-routing.ts',
  'tests/fixtures/phase-6b-d110c-registry-current/current-snapshot.ts',
];
const sources = [
  'packages/protocol-v3/conformance/freeze-policy-v3.json',
  'packages/protocol-v3/registry/registry-v1.json',
  'packages/protocol-v3/registry/registry-v1.schema.json',
  'packages/protocol-v3/conformance/reference.lock.json',
  'packages/protocol-v3/conformance/reference-regen.lock.json',
  ...workflows, 'CODEOWNERS', 'vite.config.mts', 'vitest.workspace.ts', '.github/workflows/test.yml',
].sort();
assert.equal(sources.length, 20);
const editable = new Set([
  ...inputs.filter(([id]) => id !== 'historical-successor').map(([, file]) => file),
  ...checkers, ...workflows, ...tests, ...helpers,
  'packages/protocol-v3/registry/registry-v1.schema.json',
]);
const owners = new Map();
const add = (file, owner) => {
  assert.equal(typeof file, 'string');
  assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..') && !/[?*]/u.test(file), file);
  owners.set(file, [...(owners.get(file) ?? []), owner]);
};
const policyInputs = inputs.map(([id, file, field]) => {
  const document = read(file); assert.ok(Array.isArray(document[field]));
  for (const target of document[field]) add(target, id);
  return { id, file, field, sha256: sha(bytes(file)), entryCount: document[field].length };
});
for (const file of [...editable, ...sources]) add(file, 'current-contract');
for (const file of proposedNew) { assert.equal(fs.existsSync(path.join(root, file)), false, file); add(file, 'new-red'); }
const absentRequired = new Set(['.github/CODEOWNERS', 'docs/CODEOWNERS']);
const trackedEntries = new Map(execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).split('\0').filter(Boolean).map(entry => {
  const match = /^(\d{6}) ([a-f0-9]{40}) 0\t([\s\S]+)$/u.exec(entry);
  assert.ok(match, 'unmerged or malformed tracked entry');
  return [match[3], { type: 'blob', mode: match[1] }];
}));
function fileEntry(file) {
  const stat = fs.lstatSync(path.join(root, file));
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), file);
  const tracked = trackedEntries.get(file);
  assert.ok(tracked && ['100644', '100755'].includes(tracked.mode), file);
  assert.equal(stat.mode & 0o111 ? '100755' : '100644', tracked.mode, `worktree mode mismatch: ${file}`);
  return tracked;
}
const records = [...owners].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, inheritedOwners]) => {
  if (absentRequired.has(file)) { assert.equal(fs.existsSync(path.join(root, file)), false); return { file, classification: 'required-absent', inheritedOwners }; }
  if (proposedNew.includes(file)) return { file, classification: 'proposed-new-red', inheritedOwners, fileEntry: { type: 'blob', mode: '100644' } };
  return { file, classification: editable.has(file) ? 'editable-current-owner' : 'preserved-input', inheritedOwners, fileEntry: fileEntry(file), sha256: sha(bytes(file)) };
});
const changedHistoricalInputs = new Set([...editable, 'packages/protocol-v3/registry/registry-v1.json']);
const historicalFixturePaths = records.filter(item => item.file.startsWith('tests/fixtures/') && item.file.endsWith('.json') && item.classification === 'preserved-input').map(item => item.file);
const references = [];
function walk(value, location, document) {
  if (value === null || typeof value !== 'object') return;
  if (typeof value.path === 'string' && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256) && changedHistoricalInputs.has(value.path)) references.push({ document, location, target: value.path, historicalSha256: value.sha256 });
  for (const [key, item] of Object.entries(value)) {
    if (changedHistoricalInputs.has(key) && typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item)) references.push({ document, location: location + '/' + key, target: key, historicalSha256: item });
    walk(item, location + '/' + key, document);
  }
}
for (const file of historicalFixturePaths) walk(read(file), '', file);
const v2PolicyPath = 'packages/protocol-v2/conformance/freeze-policy.json';
const v2Policy = read(v2PolicyPath);
const trackedPaths = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim().split('\n');
const v2Patterns = [...v2Policy.protectedPaths, 'CODEOWNERS', '.github/workflows/protocol-v2-registry.yml'];
const v2Files = trackedPaths.filter(file => v2Patterns.some(pattern => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern)).sort();
const verificationOnlyV2Closure = {
  policy: v2PolicyPath, policySha256: sha(bytes(v2PolicyPath)),
  patterns: v2Patterns,
  files: Object.fromEntries(v2Files.map(file => [file, sha(bytes(file))])),
  fileEntries: Object.fromEntries(v2Files.map(file => [file, fileEntry(file)])),
  requiredAbsent: v2Patterns.filter(file => absentRequired.has(file)),
  scope: 'Unchanged current v2 closure copied into fresh controlled repositories so the actual retained v2 checker executes; not a v3 amendment owner or historical reconstruction',
};
const result = {
  status: 'design-candidate-not-implementation-release',
  inspectedHead: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  policyInputs, semanticSourcePaths: sources, affectedCurrentTestFiles: tests,
  proposedNewRedFiles: proposedNew, records, historicalRecordsWhoseLiveTargetsChange: references,
  verificationOnlyV2Closure,
  limits: [
    'Union of the seven explicitly selected existing policy inventories plus reviewed current helpers, tests and source-binding roles; not a claim to govern every protocol subsystem.',
    'Preserved-input means byte preservation; the owner map explains whether it is current semantic data or historical evidence. No preserved fixture attestation is restamped.',
    'These are baseline inspection hashes, not future GREEN pins. No source, policy or workflow was modified or executed.',
  ],
};
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2] === '--write') {
  const target = path.join(root, 'specs/current-registry-governance/inventory.json');
  if (fs.existsSync(target)) assert.equal(sha(fs.readFileSync(target)), 'c4e0c69d5c09d867579c680aad1e145c2250eff8b975d507634894e41c7b4a03', 'only the known unreviewed pre-mode inventory may be replaced');
  fs.writeFileSync(target, output);
  process.stdout.write(JSON.stringify({ records: records.length, classifications: records.reduce((counts, item) => ({ ...counts, [item.classification]: (counts[item.classification] ?? 0) + 1 }), {}), semanticSources: sources.length, affectedTestFiles: tests.length, historicalReferences: references.length, verificationOnlyV2Files: v2Files.length, sha256: sha(output) }) + '\n');
} else {
  assert.equal(process.argv[2], undefined);
  process.stdout.write(output);
}
