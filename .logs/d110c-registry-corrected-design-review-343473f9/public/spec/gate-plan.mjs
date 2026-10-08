// Prints candidate commands; never executes project gates.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const inventory = JSON.parse(fs.readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'));
const newTest = inventory.proposedNewRedFiles.filter(file => file.endsWith('.test.ts'));
assert.equal(newTest.length, 1);
const editable = inventory.records.filter(item => ['editable-current-owner', 'proposed-new-red'].includes(item.classification)).map(item => item.file).sort();
const roots = editable.filter(file => file.endsWith('.ts'));
const js = editable.filter(file => file.endsWith('.mjs'));
assert.equal(roots.length, 27);
assert.equal(js.length, 7);
const variants = [
  ['PHASE_0P0', 'protocol-v3-blueprint-work-budget-0p0', 'phase-0p0-v3/controlled-blueprint-work-budget.ts'],
  ['PHASE_0P2', 'protocol-v3-blueprint-operation-budget-0p2', 'phase-0p2-v3/controlled-blueprint-operation-budget.ts'],
  ['PHASE_0O_B1B', 'protocol-v3-equivocation-author-projection-0o-b1b', 'phase-0o-b1b-v3/controlled-author-projection.ts'],
  ['PHASE_0O_B2', 'protocol-v3-equivocation-gossip-budget-0o-b2', 'phase-0o-b2-v3/controlled-gossip-budget.ts'],
  ['PHASE_0O_B3', 'protocol-v3-equivocation-acl-reputation-0o-b3', 'phase-0o-b3-v3/controlled-acl-reputation.ts'],
];
const test = (file, env = {}) => ({ command: 'pnpm', args: ['exec', 'vitest', 'run', file, '--no-coverage', '--maxWorkers=1', '--minWorkers=1'], env, ceilingSeconds: 240, expectedExit: 0 });
export const plan = {
  status: 'candidate-requires-design-acceptance-and-stage-custody',
  cwd: 'explicit absolute main or fresh-isolation root', serial: true, retries: 0,
  red: [{ ...test(newTest[0]), expectedExit: 1, acceptance: 'Named assertion through existing evaluator; no import, missing export, timeout or readiness skip as causal RED' }],
  greenMainAndIsolation: [...newTest, ...inventory.affectedCurrentTestFiles].map(file => test(file)).concat(variants.map(([prefix, name, fixture]) => test(`tests/${name}.test.ts`, { [`${prefix}_IMPLEMENTATION_MODULE`]: `tests/fixtures/${fixture}` }))),
  strictCompiler: { roots, ceilingSeconds: 120, profile: 'Actual tsconfig, package export type entries and Vite aliases; ES2022, noEmit, composite=false, declaration=false, declarationMap=false, incremental=false; no types/typeRoots injection', acceptance: 'Capture new post-RED/pre-GREEN baseline for these exact roots; no new diagnostic identities or anchors; retain baseline errors as non-clean evidence; repeat with fresh isolation and resolution provenance' },
  syntax: js.map(file => ({ command: 'node', args: ['--check', file], ceilingSeconds: 30, expectedExit: 0 })),
  lint: { command: 'pnpm', args: ['exec', 'eslint', ...roots, ...js], ceilingSeconds: 120, expectedExit: 0 },
  format: { command: 'pnpm', args: ['exec', 'prettier', '--check', ...editable], ceilingSeconds: 120, expectedExit: 0 },
  childIntegrity: js.filter(file => !file.endsWith('/check-protocol-v3-freeze.mjs') && !file.endsWith('/parameters-oracle.mjs')).map(file => ({ command: 'node', args: [file], ceilingSeconds: 30, expectedExit: 0, requiredScope: 'integrity-only' })),
  transitionEvidence: 'Actual extracted v2/root execution in new routing suite controlled repositories; signed-checkpoint-to-working-tree invocations recorded separately once checkpoint exists',
};
assert.equal(plan.greenMainAndIsolation.length, 28);
assert.equal(plan.childIntegrity.length, 5);
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}
