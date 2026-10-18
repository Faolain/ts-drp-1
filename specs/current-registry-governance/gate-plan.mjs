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
assert.equal(roots.length, 28);
assert.equal(js.length, 7);
const variants = [
  ['PHASE_0P0', 'protocol-v3-blueprint-work-budget-0p0', 'phase-0p0-v3/controlled-blueprint-work-budget.ts'],
  ['PHASE_0P2', 'protocol-v3-blueprint-operation-budget-0p2', 'phase-0p2-v3/controlled-blueprint-operation-budget.ts'],
  ['PHASE_0O_B1B', 'protocol-v3-equivocation-author-projection-0o-b1b', 'phase-0o-b1b-v3/controlled-author-projection.ts'],
  ['PHASE_0O_B2', 'protocol-v3-equivocation-gossip-budget-0o-b2', 'phase-0o-b2-v3/controlled-gossip-budget.ts'],
  ['PHASE_0O_B3', 'protocol-v3-equivocation-acl-reputation-0o-b3', 'phase-0o-b3-v3/controlled-acl-reputation.ts'],
];
const specialCeilings = {
  'tests/protocol-v3-current-registry-contract-d110c-red.test.ts': 900,
  'tests/protocol-v3-freeze-successor-v1-red.test.ts': 900,
  'tests/protocol-v3-registry-spec-n1prime-b.test.ts': 360,
  'tests/phase-5a-seal-digest-law-red.test.ts': 480,
  'tests/phase-5d-pacemaker-law-red.test.ts': 480,
  'tests/protocol-v3-anchor-trust-3a0.test.ts': 600,
  'tests/protocol-v3-blueprint-runtime-0j-b.test.ts': 600,
};
const test = (file, env = {}) => ({ command: 'pnpm', args: ['exec', 'vitest', 'run', file, '--no-coverage', '--maxWorkers=1', '--minWorkers=1'], env, unsetEnv: ['PROTOCOL_V3_FREEZE_SUCCESSOR_CERTIFICATION'], ceilingSeconds: specialCeilings[file] ?? 240, expectedExit: 0 });
const readinessFiles = [newTest[0], 'tests/protocol-v3-freeze-successor-v1-red.test.ts', 'tests/phase-5a-seal-digest-law-red.test.ts', 'tests/phase-5d-pacemaker-law-red.test.ts', 'tests/protocol-v3-anchor-trust-3a0.test.ts', 'tests/protocol-v3-blueprint-runtime-0j-b.test.ts'];
export const plan = {
  status: 'candidate-requires-design-acceptance-and-stage-custody',
  cwd: 'explicit absolute current-source validation checkout A, then independently prepared checkout B; main static/custody and final transition checks are separate', serial: true, retries: 0,
  budgetMeaning: 'One-shot admission ceilings inferred from declared child/case bounds, not measured runtime guarantees. First readiness invocations count toward the roster and are not automatically repeated.',
  red: [{ ...test(newTest[0]), expectedExit: 1, acceptance: 'Named assertion through existing evaluator; no import, missing export, timeout or readiness skip as causal RED' }],
  greenValidationAAndB: [...readinessFiles, ...inventory.affectedCurrentTestFiles.filter(file => !readinessFiles.includes(file))].map(file => test(file)).concat(variants.map(([prefix, name, fixture]) => test(`tests/${name}.test.ts`, { [`${prefix}_IMPLEMENTATION_MODULE`]: `tests/fixtures/${fixture}` }))),
  readinessPrefix: readinessFiles,
  strictCompiler: { roots, ceilingSeconds: 120, profile: 'Actual tsconfig, package export type entries and Vite aliases; ES2022, noEmit, composite=false, declaration=false, declarationMap=false, incremental=false; no types/typeRoots injection', acceptance: 'Capture new post-RED/pre-GREEN baseline for these exact roots; no new diagnostic identities or anchors; retain baseline errors as non-clean evidence; repeat with fresh isolation and resolution provenance' },
  syntax: js.map(file => ({ command: 'node', args: ['--check', file], ceilingSeconds: 30, expectedExit: 0 })),
  lint: { command: 'pnpm', args: ['exec', 'eslint', ...roots, ...js], ceilingSeconds: 120, expectedExit: 0 },
  format: { command: 'pnpm', args: ['exec', 'prettier', '--check', ...editable], ceilingSeconds: 120, expectedExit: 0 },
  childIntegrity: js.filter(file => !file.endsWith('/check-protocol-v3-freeze.mjs') && !file.endsWith('/parameters-oracle.mjs')).map(file => ({ command: 'node', args: [file], ceilingSeconds: 30, expectedExit: 0, requiredScope: 'integrity-only' })),
  transitionEvidence: 'Actual extracted v2/root execution in new routing suite controlled repositories; signed-checkpoint-to-working-tree invocations recorded separately once checkpoint exists',
};
assert.equal(plan.greenValidationAAndB.length, 29);
assert.equal(plan.childIntegrity.length, 5);
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}
