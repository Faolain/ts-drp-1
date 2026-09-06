import fs from 'node:fs';
import path from 'node:path';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite/dist/node/index.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const files=['tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts'];
const custody=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json')));
const checkedFiles=[...Object.keys(custody.ownerHashes),...Object.keys(custody.testHashes)];
const write=(file,value)=>fs.writeFileSync(path.join(out,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
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

const prior=JSON.parse(fs.readFileSync(path.join(root,'.logs/d110c-0c1f5b-red-checkpoint-link-f83764c5/typecheck.json')));
const external=diagnostics.filter(d=>!targetDiagnostics.includes(d));
const same=JSON.stringify(external)===JSON.stringify(prior.externalDiagnostics);
write('typecheck-baseline-comparison.json',{same,targetCount:targetDiagnostics.length,externalCount:external.length,expectedExternal:prior.externalDiagnostics,actualExternal:external,scope:'Source-mapped selected-test program plus imported production owners; NOT package-wide typecheck pass'});
console.log(JSON.stringify({same,targetCount:targetDiagnostics.length,externalCount:external.length}));
process.exitCode=same&&targetDiagnostics.length===0?0:1;

