import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createServer} from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite/dist/node/index.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),file='tests/phase-3a1b-p3-live-transport-red.test.ts',hash=b=>crypto.createHash('sha256').update(b).digest('hex'),write=(f,v)=>fs.writeFileSync(path.join(out,f),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'}),query='../packages/node/src/internal/v3-topic.js?d108e2c-hostile-text-encoder',importer=path.join(root,file);
const source=fs.readFileSync(importer,'utf8'),sourceSha256=hash(source),configSha256=hash(fs.readFileSync(path.join(root,'vite.config.mts')));
const server=await createServer({root,configFile:path.join(root,'vite.config.mts'),server:{middlewareMode:true,hmr:false,watch:null},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
try{
 const queried=await server.pluginContainer.resolveId(query,importer,{ssr:true}),plain=await server.pluginContainer.resolveId(query.split('?')[0],importer,{ssr:true}),transformed=await server.transformRequest('/'+file,{ssr:true});
 if(!transformed)throw Error('No actual Vite transform');
 write('vite-transformed-test.js',transformed.code);write('vite-transform-raw.json',{sourceSha256,configSha256,queried,plain,map:transformed.map,deps:transformed.deps,ssrDeps:transformed.ssrDeps,ssrDynamicDeps:transformed.ssrDynamicDeps});
 if(!queried?.id.endsWith('/packages/node/src/internal/v3-topic.ts?d108e2c-hostile-text-encoder')||!plain?.id.endsWith('/packages/node/src/internal/v3-topic.ts')||queried.id===plain.id)throw Error('Query identity lost');
 const code=transformed.code,hostile=code.indexOf('class D108e2cThrowingTextEncoder'),dynamic=code.indexOf('__vite_ssr_dynamic_import__',hostile),literal=code.indexOf('d108e2c-hostile-text-encoder',dynamic),restore=code.indexOf('finally',literal),restoreDescriptor=code.indexOf('Object.defineProperty(globalThis, "TextEncoder", textEncoderDescriptor)',restore),assertion=code.indexOf('hostileModule.deriveV3StableTopic',restore);
 if(!(hostile>=0&&dynamic>hostile&&literal>dynamic&&restore>literal&&restoreDescriptor>restore&&assertion>restoreDescriptor)||!code.slice(dynamic,literal).includes('v3-topic.'))throw Error('Hostile import ordering changed');
 if(hash(fs.readFileSync(importer))!==sourceSha256||hash(fs.readFileSync(path.join(root,'vite.config.mts')))!==configSha256)throw Error('Source/config drift');
 write('query-transform.json',{valid:true,sourceSha256,configSha256,viteVersion:JSON.parse(fs.readFileSync(path.join(root,'node_modules/vite/package.json'))).version,queriedId:queried.id,plainId:plain.id,separateIdentity:true,hostileDynamicImportRestorationAssertionOrder:{hostile,dynamic,literal,restore,restoreDescriptor,assertion},transformSha256:hash(code),actualWorkspaceConfig:true,noModuleEvaluation:true,noListeningServer:true,noWorkloadExecution:true,diagnosticOnlyServerOptions:{middlewareMode:true,hmr:false,watch:null,appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}}});
 console.log(JSON.stringify({valid:true,separateQueryIdentity:true,hostileImportOrdering:true,moduleEvaluation:false}));
}finally{await server.close();}
