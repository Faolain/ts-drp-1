import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
const require=createRequire(path.join(root,'package.json'));
const ts=require('typescript');
const {loadConfigFromFile}=await import(pathToFileURL(require.resolve('vite')).href);
const checkedFiles=['tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts','tests/fixtures/phase-6b-d110c-0c1f5b0z/native-registry-child.mjs'];
const owners=['packages/storage/src/maintenance.ts','packages/storage-browser/src/internal/ahe-reclamation.ts','packages/storage-node/src/internal/ahe-reclamation.ts'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
if(read.error)throw Error(ts.flattenDiagnosticMessageText(read.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,root),paths={...parsed.options.paths};
function typeEntry(value){
 if(typeof value==='string')return value;
 if(!value||typeof value!=='object')return undefined;
 if(typeof value.types==='string')return value.types;
 return typeEntry(value.import)??typeEntry(value.default);
}
for(const group of ['packages','examples'])for(const dir of fs.readdirSync(path.join(root,group),{withFileTypes:true})){
 if(!dir.isDirectory())continue;
 const file=path.join(root,group,dir.name,'package.json');
 if(!fs.existsSync(file))continue;
 const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!pkg.name)continue;
 if(pkg.types)paths[pkg.name]=[path.resolve(path.dirname(file),pkg.types)];
 for(const [key,value]of Object.entries(pkg.exports??{})){
  const entry=typeEntry(value);
  if(key.startsWith('.')&&entry)paths[pkg.name+(key==='.'?'':key.slice(1))]=[path.resolve(path.dirname(file),entry)];
 }
}
const loaded=await loadConfigFromFile({command:'serve',mode:'test'},path.join(root,'vite.config.mts'));
if(!loaded)throw Error('Vite aliases unavailable');
for(const [key,value]of Object.entries(loaded.config.resolve.alias))paths[key]=[value];
const program=ts.createProgram(checkedFiles.map(file=>path.join(root,file)),{
 ...parsed.options,paths,noEmit:true,composite:false,declaration:false,declarationMap:false,target:ts.ScriptTarget.ES2022,
});
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file&&path.relative(root,d.file.fileName),code:d.code,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:undefined,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
const targetDiagnostics=diagnostics.filter(d=>[...checkedFiles,...owners].includes(d.file));
fs.writeFileSync(path.join(out,`typecheck-${stage}.json`),JSON.stringify({targetDiagnostics,externalDiagnostics:diagnostics.filter(d=>!targetDiagnostics.includes(d))},null,2)+'\n',{flag:'wx'});
if(targetDiagnostics.length)throw Error('New target diagnostics');
const custody=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/phase-6b-d110c-0c1f5b0z/source-custody.json'),'utf8'));
for(const [file,expected]of Object.entries(custody.whole))if(hash(fs.readFileSync(path.join(root,file)))!==expected)throw Error('Whole custody drift: '+file);
for(const [filename,spans]of Object.entries(custody.spans)){
 const file=ts.createSourceFile(filename,fs.readFileSync(path.join(root,filename),'utf8'),ts.ScriptTarget.Latest,true);
 for(const span of spans){
  const matches=file.statements.filter(n=>(n.name?.text??(ts.isVariableStatement(n)?n.declarationList.declarations[0].name.getText(file):undefined))===span.name);
  if(matches.length!==1||hash(matches[0].getText(file))!==span.sha256)throw Error('Span custody drift: '+filename+':'+span.name);
 }
}
const browser=fs.readFileSync(path.join(root,owners[1]),'utf8');
const capture=browser.indexOf('captureAheReclamationInput(input)'),dispatch=browser.indexOf('runInternalPrimaryDispatch',capture),classify=browser.indexOf('classifyAheReclamation',dispatch);
if(!(capture>browser.indexOf('class BrowserAheReclamationMaintenance')&&dispatch>capture&&classify>dispatch))throw Error('Scheduling probe drift');
const result={stage,root,targetDiagnostics:targetDiagnostics.length,inheritedDiagnostics:diagnostics.length,wholeCustody:Object.keys(custody.whole).length,spanCustody:Object.values(custody.spans).reduce((n,v)=>n+v.length,0),schedulingProbe:{capture,dispatch,classify},owners:Object.fromEntries(owners.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))};
fs.writeFileSync(path.join(out,`source-check-${stage}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
