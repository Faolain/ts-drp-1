import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const freeze='0bca5b6d45dfaec66a3726d89093d0bc5d55c013';
const files=['tests/phase-6b-d110c-0c1k-w0-runtime-red.test.ts','tests/fixtures/phase-6b-d110c-0c1k/w0-runtime-contract.ts'];
const observationFields=new Set(['attemptedFenceCanonicalBytes','attemptedFenceDeliveredToApplication','attemptedFenceJournaled','closeCanonicalBytes','closedApplicationState','journalCanonicalBytes','offenderApplicationCount','offenderFenceCount','profileId']);
const observationVariables=new Set(['attemptedFenceCanonicalBytes','attemptedFenceDeliveredToApplication','attemptedFenceDigest','canonicalByteLengths']);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f));
const write=(f,v)=>fs.writeFileSync(path.join(out,f),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const printer=ts.createPrinter({removeComments:false,newLine:ts.NewLineKind.LineFeed});
const changes=[];
for(const file of files){
 const before=fs.readFileSync(path.join(out,path.basename(file)+'.before'),'utf8'),after=read(file).toString();
 const frozen=execFileSync('git',['-C',root,'show',freeze+':'+file]);
 if(hash(before)!==hash(frozen))throw Error('Baseline not frozen source '+file);
 const source=ts.createSourceFile(file,after,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),old=ts.createSourceFile(file,before,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const removed=[];
 const transformed=ts.transform(source,[context=>{
  const visit=node=>{
   if((ts.isPropertySignature(node)||ts.isPropertyAssignment(node)||ts.isShorthandPropertyAssignment(node))&&observationFields.has(node.name.getText(source))){removed.push(node.getText(source));return undefined;}
   if(ts.isVariableStatement(node)&&node.declarationList.declarations.every(d=>observationVariables.has(d.name.getText(source)))){removed.push(node.getText(source));return undefined;}
   if(ts.isExpressionStatement(node)){
    const e=node.expression;
    if(ts.isBinaryExpression(e)&&e.operatorToken.kind===ts.SyntaxKind.EqualsToken&&observationVariables.has(e.left.getText(source))){removed.push(node.getText(source));return undefined;}
    if(ts.isCallExpression(e)&&e.expression.getText(source)==='canonicalByteLengths.push'){removed.push(node.getText(source));return undefined;}
   }
   if(ts.isCallExpression(node)&&node.expression.getText(source)==='expect'&&node.arguments.length===2&&node.arguments[0].getText(source)==='measured'&&node.arguments[1].getText(source)==='JSON.stringify(measured)'){
    removed.push('expect diagnostic: JSON.stringify(measured)');
    return context.factory.updateCallExpression(node,node.expression,node.typeArguments,[node.arguments[0]]);
   }
   const visited=ts.visitEachChild(node,visit,context);
   if(ts.isIfStatement(visited)&&visited.expression.getText(source)==='row.sourceKind === "received"'&&ts.isBlock(visited.thenStatement)&&visited.thenStatement.statements.length===1&&ts.isReturnStatement(visited.thenStatement.statements[0])){
    return context.factory.updateIfStatement(visited,visited.expression,visited.thenStatement.statements[0],visited.elseStatement);
   }
   return visited;
  };
  return node=>ts.visitNode(node,visit);
 }]);
 const normalized=printer.printFile(transformed.transformed[0]),original=printer.printFile(old);
 if(normalized!==original)throw Error('Non-observation semantic difference '+file);
 transformed.dispose();
 changes.push({file,beforeSha256:hash(before),afterSha256:hash(after),normalizedAstSha256:hash(normalized),frozenAstSha256:hash(original),equivalentAfterRemovingOnlyEnumeratedObservations:true,removed});
}
const patch=execFileSync('git',['-C',root,'diff','--binary','--full-index','--',...files],{encoding:'utf8'});
write('authored.patch',patch);
const historical='.logs/d110c-0c1f5b-green-71bca5d5/retained-58';
const resultHash=hash(read(historical+'/result.json')),commandHash=hash(read(historical+'/command.json'));
if(resultHash!=='4926a150b2355c8f908c89085ed6fd89070c03faf66498c8cc32de9b0914fc2b'||commandHash!=='dfe6d69cc74a86b2d62eada4d1ab69144e667a39569285c2994bcf344e2737cc')throw Error('Historical evidence changed');
const originalCustody=JSON.parse(read('.logs/d110c-0c1f5b-green-71bca5d5/custody-before.json'));
const report=JSON.parse(read(historical+'/result.json'));
write('equivalence.json',{freeze,patchSha256:hash(patch),changes,historicalExecution:{path:historical,reporterSha256:resultHash,commandSha256:commandHash,custodyHead:originalCustody.head,status:JSON.parse(read(historical+'/status.json')),tests:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,failures:report.testResults.flatMap(s=>s.assertionResults.filter(a=>a.status==='failed').map(a=>({title:a.fullName,failureMessages:a.failureMessages}))),limitation:'Original aggregate mismatch only; no new observation values are attributed to this old execution.'},currentPatch:{staticOnly:true,testExecutions:0,observationsMeasured:false,expectationAndWorkloadPreserved:true}});
console.log(JSON.stringify({freeze,files:changes.map(({file,beforeSha256,afterSha256})=>({file,beforeSha256,afterSha256})),semanticEquivalence:true,oldAssertionPreserved:true,newTestExecutions:0,patchSha256:hash(patch)}));
