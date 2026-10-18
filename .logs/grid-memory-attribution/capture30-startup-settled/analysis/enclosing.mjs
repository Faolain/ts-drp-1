import { createRequire } from 'node:module';
import { readFileSync,writeFileSync } from 'node:fs';
import { disjointAnchors } from '/Users/aristotle/Documents/Projects/ts-drp-1/tests/fixtures/grid-heap-store-ownership.mjs';
const req=createRequire('/tmp/grid-heap-analysis-VZ575c/package.json');
const h=await req('@memlab/heap-analysis').getFullHeapFromFile(process.argv[2]);
const source=JSON.parse(readFileSync(process.argv[3],'utf8'));
const fact=n=>({id:n.id,type:n.type,name:n.name.slice(0,200),retainedSize:n.retainedSize,shallowSize:n.self_size});
const props=n=>n.references.filter(e=>e.type==='property'||e.type==='context').map(e=>({name:String(e.name_or_index),target:fact(e.toNode)}));
function enclosing(kind){
 const unique=new Map();
 for(const row of source.rows){const id=kind==='database'?row.proof.databaseNodeId:row.proof.storeNodeId;if(!unique.has(id))unique.set(id,{node:h.getNodeById(id),database:row.database,store:kind==='database'?undefined:row.store,proof:row.proof});}
 const gaps=[];const nodes=disjointAnchors([...unique.values()],gaps);
 return {kind,anchors:nodes.length,retainedSize:nodes.reduce((s,r)=>s+r.node.retainedSize,0),gaps,rows:nodes.map(({node,...r})=>({...r,...fact(node)}))};
}
const selected=[233205,210141,365779,467881,251591,582615,374991,424021,7133,251467].map(id=>h.getNodeById(id)).filter(Boolean).map(n=>({...fact(n),properties:props(n),elementCount:n.references.filter(e=>e.type==='element').length}));
const stores=enclosing('store'),databases=enclosing('database');
writeFileSync(process.argv[4],JSON.stringify({snapshotHash:source.snapshotHash,semantics:'Alternative partitions only; DO NOT add databases, stores or nested records/index retained sizes together. Node IDs/provenance come from current-map-verified partition of this same snapshot.',stores,databases,selected},null,2),{flag:'wx'});
console.log(JSON.stringify({stores:stores.retainedSize,storeAnchors:stores.anchors,storeGaps:stores.gaps,databases:databases.retainedSize,databaseAnchors:databases.anchors,databaseGaps:databases.gaps,selected:selected.map(n=>({id:n.id,name:n.name,size:n.retainedSize,elements:n.elementCount}))}));
