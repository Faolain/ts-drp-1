import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire('/tmp/grid-heap-analysis-VZ575c/package.json');
const heap = await require('@memlab/heap-analysis').getFullHeapFromFile(process.argv[2]);
const fact = n => ({id:n.id,name:n.name.slice(0,140),type:n.type,shallow:n.self_size,retained:n.retainedSize});
const props = n => n.references.filter(e=>e.type==='property'||e.type==='context').map(e=>({edge:String(e.name_or_index),type:e.type,target:fact(e.toNode)}));
const path = n => {const out=[]; const seen=new Set();while(n&&!seen.has(n.id)&&out.length<40){seen.add(n.id);const e=n.pathEdge;out.push({...fact(n),incoming:e?String(e.name_or_index):null,edgeType:e?.type});if(!e||e.type==='weak')break;n=e.fromNode;}return out;};
const selected = [220127,6945,79799,582615,185641,137685].map(id=>heap.getNodeById(id));
const observer=heap.getNodeById(582615);
const handles=observer.getReferenceNode('planes','property').getReferenceNode('table','internal').references.filter(e=>e.type==='internal'&&/^\d+$/.test(String(e.name_or_index))&&e.toNode.type==='object').map(e=>e.toNode.id);
const currentHandles=new Set(handles);
const rooms=[],registrations=[],interesting=[];
heap.nodes.forEach(n=>{
 if(n.type==='object'&&n.name==='Object'){
  if(n.getReference('sealEpoch','property')&&n.getReference('issue','property')) rooms.push({ ...fact(n),path:path(n),properties:props(n)});
  if(n.getReference('pendingIngress','property')&&n.getReference('networkNode','property')&&n.getReference('handle','property'))registrations.push({...fact(n),currentHandle:currentHandles.has(n.getReferenceNode('handle','property').id),path:path(n),properties:props(n)});
 }
 if(n.type==='object'&&['MessageQueueManager','CausalityIndex','FDBDatabase'].includes(n.name))interesting.push({...fact(n),path:path(n),properties:props(n)});
 if(n.type==='closure'&&['createGridMemoryProfiler','captureCheckpoint','recordCensus','runGridTransitions','openRoom'].includes(n.name))selected.push(n);
});
writeFileSync(process.argv[3],JSON.stringify({currentHandles:handles,selected:selected.map(n=>({...fact(n),properties:props(n),path:path(n)})),rooms,registrations,interesting},null,2),{flag:'wx'});
console.log(JSON.stringify({currentHandles:handles.length,rooms:rooms.length,registrations:registrations.length,currentRegistrations:registrations.filter(r=>r.currentHandle).length,otherRegistrations:registrations.filter(r=>!r.currentHandle).length}));
