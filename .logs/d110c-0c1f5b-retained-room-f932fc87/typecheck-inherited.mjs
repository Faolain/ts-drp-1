import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import ts from '/tmp/d110c-f5b-retained-room-hsBT3J/checkout/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/tmp/d110c-f5b-retained-room-hsBT3J/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),files=['tests/phase-3g-v3-room-rebase-red.test.ts'],checkedFiles=files;
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
const host=ts.createCompilerHost(options),originalRead=host.readFile,base='29e26b3f93e215f66201bfd5a71e7b2f334c164d';
const baseText=execFileSync('git',['show',base+':'+files[0]],{encoding:'utf8'}),currentText=fs.readFileSync(files[0],'utf8');
host.readFile=file=>file===path.join(root,files[0])?baseText:originalRead(file);
const program=ts.createProgram(files.map(file=>path.join(root,file)),options,host);
const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
  file: d.file && path.relative(root, d.file.fileName), code: d.code,
  line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
  message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
}));
const targetDiagnostics = diagnostics.filter(d => checkedFiles.includes(d.file));
const current=JSON.parse(fs.readFileSync(path.join(out,'typecheck.json'),'utf8'));
const baseline={targetDiagnostics,externalDiagnostics:diagnostics.filter(d=>!targetDiagnostics.includes(d))};
const custody=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json'),'utf8'));
const lineAt=(text,offset)=>text.slice(0,offset).split('\n').length;
const mappings=custody.spans.map((span,index)=>{const prior=custody.priorSpans[index];return {currentStartLine:lineAt(currentText,span.start),currentEndLine:lineAt(currentText,span.end),baselineStartLine:lineAt(baseText,prior.start),baselineEndLine:lineAt(baseText,prior.end),delta:span.text.split('\n').length-prior.text.split('\n').length};});
const editedSpanDiagnostics=current.targetDiagnostics.filter(d=>mappings.some(m=>d.line>=m.currentStartLine&&d.line<=m.currentEndLine));
const mappedCurrent={targetDiagnostics:current.targetDiagnostics.map(d=>({...d,line:d.line-mappings.filter(m=>d.line>m.currentEndLine).reduce((sum,m)=>sum+m.delta,0)})),externalDiagnostics:current.externalDiagnostics};
const locationEvidence=current.targetDiagnostics.map((d,i)=>{const mapped=mappedCurrent.targetDiagnostics[i],oldLine=baseText.split('\n')[mapped.line-1],newLine=currentText.split('\n')[d.line-1];if(oldLine!==newLine)throw Error('Mapped diagnostic source bytes differ');return {currentLine:d.line,baselineLine:mapped.line,sourceLine:newLine,byteIdentical:true};});
const grid='examples/grid/src/v3-zone.ts',gridBytes=fs.readFileSync(grid),gridSigned=execFileSync('git',['show',base+':'+grid]);
if(!gridBytes.equals(gridSigned))throw Error('External source drift');
const identical=JSON.stringify(mappedCurrent)===JSON.stringify(baseline);
write('typecheck-inherited-attribution.json',{base,current,baseline,mappedCurrent,identical,editedSpanDiagnostics,mappings,locationEvidence,externalSource:{file:grid,sha256:hash(gridBytes),byteIdenticalToSignedBase:true},method:'Same compiler program/options, only test file supplied in memory from signed pre-correction tree; exact three-span newline mapping; no source writes or runtime.'});
if(!identical||editedSpanDiagnostics.length||targetDiagnostics.length!==3||baseline.externalDiagnostics.length!==1)throw Error('Novel diagnostics or mapping mismatch');
console.log(JSON.stringify({identical,unchangedBodyDiagnostics:3,externalDiagnostics:1,editedSpanDiagnostics:0}));
