import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const out = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const {loadConfigFromFile} = await import(pathToFileURL(require.resolve('vite')).href);
const files = ['tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts'];
const checkedFiles = [...files, 'tests/fixtures/phase-6b-d110c-0c1f5b0z/native-registry-child.mjs'];
const fixture = 'tests/fixtures/phase-6b-d110c-0c1f5b0z/source-custody.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
if (fs.existsSync(path.join(out, 'matrix.json'))) throw Error('Frozen matrix exists; do not overwrite');
const commands = [];
function run(command, args, required = true) {
  const result = spawnSync(command, args, {cwd:root, encoding:'utf8',maxBuffer:32*1024*1024});
  commands.push({ command:[command,...args], status:result.status, stdout:result.stdout, stderr:result.stderr });
  write('preflight-commands.json',commands);
  if(required && result.status !== 0) throw Error('Preflight failed: '+args.join(' '));
  return result.stdout;
}
run('pnpm',['exec','eslint',...checkedFiles]);
run('pnpm',['exec','prettier','--check',...checkedFiles,fixture]);
run('node',['--check',checkedFiles[1]]);
run('git',['diff','--check']);
for(const pkg of ['@ts-drp/storage','@ts-drp/storage-browser','@ts-drp/storage-node']) run('pnpm',['--filter',pkg,'typecheck'],false);
const selected = JSON.parse(run('pnpm',['exec','vitest','list',...files,'--coverage.enabled=false','--json']));
write('list.json',selected);
if(selected.length !== 16) throw Error('Expected exactly 16 collected tests');
const read = ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
if(read.error) throw Error(ts.flattenDiagnosticMessageText(read.error.messageText,'\n'));
const parsed = ts.parseJsonConfigFileContent(read.config,ts.sys,root);
const paths = {...parsed.options.paths};
function typeEntry(value) {
 if(typeof value === 'string') return value;
 if(!value || typeof value !== 'object') return undefined;
 if(typeof value.types === 'string') return value.types;
 return typeEntry(value.import) ?? typeEntry(value.default);
}
for(const group of ['packages','examples']) for(const dir of fs.readdirSync(path.join(root,group),{withFileTypes:true})) {
 if(!dir.isDirectory()) continue;
 const file=path.join(root,group,dir.name,'package.json');
 if(!fs.existsSync(file)) continue;
 const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!pkg.name) continue;
 if(pkg.types) paths[pkg.name]=[path.resolve(path.dirname(file),pkg.types)];
 for(const [key,value] of Object.entries(pkg.exports??{})) {
  const entry=typeEntry(value);
  if(key.startsWith('.')&&entry) paths[pkg.name+(key==='.'?'':key.slice(1))]=[path.resolve(path.dirname(file),entry)];
 }
}
const loaded=await loadConfigFromFile({command:'serve',mode:'test'},path.join(root,'vite.config.mts'));
if(!loaded) throw Error('Vite aliases unavailable');
for(const [key,value] of Object.entries(loaded.config.resolve.alias)) paths[key]=[value];
const program=ts.createProgram(checkedFiles.map(file=>path.join(root,file)),{
 ...parsed.options,paths,noEmit:true,composite:false,declaration:false,declarationMap:false,target:ts.ScriptTarget.ES2022,
});
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file&&path.relative(root,d.file.fileName),code:d.code,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:undefined,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
const targetDiagnostics=diagnostics.filter(d=>checkedFiles.includes(d.file));
write('typecheck.json',{targetDiagnostics,externalDiagnostics:diagnostics.filter(d=>!targetDiagnostics.includes(d))});
if(targetDiagnostics.length) throw Error('Target type diagnostics');
const custody=JSON.parse(fs.readFileSync(path.join(root,fixture),'utf8'));
for(const [file,expected] of Object.entries(custody.whole)) if(hash(fs.readFileSync(path.join(root,file)))!==expected) throw Error('Whole source custody differs: '+file);
for(const [filename,spans] of Object.entries(custody.spans)) {
 const file=ts.createSourceFile(filename,fs.readFileSync(path.join(root,filename),'utf8'),ts.ScriptTarget.Latest,true);
 for(const span of spans) {
  const matches=file.statements.filter(n=>(n.name?.text??(ts.isVariableStatement(n)?n.declarationList.declarations[0].name.getText(file):undefined))===span.name);
  if(matches.length!==1 || hash(matches[0].getText(file))!==span.sha256) throw Error('Span source custody differs: '+filename+':'+span.name);
 }
}
const test=fs.readFileSync(path.join(root,files[0]),'utf8');
if(/it\.(skip|only|each)|describe\.(skip|only)|testTimeout|vi\.mock/u.test(test)) throw Error('Unexpected selection, timeout, or mock');
const entries=selected.map((row,index)=>{
 const name=row.name.replaceAll(' > ',' ');
 const number=Number(name.match(/ (\d\d) /u)?.[1]);
 if(number!==index+1) throw Error('Frozen roster order differs: '+name);
 const token=number<=14?(number>=7&&number<=9?'F5B0Z_INCOMPATIBLE_REGISTRY_REFUSAL_REQUIRED':'F5B0Z_NEUTRAL_MAINTENANCE_DISCOVERY_REQUIRED'):null;
 return {file:path.relative(root,row.file),name,expectedStatus:token?'failed':'passed',token};
});
const command=['pnpm','exec','vitest','run',...files,'--coverage.enabled=false','--reporter=json','--outputFile='+path.join(out,'focused.json')];
write('matrix.json',{frozenAt:new Date().toISOString(),base:'5c44a7dc18ac1db1518034bcc3fa0b276baa4ec7',files,fileHashes:Object.fromEntries([...checkedFiles,fixture].map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])),command,selected:16,expectedFailed:14,expectedPassed:2,intentionallyFiltered:0,allowedTopLevelErrors:0,allowedTimeouts:0,allowedAdditionalFailures:0,executionCount:1,entries,budgets:'Existing 10000ms test timeout and all coverage configuration/thresholds unchanged. Child transport bounded to 8000ms/1MiB. No campaigns or product epochs.'});
write('source-audit.json',{wholeCustodyCount:Object.keys(custody.whole).length,statementCustodyCount:Object.values(custody.spans).reduce((n,rows)=>n+rows.length,0),sourceChecksPassed:true,sourceNamespaceImport:'../packages/storage/src/maintenance.js',nativeChild:'source-built native ESM only',runtimeTestsExecuted:0,sourceOnlyCollection:true});
console.log(JSON.stringify({selected:16,failed:14,passed:2,targetDiagnostics:0,inheritedDiagnostics:diagnostics.length,matrixSha256:hash(fs.readFileSync(path.join(out,'matrix.json')))}));
