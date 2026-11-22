import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
import prettier from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/prettier/index.mjs';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),file='tests/phase-6b-d110c-0c1f5b-integration-red.test.ts',before=fs.readFileSync(path.join(out,'source-before.ts'),'utf8'),after=fs.readFileSync(path.join(root,file),'utf8'),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),unit=ts.createSourceFile(file,after,ts.ScriptTarget.Latest,true),old=ts.createSourceFile(file,before,ts.ScriptTarget.Latest,true),ranges=[],removed=[];
function remove(start,end,kind){const lineStart=after.lastIndexOf('\n',start-1)+1,lineEnd=after.indexOf('\n',end);if(/^\s*$/u.test(after.slice(lineStart,start))&&lineEnd!==-1&&/^\s*$/u.test(after.slice(end,lineEnd))){start=lineStart;end=lineEnd+1;}ranges.push([start,end]);removed.push({kind,start,end,text:after.slice(start,end)});}
const wide=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sixtyFourWriterGoldenPath'),priorWide=old.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sixtyFourWriterGoldenPath');if(!wide||!priorWide||hash(priorWide.body.getText(old))!=='5772c9807c1d9152f7f89e0f7fe0ad38ede650793c7a571dd63a364862c82ee5')throw Error('Original callback custody');
const wrapper=wide.body.statements.find(ts.isTryStatement);if(!wrapper||wrapper.catchClause||wrapper.finallyBlock.statements.length!==1||wrapper.finallyBlock.statements[0].getText(unit)!=='wideDiagnostic("callback", "settled", null, null, wideDiagnosticCompleted);')throw Error('Exact diagnostic finally');
remove(wrapper.getStart(unit),wrapper.tryBlock.getStart(unit)+1,'try-open');remove(wrapper.tryBlock.end-1,wrapper.end,'finally-tail');
function scan(n){
 if(n===wrapper){ts.forEachChild(n.tryBlock,scan);return;}
 if(ts.isFunctionDeclaration(n)&&n.name?.text==='wideDiagnostic'){remove(n.getStart(unit),n.end,'logger');return;}
 if(ts.isVariableStatement(n)&&n.declarationList.declarations.length===1&&['wideDiagnosticState','wideDiagnosticCompleted'].includes(n.declarationList.declarations[0].name.getText(unit))){remove(n.getStart(unit),n.end,'diagnostic-state');return;}
 if(ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(unit)==='wideDiagnostic'){remove(n.getStart(unit),n.end,'observation');return;}
 if(ts.isExpressionStatement(n)&&n.getText(unit)==='wideDiagnosticCompleted = true;'){remove(n.getStart(unit),n.end,'completion-flag');return;}
 if(ts.isImportDeclaration(n)&&n.moduleSpecifier.getText(unit)==='"node:fs"'){const names=n.importClause.namedBindings.elements;if(names.length!==2||names[0].name.text!=='readFileSync'||names[1].name.text!=='writeSync')throw Error('Exact import delta');remove(names[0].end,names[1].end,'writeSync-import');return;}
 ts.forEachChild(n,scan);
}
scan(unit);ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])throw Error('Overlapping diagnostic ranges');
let restored=after;for(const[start,end]of ranges.toReversed())restored=restored.slice(0,start)+restored.slice(end);
const tokens=text=>{const s=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,text),result=[];for(let kind=s.scan();kind!==ts.SyntaxKind.EndOfFileToken;kind=s.scan())result.push([kind,s.getTokenText()]);return result;};
const a=tokens(before),b=tokens(restored),i=a.findIndex((v,i)=>JSON.stringify(v)!==JSON.stringify(b[i]));console.log(JSON.stringify({firstDifference:i,before:a.slice(i-8,i+12),restored:b.slice(i-8,i+12),beforeLength:a.length,restoredLength:b.length},null,2));
