import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const req=createRequire('/tmp/grid-heap-analysis-VZ575c/package.json');
const h=await req('@memlab/heap-analysis').getFullHeapFromFile(process.argv[2]);
const f=n=>({id:n.id,name:n.name.slice(0,140),type:n.type,shallow:n.self_size,retained:n.retainedSize});
const parent=new Map([[1,null]]),queue=[h.getNodeById(1)];
// Independent strong-path search excludes every conditional WeakMap pair edge,
// even V8's key->value shortcut. Absence means unresolved, not dead.
for(let i=0;i<queue.length;i++)for(const e of queue[i].references){
 if(e.type==='weak'||String(e.name_or_index).includes('part of key (')||parent.has(e.toNode.id))continue;
 parent.set(e.toNode.id,{from:e.fromNode.id,name:String(e.name_or_index),type:e.type});queue.push(e.toNode);
}
const path=n=>{const out=[];let id=n.id;for(let i=0;i<60;i++){const node=h.getNodeById(id),e=parent.get(id);out.push({...f(node),incoming:e??null});if(!e)return {terminal:id===1?'strong-root':'not-found-without-ephemerons',path:out};id=e.from;}return{terminal:'truncated',path:out};};
const entries=n=>n.getReferenceNode('table','internal').references.filter(e=>e.type==='internal'&&/^\d+$/.test(String(e.name_or_index))&&e.toNode.type==='object').map(e=>e.toNode);
const handles=entries(h.getNodeById(582669)),sessions=entries(h.getNodeById(251467));
const sessionIds=new Set(sessions.map(n=>n.id));
const currentRegs=new Map();
for(const handle of handles)for(const edge of handle.references){
 if(String(edge.name_or_index).includes(`part of key (Object @${handle.id}) -> value`)&&edge.toNode.getReference('pendingIngress','property'))currentRegs.set(edge.toNode.id,{handleId:handle.id,conditionalEdge:String(edge.name_or_index),handleStrongPath:path(handle)});
}
const rooms=[],regs=[];
h.nodes.forEach(n=>{
 if(n.type!=='object'||n.name!=='Object')return;
 if(n.getReferenceNode('issue','property')?.type==='closure'&&n.getReferenceNode('sealEpoch','property')?.type==='closure')rooms.push({...f(n),current:sessionIds.has(n.id),strongPath:path(n)});
 if(n.getReferenceNode('handle','property')?.type==='object'&&n.getReference('pendingIngress','property')&&n.getReference('networkNode','property'))regs.push({...f(n),current:currentRegs.has(n.id),currentProof:currentRegs.get(n.id),active:n.getReferenceNode('active','property')?.id,handleId:n.getReferenceNode('handle','property')?.id,queueManagerId:n.getReferenceNode('messageQueueManager','property')?.id,mode:n.getReferenceNode('mode','property')?.name,strongPath:path(n)});
});
const observer=h.getNodeById(582615);
const containers=observer.references.filter(e=>e.type==='property'&&['Array','Map'].includes(e.toNode.name)).map(e=>({property:String(e.name_or_index),...f(e.toNode),visibleEntries:e.toNode.name==='Array'?e.toNode.references.filter(x=>x.type==='element').length:entries(e.toNode).length,strongPath:path(e.toNode)}));
const output={semantics:'Independent paths exclude weak and all ephemeron pair edges. Current registration proof starts from strongly rooted observed handle and uses its conditional key->value edge; WeakMap table alone is not a retaining root.',strongReachableWithoutEphemerons:parent.size,currentHandles:handles.length,currentSessions:sessions.length,currentRegistrations:currentRegs.size,rooms,registrations:regs,observerContainers:containers,selected:[251467,582615,7133,424021].map(id=>({...f(h.getNodeById(id)),strongPath:path(h.getNodeById(id))}))};
writeFileSync(process.argv[3],JSON.stringify(output,null,2),{flag:'wx'});
console.log(JSON.stringify({rooms:rooms.length,currentRooms:rooms.filter(n=>n.current).length,otherRooms:rooms.filter(n=>!n.current).length,otherRoomsWithStrongPath:rooms.filter(n=>!n.current&&n.strongPath.terminal==='strong-root').length,registrations:regs.length,currentRegistrations:currentRegs.size,otherRegistrations:regs.filter(n=>!n.current).length,otherRegistrationsWithStrongPath:regs.filter(n=>!n.current&&n.strongPath.terminal==='strong-root').length}));
