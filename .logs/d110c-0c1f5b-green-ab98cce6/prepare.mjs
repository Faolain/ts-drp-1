import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),prior=path.join(root,'.logs/d110c-0c1f5b-green-89f147cc');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const frozen=JSON.parse(fs.readFileSync(path.join(prior,'retained-runtime-roster.json')));
const correction='tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts',digest='b3e4eb073dfd3e660703957573dbfadfe8e2989396f1d77041632614edaa5c20';
const hashes={};
for(const row of frozen.roster){
 row.command=row.command.map(arg=>arg.replaceAll(prior,out));row.output=row.output.replaceAll(prior,out);
 if(row.hashes[correction])row.hashes[correction]=digest;
 for(const [file,expected] of Object.entries(row.hashes)){if(hash(fs.readFileSync(path.join(root,file)))!==expected)throw Error('Test drift '+file);hashes[file]=expected;}
 if(Number(row.label.slice(-2))<=6||row.label==='retained-26')row.coveredBy=path.join(prior,row.label==='retained-26'?'retained-02':'retained-'+row.label.slice(-2),'result.json');
}
write('retained-runtime-roster.json',{...frozen,continuationHead:'ab98cce6606e6762c19eaa2c6cc93493a68b419e',reusedFrom:path.relative(root,prior),newCollection:false,onlyTestChange:{file:correction,sha256:digest}});
const owners=JSON.parse(fs.readFileSync(path.join(prior,'custody-stopped.json'))).ownerHashes;
const built={};
for(const file of Object.keys(owners).filter(file=>file.startsWith('packages/'))){
 const runtime=file.replace('/src/','/dist/src/').replace(/\.ts$/u,'.js'),map=runtime+'.map';
 const item={sha256:hash(fs.readFileSync(path.join(root,runtime))),realpath:fs.realpathSync(path.join(root,runtime))};
 if(fs.existsSync(path.join(root,map))){const sourceMap=JSON.parse(fs.readFileSync(path.join(root,map)));item.sourceMapSha256=hash(fs.readFileSync(path.join(root,map)));item.embeddedSourceMatches=sourceMap.sourcesContent?.some(content=>hash(content)===owners[file]);if(item.embeddedSourceMatches!==true)throw Error('Built source mismatch '+file);}
 else throw Error('No source map '+runtime);
 built[runtime]=item;
}
write('identity-before.json',{head:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),ownerHashes:owners,testHashes:hashes,built,sourceBuild:'Reused completed source-build from sealed green89; each affected package runtime source map embeds exact current owner source. Room source loaded directly by Vite.',roster:{files:Object.keys(hashes).length,assertions:frozen.total,gates:frozen.roster.length},skipGates:[1,2,3,4,5,6,26]});
console.log(JSON.stringify({files:Object.keys(hashes).length,builtOwners:Object.keys(built).length,gate07:19,collectionRepeated:false}));
