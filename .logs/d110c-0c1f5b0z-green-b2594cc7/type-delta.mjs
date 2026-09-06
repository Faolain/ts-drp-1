import fs from 'node:fs';
import path from 'node:path';
const out=path.dirname(new URL(import.meta.url).pathname),stage=process.argv[2];
function diagnostics(label){
 const command=JSON.parse(fs.readFileSync(path.join(out,label,'command.json'),'utf8'));
 const root=fs.realpathSync(command.cwd);
 const text=fs.readFileSync(path.join(out,label,'stdout'),'utf8').replaceAll(root,'<ROOT>').replaceAll(command.cwd,'<ROOT>');
 const lines=text.split('\n');
 const result=[];
 for(let i=0;i<lines.length;i++)if(/^.*\(\d+,\d+\): error TS\d+:/u.test(lines[i])){
  const block=[lines[i]];
  while(i+1<lines.length&&/^\s+\S/u.test(lines[i+1]))block.push(lines[++i]);
  result.push(block.join('\n'));
 }
 return result;
}
const comparison=[];
for(const name of ['storage','storage-browser','storage-node']){
 const before=diagnostics(`baseline-typecheck-${name}`),after=diagnostics(`${stage}-typecheck-${name}`);
 const added=after.filter(d=>!before.includes(d)),removed=before.filter(d=>!after.includes(d));
 comparison.push({package:`@ts-drp/${name}`,baselineCount:before.length,greenCount:after.length,added,removed,identical:JSON.stringify(before)===JSON.stringify(after)});
}
const baseline=JSON.parse(fs.readFileSync(path.join(out,'typecheck-baseline.json'),'utf8'));
const green=JSON.parse(fs.readFileSync(path.join(out,`typecheck-${stage==='initial'?'initial-green':stage}.json`),'utf8'));
const sourceMappedUnchanged=JSON.stringify(baseline)===JSON.stringify(green);
const result={stage,comparison,sourceMappedUnchanged,targetDiagnostics:green.targetDiagnostics,inheritedSourceMappedDiagnostics:green.externalDiagnostics};
fs.writeFileSync(path.join(out,`type-delta-${stage}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
if(comparison.some(row=>!row.identical)||!sourceMappedUnchanged||green.targetDiagnostics.length)process.exitCode=1;
