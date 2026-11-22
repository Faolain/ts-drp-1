import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import {loadConfigFromFile} from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite/dist/node/index.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
if(!['final'].includes(stage))throw Error('stage');
const files=['tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts','tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts','tests/fixtures/phase-6a-v3/creator-adoption-contract.ts'];
const write=(file,value)=>fs.writeFileSync(path.join(out,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const read=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
if(read.error)throw Error(ts.flattenDiagnosticMessageText(read.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,root),paths={...parsed.options.paths};
function typeEntry(value){if(typeof value==='string')return value;if(!value||typeof value!=='object')return undefined;if(typeof value.types==='string')return value.types;return typeEntry(value.import)??typeEntry(value.default);}
for(const group of ['packages','examples'])for(const dir of fs.readdirSync(path.join(root,group),{withFileTypes:true})){
 if(!dir.isDirectory())continue;const file=path.join(root,group,dir.name,'package.json');if(!fs.existsSync(file))continue;
 const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(!pkg.name)continue;if(pkg.types)paths[pkg.name]=[path.resolve(path.dirname(file),pkg.types)];
 for(const[key,value]of Object.entries(pkg.exports??{})){const entry=typeEntry(value);if(key.startsWith('.')&&entry)paths[pkg.name+(key==='.'?'':key.slice(1))]=[path.resolve(path.dirname(file),entry)];}
}
const loaded=await loadConfigFromFile({command:'serve',mode:'test'},path.join(root,'vite.config.mts'));if(!loaded)throw Error('Vite aliases unavailable');
for(const[key,value]of Object.entries(loaded.config.resolve.alias))paths[key]=[value];
const program=ts.createProgram(files.map(file=>path.join(root,file)),{...parsed.options,paths,noEmit:true,composite:false,declaration:false,declarationMap:false,target:ts.ScriptTarget.ES2022});
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file&&path.relative(root,d.file.fileName),code:d.code,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:undefined,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
const targetDiagnostics=diagnostics.filter(d=>files.includes(d.file)),externalDiagnostics=diagnostics.filter(d=>!files.includes(d.file));
const sources=program.getSourceFiles().map(s=>({file:s.fileName,physical:fs.realpathSync(s.fileName),sha256:crypto.createHash('sha256').update(s.text).digest('hex')}));
write('typecheck-'+stage+'.json',{targetDiagnostics,externalDiagnostics});
write('program-identity-'+stage+'.json',{files,rootNames:program.getRootFileNames(),options:program.getCompilerOptions(),sources,compilerVersion:ts.version,noEmit:true,testExecutions:0});
let baselineEquivalent;
if(stage==='final'){
 const before=JSON.parse(fs.readFileSync(path.join(out,'typecheck-before.json')));
 baselineEquivalent=JSON.stringify(before.externalDiagnostics)===JSON.stringify(externalDiagnostics);
 if(!baselineEquivalent)throw Error('External diagnostics changed');
}
console.log(JSON.stringify({stage,targetCount:targetDiagnostics.length,externalCount:externalDiagnostics.length,baselineEquivalent,wholeProgramPass:diagnostics.length===0,sourceInputs:sources.length}));
process.exitCode=targetDiagnostics.length?1:0;
