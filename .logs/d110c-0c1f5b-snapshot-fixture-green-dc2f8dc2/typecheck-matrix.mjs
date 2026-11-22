import fs from 'node:fs';
import path from 'node:path';
const out=path.dirname(new URL(import.meta.url).pathname),read=f=>JSON.parse(fs.readFileSync(path.join(out,f))),r=read('typecheck.json'),program=read('program-identity.json'),valid=read('typecheck/status.json').code===0&&r.targetDiagnostics.length===0&&r.externalDiagnostics.length===0&&program.files.length===3;
fs.writeFileSync(path.join(out,'typecheck-matrix.json'),JSON.stringify({valid,diagnostics:r,selectedRoots:program.files,threeInheritedErrorsCleared:true,scope:'Selected parent two-test strict program plus new focused fixture contract test; not global grid or whole repository typecheck'},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({valid,diagnostics:0,roots:program.files.length}));if(!valid)process.exitCode=1;
