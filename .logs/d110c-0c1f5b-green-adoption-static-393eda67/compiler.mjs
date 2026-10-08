import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite/dist/node/index.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),files=['tests/phase-6a-creator-successor-product-red.test.ts'],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),write=(n,d)=>fs.writeFileSync(path.join(out,n),JSON.stringify(d,null,2)+'\n',{flag:'wx'});
if(fs.existsSync(path.join(out,'compiler-start.json')))throw Error('Single compiler execution already consumed');
const acceptedPath=path.join(root,'.logs/d110c-0c1f5b-green-room-guard-db8a8615/typecheck-final.json'),accepted=JSON.parse(fs.readFileSync(acceptedPath,'utf8'));
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


if(JSON.stringify(options)!==JSON.stringify(accepted.options)||ts.version!==accepted.compilerVersion)throw Error('Effective accepted options/compiler identity differs before program execution');
const host=ts.createCompilerHost(options),originalRead=host.readFile,readInputs=new Map();
host.readFile=file=>{const text=originalRead(file);if(text!==undefined)readInputs.set(path.resolve(file),{file:path.resolve(file),physical:fs.realpathSync(file),bytes:Buffer.byteLength(text),sha256:hash(text)});return text};
write('compiler-start.json',{startedAt:new Date().toISOString(),pid:process.pid,root,files,compilerVersion:ts.version,nodeVersion:process.version,nodeExecutable:process.execPath,programExecutions:1,effectiveOptionsExactlyAccepted:true,acceptedDiagnosticFile:acceptedPath,acceptedSha256:hash(fs.readFileSync(acceptedPath))});
const program=ts.createProgram(files.map(f=>path.join(root,f)),options,host);
const raw=ts.getPreEmitDiagnostics(program);
const diagnostics=raw.map(d=>{const position=d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start):undefined;return{file:d.file&&path.relative(root,d.file.fileName),code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),line:position&&position.line+1,column:position&&position.character+1,length:d.length,start:d.start,token:d.file&&d.start!==undefined?d.file.text.slice(d.start,d.start+(d.length??0)):undefined}});
const sources=program.getSourceFiles().map(s=>({file:s.fileName,physical:fs.realpathSync(s.fileName),bytes:Buffer.byteLength(s.text),sha256:hash(s.text),onDiskSha256:hash(fs.readFileSync(s.fileName)),declarationFile:s.isDeclarationFile})).sort((a,b)=>a.file.localeCompare(b.file));
const modules=[],types=[];program.forEachResolvedModule((resolution,name,mode,file)=>modules.push({containingFile:file,specifier:name,mode,resolvedModule:resolution.resolvedModule??null}));program.forEachResolvedTypeReferenceDirective((resolution,name,mode,file)=>types.push({containingFile:file,specifier:name,mode,resolvedTypeReferenceDirective:resolution.resolvedTypeReferenceDirective??null}));
const configFiles=['tsconfig.json','vite.config.mts','pnpm-lock.yaml','package.json'];for(const group of ['packages','examples'])for(const dir of fs.readdirSync(path.join(root,group),{withFileTypes:true})){const f=path.join(group,dir.name,'package.json');if(dir.isDirectory()&&fs.existsSync(path.join(root,f)))configFiles.push(f)}
const identities=Object.fromEntries(configFiles.map(f=>[f,hash(fs.readFileSync(path.join(root,f)))])),compilerFiles=['node_modules/typescript/lib/typescript.js','node_modules/typescript/package.json','node_modules/vite/package.json','node_modules/vite/dist/node/index.js'].map(f=>({file:path.join(root,f),physical:fs.realpathSync(path.join(root,f)),sha256:hash(fs.readFileSync(path.join(root,f)))}));
write('program-identity.json',{root,rootNames:program.getRootFileNames(),options,compilerVersion:ts.version,compilerFiles,configurationInputHashes:identities,sources,readInputs:[...readInputs.values()].sort((a,b)=>a.file.localeCompare(b.file)),resolvedModules:modules,resolvedTypeReferences:types,noSourceReplacement:true,noEmit:true,programExecutions:1,finishedAt:new Date().toISOString()});
write('diagnostics.json',{root,files,options,compilerVersion:ts.version,diagnostics,diagnosticCount:diagnostics.length,programExecutions:1,typecheckPassed:diagnostics.length===0});
process.stderr.write(ts.formatDiagnostics(raw,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
console.log(JSON.stringify({programExecutions:1,diagnosticCount:diagnostics.length,typecheckPassed:diagnostics.length===0,sourceInputs:sources.length,readInputs:readInputs.size,moduleResolutions:modules.length,typeResolutions:types.length}));
process.exitCode=diagnostics.length?1:0;
