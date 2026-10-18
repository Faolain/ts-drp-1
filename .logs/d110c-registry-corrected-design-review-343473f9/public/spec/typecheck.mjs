// Bounded selected-root compiler collector. Execution requires released stage custody.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { plan } from './gate-plan.mjs';

const [stage, requestedRoot, requestedOutput, baselineFile, ...extra] = process.argv.slice(2);
assert.ok(['baseline', 'green', 'isolated'].includes(stage), 'stage: baseline, green or isolated');
assert.equal(extra.length, 0, 'unexpected arguments');
assert.ok(path.isAbsolute(requestedRoot ?? '') && path.isAbsolute(requestedOutput ?? ''), 'absolute root and output required');
assert.equal(stage === 'baseline', baselineFile === undefined, 'green/isolation require explicit baseline report');
if (baselineFile) assert.ok(path.isAbsolute(baselineFile), 'absolute baseline report required');
const root = fs.realpathSync(requestedRoot);
assert.equal(fs.realpathSync(process.cwd()), root, 'cwd must equal selected root');
const output = fs.realpathSync(requestedOutput);
assert.notEqual(output, root, 'output must be a dedicated evidence directory');
const target = path.join(output, `typecheck-${stage}.json`);
assert.equal(fs.existsSync(target), false, 'refuse to overwrite evidence');
const files = plan.strictCompiler.roots;
for (const file of files) assert.ok(fs.statSync(path.join(root, file)).isFile(), `missing selected root: ${file}`);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(root, '<checkout>'));
const baseline = baselineFile ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : undefined;
if (baseline) {
  assert.equal(baseline.stage, 'baseline');
  assert.deepEqual(baseline.selectedRoots, files);
}

const compilerPath = fs.realpathSync(path.join(root, 'node_modules/typescript/lib/typescript.js'));
const ts = (await import(pathToFileURL(compilerPath).href)).default;
const { loadConfigFromFile } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
const configFile = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configFile, ts.sys.readFile);
assert.equal(config.error, undefined, 'tsconfig must parse');
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
assert.equal(parsed.errors.length, 0, 'tsconfig options must parse');
const paths = { ...parsed.options.paths };
const configurationInputs = [configFile];
function typeEntry(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.types === 'string') return value.types;
  return typeEntry(value.import) ?? typeEntry(value.default);
}
for (const group of ['packages', 'examples']) {
  for (const directory of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const file = path.join(root, group, directory.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    configurationInputs.push(file);
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
assert.ok(loaded, 'actual Vite config required');
assert.ok(loaded.config.resolve?.alias && !Array.isArray(loaded.config.resolve.alias), 'reviewed object alias representation required');
for (const [key, value] of Object.entries(loaded.config.resolve.alias)) {
  assert.equal(typeof value, 'string');
  paths[key] = [value];
}
configurationInputs.push(...loaded.dependencies);
const options = { ...parsed.options, paths, noEmit: true, composite: false, declaration: false, declarationMap: false, target: ts.ScriptTarget.ES2022, incremental: false };
assert.equal(options.strict, true);
assert.equal(Object.hasOwn(options, 'types') || Object.hasOwn(options, 'typeRoots'), false, 'no ambient type overrides');
const program = ts.createProgram(files.map(file => path.join(root, file)), options);
const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => {
  const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
  return {
    file: diagnostic.file ? path.relative(root, diagnostic.file.fileName) : null,
    category: diagnostic.category, code: diagnostic.code,
    line: position ? position.line + 1 : null,
    column: position ? position.character + 1 : null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').replaceAll(root, '<checkout>'),
    sourceAnchor: position ? diagnostic.file.text.split('\n')[position.line].trim() : null,
  };
});
const sources = program.getSourceFiles().map(source => ({ file: source.fileName, physical: fs.realpathSync(source.fileName), sha256: sha(source.text) }));
const escapedProjectSources = sources.filter(source => !source.file.includes('/node_modules/') && !source.physical.startsWith(root + '/'));
const edges = [];
for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(root + '/') || source.fileName.includes('/node_modules/')) continue;
  for (const imported of ts.preProcessFile(source.text, true, true).importedFiles) {
    const resolved = ts.resolveModuleName(imported.fileName, source.fileName, options, ts.sys).resolvedModule;
    edges.push({ from: source.fileName, specifier: imported.fileName, to: resolved?.resolvedFileName ?? null });
  }
}
const resolvedTypeReferences = ts.getAutomaticTypeDirectiveNames(options, ts.sys).map(name => ({ name, resolved: ts.resolveTypeReferenceDirective(name, path.join(root, '__compiler_environment__.ts'), options, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName ?? null }));
const diagnosticIdentities = items => items.map(({ line, column, ...identity }) => JSON.stringify(identity)).sort();
const optionsEquivalent = !baseline || JSON.stringify(normalize(options)) === JSON.stringify(baseline.normalizedOptions);
const diagnosticsEquivalent = !baseline || JSON.stringify(diagnosticIdentities(diagnostics)) === JSON.stringify(diagnosticIdentities(baseline.diagnostics));
const compilerEquivalent = !baseline || (baseline.compilerVersion === ts.version && baseline.compilerSha256 === sha(fs.readFileSync(compilerPath)));
const selectedDiagnostics = diagnostics.filter(item => files.includes(item.file));
const report = {
  stage, root, selectedRoots: files, rootNames: program.getRootFileNames(),
  normalizedOptions: normalize(options), compilerVersion: ts.version, compilerPath,
  compilerSha256: sha(fs.readFileSync(compilerPath)),
  configurationInputs: [...new Set(configurationInputs)].map(file => ({ file, sha256: sha(fs.readFileSync(file)) })),
  sources, edges, resolvedTypeReferences, escapedProjectSources, diagnostics, selectedDiagnostics,
  optionsEquivalent, diagnosticsEquivalent, compilerEquivalent,
  wholeProgramPass: diagnostics.length === 0, testExecutions: 0,
  classification: diagnostics.length ? 'non-clean strict compiler diagnostic inventory' : 'clean selected-root strict program',
};
fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const accepted = selectedDiagnostics.length === 0 && escapedProjectSources.length === 0 && optionsEquivalent && diagnosticsEquivalent && compilerEquivalent;
process.stdout.write(JSON.stringify({ stage, roots: files.length, diagnostics: diagnostics.length, selectedDiagnostics: selectedDiagnostics.length, accepted, wholeProgramPass: report.wholeProgramPass, report: target }) + '\n');
process.exitCode = accepted ? 0 : 1;
