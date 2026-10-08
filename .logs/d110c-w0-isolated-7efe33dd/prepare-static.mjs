import fs from 'node:fs';
import path from 'node:path';
import { root as main, out, read, write, hash } from './common.mjs';
const { root } = read('checkout.json');
if (read('build/status.json').code !== 0 || !read('build/status.json').quiescent) throw Error('Independent build not complete');
const mainRoster = JSON.parse(fs.readFileSync(path.join(main, '.logs/d110c-w0-regression-readiness-7efe33dd/runtime-roster.json')));
const targets = [
  'tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts',
  'tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts',
  'tests/fixtures/phase-6a-v3/creator-adoption-contract.ts',
  'packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs',
  'tests/fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.ts',
  'tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts',
];
for (const file of mainRoster.files) if (hash(fs.readFileSync(path.join(root, file))) !== hash(fs.readFileSync(path.join(main, file)))) throw Error('Selected test source differs');
write('selected-files.json', mainRoster.files);
write('targeted-static-files.json', targets);
const node = fs.realpathSync(process.execPath);
const vitest = fs.realpathSync(path.join(root, 'node_modules/vitest/vitest.mjs'));
if (!vitest.startsWith(root + '/')) throw Error('Shared Vitest');
const operations = [
  { label: 'main-typecheck', cwd: main, budgetMs: 120000, command: [node, path.join(out, 'typecheck.mjs'), 'main'] },
  { label: 'isolated-typecheck', cwd: root, budgetMs: 120000, command: [node, path.join(out, 'typecheck.mjs'), 'isolated'] },
  { label: 'lint', cwd: root, budgetMs: 120000, command: ['pnpm', 'exec', 'eslint', '--format', 'json', ...targets] },
  { label: 'format', cwd: root, budgetMs: 120000, command: ['pnpm', 'exec', 'prettier', '--check', ...targets] },
  { label: 'diff', cwd: root, budgetMs: 30000, command: ['git', '-C', root, 'diff', '--check'] },
  { label: 'collection', cwd: root, budgetMs: 60000, command: [node, vitest, 'list', ...mainRoster.files.map(file => path.join(root, file)), '--json', '--no-file-parallelism', '--coverage.enabled=false'] },
  { label: 'isolation-inventory', cwd: root, budgetMs: 120000, command: [node, path.join(out, 'isolation-inventory.mjs')] },
  { label: 'freeze', cwd: root, budgetMs: 120000, command: [node, path.join(out, 'freeze.mjs')] },
];
write('static-operations.json', { root, node, vitest, operations, sourceEdits: 0, runtimeTestExecutions: 0, diagnosticsNotAssumedClean: true });
console.log(JSON.stringify({ isolatedRoot: root, targetedFiles: targets.length, collectionFiles: mainRoster.files.length, expectedCases: mainRoster.entries.length, runtimeTestsAuthorized: false }));
