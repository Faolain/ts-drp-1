import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from '/tmp/d110c-f5b-red-room-guard-ueW92K/checkout/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/tmp/d110c-f5b-red-room-guard-ueW92K/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),files=['tests/phase-6a-creator-successor-product-red.test.ts'],hash=b=>crypto.createHash('sha256').update(b).digest('hex');
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
const data={root,compilerVersion:ts.version,options,baselineCommit:'61a793d38a9fa1eafd9639aa41de2335f9891695',currentCommit:'da874b52ab99e7143911f1ce8c018c29f826db3c',currentTestSha256:hash(currentText),baselineTestSha256:hash(baselineText),sameProgramOptions:true,onlyTargetTextReplacedInMemory:true,noFilesMutated:true,externalExactlyEqual:same,currentTargetCount:targetRows(current).length,baselineTargetCount:targetRows(baseline).length,externalCount:external(current).length,current,baseline,typecheckPassed:false,newTargetDiagnostic:targetRows(current)};
fs.writeFileSync(path.join(out,'typecheck-baseline-comparison.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
if(!same||external(current).length!==41||targetRows(current).length!==1||targetRows(baseline).length!==0||targetRows(current)[0].code!==2345||targetRows(current)[0].token!=='"guard"')throw Error('Unexpected attribution');
console.log(JSON.stringify({externalExactlyEqual:same,externalCount:41,currentTargetCount:1,baselineTargetCount:0,newToken:targetRows(current)[0].token,noFilesMutated:true}));
