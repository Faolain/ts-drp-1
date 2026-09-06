import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),files=fs.readdirSync(out).filter(n=>/\.(mjs|md)$/.test(n));
for(const file of files){const text=fs.readFileSync(path.join(out,file),'utf8');if(/[ \t]+$/m.test(text)||text.endsWith('\n\n')||!text.endsWith('\n'))throw Error('Authored whitespace '+file);if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',path.join(out,file)],{stdio:'pipe'})}
execFileSync('git',['diff','--check'],{cwd:root,stdio:'pipe'});
console.log(JSON.stringify({authoredFiles:files,syntax:true,authoredWhitespace:true,trackedDiffCheck:true,noCompilerOrRuntimeExecuted:true}));
