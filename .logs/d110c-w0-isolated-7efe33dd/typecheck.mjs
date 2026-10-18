import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root as main, read, write, hash } from './common.mjs';
const stage = process.argv[2];
if (!['main', 'isolated'].includes(stage)) throw Error('Compiler stage');
const root = stage === 'main' ? main : read('checkout.json').root;
const ts = (await import(pathToFileURL(path.join(root, 'node_modules/typescript/lib/typescript.js')).href)).default;
const { loadConfigFromFile } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
const prior = JSON.parse(fs.readFileSync(path.join(main, '.logs/d110c-w0-regression-readiness-7efe33dd/program-identity.json')));
const rootNames = prior.rootNames.map(file => path.join(root, path.relative(main, file)));
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const paths = { ...parsed.options.paths };
function typeEntry(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.types === 'string') return value.types;
  return typeEntry(value.import) ?? typeEntry(value.default);
}
for (const group of ['packages', 'examples']) for (const directory of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const file = path.join(root, group, directory.name, 'package.json');
  if (!fs.existsSync(file)) continue;
  const pkg = JSON.parse(fs.readFileSync(file));
  if (!pkg.name) continue;
  if (pkg.types) paths[pkg.name] = [path.resolve(path.dirname(file), pkg.types)];
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeEntry(value);
    if (key.startsWith('.') && entry) paths[pkg.name + (key === '.' ? '' : key.slice(1))] = [path.resolve(path.dirname(file), entry)];
  }
}
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.mts'));
if (!loaded) throw Error('Actual source aliases unavailable');
for (const [key, value] of Object.entries(loaded.config.resolve.alias)) paths[key] = [value];
const options = { ...parsed.options, paths, noEmit: true, composite: false, declaration: false, declarationMap: false, target: ts.ScriptTarget.ES2022, incremental: false };
const normalizeOptions = value => JSON.stringify(value).replaceAll(root, '<checkout>');
if (normalizeOptions(options) !== JSON.stringify(prior.options).replaceAll(main, '<checkout>')) throw Error('Fresh compiler options do not match sealed main profile');
if (Object.hasOwn(options, 'types') || Object.hasOwn(options, 'typeRoots')) throw Error('Unexpected ambient type configuration');
const program = ts.createProgram(rootNames, options);
const sources = program.getSourceFiles().map(source => ({ file: source.fileName, physical: fs.realpathSync(source.fileName), sha256: hash(source.text) }));
const edges = [];
for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(root + '/') || source.fileName.includes('/node_modules/')) continue;
  for (const imported of ts.preProcessFile(source.text, true, true).importedFiles) {
    const resolved = ts.resolveModuleName(imported.fileName, source.fileName, options, ts.sys).resolvedModule;
    edges.push({ from: source.fileName, specifier: imported.fileName, to: resolved?.resolvedFileName ?? null });
  }
}
const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({
  file: diagnostic.file && path.relative(root, diagnostic.file.fileName), code: diagnostic.code,
  line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : undefined,
  message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').replaceAll(root, '<checkout>'),
  sourceAnchor: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.text.split('\n')[diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line].trim() : undefined,
}));
const targeted = [
  'tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts',
  'tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts',
  'tests/fixtures/phase-6a-v3/creator-adoption-contract.ts',
  'packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs',
  'tests/fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.ts',
  'tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts',
];
const resolvedTypeReferences = [];
for (const name of ts.getAutomaticTypeDirectiveNames(options, ts.sys)) {
  const resolved = ts.resolveTypeReferenceDirective(name, path.join(root, '__compiler_environment__.ts'), options, ts.sys).resolvedTypeReferenceDirective;
  resolvedTypeReferences.push({ name, resolved: resolved?.resolvedFileName ?? null });
}
write('program-identity-' + stage + '.json', { stage, root, rootNames, options: program.getCompilerOptions(), sources, edges, compilerVersion: ts.version, compilerPath: fs.realpathSync(path.join(root, 'node_modules/typescript/lib/typescript.js')), resolvedTypeReferences, noEmit: true, actualConfigAndAliasesLoaded: true, noTypesOrTypeRootsInjected: true, noAmbientFilesAdded: true, testExecutions: 0 });
write('typecheck-' + stage + '.json', { diagnostics, targetDiagnostics: diagnostics.filter(diagnostic => targeted.includes(diagnostic.file)), otherDiagnostics: diagnostics.filter(diagnostic => !targeted.includes(diagnostic.file)), targeted, wholeProgramPass: diagnostics.length === 0, classification: 'Fresh strict forty-root diagnostic inventory; compiler collection success is not a clean typecheck' });
console.log(JSON.stringify({ stage, roots: rootNames.length, sources: sources.length, edges: edges.length, diagnostics: diagnostics.length, targetedDiagnostics: diagnostics.filter(diagnostic => targeted.includes(diagnostic.file)).length, wholeProgramPass: diagnostics.length === 0, testsExecuted: 0 }));
