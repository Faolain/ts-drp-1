import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from '/tmp/d110c-f5b-retained-transport-native-uwMjHN/checkout/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/tmp/d110c-f5b-retained-transport-native-uwMjHN/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),file='tests/phase-3a1b-p3-live-transport-red.test.ts',base='18e6454593c8774c605bbba9359d4a89d50b7465',files=[file];
const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
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
const current=fs.readFileSync(file,'utf8'),baseline=execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
const patch=execFileSync('git',['diff','--unified=0',base,'HEAD','--',file],{encoding:'utf8'});
const hunks=[...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map(m=>({oldStart:Number(m[1]),oldCount:m[2]===undefined?1:Number(m[2]),newStart:Number(m[3]),newCount:m[4]===undefined?1:Number(m[4])}));
const oldLines=baseline.split('\n'),newLines=current.split('\n'),mapping={};let oi=1,ni=1;
for(const h of hunks){const oldBoundary=h.oldCount===0?h.oldStart+1:h.oldStart,newBoundary=h.newCount===0?h.newStart+1:h.newStart;while(oi<oldBoundary&&ni<newBoundary){if(oldLines[oi-1]!==newLines[ni-1])throw Error('Unchanged source mapping differs');mapping[ni++]=oi++}oi=oldBoundary+h.oldCount;ni=newBoundary+h.newCount}
while(oi<=oldLines.length&&ni<=newLines.length){if(oldLines[oi-1]!==newLines[ni-1])throw Error('Tail mapping differs');mapping[ni++]=oi++}
function diagnose(text){const host=ts.createCompilerHost(options),readFile=host.readFile.bind(host);host.readFile=name=>path.resolve(name)===path.resolve(file)?text:readFile(name);const program=ts.createProgram(files.map(f=>path.join(root,f)),options,host);return ts.getPreEmitDiagnostics(program).map(d=>{const rel=d.file&&path.relative(root,d.file.fileName),position=d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start):undefined;let owner;function find(n){if(d.start!==undefined&&n.pos<=d.start&&n.end>d.start){if(ts.isFunctionDeclaration(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n))owner=n;ts.forEachChild(n,find)}}if(d.file)find(d.file);return {file:rel,code:d.code,line:position&&position.line+1,character:position&&position.character+1,start:d.start,length:d.length,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),owner:owner&&{kind:ts.SyntaxKind[owner.kind],name:owner.name?.getText(d.file),startLine:d.file.getLineAndCharacterOfPosition(owner.getStart(d.file)).line+1},sourceLine:position&&d.file.text.split('\n')[position.line]}})}
const now=diagnose(current),prior=diagnose(baseline);
write('typecheck-current-full.json',now);write('typecheck-baseline-full.json',prior);
const original=JSON.parse(fs.readFileSync(path.join(out,'typecheck.json'))),compact=d=>({file:d.file,code:d.code,line:d.line,message:d.message});
if(JSON.stringify(now.map(compact))!==JSON.stringify([...original.targetDiagnostics,...original.externalDiagnostics]))throw Error('Same current program differs from preflight');
const changedLineDiagnostics=now.filter(d=>d.file===file&&mapping[d.line]===undefined);
const mapped=now.map(d=>({...compact(d),line:d.file===file?mapping[d.line]:d.line}));
const equal=JSON.stringify(mapped)===JSON.stringify(prior.map(compact));
const helperOverlap=now.filter(d=>d.owner?.name==='fakeIssuanceStore');
const data={base,currentHead:'a430272a0e8dd361c9139e66c140870d4ece7e1f',sameCompilerProgramOptions:true,onlyBaselineFileSuppliedInMemory:file,currentSha256:hash(current),baselineSha256:hash(baseline),options,hunks,diagnosticMapping:now.map(d=>({current:compact(d),baselineLine:d.file===file?mapping[d.line]:d.line,unchangedSourceLine:d.file!==file||mapping[d.line]!==undefined,sourceLine:d.sourceLine,owner:d.owner})),equal,changedLineDiagnostics,authorizedHelperOverlap:helperOverlap,targetDiagnostics:now.filter(d=>d.file===file).length,externalDiagnostics:now.filter(d=>d.file!==file).length,classification:equal&&changedLineDiagnostics.length===0?'BASELINE_IDENTICAL_WITH_AUTHORIZED_HELPER_OVERLAP_REQUIRES_ROOT_DISPOSITION':'STOP_NONIDENTICAL',notTypecheckPass:true,noRuntimeExecuted:true};
write('typecheck-baseline-comparison.json',data);
if(!equal||changedLineDiagnostics.length)throw Error('Type diagnostics not inherited exact');
console.log(JSON.stringify({classification:data.classification,equal,targetDiagnostics:data.targetDiagnostics,externalDiagnostics:data.externalDiagnostics,changedLineDiagnostics:changedLineDiagnostics.length,authorizedHelperOverlap:helperOverlap.map(d=>({code:d.code,line:d.line,baselineLine:mapping[d.line],owner:d.owner}))}));
