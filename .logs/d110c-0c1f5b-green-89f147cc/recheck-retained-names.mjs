import fs from 'node:fs';
import path from 'node:path';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname);
const frozen=JSON.parse(fs.readFileSync(path.join(out,'retained-runtime-roster.json')));
const results=[];
for(let index=0;index<5;index++){
 const row=frozen.roster[index];
 const files=row.label==='retained-02'?[...row.files,...frozen.roster[25].files]:row.files;
 const report=JSON.parse(fs.readFileSync(row.output));
 const actual=report.testResults.flatMap(file=>file.assertionResults.map(assertion=>file.name+'\0'+[...assertion.ancestorTitles,assertion.title].join(' > '))).sort();
 const expected=frozen.collection.filter(entry=>files.includes(path.relative(root,entry.file))).map(entry=>entry.file+'\0'+entry.name).sort();
 const exactNames=JSON.stringify(actual)===JSON.stringify(expected);
 const exactFiles=JSON.stringify(report.testResults.map(file=>path.relative(root,file.name)).sort())===JSON.stringify([...files].sort());
 const pass=exactNames&&exactFiles&&report.success===true&&report.numFailedTests===0&&report.numPendingTests===0&&!report.numRuntimeErrorTestSuites&&!report.numUnhandledErrors&&report.testResults.every(file=>!file.message&&!file.testExecError&&file.assertionResults.every(assertion=>assertion.failureMessages.length===0));
 results.push({label:row.label,pass,exactNames,exactFiles,total:report.numTotalTests,files,actualNames:actual,expectedNames:expected});
}
fs.writeFileSync(path.join(out,'retained-completed-name-recheck.json'),JSON.stringify({pass:results.every(row=>row.pass),total:results.reduce((sum,row)=>sum+row.total,0),results,originalFailedValidatorsPreserved:true,diagnosis:'Global list-name separator replacement erased literal m > f; reconstructed reporter hierarchy preserves complete raw names. No test rerun/recollection.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pass:results.every(row=>row.pass),total:results.reduce((sum,row)=>sum+row.total,0)}));
process.exitCode=results.every(row=>row.pass)?0:1;
