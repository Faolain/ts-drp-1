import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite/dist/node/index.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const files=['tests/phase-6b-d110c-0c1f5b-snapshot-fixture-contract-red.test.ts','tests/phase-6b-d110c-0c1f5b-integration-red.test.ts','tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts'];
const custody=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json')));
const checkedFiles=['tests/fixtures/phase-4b-v3/live-snapshot.ts',...Object.keys(custody.ownerHashes),...Object.keys(custody.testHashes)];
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
const allSources=program.getSourceFiles().map(s=>({file:s.fileName,physical:fs.realpathSync(s.fileName),sha256:crypto.createHash('sha256').update(s.text).digest('hex')}));
write('program-identity.json',{root,files,rootNames:program.getRootFileNames(),options:program.getCompilerOptions(),sources:allSources,compilerVersion:ts.version,programExecutions:1});
write('typecheck-disposition.json',{diagnosticCount:diagnostics.length,targetCount:targetDiagnostics.length,externalCount:diagnostics.length-targetDiagnostics.length,productionDiagnostics:diagnostics.filter(d=>Object.hasOwn(custody.ownerHashes,d.file)),checkedFiles,scope:'Existing selected-two-test source-mapped program and imported closure only; does not cover grid unless it is actually imported',prior41ComparatorNotUsed:true,wholeProgramPass:diagnostics.length===0});
console.log(JSON.stringify({diagnosticCount:diagnostics.length,targetCount:targetDiagnostics.length,externalCount:diagnostics.length-targetDiagnostics.length,sourceInputs:allSources.length}));process.exitCode=diagnostics.length?1:0;
