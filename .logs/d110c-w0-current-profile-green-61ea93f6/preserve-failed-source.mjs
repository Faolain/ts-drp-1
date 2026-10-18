import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),read=f=>JSON.parse(fs.readFileSync(path.join(out,f))),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),custody=read('custody-after.json'),roster=read('runtime-roster.json');
const patch=execFileSync('git',['-C',root,'diff','--binary','--full-index','--',...Object.keys(custody.targetHashes)]),production=execFileSync('git',['-C',root,'diff','--binary','--full-index','--',...Object.keys(custody.ownerHashes)]);
if(hash(patch)!==roster.sourcePatchSha256||hash(production)!==custody.patchSha256)throw Error('Failed invocation patch drift');
const dir=path.join(out,'failed-source');fs.mkdirSync(dir);
for(const[f,d]of Object.entries(custody.targetHashes)){const b=fs.readFileSync(path.join(root,f));if(hash(b)!==d)throw Error('Failed source drift');fs.writeFileSync(path.join(dir,path.basename(f)),b,{flag:'wx'});}
fs.writeFileSync(path.join(dir,'green.patch'),patch,{flag:'wx'});fs.writeFileSync(path.join(dir,'protected-production.patch'),production,{flag:'wx'});
const diagnostic=read('diagnose-fence-rows.json'),database=diagnostic.results[0].database,db=fs.readFileSync(database);if(hash(db)!==diagnostic.results[0].databaseSha256)throw Error('Failed journal drift');fs.writeFileSync(path.join(dir,'failed-journal.sqlite'),db,{flag:'wx'});
const result={baseline:roster.head,sourceHashes:custody.targetHashes,greenPatchSha256:hash(patch),greenPatchMatchesFrozenRoster:true,productionPatchSha256:hash(production),productionPatchMatchesCustody:true,frozenRosterSha256:hash(fs.readFileSync(path.join(out,'runtime-roster.json'))),databaseSha256:hash(db),runtimeExecutionsAdded:0};fs.writeFileSync(path.join(out,'failed-source.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
