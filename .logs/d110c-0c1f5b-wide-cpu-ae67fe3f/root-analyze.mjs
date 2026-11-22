import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const profileDir=path.join(out,'profiles');
const launch=JSON.parse(fs.readFileSync(path.join(out,'wide-only/execution-start.json'),'utf8'));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const names=fs.readdirSync(profileDir).filter(n=>n.endsWith('.cpuprofile')).sort();
if(!names.length)throw Error('No profiles; attribution unavailable, no retry');
const add=(map,key,ms)=>map.set(key,(map.get(key)??0)+ms);
const top=(map,n=35)=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([key,ms])=>({key,weightedMs:ms}));
const results=[];
for(const name of names){
 const raw=fs.readFileSync(path.join(profileDir,name));const p=JSON.parse(raw);
 if(!Array.isArray(p.nodes)||!Array.isArray(p.samples)||!Array.isArray(p.timeDeltas)||p.samples.length!==p.timeDeltas.length)throw Error('Invalid profile arrays '+name);
 const nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map();
 for(const n of p.nodes)for(const id of n.children??[]){if(parents.has(id)||!nodes.has(id))throw Error('Malformed profile tree');parents.set(id,n.id);}
 const key=n=>JSON.stringify([n.callFrame.functionName||'(anonymous)',n.callFrame.url,n.callFrame.lineNumber,n.callFrame.columnNumber]);
 const self=new Map(),inclusive=new Map(),modules=new Map(),categories=new Map(),counts=new Map();let total=0;
 const category=n=>{const f=n.callFrame;if(f.functionName==='(idle)')return'idle';if(f.functionName==='(garbage collector)')return'GC';if(f.url.includes('/tests/'))return'fixture';if(f.url.includes('/packages/')||f.url.includes('/examples/'))return'product';if(f.url.includes('/node_modules/'))return'dependency-or-runner';if(f.url.startsWith('node:'))return'node-internal';return'unattributed-or-runtime';};
 for(let i=0;i<p.samples.length;i++){
  const delta=p.timeDeltas[i];if(!Number.isFinite(delta)||delta<0)throw Error('Invalid sampling delta');
  const ms=delta/1000;let id=p.samples[i];const leaf=nodes.get(id);if(!leaf)throw Error('Missing sampled node');
  total+=ms;add(self,key(leaf),ms);add(counts,key(leaf),1);add(modules,leaf.callFrame.url||leaf.callFrame.functionName||'(unknown)',ms);add(categories,category(leaf),ms);
  const seenNodes=new Set(),seenFunctions=new Set();
  while(id!==undefined){if(seenNodes.has(id))throw Error('Profile cycle');seenNodes.add(id);const n=nodes.get(id),k=key(n);if(!seenFunctions.has(k)){add(inclusive,k,ms);seenFunctions.add(k);}id=parents.get(id);}
 }
 const match=name.match(/^CPU\.\d{8}\.\d{6}\.(\d+)\.(\d+)\.\d+\.cpuprofile$/);
 const pid=match?Number(match[1]):null;
 results.push({file:name,sha256:digest(raw),pid,threadId:match?Number(match[2]):null,role:pid===launch.childPid?'primary-vite':'non-primary-profile',nodeCount:p.nodes.length,samples:p.samples.length,startTime:p.startTime,endTime:p.endTime,profileSpanMs:(p.endTime-p.startTime)/1000,weightedSampleMs:total,unallocatedTailMs:(p.endTime-p.startTime)/1000-total,containsIntegrationSource:p.nodes.some(n=>n.callFrame.url.includes('phase-6b-d110c-0c1f5b-integration-red')),categories:top(categories),self:top(self),inclusive:top(inclusive),modules:top(modules),sampleCounts:top(counts,20).map(x=>({key:x.key,samples:x.weightedMs}))});
}
const report={method:'Each sample weighted by corresponding timeDelta; inclusive functions counted at most once per sample stack, so recursion is not double-counted. Inclusive rows overlap and must not be summed. Weighted sampling time is not exact CPU accounting. Profiles remain separate; no inferred phase clock alignment.',primaryPid:launch.childPid,profiles:results};
fs.writeFileSync(path.join(out,'root-profile-analysis.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report,null,2));
