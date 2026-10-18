import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import { loadConfigFromFile } from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite/dist/node/index.js';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const stage = process.argv[2];
if (!['before', 'after', 'final', 'final2'].includes(stage)) throw Error('stage');
const custody = JSON.parse(fs.readFileSync(path.join(out, 'custody-before.json')));
const selected = JSON.parse(fs.readFileSync(path.join(out, 'selected-files.json')));
const files = [...new Set([...custody.targets.filter(file => file.endsWith('.ts')), ...selected])];
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
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
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.name) continue;
  if (pkg.types) paths[pkg.name] = [path.resolve(path.dirname(file), pkg.types)];
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeEntry(value);
    if (key.startsWith('.') && entry) paths[pkg.name + (key === '.' ? '' : key.slice(1))] = [path.resolve(path.dirname(file), entry)];
  }
}
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vite.config.mts'));
if (!loaded) throw Error('Vite aliases unavailable');
for (const [key, value] of Object.entries(loaded.config.resolve.alias)) paths[key] = [value];
const options = { ...parsed.options, paths, noEmit: true, composite: false, declaration: false, declarationMap: false, target: ts.ScriptTarget.ES2022 };
const host = ts.createCompilerHost(options);
const ordinaryRead = host.readFile.bind(host);
if (stage === 'before') host.readFile = file => {
  const relative = path.relative(root, file);
  return custody.targets.includes(relative) ? fs.readFileSync(path.join(out, 'before', relative), 'utf8') : ordinaryRead(file);
};
const program = ts.createProgram(files.map(file => path.join(root, file)), options, host);
const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({
  file: diagnostic.file && path.relative(root, diagnostic.file.fileName),
  code: diagnostic.code,
  line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : undefined,
  message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
}));
const targetDiagnostics = diagnostics.filter(diagnostic => files.includes(diagnostic.file));
const externalDiagnostics = diagnostics.filter(diagnostic => !files.includes(diagnostic.file));
const sources = program.getSourceFiles().map(source => ({ file: source.fileName, physical: fs.realpathSync(source.fileName), sha256: crypto.createHash('sha256').update(source.text).digest('hex') }));
write('typecheck-' + stage + '.json', { targetDiagnostics, externalDiagnostics });
write('program-identity-' + stage + '.json', { files, rootNames: program.getRootFileNames(), options: program.getCompilerOptions(), sources, compilerVersion: ts.version, noEmit: true, testExecutions: 0, baselineUsesFrozenSourceSnapshots: stage === 'before' });
let externalBaselineEquivalent;
if (stage !== 'before') {
  const before = JSON.parse(fs.readFileSync(path.join(out, 'typecheck-before.json')));
  externalBaselineEquivalent = JSON.stringify(before.externalDiagnostics) === JSON.stringify(externalDiagnostics);
}
console.log(JSON.stringify({ stage, roots: files.length, targetDiagnostics, externalCount: externalDiagnostics.length, externalBaselineEquivalent, sourceInputs: sources.length, wholeProgramPass: diagnostics.length === 0 }));
process.exitCode = targetDiagnostics.length || externalBaselineEquivalent === false ? 1 : 0;
