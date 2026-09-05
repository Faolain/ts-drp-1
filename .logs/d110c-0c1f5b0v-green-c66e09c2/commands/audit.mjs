import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const root=process.argv[2], baseline='c938038298b912875f2a8e7b717256fb34370df6';
const hash=s=>createHash('sha256').update(s).digest('hex');
const owners=['examples/v3-room/src/index.ts','packages/node/src/v3-live.ts'];
const results=[];
for(const path of owners){
 const before=execFileSync('git',['-C',root,'show',`${baseline}:${path}`],{encoding:'utf8'});
 const after=readFileSync(resolve(root,path),'utf8');
 const print=s=>ts.createPrinter({removeComments:true}).printFile(ts.createSourceFile(path,s,ts.ScriptTarget.Latest,true));
 const tokens=s=>{const source=ts.createSourceFile(path,s,ts.ScriptTarget.Latest,true),out=[];const visit=n=>{if(n.kind===ts.SyntaxKind.JSDocComment)return;const children=n.getChildren(source);if(children.length===0&&n.kind>=ts.SyntaxKind.FirstToken&&n.kind<=ts.SyntaxKind.LastToken)out.push([n.kind,n.getText(source)]);else children.forEach(visit)};visit(source);return JSON.stringify(out)};
 const astEqual=print(before)===print(after),tokenEqual=tokens(before)===tokens(after);
 if(!astEqual||!tokenEqual)throw Error(`${path}: non-comment change`);
 const comment=/^[ \t]*\/\*\*\s*\n[ \t]*\* Authenticated replayable notification attempt, not an exactly-once external commit\.\s*\n[ \t]*\* Persistent consumers deduplicate side effects by authenticated vertex digest\.\s*\n[ \t]*\* Rejection fails the current session closed; failure, crash or cold reopen may replay notifications\.\s*\n[ \t]*\*\/\n/m;
 if(after.replace(comment,'')!==before)throw Error(`${path}: more than the sole contract comment changed`);
 results.push({path,before:hash(before),after:hash(after),astHash:hash(print(after)),tokenHash:hash(tokens(after)),astEqual,tokenEqual,soleExactComment:true});
}
console.log(JSON.stringify({baseline,results},null,2));
