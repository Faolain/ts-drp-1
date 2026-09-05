import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import ts from '/tmp/d110c-f5b-retained-counter-MFlKNz/checkout/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/tmp/d110c-f5b-retained-counter-MFlKNz/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),files=['tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts'],checkedFiles=files;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
if(fs.existsSync(path.join(out,'matrix.json')))throw Error('Frozen matrix exists');
const commands=[];
const run=args=>{const r=spawnSync('pnpm',['exec',...args],{encoding:'utf8'});commands.push({command:['pnpm','exec',...args],status:r.status,stdout:r.stdout,stderr:r.stderr});if(r.status!==0){write('preflight-commands.json',commands);throw Error('Preflight failed')}return r.stdout;};
run(['eslint',...files]);run(['prettier','--check',...files]);
const selected=JSON.parse(run(['vitest','list',...files,'--json']));
write('list.json',selected);write('preflight-commands.json',commands);
const stopped=JSON.parse(fs.readFileSync('/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b-green-89f147cc/retained-07/result.json','utf8'));
const expected=stopped.testResults.flatMap(s=>s.assertionResults.map(r=>({file:path.basename(s.name),name:[...r.ancestorTitles,r.title].join(' > ')}))).sort((a,b)=>a.name.localeCompare(b.name));
const actual=selected.map(r=>({file:path.basename(r.file),name:r.name})).sort((a,b)=>a.name.localeCompare(b.name));
if(selected.length!==19||JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Exact retained19 names differ');
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

const matrix={frozenAt:new Date().toISOString(),base:'bc7d615b40c5125ed5b48ff90d0be64dcdca4b15',files,selected:19,expectedPassed:19,expectedFailed:0,intentionallyFiltered:0,executionCount:1,classification:'RETAINED_BASELINE_PRESERVATION_NOT_CAUSAL_RED',fileHashes:Object.fromEntries([...files,'tests/fixtures/phase-6b-d110c-0c1f5b0s/settlement-plan-contract.ts'].map(f=>[f,hash(fs.readFileSync(f))])),entries:selected.map(r=>({file:path.relative(root,r.file),name:r.name,expectedStatus:'passed',token:null}))};
write('matrix.json',matrix);
write('focused-command.json',{cwd:root,command:['pnpm','exec','vitest','run',...files,'--no-file-parallelism','--coverage.enabled=false','--reporter=json','--outputFile='+path.join(out,'focused.json')],executionCount:1});
console.log(JSON.stringify({selected:19,expectedPassed:19,expectedFailed:0,targetDiagnostics:0,externalDiagnostics:diagnostics.length,matrixSha256:hash(fs.readFileSync(path.join(out,'matrix.json')))}));
