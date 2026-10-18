import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const custody=JSON.parse(fs.readFileSync(path.join(out,'custody-before.json')));
const built={};
const programs=new Map();
for(const [file,sourceHash] of Object.entries(custody.ownerHashes).filter(([f])=>f.startsWith('packages/'))){
 const config=path.join(root,file.split('/').slice(0,2).join('/'),'tsconfig.build.json');
 const parsed=ts.readConfigFile(config,ts.sys.readFile);
 const options=ts.parseJsonConfigFileContent(parsed.config,ts.sys,path.dirname(config)).options;
 const runtime=file.replace('/src/','/dist/src/').replace(/\.ts$/u,'.js');
 const source=fs.readFileSync(path.join(root,file),'utf8');
 let program=programs.get(config);if(!program){const parsedProgram=ts.parseJsonConfigFileContent(parsed.config,ts.sys,path.dirname(config));program=ts.createProgram(parsedProgram.fileNames,options);programs.set(config,program);}
 let expected;program.emit(program.getSourceFile(path.join(root,file)),(emitted,text)=>{if(emitted.endsWith('.js'))expected=text;});
 if(expected===undefined)throw Error('No in-memory JS emit '+file);
 const actual=fs.readFileSync(path.join(root,runtime));
 built[runtime]={sourceHash,sha256:hash(actual),currentCompilerEmitSha256:hash(expected),exactEmit:hash(expected)===hash(actual),realpath:fs.realpathSync(path.join(root,runtime))};
}
const result={built,allExact:Object.values(built).every(row=>row.exactEmit),scope:'Read-only current compiler emit versus existing package runtime; no build or runtime test repeated. Room owner consumed as source by Vite.',priorDiagnostic:'prepare incorrectly required nonexistent JS maps. A separate read-only one-line emit probe had a trailing-brace SyntaxError; neither invoked product or test.'};
fs.writeFileSync(path.join(out,'runtime-identity-corrected.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));if(!result.allExact)process.exitCode=1;
