import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from '/tmp/d110c-f5b-observer-red-zKIwWG/checkout/node_modules/typescript/lib/typescript.js';
import { loadConfigFromFile } from '/tmp/d110c-f5b-observer-red-zKIwWG/checkout/node_modules/vite/dist/node/index.js';

const root = process.cwd();
const out = path.dirname(new URL(import.meta.url).pathname);
const files = ['tests/phase-6b-d110c-0c1f5b-integration-red.test.ts', 'tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts'];
const checkedFiles = [...files, 'tests/fixtures/phase-6b-d110c-0c1f5b/transient-payload-application.ts', 'tests/fixtures/phase-6b-d110c-0c1f5b/snapshot-state-oracle.ts'];
const filter = 'D.110c-0c1f5b parent genuine settlement composition|parent f5b P2';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
if (fs.existsSync(path.join(out, 'matrix.json'))) throw Error('Frozen matrix exists; do not overwrite');
const commands = [];
function run(args) {
  const result = spawnSync('pnpm', ['exec', ...args], { encoding: 'utf8' });
  commands.push({ command: ['pnpm', 'exec', ...args], status: result.status, stdout: result.stdout, stderr: result.stderr });
  write('preflight-commands.json', commands);
  if (result.status !== 0) throw Error('Preflight failed: ' + args.join(' '));
  return result.stdout;
}
run(['eslint', ...checkedFiles]);
run(['prettier', '--check', ...checkedFiles]);
const selected = JSON.parse(run(['vitest', 'list', ...files, '-t', filter, '--json']));
const all = JSON.parse(run(['vitest', 'list', ...files, '--json']));
write('list.json', selected);
write('all-list.json', all);
if (selected.length !== 28) throw Error('Expected 28 selected');

const read = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (read.error) throw Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
const paths = { ...parsed.options.paths };
function typeEntry(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.types === 'string') return value.types;
  return typeEntry(value.import) ?? typeEntry(value.default);
}
for (const group of ['packages', 'examples']) {
  for (const dir of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, group, dir.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pkg.name) continue;
    if (pkg.types) paths[pkg.name] = [path.resolve(path.dirname(file), pkg.types)];
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const entry = typeEntry(value);
      if (key.startsWith('.') && entry) paths[pkg.name + (key === '.' ? '' : key.slice(1))] = [path.resolve(path.dirname(file), entry)];
    }
  }
}
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.mts'));
if (!loaded) throw Error('Vite aliases unavailable');
for (const [key, value] of Object.entries(loaded.config.resolve.alias)) paths[key] = [value];
const program = ts.createProgram(files.map(file => path.join(root, file)), {
  ...parsed.options, paths, noEmit: true, composite: false, declaration: false, declarationMap: false, target: ts.ScriptTarget.ES2022,
});
const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
  file: d.file && path.relative(root, d.file.fileName), code: d.code,
  line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
  message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
}));
const targetDiagnostics = diagnostics.filter(d => checkedFiles.includes(d.file));
write('typecheck.json', { targetDiagnostics, externalDiagnostics: diagnostics.filter(d => !targetDiagnostics.includes(d)) });
if (targetDiagnostics.length) throw Error('Target type diagnostics');
const entries = selected.map(row => {
  const name = row.name.replaceAll(' > ', ' ');
  let token = null;
  if (row.file.endsWith(files[0]) && !name.includes('legacy v1 reentry guard') && !name.includes('keeps the genuine v1')) token = 'F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED';
  if (name.includes('snapshot oracle')) token = null;
  if (name.includes('composes 64 active writers')) token = 'canonical value exceeds item limit';
  if (name.includes('non-hold same-message')) token = 'F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED';
  if (name.endsWith('precedence is consistent for rehearse')) token = 'F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED';
  if (name.endsWith('precedence is consistent for activate')) token = 'F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED';
  return { file: path.relative(root, row.file), name, expectedStatus: token ? 'failed' : 'passed', token };
});
const expectedFailed = entries.filter(row => row.expectedStatus === 'failed').length;
if (expectedFailed !== 23) throw Error('Expected 23 failures');
const matrix = {
  frozenAt: new Date().toISOString(), base: '78e068a8992a6a4fa7402e24eeca50609aebff64', filter, files,
  fileHashes: Object.fromEntries(checkedFiles.map(file => [file, hash(fs.readFileSync(file))])),
  selected: 28, expectedFailed: 23, expectedPassed: 5, intentionallyFiltered: all.length - selected.length,
  allowedTopLevelErrors: 0, allowedTimeouts: 0, allowedAdditionalFailures: 0, executionCount: 1, entries,
  budgets: 'Independent continuations; existing 60000ms wide-fixture watchdog unchanged and not a performance threshold. Routed ingress uses at most 256 real readonly IDB scheduling rounds; P2 prompt refusals use the accepted 256-microtask oracle. No wall-clock causal failure oracle. No complete GREEN duration claimed.',
};
const inherited = JSON.parse(fs.readFileSync('/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b-red-oracle-97c0836b/matrix.json', 'utf8'));
if (JSON.stringify(entries) !== JSON.stringify(inherited.entries) || matrix.intentionallyFiltered !== 17) throw Error('Frozen inherited matrix differs');
if (all.length !== 45 || entries.filter(row => row.name.includes('snapshot oracle')).length !== 2) throw Error('Oracle/total count differs');
write('matrix.json', matrix);
console.log(JSON.stringify({ selected: matrix.selected, failed: matrix.expectedFailed, passed: matrix.expectedPassed, intentionallyFiltered: matrix.intentionallyFiltered, matrixSha256: hash(fs.readFileSync(path.join(out, 'matrix.json'))) }));
