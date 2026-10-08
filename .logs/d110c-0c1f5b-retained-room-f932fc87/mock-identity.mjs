import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolveConfig} from '/tmp/d110c-f5b-retained-room-hsBT3J/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const config=await resolveConfig({root,configFile:path.join(root,'vite.config.mts')},'serve','test');
const resolve=config.createResolver(),test=path.join(root,'tests/phase-3g-v3-room-rebase-red.test.ts'),room=path.join(root,'examples/v3-room/src/index.ts');
const pairs=[
 ['@ts-drp/control-plane','@ts-drp/control-plane'],
 ['../packages/storage/dist/src/index.js','@ts-drp/storage'],
 ['../packages/storage-browser/dist/src/index.js','@ts-drp/storage-browser'],
 ['../packages/storage-browser/dist/src/issuance.js','@ts-drp/storage-browser/issuance'],
 ['../packages/storage-browser/dist/src/live-journal.js','@ts-drp/storage-browser/live-journal'],
 ['../packages/protocol-v3/dist/src/public.js','@ts-drp/protocol-v3'],
 ['../packages/node/dist/src/v3-live.js','@ts-drp/node/v3-live']
];
const mappings=[];
for(const[mock,production]of pairs){
 const mockPath=await resolve(mock,test,false,true),productionPath=await resolve(production,room,false,true);
 if(!mockPath||!productionPath)throw Error('Unresolved module identity');
 const m=fs.realpathSync(mockPath),p=fs.realpathSync(productionPath);
 if(!m.startsWith(root+'/')||!p.startsWith(root+'/'))throw Error('Resolution outside isolated install');
 mappings.push({mock,production,mockPath:m,productionPath:p,sameIdentity:m===p,mockSha256:hash(fs.readFileSync(m)),productionSha256:hash(fs.readFileSync(p))});
}
const files=['vite.config.mts','tests/phase-3g-v3-room-rebase-red.test.ts','examples/v3-room/src/index.ts','packages/node/src/v3-live.ts'];
const sources=Object.fromEntries(files.map(file=>{const bytes=fs.readFileSync(file),signed=execFileSync('git',['show','HEAD:'+file]);if(!bytes.equals(signed))throw Error('Source drift');return[file,{sha256:hash(bytes),matchesSignedHead:true}];}));
const data={method:'Read-only Vite resolveConfig/createResolver SSR identity resolution. No server, module runner, optimizer, fixture execution, build or test run.',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mappings,sources,mismatches:mappings.filter(m=>!m.sameIdentity),diagnosis:'Existing Node and protocol mocks target dist modules, while room bare contracts resolve to src modules. Real Node preparation snapshots the incomplete control-plane mock trust and returns trust-open-failed. Carrier guards are now passed; no scheduling acceptance is claimed.'};
fs.writeFileSync(path.join(out,'mock-identity-attribution.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({resolved:mappings.length,matched:mappings.filter(m=>m.sameIdentity).length,mismatched:mappings.filter(m=>!m.sameIdentity).map(m=>m.production)}));
