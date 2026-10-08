import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import ts from '/tmp/d110c-f5b-retained-finality-RkJzXV/checkout/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/tmp/d110c-f5b-retained-finality-RkJzXV/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),files=['tests/phase-5a-c-seal-safety-red.test.ts','tests/phase-5e-creator-actor-red.test.ts'],checkedFiles=[...files,...["tests/fixtures/phase-5-v3/seal-types.ts","tests/fixtures/phase-5e-v3/creator-actor-contract.ts"]];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
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
const options = {
  ...parsed.options, paths, noEmit: true, composite: false, declaration: false, declarationMap: false, target: ts.ScriptTarget.ES2022,
};
const host=ts.createCompilerHost(options),originalRead=host.readFile,base='15c66947ea8ece4eb5bf0a9bc0e7632e749b209c';
const substitutions=new Map(["tests/fixtures/phase-5-v3/seal-types.ts","tests/fixtures/phase-5e-v3/creator-actor-contract.ts","tests/phase-5e-creator-actor-red.test.ts"].map(f=>[path.join(root,f),execFileSync('git',['show',base+':'+f],{encoding:'utf8'})]));
host.readFile=file=>substitutions.get(file)??originalRead(file);
const program=ts.createProgram(files.map(file=>path.join(root,file)),options,host);
const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
  file: d.file && path.relative(root, d.file.fileName), code: d.code,
  line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
  message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
}));
const targetDiagnostics = diagnostics.filter(d => checkedFiles.includes(d.file));
const current=JSON.parse(fs.readFileSync(path.join(out,'typecheck.json'),'utf8'));
const baseline={targetDiagnostics,externalDiagnostics:diagnostics.filter(d=>!targetDiagnostics.includes(d))};
const identical=JSON.stringify(current)===JSON.stringify(baseline);
const sourceFiles=['tests/phase-5a-c-seal-safety-red.test.ts','tests/fixtures/phase-3b-v3/certified-genesis-contract.ts','packages/protocol-v3/src/index.ts'];
const sourceAttribution=sourceFiles.map(file=>{const bytes=fs.readFileSync(path.join(root,file)),signed=execFileSync('git',['show',base+':'+file]);if(!bytes.equals(signed))throw Error('Diagnostic source changed');return {file,sha256:hash(bytes),byteIdenticalToSignedBase:true};});
write('typecheck-inherited-attribution.json',{base,current,baseline,identical,sourceAttribution,virtualBaselineMethod:'CompilerHost substitutes only original three list-owner files from signed baseline; no source writes or runtime execution.',editedFileDiagnostics:diagnostics.filter(d=>["tests/fixtures/phase-5-v3/seal-types.ts","tests/fixtures/phase-5e-v3/creator-actor-contract.ts","tests/phase-5e-creator-actor-red.test.ts"].includes(d.file))});
if(!identical)throw Error('New diagnostics');
console.log(JSON.stringify({identical,targetDiagnostics:targetDiagnostics.length,editedFileDiagnostics:0,externalDiagnostics:baseline.externalDiagnostics.length}));
