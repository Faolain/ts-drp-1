import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import ts from '/tmp/d110c-f5b-red-room-guard-label-yqm8r2/checkout/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/tmp/d110c-f5b-red-room-guard-label-yqm8r2/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),files=['tests/phase-6a-creator-successor-product-red.test.ts'],checkedFiles=files;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
if(fs.existsSync(path.join(out,'matrix.json')))throw Error('Frozen matrix exists');
const commands=[];
const run=args=>{const r=spawnSync('pnpm',['exec',...args],{encoding:'utf8'});commands.push({command:['pnpm','exec',...args],status:r.status,stdout:r.stdout,stderr:r.stderr});if(r.status!==0){write('preflight-commands.json',commands);throw Error('Preflight failed')}return r.stdout;};
run(['eslint',...files]);run(['prettier','--check',...files]);
const selected=JSON.parse(run(['vitest','list',...files,'--json']));
write('list.json',selected);write('preflight-commands.json',commands);
const stopped=JSON.parse(fs.readFileSync('/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b-green-ab98cce6/retained-22/result.json','utf8'));
const expected=stopped.testResults.flatMap(s=>s.assertionResults.map(r=>({file:path.basename(s.name),name:[...r.ancestorTitles,r.title].join(' > ')}))).sort((a,b)=>a.name.localeCompare(b.name));
expected.push({file:path.basename(files[0]),name:'classifies complete legacy and settlement successor compositions before reading room authorities'});expected.sort((a,b)=>a.name.localeCompare(b.name));
const actual=selected.map(r=>({file:path.basename(r.file),name:r.name})).sort((a,b)=>a.name.localeCompare(b.name));
if(selected.length!==13||JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Exact original12 plus additive title differ');
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

const options={...parsed.options,paths,noEmit:true,composite:false,declaration:false,declarationMap:false,target:ts.ScriptTarget.ES2022};
const target=path.join(root,files[0]),currentText=fs.readFileSync(target,'utf8'),baselineText=execFileSync('git',['show','61a793d38a9fa1eafd9639aa41de2335f9891695:'+files[0]],{encoding:'utf8'});
function diagnostics(text){
 const host=ts.createCompilerHost(options),read=host.readFile;host.readFile=f=>path.resolve(f)===target?text:read(f);
 const program=ts.createProgram(files.map(f=>path.join(root,f)),options,host);
 return ts.getPreEmitDiagnostics(program).map(d=>{const position=d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start):undefined;return{file:d.file&&path.relative(root,d.file.fileName),code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),line:position&&position.line+1,column:position&&position.character+1,length:d.length,start:d.start,token:d.file&&d.start!==undefined?d.file.text.slice(d.start,d.start+(d.length??0)):undefined}})}
const current=diagnostics(currentText),baseline=diagnostics(baselineText),external=rows=>rows.filter(d=>d.file!==files[0]),targetRows=rows=>rows.filter(d=>d.file===files[0]),same=JSON.stringify(external(current))===JSON.stringify(external(baseline));
const data={root,compilerVersion:ts.version,options,baselineCommit:'61a793d38a9fa1eafd9639aa41de2335f9891695',currentCommit:'ba15bb894d324bb8d8a0d8a7da3f3e61042a0283',currentTestSha256:hash(currentText),baselineTestSha256:hash(baselineText),sameProgramOptions:true,onlyTargetTextReplacedInMemory:true,noFilesMutated:true,externalExactlyEqual:same,currentTargetCount:targetRows(current).length,baselineTargetCount:targetRows(baseline).length,externalCount:external(current).length,current,baseline,typecheckPassed:false,newTargetDiagnostic:targetRows(current)};
fs.writeFileSync(path.join(out,'typecheck-baseline-comparison.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});

write('typecheck.json',{targetDiagnostics:targetRows(current),externalDiagnostics:external(current),typecheckPassed:false});
if(!same||external(current).length!==41||targetRows(current).length!==0||targetRows(baseline).length!==0)throw Error('Unexpected type attribution');
console.log(JSON.stringify({externalExactlyEqual:same,externalCount:41,currentTargetCount:0,baselineTargetCount:0,noFilesMutated:true,typecheckPassed:false}));
const fixtures=JSON.parse(fs.readFileSync(path.join(out,'fixture-validation.json'),'utf8'));if(fixtures.fixtures.length!==2||!fixtures.allVerified)throw Error('Fixtures not independently verified');
const failedTitles=['rejects only unsupported cold successor compositions before reading room authorities','classifies complete legacy and settlement successor compositions before reading room authorities'];
const matrix={frozenAt:new Date().toISOString(),base:'ba15bb894d324bb8d8a0d8a7da3f3e61042a0283',files,selected:13,expectedPassed:11,expectedFailed:2,intentionallyFiltered:0,executionCount:1,classification:'CAUSAL_ROOM_AUTHORITY_READ_ORDER_RED',fileHashes:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(f))])),entries:selected.map(r=>({file:path.relative(root,r.file),name:r.name,expectedStatus:failedTitles.some(t=>r.name.endsWith(t))?'failed':'passed'})),expectedObservation:{count:8,forbidden:5,permitted:3,actualReads:{application:1,signer:0,store:0,transport:0},actualDetail:'D.108e2b application authority was read'}};
write('matrix.json',matrix);
write('focused-command.json',{cwd:root,command:['pnpm','exec','vitest','run',...files,'--no-file-parallelism','--coverage.enabled=false','--reporter=json','--outputFile='+path.join(out,'focused.json')],executionCount:1});
console.log(JSON.stringify({selected:13,expectedPassed:11,expectedFailed:2,targetDiagnostics:0,externalDiagnostics:41,typecheckPassed:false,matrixSha256:hash(fs.readFileSync(path.join(out,'matrix.json')))}));
