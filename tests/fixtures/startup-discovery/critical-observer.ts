export const spans: { phase: string; role: string; transition: number; command:string; ordinal:number; timeOrigin:number; begin: number; end: number; milliseconds: number; id?:number;rpcToken?:number }[] = [];
const spanLimit=20_000, metricLimit=4_096, markLimit=20_000;
export let spansTruncated=false, criticalObserverMilliseconds=0, timingMarksTruncated=false, metricsTruncated=false;
let nextSpan=0,markCount=0;
export const criticalMetrics=new Map<string,{phase:string;role:string;transition:number;command:string;ordinal:number;entered:number;completed:number;milliseconds:number;maximumMilliseconds:number;inputBytes:number;outputBytes:number;thrown:number;returnedRefusals:number}>();
const synchronousMetrics:{phase:string;value:any}[]=[];
const scalarCounters:Record<string,number>={};
const scalarByEpoch=new Map<number,Record<string,number>>();
export const context = { role: "initialization", transition: -1, preparation:false, command:"initialization", ordinal:-1,rpcToken:-1 };
export type StartToken=Readonly<{begin:number;role:string;transition:number;preparation:boolean;command:string;ordinal:number;timeOrigin:number;id:number;rpcToken:number}>;
export function begin(): StartToken { return Object.freeze({begin:performance.now(),role:context.role,transition:context.transition,preparation:context.preparation,command:context.command,ordinal:context.ordinal,timeOrigin:performance.timeOrigin,id:++nextSpan,rpcToken:context.rpcToken}); }
export function end(phase: string, start: StartToken): void {
  const stop = performance.now();
  const label=start.preparation?"test-preparation:"+phase:phase;
  if(spans.length<spanLimit)spans.push({ phase:label, role:start.role,transition:start.transition,command:start.command,ordinal:start.ordinal,timeOrigin:start.timeOrigin, begin: start.begin, end: stop, milliseconds: stop - start.begin,id:start.id,rpcToken:start.rpcToken });else spansTruncated=true;
  if(Reflect.get(globalThis,"__r8CriticalProfiling")===true){
    const observed=performance.now();
    if(markCount++<markLimit)performance.measure(`drp:${label}:${start.role}:e${start.transition}:${start.command}:o${start.ordinal}:rpc${start.rpcToken}:s${start.id}`,{start:start.begin,end:stop});else timingMarksTruncated=true;
    criticalObserverMilliseconds+=performance.now()-observed;
  }
}
Object.assign(globalThis, { __warmBegin: begin, __warmEnd: end });

// Aggregation replaces per-leaf retained spans. No product bytes, parsed data,
// admission authority or native handles are retained. Inclusive nested times
// must not be added together or treated as CPU time. Context is the command
// active at entry, not proof that an asynchronous remote job was caused by it.
function metricBegin(phase:string,inputBytes=0,synchronous=false,owner?:StartToken){
 if(Reflect.get(globalThis,"__r8CriticalProfiling")!==true)return undefined;
 // Focus the added image/coordinator diagnosis on the one mature creator API
 // window. Do not multiply its rows across all clients/epochs or raise the
 // existing finite table bound. Outside this scope these owners are unmeasured.
 if(/^(?:retirement-|native-signing-|native-journal-|native-ahe-control|sealing-source-authenticate|recovery-preparation-|test-only-retirement-row-volume)/u.test(phase)&&
  (context.role!=="creator"||context.transition!==4))return undefined;
 // Static decode/encode sites aggregate per realm, rather than multiplying retention
 // by command ordinal. Other owners retain role/epoch/command attribution;
 // per-operation waterfall remains in the separately bounded original spans.
 // Do not also multiply every owner row by synchronous caller: later-epoch
 // observations otherwise exhaust this same finite table before completion.
 // Canonical work retains caller attribution to distinguish repeated parsing.
 const observed=performance.now(),entered=begin(),token=owner===undefined?entered:Object.freeze({...entered,
  role:owner.role,transition:owner.transition,preparation:owner.preparation,command:owner.command,ordinal:owner.ordinal,rpcToken:owner.rpcToken}),
  caller=synchronousMetrics.at(-1)?.phase??"unattributed";
 // Static callsite wrappers supply attribution to the actual codec counter.
 // Retaining a second row for that wrapper duplicated every codec/callsite
 // pair and exhausted this same table. Share the original codec row, but
 // count/timestamp only entry into the actual codec, not both layers.
 const attributionOwner=phase.startsWith("canonical-decode-callsite:")?"canonical-decode":
  phase.startsWith("canonical-encode-callsite:")?"canonical-encode":undefined;
 const key=JSON.stringify(attributionOwner!==undefined?[attributionOwner,phase]:
  phase==="canonical-decode"||phase==="canonical-encode"?[phase,caller]:[phase,token.role,token.transition,token.command]);
 let row=criticalMetrics.get(key);
 if(row===undefined){if(criticalMetrics.size>=metricLimit){metricsTruncated=true;return undefined;}row={phase:attributionOwner??phase,role:token.role,transition:token.transition,command:token.command,ordinal:token.ordinal,entered:0,completed:0,milliseconds:0,maximumMilliseconds:0,inputBytes:0,outputBytes:0,thrown:0,returnedRefusals:0};criticalMetrics.set(key,row);}
 if(attributionOwner===undefined){row.entered++;row.inputBytes+=inputBytes;}
 criticalObserverMilliseconds+=performance.now()-observed;
 const value={token,row,caller,synchronous,attributionOnly:attributionOwner!==undefined,returned:undefined as unknown,failed:false};if(synchronous)synchronousMetrics.push({phase,value});return value;
}
function metricEnd(value:ReturnType<typeof metricBegin>,outputBytes=0){
 if(value===undefined)return;
 const stop=performance.now(),observed=stop,duration=stop-value.token.begin;
 if(value.synchronous){const index=synchronousMetrics.findLastIndex(row=>row.value===value);if(index>=0)synchronousMetrics.splice(index,1);}
 if(value.attributionOnly){criticalObserverMilliseconds+=performance.now()-observed;return;}
 value.row.completed++;value.row.milliseconds+=duration;value.row.maximumMilliseconds=Math.max(value.row.maximumMilliseconds,duration);value.row.outputBytes+=outputBytes;
 if(value.row.phase.endsWith("-sequential-owner")||value.row.phase.includes("-step:")||value.row.phase.startsWith("room-lifetime-")||["maintenance-schedule","maintenance-generation-source-classification","maintenance-ahe-classifier","maintenance-compose-total","maintenance-application-preview","application-complete-epoch-fold","local-issue-native-job","remote-authentication-inclusive","remote-admission-delivery-inclusive","maintenance-quote-prepare","maintenance-forecast-charge"].includes(value.row.phase))end(value.row.phase,value.token);
 criticalObserverMilliseconds+=performance.now()-observed;
}
function metricBytes(value:ReturnType<typeof metricBegin>,bytes:number,output=false){if(value!==undefined){if(output)value.row.outputBytes+=bytes;else value.row.inputBytes+=bytes;}}
function metricCount(phase:string){if(Reflect.get(globalThis,"__r8CriticalProfiling")===true){scalarCounters[phase]=(scalarCounters[phase]??0)+1;let row=scalarByEpoch.get(context.transition);if(!row&&scalarByEpoch.size<32){row={};scalarByEpoch.set(context.transition,row);}if(row)row[phase]=(row[phase]??0)+1;}}
// Observation only: a virtual group ends at its leader's ORIGINAL native
// success callback, before promise continuations. An overlapping async method
// is not enough: callers after that point must count as a new group. No native
// request, promise, authority, byte buffer or view is retained in these records.
type CurrencyPointState={future?:CurrencyPointToken};
type CurrencyPointToken={state:CurrencyPointState;leader?:CurrencyPointToken;issued:boolean};
const currencyPointStates=new WeakMap<object,CurrencyPointState>();
function nativeCurrencyAdmit(view:object):CurrencyPointToken|undefined{
 if(Reflect.get(globalThis,"__r8CriticalProfiling")!==true)return undefined;
 let state=currencyPointStates.get(view);if(!state){state={};currencyPointStates.set(view,state);}
 const token:CurrencyPointToken={state,issued:false};
 metricCount("native-currency-admitted-before-point");
 if(state.future){token.leader=state.future;metricCount("native-currency-shareable-future-point");
  metricCount(state.future.issued?"native-currency-shareable-request-started":"native-currency-shareable-read-turn-queued");}
 else{state.future=token;metricCount("native-currency-distinct-future-point");}
 return token;
}
function nativeCurrencyIssued(token:CurrencyPointToken|undefined){if(token)token.issued=true;}
function nativeCurrencyPoint(token:CurrencyPointToken|undefined){
 if(!token)return;
 metricCount("native-currency-original-point-serviced");
 if(token.state.future===token)token.state.future=undefined;
}
function nativeCurrencyEnd(token:CurrencyPointToken|undefined){
 if(token!==undefined&&token.state.future===token)token.state.future=undefined;
}
Object.assign(globalThis,{__warmNativeCurrencyAdmit:nativeCurrencyAdmit,__warmNativeCurrencyIssued:nativeCurrencyIssued,
 __warmNativeCurrencyPoint:nativeCurrencyPoint,__warmNativeCurrencyEnd:nativeCurrencyEnd});
function metricFailure(value:ReturnType<typeof metricBegin>){if(value){if(!value.attributionOnly)value.row.thrown++;value.failed=true;}}
// A body finally runs before an un-awaited returned Promise settles. Record
// the actual selected return (including original finally overrides), then
// observe it after the original body unwinds. Never insert a product await or
// replace its returned value/promise just to time it.
function metricReturned<T>(value:ReturnType<typeof metricBegin>,returned:T):T{if(value)value.returned=returned;return returned;}
function metricFinish(value:ReturnType<typeof metricBegin>){
 if(value===undefined)return;
 const returned=value.returned;value.returned=undefined;
 if(!value.failed&&returned instanceof Promise){
  void returned.then(()=>metricEnd(value),()=>{metricFailure(value);metricEnd(value);});
 }else metricEnd(value);
}
function observeMetric<T>(phase:string,operation:()=>T):T {
 const value=metricBegin(phase);let result:T;
 try{result=operation();}catch(error){metricFailure(value);metricEnd(value);throw error;}
 const completed=(result:unknown)=>{if(value&&result!==null&&typeof result==="object"&&Object.getOwnPropertyDescriptor(result,"ok")?.value===false)value.row.returnedRefusals++;metricEnd(value);};
 if(result instanceof Promise)void result.then(completed,()=>{metricFailure(value);metricEnd(value);});else completed(result);
 return result; // exact original result/promise; no admission or lifetime substituted
}
function criticalSnapshot(){return {timeOrigin:performance.timeOrigin,scalarCounters,scalarByEpoch:[...scalarByEpoch].map(([epoch,counters])=>({epoch,counters})),metrics:[...criticalMetrics.entries()].map(([key,row])=>({key,...row})),metricsTruncated,metricLimit,spanLimit,spansTruncated,timingMarksTruncated,markLimit,criticalObserverMilliseconds,
 qualification:"Actual function entries/completions and inclusive elapsed times; samples are separate. Completed timings exclude in-flight calls. Static decode/encode callsites and their canonical-decode/encode rows aggregate across the whole realm; row context fields are first-entry labels, not epoch/ordinal segmentation. Other owners aggregate by role/epoch/command, not ordinal. canonical-capture-row outputBytes are logical captured encoding sizes, canonical-capture-compose outputBytes are full flattened outputs, and canonical-capture-reused-fragment inputBytes are logical fragment occurrences not recursively revalidated; these overlap and are not unique workload, storage or memory bytes. Exported canonical-encode counters exclude these internal capture paths. Original spans retain per-operation waterfall. Current command context is observational, not asynchronous causal authority. Counter/mark handler overhead excludes instrumentation calls and event construction."};}
Object.assign(globalThis,{__warmMetricBegin:metricBegin,__warmMetricEnd:metricEnd,__warmMetricBytes:metricBytes,__warmMetricCount:metricCount,__warmMetricFailure:metricFailure,__warmMetricReturned:metricReturned,__warmMetricFinish:metricFinish,__warmObserveMetric:observeMetric,__r8CriticalSnapshot:criticalSnapshot});

// Diagnostic-only whole-bundle function instrumentation. These are execution
// wall intervals, NOT CPU clocks. Suspension leaves the execution stack; another
// callback's computation must never be counted as the suspended function's self
// work. The VM/native CPU capture is an independent measurement.
type FullFunctionMeta={phase:string;role:string;transition:number;rpcToken:number;timeOrigin:number};
type FullFunctionRow={id:number;entered:number;enteredBeforeCapture:number;bodyExited:number;thrown:number;
 selfMilliseconds:number;bodyElapsedMilliseconds:number;awaitMilliseconds:number;yieldMilliseconds:number;
 delegatedMilliseconds:number;suspensions:number;resumptions:number;selectedReturns:number};
type FullFunctionFrame={id:number;flags:number;state?:FullFunctionWindow;row?:FullFunctionRow;call?:number;
 parent?:FullFunctionFrame;lexicalParent?:number;started?:number;waiting?:{begin:number;kind:string;site?:string};
 hasReturn?:boolean;failed?:boolean;exited?:boolean};
type FullFunctionWindow={meta:FullFunctionMeta;begin:number;end?:number;last:number;current?:FullFunctionFrame;
 rows:Map<number,FullFunctionRow>;live:Set<FullFunctionFrame>;edges:Map<string,number>;
 waits:{id:number;call:number;kind:string;site?:string;begin:number;end:number;milliseconds:number}[];
 observerMilliseconds:number;selfMilliseconds:number;unownedMilliseconds:number;calls:number;
 invalid:string[];waitsTruncated:boolean;edgesTruncated:boolean;manifestSize:number;
 lastBoundary?:{kind:string;id?:number};unownedIntervals:{begin:number;end:number;milliseconds:number;previous?:{kind:string;id?:number};next?:{kind:string;id?:number}}[];unownedIntervalsTruncated:boolean};
let fullFunctionWindow:FullFunctionWindow|undefined, fullFunctionLastSnapshot:unknown;
// Diagnostic only: prior selected288 has50,336 top-level body entries plus
// resumptions. This explicit finite scalar interval budget is not a product
// capacity or a claim about JavaScript heap bytes. Truncation invalidates full
// attribution, while cumulative time remains available to report the failure.
const unownedIntervalLimit=100_000;
// Expanded async-owner297 actually completed22,900 waits; the old20k table
// truncated. Same explicit diagnostic-only finite scalar interval budget.
const functionWaitLimit=100_000;
function fullFunctionAccount(state:FullFunctionWindow,now:number,next?:{kind:string;id?:number}):void {
 const elapsed=now-state.last;
 if(elapsed<0){if(state.invalid.length<32)state.invalid.push("nonmonotone execution clock");return;}
 if(state.current?.row){state.current.row.selfMilliseconds+=elapsed;state.selfMilliseconds+=elapsed;}
 else {state.unownedMilliseconds+=elapsed;if(elapsed>0){if(state.unownedIntervals.length<unownedIntervalLimit)state.unownedIntervals.push({begin:state.last,end:now,milliseconds:elapsed,previous:state.lastBoundary,next});else state.unownedIntervalsTruncated=true;}}
 state.last=now;
}
function fullFunctionMeasured<T>(state:FullFunctionWindow,action:(now:number)=>T,boundary?:{kind:string;id?:number}):T {
 const now=performance.now();fullFunctionAccount(state,now,boundary);
 try{return action(now);}finally{const end=performance.now();state.observerMilliseconds+=end-now;state.last=end;state.lastBoundary=boundary;}
}
function fullFunctionRow(state:FullFunctionWindow,id:number):FullFunctionRow|undefined {
 if(!Number.isSafeInteger(id)||id<0||id>=state.manifestSize){
  if(state.invalid.length<32)state.invalid.push("function outside pinned manifest:"+id);return undefined;
 }
 let row=state.rows.get(id);
 if(!row){row={id,entered:0,enteredBeforeCapture:0,bodyExited:0,thrown:0,selfMilliseconds:0,
  bodyElapsedMilliseconds:0,awaitMilliseconds:0,yieldMilliseconds:0,delegatedMilliseconds:0,
  suspensions:0,resumptions:0,selectedReturns:0};state.rows.set(id,row);}
 return row;
}
function fullFunctionAdopt(state:FullFunctionWindow,frame:FullFunctionFrame,now:number,entered:boolean):void {
 frame.state=state;frame.row=fullFunctionRow(state,frame.id);frame.started=now;frame.call=++state.calls;
 frame.waiting=undefined;frame.exited=false;frame.parent=state.current;
 if(frame.row){if(entered)frame.row.entered++;else frame.row.enteredBeforeCapture++;}
 const key=(state.current?.id??-1)+":"+frame.id;
 if(state.edges.has(key))state.edges.set(key,state.edges.get(key)!+1);
 else if(state.edges.size<spanLimit)state.edges.set(key,1);else state.edgesTruncated=true;
 state.live.add(frame);state.current=frame;
}
function fullFunctionEnter(id:number,lexicalParent?:FullFunctionFrame,flags=0):FullFunctionFrame|undefined {
 const state=fullFunctionWindow;
 // A suspended function that began before the capture must still enroll on
 // its actual resume. Only may-suspend functions need this dormant token.
 if(state===undefined)return flags===0?undefined:{id,flags};
 return fullFunctionMeasured(state,now=>{
  const frame:FullFunctionFrame={id,flags,lexicalParent:lexicalParent?.call};
  fullFunctionAdopt(state,frame,now,true);return frame;
 },{kind:"enter",id});
}
function fullFunctionCloseWait(state:FullFunctionWindow,frame:FullFunctionFrame,now:number):void {
 const wait=frame.waiting;if(!wait)return;const elapsed=now-wait.begin;
 if(frame.row){if(wait.kind==="yield*")frame.row.delegatedMilliseconds+=elapsed;
  else if(wait.kind==="yield")frame.row.yieldMilliseconds+=elapsed;else frame.row.awaitMilliseconds+=elapsed;
  frame.row.resumptions++;}
 if(state.waits.length<functionWaitLimit)state.waits.push({id:frame.id,call:frame.call!,kind:wait.kind,...(wait.site===undefined?{}:{site:wait.site}),begin:wait.begin,end:now,milliseconds:elapsed});
 else state.waitsTruncated=true;
 frame.waiting=undefined;
}
function fullFunctionSuspend<T>(frame:FullFunctionFrame|undefined,value:T,kind="await",site?:string):T {
 const state=fullFunctionWindow;if(!frame||!state)return value;
 fullFunctionMeasured(state,now=>{
  if(frame.state!==state)fullFunctionAdopt(state,frame,now,false);
  if(state.current!==frame){if(state.invalid.length<32)state.invalid.push("suspend execution stack mismatch:"+frame.id);}
  else state.current=frame.parent;
  frame.parent=undefined;frame.waiting={begin:now,kind,...(site===undefined?{}:{site})};if(frame.row)frame.row.suspensions++;
 },{kind:"suspend",id:frame.id});return value;
}
function fullFunctionResume<T>(frame:FullFunctionFrame|undefined,value:T):T {
 const state=fullFunctionWindow;if(!frame||!state)return value;
 fullFunctionMeasured(state,now=>{
  if(frame.state!==state){fullFunctionAdopt(state,frame,now,false);return;}
  if(!frame.waiting)return;
  fullFunctionCloseWait(state,frame,now);frame.parent=state.current;state.current=frame;
 },{kind:"resume",id:frame.id});return value;
}
function fullFunctionResumeOnError(frame:FullFunctionFrame|undefined):void{fullFunctionResume(frame,undefined);}
function fullFunctionReturned<T>(frame:FullFunctionFrame|undefined,value:T):T {
 if(frame)frame.hasReturn=true;return value;
}
function fullFunctionThrown(frame:FullFunctionFrame|undefined,_error:unknown):void {
 if(!frame)return;fullFunctionResumeOnError(frame);frame.failed=true;if(frame.row)frame.row.thrown++;
}
function fullFunctionExit(frame:FullFunctionFrame|undefined):void {
 const state=fullFunctionWindow;if(!frame||!state)return;
 fullFunctionMeasured(state,now=>{
  if(frame.state!==state)fullFunctionAdopt(state,frame,now,false);
  fullFunctionCloseWait(state,frame,now);
  if(state.current===frame)state.current=frame.parent;
  else if(frame.parent!==undefined&&state.invalid.length<32)state.invalid.push("exit execution stack mismatch:"+frame.id);
  frame.parent=undefined;frame.exited=true;state.live.delete(frame);
  if(frame.row){frame.row.bodyExited++;frame.row.bodyElapsedMilliseconds+=now-frame.started!;}
  // Do not inspect/assimilate return values or attach .then observers: even a
  // Promise subclass can run a hostile species getter. Original callers' await
  // sites independently measure task waits. This row measures the body, not a
  // fabricated settlement point for an un-awaited returned task.
  if(!frame.failed&&frame.hasReturn&&frame.row)frame.row.selectedReturns++;
 },{kind:"exit",id:frame.id});
}
function fullFunctionSnapshot(state=fullFunctionWindow):unknown {
 if(!state)return fullFunctionLastSnapshot;
 const now=state.end??performance.now();
 const partition=state.selfMilliseconds+state.unownedMilliseconds+state.observerMilliseconds;
 return {meta:state.meta,timeOrigin:performance.timeOrigin,begin:state.begin,end:state.end??null,
  elapsedMilliseconds:now-state.begin,manifestSize:state.manifestSize,calls:state.calls,
  rows:[...state.rows.values()].map(row=>({...row})),edges:[...state.edges].map(([edge,calls])=>({edge,calls})),waits:[...state.waits],
  openBodies:[...state.live].map(frame=>({id:frame.id,call:frame.call,waiting:frame.waiting,started:frame.started})),
  currentExecutingBody:state.current===undefined?null:{id:state.current.id,call:state.current.call},waitLimit:functionWaitLimit,
  selfExecutionWallMilliseconds:state.selfMilliseconds,unownedWallMilliseconds:state.unownedMilliseconds,
  observerMilliseconds:state.observerMilliseconds,partitionMilliseconds:partition,reconciliationResidualMilliseconds:now-state.begin-partition,
  unownedIntervals:[...state.unownedIntervals],unownedIntervalsTruncated:state.unownedIntervalsTruncated,unownedIntervalLimit,
  invalid:[...state.invalid],waitsTruncated:state.waitsTruncated,edgesTruncated:state.edgesTruncated,
  qualification:"Every instrumented body entry/exit and original await/yield boundary; exact body counts, not CPU samples. Self execution is wall time with nested instrumented calls and suspension removed, NOT CPU; includes native builtins, automatic GC and descheduling inside the segment. Await intervals overlap other work and must not be added to self/partition. yield* and for-await are opaque delegated/iterator computation and suspension, not pure waits. observerMilliseconds measures handlers only, not all inserted-call, JIT/deoptimization or instrumentation overhead. Capture-before-entry continuations are separate. Parameter/default evaluation occurs before body entry. Native/unknown thenable settlement is not assimilated. Observation-runtime functions are excluded explicitly. Open bodies, truncation, unknown IDs, stack mismatches and nonzero reconciliation residual invalidate a claim of complete attribution."};
}
export function beginFullFunctionWindow(meta:FullFunctionMeta):void {
 if(Reflect.get(globalThis,"__r8FullFunctionCalls")!==true)return;
 const required=Reflect.get(globalThis,"__r8RequiredFunctionClockScope");
 if(required!==undefined&&Reflect.get(globalThis,"__r8FunctionClockScope")!==required)throw Error("FUNCTION_CLOCK_BUILD_SCOPE_MISMATCH");
 if(fullFunctionWindow&&JSON.stringify(fullFunctionWindow.meta)!==JSON.stringify(meta))throw Error("FULL_FUNCTION_CAPTURE_OVERLAP");
 const count=Reflect.get(globalThis,"__r8FunctionManifestSize");
 if(!Number.isSafeInteger(count)||count<=0)throw Error("FULL_FUNCTION_PINNED_MANIFEST_MISSING");
 const now=performance.now();fullFunctionWindow={meta:{...meta},begin:now,last:now,rows:new Map(),live:new Set(),edges:new Map(),waits:[],
  calls:0,observerMilliseconds:0,selfMilliseconds:0,unownedMilliseconds:0,invalid:[],waitsTruncated:false,edgesTruncated:false,manifestSize:count,
  unownedIntervals:[],unownedIntervalsTruncated:false,lastBoundary:{kind:"capture-begin"}};
 Reflect.set(globalThis,"__r8FunctionWindowActive",true);
}
export function endFullFunctionWindow():unknown {
 const state=fullFunctionWindow;if(!state)return fullFunctionLastSnapshot;
 const now=performance.now();fullFunctionAccount(state,now,{kind:"capture-end"});state.end=now;
 fullFunctionLastSnapshot=fullFunctionSnapshot(state);fullFunctionWindow=undefined;
 Reflect.set(globalThis,"__r8FunctionWindowActive",false);return fullFunctionLastSnapshot;
}
Object.assign(globalThis,{__r8FunctionEnter:fullFunctionEnter,__r8FunctionSuspend:fullFunctionSuspend,
 __r8FunctionResume:fullFunctionResume,__r8FunctionResumeOnError:fullFunctionResumeOnError,
 __r8FunctionReturned:fullFunctionReturned,__r8FunctionThrown:fullFunctionThrown,__r8FunctionExit:fullFunctionExit,
 __r8FunctionWindowBegin:beginFullFunctionWindow,__r8FunctionWindowEnd:endFullFunctionWindow,__r8FunctionSnapshot:fullFunctionSnapshot});

export const proofEvents: unknown[] = [];
export let proofEventsTruncated = false;
// Measurement-only evidence buffer per frame realm. The steady per-rollover volume
// is constant, so a fixed cap bounds the configured run length rather than any
// growth. A harness may raise it for longer bounded runs before this realm loads;
// 50,000 stays the default and the floor.
const configuredProofEventBudget = Reflect.get(globalThis, "__r8ProofEventBudget");
export const proofEventBudget =
  typeof configuredProofEventBudget === "number" && Number.isSafeInteger(configuredProofEventBudget) && configuredProofEventBudget > 50_000
    ? configuredProofEventBudget
    : 50_000;
export let proofObserverMilliseconds = 0;
export const proofOwnerSummaries = new Map<number, {owner:number;initialBytes:number;chargedBytes:number;unknownBytes:number;forecastMaximum?:number;forecasts:number;completedCurrentJobPhases?:number;completedCurrentJobJournalComputations?:number}>();
let proofOwner = 0;
const proofOwnerIds = new WeakMap<object, number>();
function proofEvent(event: Readonly<Record<string, unknown>>): void {
  const start = performance.now();
  if (typeof event.owner === "number") {
    let summary=proofOwnerSummaries.get(event.owner);
    if(!summary){summary={owner:event.owner,initialBytes:typeof event.chargedBytes==="number"?event.chargedBytes:0,chargedBytes:0,unknownBytes:0,forecasts:0};proofOwnerSummaries.set(event.owner,summary);}
    if(typeof event.chargedBytes==="number")summary.chargedBytes=Math.max(summary.chargedBytes,event.chargedBytes);
    if(typeof event.unknownBytes==="number")summary.unknownBytes=Math.max(summary.unknownBytes,event.unknownBytes);
    if(event.kind==="complete-proof-forecast"&&Array.isArray(event.fullFutureProofEnvelopeByteLengths)){
      summary.forecasts++;summary.forecastMaximum=Math.max(summary.forecastMaximum??0,...event.fullFutureProofEnvelopeByteLengths as number[]);
      // Completed schedule branches only; no extra reads, timers or product
      // counter. A branch that refuses before this event is not counted.
      if(typeof event.currentJobPhaseCount==="number"&&Number.isSafeInteger(event.currentJobPhaseCount)&&event.currentJobPhaseCount>=0)
        summary.completedCurrentJobPhases=(summary.completedCurrentJobPhases??0)+event.currentJobPhaseCount;
      if(typeof event.currentJobJournalComputations==="number"&&Number.isSafeInteger(event.currentJobJournalComputations)&&event.currentJobJournalComputations>=0)
        summary.completedCurrentJobJournalComputations=(summary.completedCurrentJobJournalComputations??0)+event.currentJobJournalComputations;
    }
  }
  if (proofEvents.length < proofEventBudget) proofEvents.push({ ...event, ...context, time: start });
  else proofEventsTruncated = true;
  proofObserverMilliseconds += performance.now() - start;
}
// Diagnostic-only: inspect the guard's already visited set, not another graph
// walk. Keep no inputs/references and never read a caller's accessor or bytes.
export function ordinaryIntegrityShape(value: unknown, supported: boolean, visited: ReadonlySet<object>): Readonly<Record<string, unknown>> | undefined {
  const descriptor=(object:unknown,key:PropertyKey)=>object!==null&&typeof object==="object"?Object.getOwnPropertyDescriptor(object,key):undefined;
  const kind=(field:PropertyDescriptor|undefined)=>field===undefined?"absent":"value" in field?"data":"accessor";
  const fields=["current","scope","history","bootstrap","source"].map(key=>descriptor(value,key));
  if(!fields.every(field=>field!==undefined&&"value" in field))return undefined;
  if(visited.size>65_536)return {kind:"dimension-integrity-shape",diagnosticFailure:"original-visited-bound-exceeded"};
  const bootstrap=fields[3]!.value,source=fields[4]!.value,sourceBootstrap=descriptor(source,"bootstrap");
  const prototype=Uint8Array.prototype,typedPrototype=Object.getPrototypeOf(prototype);
  const intrinsic=Object.getOwnPropertyDescriptor(typedPrototype,"byteLength")?.get;
  let byteLeaves=0,ownDataLengths=0,ownAccessorLengths=0,ownDataMatchesIntrinsic=0,lastVisitedKind="none";
  let lastByte:Readonly<Record<string,unknown>>|undefined;
  for(const item of visited){
    lastVisitedKind="object";
    if(!(item instanceof Uint8Array))continue;
    lastVisitedKind="bytes";byteLeaves++;
    const own=descriptor(item,"byteLength");let intrinsicLength:number|undefined;
    try {if(intrinsic!==undefined)intrinsicLength=Reflect.apply(intrinsic,item,[]) as number;}catch{/* scalar diagnostic only */}
    if(own!==undefined&&"value" in own){ownDataLengths++;if(own.value===intrinsicLength)ownDataMatchesIntrinsic++;}
    else if(own!==undefined)ownAccessorLengths++;
    lastByte={ownByteLength:kind(own),ownValueType:own!==undefined&&"value" in own?typeof own.value:"none",
      ownDataMatchesIntrinsic:own!==undefined&&"value" in own&&intrinsicLength!==undefined&&own.value===intrinsicLength,
      intrinsicLengthAvailable:intrinsicLength!==undefined,prototypeSame:Object.getPrototypeOf(item)===prototype,
      ownIteratorAbsent:descriptor(item,Symbol.iterator)===undefined,prototypeByteLengthAbsent:descriptor(prototype,"byteLength")===undefined,
      bootstrapReference:item===bootstrap,sourceBootstrapReference:sourceBootstrap!==undefined&&"value" in sourceBootstrap&&item===sourceBootstrap.value,
      configurable:own?.configurable??null,enumerable:own?.enumerable??null,writable:own!==undefined&&"value" in own?own.writable??false:null};
  }
  return {kind:"dimension-integrity-shape",supported,contextHasBootstrapField:true,sourceBootstrapDescriptor:kind(sourceBootstrap),
    visitedObjects:visited.size,byteLeaves,ownDataLengths,ownAccessorLengths,ownDataMatchesIntrinsic,lastVisitedKind,lastByte:lastByte??null};
}
Object.assign(globalThis, {
  __warmProofOwner: () => ++proofOwner,
  __warmProofEvent: proofEvent,
  __warmBindProofOwner: (owner: object, id: number) => proofOwnerIds.set(owner, id),
  __warmProofIdentity: (owner: object) => proofOwnerIds.get(owner),
  __warmDimensionIntegrityShape:(value:unknown,supported:boolean,visited:ReadonlySet<object>)=>{
    if(context.role!=="creator"||context.transition!==4)return;
    observeMetric("test-only-dimension-integrity-shape",()=>{try{const event=ordinaryIntegrityShape(value,supported,visited);if(event)proofEvent(event);}catch{proofEvent({kind:"dimension-integrity-shape",diagnosticFailure:"shape-inspection-threw"});}});
  },
});

