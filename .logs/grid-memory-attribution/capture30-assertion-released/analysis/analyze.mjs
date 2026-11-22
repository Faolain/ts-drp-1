import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream,readFileSync,writeFileSync } from 'node:fs';
import { partition,disjointAnchors } from '/Users/aristotle/Documents/Projects/ts-drp-1/tests/fixtures/grid-heap-store-ownership.mjs';
const [snapshot,expectedHash,outPrefix]=process.argv.slice(2);
assert.ok(snapshot&&expectedHash&&outPrefix);
const hash=createHash('sha256');for await(const chunk of createReadStream(snapshot))hash.update(chunk);
const snapshotHash=hash.digest('hex');assert.equal(snapshotHash,expectedHash);
const req=createRequire('/tmp/grid-heap-analysis-VZ575c/package.json');
assert.equal(req('@memlab/heap-analysis/package.json').version,'2.0.5');
const h=await req('@memlab/heap-analysis').getFullHeapFromFile(snapshot);
const f=n=>({id:n.id,name:n.name.slice(0,180),type:n.type,shallow:n.self_size,retained:n.retainedSize});
const prop=(n,k)=>n?.getReferenceNode(k,'property');
const room=n=>n?.type==='object'&&n.name==='Object'&&prop(n,'issue')?.type==='closure'&&prop(n,'sealEpoch')?.type==='closure';
const reg=n=>n?.type==='object'&&n.name==='Object'&&prop(n,'handle')?.type==='object'&&prop(n,'pendingIngress')?.name==='Map'&&prop(n,'networkNode')?.type==='object';
const numericEntries=n=>n.getReferenceNode('table','internal').references.filter(e=>e.type==='internal'&&/^\d+$/.test(String(e.name_or_index))).map(e=>e.toNode);
const bindings=[],observers=[],sessionCandidates=new Map(),rooms=[],regs=[];
h.nodes.forEach(n=>{
 if(n.name==='global'&&prop(n,'indexedDB')?.name==='FDBFactory')bindings.push({global:n,factory:prop(n,'indexedDB')});
 if(n.type==='object'&&n.name==='Object'&&prop(n,'stores')?.name==='Map'&&prop(n,'planes')?.name==='Map'&&prop(n,'commits')?.name==='Array'&&prop(n,'advances')?.name==='Array'&&prop(n,'cleanup')?.name==='Array')observers.push(n);
 if(n.type==='closure'&&n.name==='waitForGridStartupForDiagnostics'){
  const context=n.getReferenceNode('context','internal');
  for(const edge of context?.references??[])if(edge.toNode.name==='Set'&&edge.toNode.type==='object'){
   const values=numericEntries(edge.toNode);if(values.length&&values.every(room))sessionCandidates.set(edge.toNode.id,{set:edge.toNode,closure:n.id,context:context.id,edge:String(edge.name_or_index)});
  }
 }
 if(room(n))rooms.push(n);if(reg(n))regs.push(n);
});
assert.equal(new Set(bindings.map(b=>b.factory.id)).size,1,'unique global-bound factory');
assert.equal(observers.length,1,'unique actual observer shape');
assert.equal(sessionCandidates.size,1,'unique sessions Set in startup-waiter lexical context');
const binding=bindings[0],observer=observers[0],sessionProof=[...sessionCandidates.values()][0];
const sessions=numericEntries(sessionProof.set),sessionIds=new Set(sessions.map(n=>n.id));
const planes=prop(observer,'planes'),handles=numericEntries(planes).filter(n=>n.type==='object');
const parent=new Map([[1,null]]),queue=[h.getNodeById(1)];
for(let i=0;i<queue.length;i++)for(const e of queue[i].references){
 if(e.type==='weak'||String(e.name_or_index).includes('part of key (')||parent.has(e.toNode.id))continue;
 parent.set(e.toNode.id,{from:e.fromNode.id,name:String(e.name_or_index),type:e.type});queue.push(e.toNode);
}
const path=n=>{const out=[];let id=n.id;for(let i=0;i<80;i++){const node=h.getNodeById(id),edge=parent.get(id);out.push({...f(node),incoming:edge??null});if(!edge)return{terminal:id===1?'strong-root':'not-found-without-ephemerons',path:out};id=edge.from;}return{terminal:'truncated',path:out};};
for(const n of [binding.global,binding.factory,observer,sessionProof.set,...handles])assert.equal(path(n).terminal,'strong-root');
const currentRegs=new Map();
for(const handle of handles)for(const edge of handle.references){
 const name=String(edge.name_or_index);
 if(name.includes(`part of key (Object @${handle.id}) -> value`)&&reg(edge.toNode)){
  const match=name.match(/table @(\d+)/);assert.ok(match);const table=h.getNodeById(Number(match[1]));assert.equal(path(table).terminal,'strong-root');
  currentRegs.set(edge.toNode.id,{handleId:handle.id,conditionalEdge:name,handleStrongPath:path(handle),tableId:table.id,tableStrongPath:path(table)});
 }
}
assert.equal(currentRegs.size,handles.length,'one registration per observed current handle');
const storeReport={snapshot,snapshotHash,...partition(h,[binding.factory.id])};
function enclosing(kind){const unique=new Map();for(const row of storeReport.rows){const id=kind==='database'?row.proof.databaseNodeId:row.proof.storeNodeId;if(!unique.has(id))unique.set(id,{node:h.getNodeById(id),database:row.database,store:kind==='database'?undefined:row.store,proof:row.proof});}const gaps=[],nodes=disjointAnchors([...unique.values()],gaps);return{kind,anchors:nodes.length,retainedSize:nodes.reduce((s,r)=>s+r.node.retainedSize,0),gaps,rows:nodes.map(({node,...r})=>({...r,...f(node)}))};}
const worker=prop(binding.global,'__vitest_worker__'),currentTest=prop(worker,'current'),onFinished=prop(currentTest,'onFinished');
const rawStorePartition=enclosing('store'),rawDatabasePartition=enclosing('database');
const report={snapshot,snapshotHash,semantics:'Independent paths exclude all weak and ephemeron-pair edges. Current registration proof requires independently rooted handle AND WeakMap table plus key-to-value edge. Alternative retained partitions must not be summed or subtracted from process counters.',roots:{factory:{...f(binding.factory),strongPath:path(binding.factory)},observer:{...f(observer),strongPath:path(observer)},sessions:{...f(sessionProof.set),closureId:sessionProof.closure,contextId:sessionProof.context,contextEdge:sessionProof.edge,strongPath:path(sessionProof.set)},planes:{...f(planes),strongPath:path(planes)},vitestWorker:worker?f(worker):null,currentTest:currentTest?f(currentTest):null,onFinished:onFinished?{...f(onFinished),elementCount:onFinished.name==='Array'?onFinished.references.filter(e=>e.type==='element').length:null}:null},currentRooms:sessions.length,currentRegistrations:currentRegs.size,rooms:rooms.map(n=>({...f(n),current:sessionIds.has(n.id),strongPath:path(n)})),registrations:regs.map(n=>({...f(n),current:currentRegs.has(n.id),currentProof:currentRegs.get(n.id),activeOddballNodeId:prop(n,'active')?.id,handleId:prop(n,'handle').id,mode:prop(n,'mode')?.name,strongPath:path(n)})),rawStorePartition,rawDatabasePartition,graphShallowBytes:storeReport.graphShallowBytes,recordsAndIndexesRetainedBytes:storeReport.attributedGraphBytes,observerContainers:observer.references.filter(e=>e.type==='property'&&['Array','Map'].includes(e.toNode.name)).map(e=>({property:String(e.name_or_index),...f(e.toNode),elementCount:e.toNode.name==='Array'?e.toNode.references.filter(x=>x.type==='element').length:null}))};
writeFileSync(`${outPrefix}-stores.json`,JSON.stringify(storeReport,null,2),{flag:'wx'});
writeFileSync(`${outPrefix}-owners.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({snapshotHash,factory:binding.factory.id,observer:observer.id,sessions:sessionProof.set.id,onFinished:report.roots.onFinished,currentRooms:report.currentRooms,totalRooms:rooms.length,otherRooms:rooms.length-report.currentRooms,totalRegistrations:regs.length,currentRegistrations:report.currentRegistrations,graph:report.graphShallowBytes,recordsIndex:report.recordsAndIndexesRetainedBytes,rawStores:rawStorePartition.retainedSize,rawDatabases:rawDatabasePartition.retainedSize}));
