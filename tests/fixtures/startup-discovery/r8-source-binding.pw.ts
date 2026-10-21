import {expect,test as base} from "@playwright/test";
import {execFile,spawn} from "node:child_process";
import {mkdtemp,stat,open} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute,join} from "node:path";
import {promisify} from "node:util";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {server} from "./server.js";
// Never repair invalid V8 timelines by clamping negative deltas. Preserve the
// original profile, and prohibit temporal attribution if any sample is invalid.
function validateCriticalCpuProfile(profile:any){
 const failures:string[]=[],nodes=new Set<number>();
 if(!Number.isFinite(profile?.startTime)||!Number.isFinite(profile?.endTime)||profile.endTime<profile.startTime)failures.push("invalid start/end timestamps");
 if(!Array.isArray(profile?.nodes))failures.push("nodes absent");
 for(const node of Array.isArray(profile?.nodes)?profile.nodes:[]){if(!Number.isSafeInteger(node.id)||node.id<=0||nodes.has(node.id))failures.push("invalid/duplicate node id");nodes.add(node.id);}
 for(const node of Array.isArray(profile?.nodes)?profile.nodes:[])for(const child of node.children??[])if(!nodes.has(child))failures.push("unknown child node id");
 const samples=profile?.samples,deltas=profile?.timeDeltas;
 if(!Array.isArray(samples)||!Array.isArray(deltas)||samples.length!==deltas.length)failures.push("sample/delta arrays absent or unequal");
 let elapsed=0,negativeDeltas=0,outOfBoundsSamples=0,unknownSampleIds=0,invalidDeltas=0;
 for(let index=0;index<(deltas?.length??0);index++){
  const delta=deltas[index];if(!Number.isFinite(delta)||delta<0){invalidDeltas++;if(delta<0)negativeDeltas++;}
  elapsed+=delta;if(!Number.isFinite(elapsed)||profile.startTime+elapsed>profile.endTime)outOfBoundsSamples++;
 }
 for(const sample of Array.isArray(samples)?samples:[])if(!nodes.has(sample))unknownSampleIds++;
 if(invalidDeltas)failures.push("invalid sample deltas");if(outOfBoundsSamples)failures.push("sample timestamps outside profile bounds");if(unknownSampleIds)failures.push("unknown sampled node ids");
 return {valid:failures.length===0,failures:[...new Set(failures)],negativeDeltas,invalidDeltas,outOfBoundsSamples,unknownSampleIds,
  samples:samples?.length??0,nodes:nodes.size,startTime:profile?.startTime,endTime:profile?.endTime,sumTimeDeltas:elapsed,
  qualification:"CPU samples are not invocation counts. Invalid profiles remain raw evidence, not a valid flamegraph/wall-time partition."};
}
function validateCriticalCoverage(coverage:any){
 let functions=0,calls=0;const failures:string[]=[];
 if(!Array.isArray(coverage?.result)||!Number.isFinite(coverage?.timestamp))failures.push("invalid coverage response");
 for(const script of Array.isArray(coverage?.result)?coverage.result:[]){
  if(typeof script.scriptId!=="string"||typeof script.url!=="string"||!Array.isArray(script.functions))failures.push("invalid script identity/functions");
  for(const fn of script.functions??[]){functions++;if(!Array.isArray(fn.ranges)||fn.ranges.length===0)failures.push("function ranges absent");
   for(const range of fn.ranges??[])if(!Number.isSafeInteger(range.startOffset)||!Number.isSafeInteger(range.endOffset)||range.startOffset<0||range.endOffset<range.startOffset||!Number.isSafeInteger(range.count)||range.count<0)failures.push("invalid function range/count");
   calls+=fn.ranges?.[0]?.count??0;
  }
 }
 return {valid:failures.length===0,failures:[...new Set(failures)],scripts:coverage?.result?.length??0,functions,calls,timestamp:coverage?.timestamp,
  qualification:"V8 precise per-function call counts for this isolate and capture interval, not CPU samples or cross-client causal attribution. Precise coverage prevents optimized execution; diagnostic timings are not an unprofiled performance result."};
}
function selectCriticalTraceCategories(available:readonly string[],handoffOnly=false,rendererOnly=false,rendererTasks=false):string[]{
 // Exact names only: substring "file" also matches "cpu_profiler". Enabling
 // that starts another profiler and does not measure filesystem work.
 const native=["IndexedDB","indexeddb","disabled-by-default-indexeddb","leveldb","disabled-by-default-leveldb"];
 return ["devtools.timeline","blink.user_timing",...(handoffOnly?[]:["disabled-by-default-v8.gc"]),...(rendererOnly?[]:native.filter(category=>available.includes(category))),
  ...(rendererTasks?["v8.execute","toplevel"].filter(category=>available.includes(category)):[])];
}
function criticalCaptureModes(mode:"full-calls"|"cpu-only"|"trace-only"|"allocation-only"|"system-trace"|"self-only"|"self-trace"){
 return {v8CpuProfiling:mode==="cpu-only",nativeTracing:mode!=="cpu-only"&&mode!=="system-trace"&&mode!=="self-only",allocationSampling:mode==="allocation-only"};
}
function verifiedCriticalSourceReuse(reportedHash:unknown,pins:Iterable<any>){
 if(typeof reportedHash!=="string"||!/^[0-9a-f]{64}$/u.test(reportedHash))return undefined;
 for(const pin of pins)if(pin.independentlyFetchedSource===true&&pin.sha256===reportedHash)return pin;
 return undefined;
}
function validateCriticalAllocationProfile(profile:any){
 const failures:string[]=[],nodes=new Set<number>(),ordinals=new Set<number>(),pending=[profile?.head];
 let nodeSelfSize=0,sampledEstimatedBytes=0;
 while(pending.length){const node=pending.pop();if(!node||!Number.isSafeInteger(node.id)||nodes.has(node.id)||!Number.isFinite(node.selfSize)||node.selfSize<0){failures.push("invalid/duplicate allocation node");continue;}
  nodes.add(node.id);nodeSelfSize+=node.selfSize;if(nodes.size>200_000){failures.push("allocation node bound exceeded");break;}
  if(!node.callFrame||!Array.isArray(node.children)){failures.push("invalid allocation call frame/children");continue;}for(const child of node.children)pending.push(child);
 }
 if(!Array.isArray(profile?.samples))failures.push("allocation samples absent");
 else if(profile.samples.length>2_000_000)failures.push("allocation sample bound exceeded");
 else for(const sample of profile.samples){if(!nodes.has(sample.nodeId)||!Number.isFinite(sample.size)||sample.size<0||!Number.isSafeInteger(sample.ordinal)||ordinals.has(sample.ordinal))failures.push("invalid/duplicate allocation sample");
  ordinals.add(sample.ordinal);sampledEstimatedBytes+=sample.size;}
 return {valid:failures.length===0,failures:[...new Set(failures)],nodes:nodes.size,samples:profile?.samples?.length??0,nodeSelfSize,sampledEstimatedBytes,
  qualification:"Phase-scoped sampled allocation estimates, including collected objects when both flags are enabled; not allocation call counts, every byte, live memory or a retained/temporary split. Allocation ordinals are not timestamps."};
}
// Only this opt-in resource run changes the original launcher's context.
// Its default incognito context has no on-disk IndexedDB directory to measure.
const test=process.env.STARTUP_SOURCE_NATIVE_RESOURCES==="1"?base.extend({
	context:async({playwright,browserName},use)=>{
		if(browserName!=="chromium")throw new Error("persistent native resource context requires Chromium");
		const profile=await mkdtemp(join(tmpdir(),"r8-native-source-resource-"));
		const context=await playwright.chromium.launchPersistentContext(profile,{headless:true,args:["--enable-automation"]});
		try{await use(context);}finally{await context.close();}
	},
}):base;
let local:Awaited<ReturnType<typeof server>>;
const suspendHealthyGrid=process.env.STARTUP_HEALTHY_GRID_SUSPEND==="1";
test(suspendHealthyGrid?"native Grid resumes renderer suspension during admitted recipient snapshot transfer":"healthy native Grid integrates gameplay warm rollover cleanup persisted reopen and continuation",async({page},info)=>{
 test.setTimeout(360_000);
 let browserFailureMessages=0;
 let browserIngressFailureMessages=0;
 let checkpointMemoryMessages=0;
 page.on("console",message=>{
  if(message.type()==="info"&&message.text().startsWith('{"kind":"healthy-native-admission-memory"')){
   if(checkpointMemoryMessages++<4)console.info(message.text().slice(0,8192));return;
  }
  if(message.type()!=="warning"&&message.type()!=="error")return;
  // Preserve the original finite 128-message allowance, reserving space for
  // existing ingress error hooks instead of consuming it all on fence traces.
  const text=message.text(),ingressFailure=text.startsWith('{"kind":"healthy-ingress-')&&text.includes('-error"')||
   text.startsWith("::v3-ingress admission-rejected received-maintenance-");
  const count=ingressFailure?browserIngressFailureMessages:browserFailureMessages,limit=ingressFailure?32:96;
  if(count<limit)console.info(JSON.stringify({kind:"healthy-native-browser-diagnostic",type:message.type(),text:text.slice(0,4096),location:message.location()}));
  else if(count===limit)console.info(JSON.stringify({kind:"healthy-native-browser-diagnostic",truncated:true,category:ingressFailure?"ingress-error":"other",limit}));
  if(ingressFailure)browserIngressFailureMessages=Math.min(count+1,limit+1);
  else browserFailureMessages=Math.min(count+1,limit+1);
 });
 if(process.env.STARTUP_SOURCE_NATIVE_RESOURCES!=="1"||info.project.name!=="chromium")throw new Error("integrated resource case requires existing persistent Chromium measurement mode");
 const directory=process.env.STARTUP_ARTIFACTS;if(directory===undefined)throw new Error("current native artifacts required");
 const finishingWindowFile=process.env.STARTUP_HEALTHY_GRID_FINISHING_WINDOW_FILE;
 if(finishingWindowFile!==undefined){
  const declaration=JSON.parse(readFileSync(finishingWindowFile,"utf8"));
  await page.context().addInitScript(value=>Reflect.set(globalThis,"__r8OrdinaryFinishingWindow",value),declaration);
  await info.attach("healthy-native-local-finishing-window",{body:Buffer.from(JSON.stringify(declaration)),contentType:"application/json"});
 }
 const criticalProfiling=process.env.STARTUP_HEALTHY_GRID_CRITICAL_PROFILE==="1";
 const fullFunctionCalls=process.env.STARTUP_HEALTHY_GRID_FULL_CALLS==="1";
 if(fullFunctionCalls&&!criticalProfiling)throw new Error("full function capture requires existing critical instrumentation");
 const profileMode=process.env.STARTUP_HEALTHY_GRID_PROFILE_MODE??"full-calls";
 if(profileMode!=="full-calls"&&profileMode!=="cpu-only"&&profileMode!=="trace-only"&&profileMode!=="allocation-only"&&profileMode!=="system-trace"&&profileMode!=="self-only"&&profileMode!=="self-trace")throw new Error("bounded full-calls, cpu-only, trace-only, allocation-only, system-trace, self-only or self-trace profile mode required");
 const exactFunctionCalls=fullFunctionCalls&&profileMode==="full-calls";
 const selfFunctionCalls=fullFunctionCalls&&(profileMode==="self-only"||profileMode==="self-trace");
 const handoffOnly=process.env.STARTUP_HEALTHY_GRID_TRACE_DETAIL==="handoff";
 const rendererTaskTrace=process.env.STARTUP_HEALTHY_GRID_TRACE_DETAIL==="renderer-tasks";
 const rendererTraceOnly=process.env.STARTUP_HEALTHY_GRID_TRACE_DETAIL==="renderer"||rendererTaskTrace;
 if(process.env.STARTUP_HEALTHY_GRID_TRACE_DETAIL!==undefined&&!(handoffOnly&&profileMode==="trace-only")&&!(rendererTraceOnly&&(profileMode==="self-trace"||profileMode==="trace-only")))throw Error("NATIVE_HANDOFF_TRACE_SCOPE_INVALID");
 const bodyFunctionCalls=exactFunctionCalls||selfFunctionCalls;
 if((profileMode==="self-only"||profileMode==="self-trace")&&(!fullFunctionCalls||process.env.STARTUP_HEALTHY_GRID_OWNER_CLOCK_SCOPE!=="retirement"))throw Error("SELF_ONLY_REQUIRES_RETIREMENT_SCOPE");
 const captureModes=criticalCaptureModes(profileMode);
 if((profileMode==="trace-only"||profileMode==="allocation-only"||profileMode==="system-trace")&&!fullFunctionCalls)throw new Error("trace/allocation/system diagnostic requires original bounded E4 API windows");
 if(fullFunctionCalls)await page.context().addInitScript(exact=>{
  Reflect.set(globalThis,"__r8FunctionCaptureEnabled",true);Reflect.set(globalThis,"__r8FullFunctionCalls",exact);
 },bodyFunctionCalls);
 if(selfFunctionCalls)await page.context().addInitScript(()=>Reflect.set(globalThis,"__r8RequiredFunctionClockScope","retirement"));
 const incrementalNativeControls=process.env.STARTUP_HEALTHY_GRID_INCREMENTAL_CONTROLS==="1";
 if(incrementalNativeControls&&!criticalProfiling)throw new Error("incremental native controls require existing critical build/runtime instrumentation");
 if(incrementalNativeControls)await page.context().addInitScript(()=>Reflect.set(globalThis,"__r8IncrementalNativeControls",true));
 const criticalTimingsOnly=process.env.STARTUP_HEALTHY_GRID_CRITICAL_TIMINGS_ONLY==="1";
 if(criticalTimingsOnly&&!criticalProfiling)throw new Error("critical timing-only mode requires existing critical instrumentation");
 if(criticalProfiling)await page.context().addInitScript(()=>{
  Reflect.set(globalThis,"__r8CriticalProfiling",true);
  const delays:{scheduledAt:number;firedAt:number;delayMilliseconds:number}[]=[],limit=4096;
  let due=performance.now()+100,truncated=false;
  setInterval(()=>{const now=performance.now();if(delays.length<limit)delays.push({scheduledAt:due,firedAt:now,delayMilliseconds:Math.max(0,now-due)});else truncated=true;due=now+100;},100);
  Reflect.set(globalThis,"__r8EventLoopCheckpoint",()=>({timeOrigin:performance.timeOrigin,delays,truncated,limit,
   qualification:"Timer scheduling drift, not a classification of native waits or scheduler contention; captures blocked JS, GC and scheduling together."}));
 });
 // Main-thread long tasks, observed in every frame realm (each role frame and
 // the top page). Observation only; role frames report theirs at close.
 const longTasks=process.env.STARTUP_HEALTHY_GRID_LONGTASKS==="1";
 if(longTasks)await page.context().addInitScript(()=>{const entries:{startTime:number;duration:number;name:string}[]=[];let truncated=false;
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries()){if(entries.length<65536)entries.push({startTime:entry.startTime,duration:entry.duration,name:entry.name});else truncated=true;}})
   .observe({type:"longtask",buffered:true});}catch{}
  Reflect.set(globalThis,"__rdLongTasks",()=>({timeOrigin:performance.timeOrigin,entries:[...entries],truncated}));});
 // Measurement-only proof-event buffer, per frame realm. The creator's steady
 // volume is a constant ~3.7k events per rollover (Track R3's 16-rollover runs),
 // so the fixed 50,000 cap bounded the run at ~13 rollovers instead of detecting
 // growth. Scale it with the configured rollovers (4k per rollover plus one for
 // creation, the floor of 50,000 kept); the truncation checks below still apply.
 // Endurance runs (more than 32 rollovers) allow 6k per rollover: the room-retention creator emits
 // about 4.3k per rollover, and a 100-rollover run saturated 4k per rollover near rollover 94.
 const proofEventRollovers=Number(process.env.STARTUP_HEALTHY_GRID_ROLLOVERS??4);
 const proofEventBudget=Math.max(50_000,(proofEventRollovers>32?6_000:4_000)*(proofEventRollovers+1));
 await page.context().addInitScript(value=>Reflect.set(globalThis,"__r8ProofEventBudget",value),proofEventBudget);
 // Measurement only (endurance heap): STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS names the proof-event kinds each realm
 // retains; others are only counted. Unset by default (every event retained).
 const proofEventKinds=process.env.STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS;
 if(proofEventKinds!==undefined)await page.context().addInitScript(value=>Reflect.set(globalThis,"__r8ProofEventKinds",value),proofEventKinds.split(",").map(kind=>kind.trim()).filter(Boolean));
 // Measurement only (endurance heap): STARTUP_HEALTHY_GRID_HARNESS_RECORDS=counted also stops retaining the harness's other
 // per-epoch records (spans, per-owner proof summaries, startup trace events, the parent's per-move, per-checkpoint and
 // per-transition records, the transport fixture's per-message records); every realm counts them instead. Unset by default.
 const harnessRecords=process.env.STARTUP_HEALTHY_GRID_HARNESS_RECORDS;
 if(harnessRecords!==undefined&&harnessRecords!=="counted")throw new Error("harness records mode must be counted");
 if(harnessRecords==="counted")await page.context().addInitScript(()=>Reflect.set(globalThis,"__r8HarnessRecordsCounted",true));
 // Endurance runs (more than 32 rollovers) scale the per-role delivery telemetry bound the same way.
 const deliveryRollovers=Number(process.env.STARTUP_HEALTHY_GRID_ROLLOVERS??4),deliveryObservationBound=deliveryRollovers>32?32*(deliveryRollovers+1):1024;
 await page.context().addInitScript(value=>Reflect.set(globalThis,"__r8DeliveryObservationBound",value),deliveryObservationBound);
 const clients:Awaited<ReturnType<typeof server>>[]=[];
 for(let index=0;index<4;index++)clients.push(await server(directory));
 await page.goto(local.origin+"/r8-source-binding");
 await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8HealthyGrid")==="function");
 const cdp=await page.context().newCDPSession(page),command=await cdp.send("Browser.getBrowserCommandLine");
 const browserVersion=(await cdp.send("Browser.getVersion")).product;
 const profile=command.arguments.find(argument=>argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
 if(profile===undefined||!isAbsolute(profile))throw new Error("native profile unavailable");
 const physicalDirectory=join(profile,"Default","IndexedDB");
 const rollovers=Number(process.env.STARTUP_HEALTHY_GRID_ROLLOVERS??4),profileCpu=process.env.STARTUP_HEALTHY_GRID_CPU_PROFILE==="1"&&!criticalProfiling;
 const creatorProfile=process.env.STARTUP_HEALTHY_GRID_CREATOR_PROFILE??"creator-trusted-settlement-v1";
 if(creatorProfile!=="creator-trusted-settlement-v1"&&creatorProfile!=="creator-trusted-v1")throw new Error("existing creator profile required");
 // Both original profiles must traverse the SAME real room/native factories;
 // the V1 control uses that room's original settlement preview, never a fixture.
 // Eight traverses the existing seven-generation recovery ceiling and its
 // lawful turnover; four/five alone cannot distinguish warm-up from age growth.
 // Longer bounded runs (up to 32) pass the former epoch-8 recipient journal
 // ceiling and the 9->10 boundary of the snapshot protected-hole order.
 // Default acceptance workload/deadline and all per-transition assertions stay.
 // Endurance (measurement only): up to 128 rollovers, with the test deadline and the
 // diagnostic checkpoint timers scaled by the rollovers; at most 32 is unchanged.
 if(rollovers!==4&&rollovers!==5&&!(Number.isSafeInteger(rollovers)&&rollovers>=8&&rollovers<=128))throw new Error("bounded native pool-turnover extension required");
 const enduranceDeadline=rollovers>32?rollovers*30_000:undefined;
 if(enduranceDeadline!==undefined)test.setTimeout(enduranceDeadline);
 if(suspendHealthyGrid&&rollovers!==5)throw new Error("suspension must exercise the original full-pool recipient turnover");
 const executionContexts=new Map<number,{origin:string;defaultContext:boolean}>();
 if(suspendHealthyGrid){
  cdp.on("Runtime.executionContextCreated",({context})=>{executionContexts.set(context.id,{origin:context.origin,defaultContext:Reflect.get(context.auxData??{},"isDefault")===true});});
  cdp.on("Runtime.executionContextDestroyed",({executionContextId})=>{executionContexts.delete(executionContextId);});
  await cdp.send("Runtime.enable");
 }
 const samples:{elapsedMilliseconds:number;jsHeapUsedBytes:number;jsHeapTotalBytes:number;indexedDbAllocatedBytes:number}[]=[],samplingErrors:unknown[]=[];
 const started=performance.now();
 const sample=async()=>{
  const {metrics}=await cdp.send("Performance.getMetrics");
  const used=metrics.find(metric=>metric.name==="JSHeapUsedSize")?.value,total=metrics.find(metric=>metric.name==="JSHeapTotalSize")?.value;
  if(used===undefined||total===undefined)throw new Error("native heap metrics unavailable");
  const present=await stat(physicalDirectory).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error;});
  const allocated=present?Number((await promisify(execFile)("/usr/bin/du",["-sk",physicalDirectory])).stdout.split(/\s+/u)[0])*1024:0;
  if(!Number.isSafeInteger(allocated))throw new Error("native physical allocation invalid");
  samples.push({elapsedMilliseconds:performance.now()-started,jsHeapUsedBytes:used,jsHeapTotalBytes:total,indexedDbAllocatedBytes:allocated});
 };
 await cdp.send("Performance.enable");await sample();
 let pending=Promise.resolve();const timer=setInterval(()=>{pending=pending.then(sample).catch(error=>{samplingErrors.push(error);});},200);
 const activeMemory:unknown[]=[];
 // Measurement only: STARTUP_HEALTHY_GRID_HEAP_SNAPSHOTS names checkpoint labels (for example adopted-50,adopted-90); after
 // that checkpoint's forced GC a V8 heap snapshot of the renderer (every frame realm) is written to STARTUP_EVIDENCE as
 // heap-<label>.heapsnapshot. Unset by default (no snapshot).
 const heapSnapshotLabels=new Set((process.env.STARTUP_HEALTHY_GRID_HEAP_SNAPSHOTS??"").split(",").map(label=>label.trim()).filter(Boolean));
 if(heapSnapshotLabels.size&&process.env.STARTUP_EVIDENCE===undefined)throw new Error("heap snapshots require STARTUP_EVIDENCE");
 const heapSnapshots:unknown[]=[];
 const takeHeapSnapshot=async(label:string)=>{
  const path=join(process.env.STARTUP_EVIDENCE!,"heap-"+label.replace(/[^a-z0-9-]/giu,"_")+".heapsnapshot"),file=await open(path,"w");
  let bytes=0,writes=Promise.resolve();
  const chunk=({chunk}:{chunk:string})=>{bytes+=chunk.length;writes=writes.then(()=>file.write(chunk)).then(()=>undefined);};
  const started=performance.now();
  cdp.on("HeapProfiler.addHeapSnapshotChunk",chunk);
  try{await cdp.send("HeapProfiler.takeHeapSnapshot",{reportProgress:false});}finally{cdp.off("HeapProfiler.addHeapSnapshotChunk",chunk);await writes;await file.close();}
  heapSnapshots.push({label,path,characters:bytes,testOnlyMilliseconds:performance.now()-started});
 };
 await page.exposeFunction("__r8ActiveResourceCheckpoint",async(label:string)=>{
  await pending;await sample();const before=samples.at(-1),start=performance.now();
  await cdp.send("HeapProfiler.collectGarbage");const gcMilliseconds=performance.now()-start;await sample();
  activeMemory.push({label,before,after:samples.at(-1),testOnlyGcMilliseconds:gcMilliseconds});
  if(heapSnapshotLabels.has(label))await takeHeapSnapshot(label);
 });
 const suspensions:unknown[]=[];
 if(suspendHealthyGrid)await page.exposeFunction("__r8SuspendTransfer",async(metadata:any)=>{
  const origins=[local.origin,...clients.map(client=>client.origin)];
  const inspect=async()=>{
   const selected=[...executionContexts].filter(([,value])=>value.defaultContext&&origins.includes(value.origin));
   expect(selected).toHaveLength(5);
   return Promise.all(selected.map(async([id,value])=>{
    const name=value.origin===local.origin?"__r8FrozenRouteObservation":"__r8FrozenClientObservation";
    const result=await cdp.send("Runtime.evaluate",{contextId:id,expression:`globalThis.${name}()`,returnByValue:true});
    if(result.exceptionDetails!==undefined||result.result.value===undefined)throw new Error("native freeze probe context unavailable");
    return {origin:value.origin,value:result.result.value};
   }));
  };
  expect(metadata).toMatchObject({phase:"recipient-install-4:1",epoch:4,source:0,target:1,protocol:"/ts-drp/v3/creator-successor/1.0.0",pendingRpc:1,nativeSnapshotChunkIndex:0});
  expect(metadata.packetBytes).toBeGreaterThan(0);
  const before=await inspect(),start=performance.now();
  const source=before.find(row=>row.value.index===0),recipient=before.find(row=>row.value.index===1);
  expect(source?.value.transport.serveJobs).toBeGreaterThan(0);
  expect(source?.value.transport.pendingRequests).toBeGreaterThan(0);
  expect(recipient?.value.transport.streams).toBeGreaterThan(0);
  const browser=page.context().browser();if(browser===null)throw new Error("owned native browser process unavailable");
  const browserCdp=await browser.newBrowserCDPSession();
  const processes=(await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
  // SystemInfo belongs to this fresh persistent test-browser instance, not
  // the user's Chrome. Include any unused/spare renderer of that instance.
  const rendererPids=processes.filter(row=>row.type==="renderer").map(row=>row.id);
  expect(rendererPids.length).toBeGreaterThan(0);
  if(rendererPids.some(pid=>!Number.isSafeInteger(pid)||pid<=0||pid===process.pid))throw new Error("owned renderer PID invalid");
  const rootContext=[...executionContexts].find(([,value])=>value.defaultContext&&value.origin===local.origin)?.[0];
  if(rootContext===undefined)throw new Error("owned native root context absent");
  const stopped:number[]=[],stoppedStates:{pid:number;state:string}[]=[],stoppedStatesAfter:{pid:number;state:string}[]=[];
  let blockedProbe:Promise<any>|undefined,probeSettled=false,cpuBefore:{pid:number;seconds:number}[]|undefined,cpuDuring:{pid:number;seconds:number}[]|undefined;
  const cpu=async()=>{
   const current=(await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
   return rendererPids.map(pid=>{const row=current.find(value=>value.id===pid);if(row===undefined)throw new Error("owned renderer disappeared during suspension");return {pid,seconds:row.cpuTime};});
  };
  try{
   for(const pid of rendererPids){process.kill(pid,"SIGSTOP");stopped.push(pid);}
   for(const pid of rendererPids){const state=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","state="])).stdout.trim();stoppedStates.push({pid,state});expect(state).toContain("T");}
   cpuBefore=await cpu();
   blockedProbe=cdp.send("Runtime.evaluate",{contextId:rootContext,expression:"globalThis.__r8FrozenRouteObservation()",returnByValue:true});
   void blockedProbe.then(()=>{probeSettled=true;},()=>{probeSettled=true;});
   await new Promise(resolve=>setTimeout(resolve,500));
   expect(probeSettled,"JavaScript execution must not respond while the owned renderer is OS-suspended").toBe(false);
   cpuDuring=await cpu();
   // Kernel CPU counters can finish accounting microseconds after SIGSTOP.
   // Record that telemetry; the native stopped state and blocked JavaScript
   // request are the actual suspension witness, not floating-point equality.
   for(const pid of rendererPids){const state=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","state="])).stdout.trim();stoppedStatesAfter.push({pid,state});expect(state).toContain("T");}
  }finally{
   const failures:unknown[]=[];
   for(const pid of stopped){try{process.kill(pid,"SIGCONT");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")failures.push(error);}}
   await browserCdp.detach();
   if(failures.length)throw new AggregateError(failures,"owned native renderers failed to resume");
  }
  const resumedProbe=await blockedProbe!;
  if(resumedProbe.exceptionDetails!==undefined)throw new Error("resumed native JavaScript probe failed");
  expect(resumedProbe.result.value).toMatchObject({phase:"recipient-install-4:1",epoch:4,pendingRpc:1,suspensionStarted:true});
  await new Promise(resolve=>setTimeout(resolve,100));const after=await inspect();
  for(const row of after)expect(row.value.ticks).toBeGreaterThan(before.find(prior=>prior.origin===row.origin)!.value.ticks);
  const result={metadata,before,after,resumedProbe:resumedProbe.result.value,rendererPids,stoppedStates,stoppedStatesAfter,cpuBefore,cpuDuring,
   javaScriptProbeSettledWhileStopped:false,testOnlySuspensionMilliseconds:performance.now()-start,
   frozenTarget:"Owned test browser renderer SIGSTOP/SIGCONT",frozenHoldMilliseconds:500,
   qualification:"Actual renderer OS suspension, not document freeze events, whole-browser/process death, background-tab/mobile lifecycle or real-device acceptance. Browser-process native IndexedDB backend remains alive."};
  suspensions.push(result);return result;
 });
 const ownedBrowser=page.context().browser();if(ownedBrowser===null)throw new Error("owned healthy benchmark browser unavailable");
 const browserCpu=await ownedBrowser.newBrowserCDPSession();
 const cpuBefore=(await browserCpu.send("SystemInfo.getProcessInfo")).processInfo;
 const cpuStarted=performance.now();
 // One actual renderer/isolate session covers the four same-process realms.
 // Never create/poll a CDP session per iframe: that duplicated discovery errors
 // and profile servicing, without adding another independently profiled VM.
 const criticalErrors:any[]=[],captureWindows:any[]=[],contexts=new Map<number,any>(),scripts=new Map<string,any>(),sourcePins=new Map<string,any>();
 let criticalFinished=false,activeCapture:any,criticalReady=false,targetId:string|undefined,criticalTraceFailed=false;
 const deferredCriticalExports:{capture:any;finish:()=>Promise<any>}[]=[];
 const bounded=async<T>(promise:Promise<T>,label:string,milliseconds=20_000):Promise<T>=>{
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error(label+" timed out after "+milliseconds+" ms")),milliseconds);})]);}
  finally{if(timeout)clearTimeout(timeout);}
 };
 const attachJson=async(name:string,value:unknown)=>{
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.byteLength>128*1024*1024)throw new Error(name+" exceeds bounded 128 MiB output");
  await info.attach(name,{body:bytes,contentType:"application/json"});
 };
 const initializeCritical=async()=>{
  if(criticalReady)return;criticalReady=true;
  targetId=(await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
  cdp.on("Runtime.executionContextCreated",({context}:any)=>{if(contexts.size<64)contexts.set(context.id,{id:context.id,origin:context.origin,name:context.name,auxData:context.auxData});else criticalErrors.push({stage:"context-cap",id:context.id});});
  cdp.on("Runtime.executionContextDestroyed",({executionContextId}:any)=>{const context=contexts.get(executionContextId);if(context)context.destroyed=true;});
  cdp.on("Debugger.scriptParsed",(script:any)=>{if(scripts.size<4096)scripts.set(script.scriptId,{scriptId:script.scriptId,url:script.url,hash:script.hash,
   sourceMapURL:script.sourceMapURL?.startsWith("data:")?{inline:true,encodedBytes:Buffer.byteLength(script.sourceMapURL),sha256:createHash("sha256").update(script.sourceMapURL).digest("hex")}:script.sourceMapURL,
   executionContextId:script.executionContextId,startLine:script.startLine,startColumn:script.startColumn,endLine:script.endLine,endColumn:script.endColumn});});
  await cdp.send("Runtime.enable");await cdp.send("Debugger.enable");await cdp.send("Profiler.enable");if(captureModes.v8CpuProfiling)await cdp.send("Profiler.setSamplingInterval",{interval:4000});
  if(captureModes.allocationSampling)await cdp.send("HeapProfiler.enable");
 };
 const realmWindows=async(kind:"begin"|"end",meta:any)=>{
  const result:any[]=[];
  for(const frame of page.frames()){
   const origin=frame.url().split("/").slice(0,3).join("/");
   if(![local.origin,...clients.map(client=>client.origin)].includes(origin))continue;
   // The creator wrapper owns its exact begin/end immediately around action().
   // Other realms have explicitly broader diagnostic windows, never substitute
   // their timestamps for the creator's actual API interval.
   if(origin===clients[0]?.origin){result.push({url:frame.url(),creatorWindowOwnedByApiWrapper:true});continue;}
   try{result.push({url:frame.url(),value:await frame.evaluate(({kind,meta})=>{
    const hook=Reflect.get(globalThis,kind==="begin"?"__r8FunctionWindowBegin":"__r8FunctionWindowEnd");
    return typeof hook==="function"?{available:true,timeOrigin:performance.timeOrigin,at:performance.now(),value:hook(meta)}:{available:false};
   },{kind,meta})});}catch(error){result.push({url:frame.url(),error:String(error)});}
  }
  return result;
 };
 const criticalClockAnchor=async()=>{
  const hostBegin=performance.now();
  const before=await bounded(cdp.send("Performance.getMetrics"),"critical clock before");
  const creator=page.frames().find(frame=>frame.url().split("/").slice(0,3).join("/")===clients[0]?.origin);
  if(!creator)throw new Error("critical creator clock context unavailable");
  const renderer=await bounded(creator.evaluate(()=>({timeOrigin:performance.timeOrigin,now:performance.now()})),"critical renderer clock");
  const after=await bounded(cdp.send("Performance.getMetrics"),"critical clock after");
  const monotonicSecondsBefore=before.metrics.find(row=>row.name==="Timestamp")?.value,monotonicSecondsAfter=after.metrics.find(row=>row.name==="Timestamp")?.value;
  if(!Number.isFinite(monotonicSecondsBefore)||!Number.isFinite(monotonicSecondsAfter)||monotonicSecondsAfter!<monotonicSecondsBefore!)throw new Error("critical monotonic clock bracket invalid");
  return {hostBegin,hostEnd:performance.now(),renderer,monotonicSecondsBefore,monotonicSecondsAfter,
   qualification:"Sequential CDP monotonic Timestamp brackets renderer performance.now; uncertainty is the full bracket width, not an exact equal-clock assertion. Original blink.user_timing API measure gives exact trace-local begin/end."};
 };
 // An opt-in OS capture answers scheduling/thread-state questions, not JS call
 // counts. The short PID-mapping trace is completely stopped before xctrace or
 // the original API starts; V8/precise coverage/allocation sampling stay off.
 let systemTrace:any,systemTraceStop:Promise<void>|undefined;
 const systemTraceRawSourceHashes=new Set<string>();
 const systemTraceClock=()=>({utcMilliseconds:Date.now(),hostMonotonicMilliseconds:performance.now(),hostTimeOrigin:performance.timeOrigin});
 const stopSystemTrace=(reason:string):Promise<void>=>{
  if(!systemTrace)return Promise.resolve();
  if(systemTraceStop)return systemTraceStop;
  const state=systemTrace;
  systemTraceStop=(async()=>{
   state.stopRequested={reason,...systemTraceClock()};if(state.monitor)clearInterval(state.monitor);
   if(state.child?.exitCode===null&&state.child?.signalCode===null)state.child.kill("SIGINT");
   if(state.listener?.exitCode===null&&state.listener?.signalCode===null)state.listener.kill("SIGTERM");
   if(state.exited)try{state.exit=await bounded(state.exited,"System Trace stop/save",90_000);}catch(error){state.errors.push({stage:"stop",error:String(error)});state.child?.kill("SIGTERM");
    try{state.exit=await bounded(state.exited,"System Trace terminate/join",10_000);}catch(joinError){state.errors.push({stage:"terminate-join",error:String(joinError)});state.child?.kill("SIGKILL");state.exit=await bounded(state.exited,"System Trace kill/join",5_000);}}
   state.stopped=systemTraceClock();
   const {child,listener,exited,monitor,...metadata}=state;
   await attachJson("healthy-system-trace-metadata",metadata);
  })();return systemTraceStop;
 };
 const startSystemTrace=async()=>{
  if(systemTrace)return;
  const creator=page.frames().find(frame=>frame.url().split("/").slice(0,3).join("/")===clients[0]?.origin);
  if(!creator)throw new Error("System Trace creator frame unavailable");
  const frameTree=(await cdp.send("Page.getFrameTree")).frameTree,frames:any[]=[];
  const visit=(row:any)=>{frames.push(row.frame);for(const child of row.childFrames??[])visit(child);};visit(frameTree);
  const matching=frames.filter(frame=>frame.url===creator.url());if(matching.length!==1)throw new Error("System Trace creator CDP frame ambiguous");
  const marker="r8-os-pid-"+process.pid+"-"+Date.now(),chunks:Buffer[]=[];let bytes=0,completed:any;
  const completion=new Promise<any>(resolve=>{browserCpu.once("Tracing.tracingComplete",resolve);});
  const mappingBegin=systemTraceClock();
  await browserCpu.send("Tracing.start",{transferMode:"ReturnAsStream",streamFormat:"json",streamCompression:"none",
   traceConfig:{recordMode:"recordUntilFull",traceBufferSizeInKb:8192,includedCategories:["devtools.timeline","disabled-by-default-devtools.timeline","blink.user_timing"]}});
  let creatorClock:any;
  try{creatorClock=await creator.evaluate(name=>{performance.mark(name);return {timeOrigin:performance.timeOrigin,now:performance.now()};},marker);}
  finally{await browserCpu.send("Tracing.end");completed=await bounded(completion,"System Trace PID mapping completion");}
  if(!completed.stream||completed.dataLossOccurred!==false)throw new Error("System Trace PID mapping stream absent or lost");
  try{for(;;){const chunk=await browserCpu.send("IO.read",{handle:completed.stream,size:1024*1024});const value=Buffer.from(chunk.data,chunk.base64Encoded?"base64":"utf8");bytes+=value.length;
   if(bytes>8*1024*1024)throw new Error("System Trace PID mapping exceeds 8 MiB");chunks.push(value);if(chunk.eof)break;}}
  finally{await browserCpu.send("IO.close",{handle:completed.stream});await creator.evaluate(name=>performance.clearMarks(name),marker);}
  const raw=Buffer.concat(chunks),events=JSON.parse(raw.toString("utf8")).traceEvents;
  if(!Array.isArray(events))throw new Error("System Trace PID mapping events absent");
  const marks=events.filter((event:any)=>event.name===marker&&event.cat?.split(",").includes("blink.user_timing"));
  if(marks.length!==1||!Number.isSafeInteger(marks[0].pid)||!Number.isSafeInteger(marks[0].tid))throw new Error("System Trace creator marker PID ambiguous");
  const processes=(await browserCpu.send("SystemInfo.getProcessInfo")).processInfo,pid=marks[0].pid;
  if(!processes.some(row=>row.id===pid&&row.type==="renderer"))throw new Error("System Trace mapped PID is not an owned renderer");
  const executable=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-ww","-o","comm="])).stdout.trim();
  const processCommand=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-ww","-o","command="])).stdout.trim();
  if(!isAbsolute(command.arguments[0])||executable!==command.arguments[0]||!processCommand.includes("--type=renderer"))throw new Error("System Trace renderer binary does not match owned browser");
  await info.attach("healthy-system-trace-pid-mapping",{body:raw,contentType:"application/json"});
  const path=info.outputPath("healthy-system-trace.trace"),notification="codex.r8.systemtrace."+process.pid+"."+Date.now();
  const state:any={path,pid,mainThreadId:marks[0].tid,executable,processCommand,ownedProcesses:processes,frame:matching[0],marker:marks[0],creatorClock,
   mappingBegin,mappingEnd:systemTraceClock(),mappingBytes:bytes,mappingDataLossOccurred:completed.dataLossOccurred,
   timeLimitSeconds:30,allocatedOutputLimitBytes:512*1024*1024,allocationSamples:[],phases:[],errors:[],stdout:"",stderr:"",notification:"",
   qualification:"One exact creator renderer selected by a unique mark executed in its URL/CDP-identified frame, owned-browser process membership and binary path. Mapping trace stops before OS recording/API. System Trace may include kernel/system scheduling metadata; export selects this PID. Browser-process IndexedDB backend is not this target. UTC export precision and clock brackets bound phase alignment; no cycle-exact attribution or backend-lock causality is claimed."};
  systemTrace=state;
  const listener=spawn("/usr/bin/notifyutil",["-v","-1",notification],{stdio:["ignore","pipe","pipe"]});state.listener=listener;
  const ready=new Promise<void>((resolve,reject)=>{listener.on("error",reject);listener.stdout.on("data",chunk=>{state.notification+=chunk.toString();
    if(state.notification.includes(notification)&&/\[\d+\]/u.test(state.notification)){state.ready=systemTraceClock();resolve();}});
   listener.on("exit",code=>{if(!state.ready)reject(new Error("System Trace notification did not confirm readiness: "+code+" "+state.notification));});});
  // Avoid an unhandled rejection if native launch fails before the await below.
  void ready.catch(()=>{});
  const args=["xctrace","record","--template","System Trace","--attach",String(pid),"--time-limit","30s","--window","30s","--output",path,"--notify-tracing-started",notification,"--no-prompt"];
  state.launch={arguments:args,...systemTraceClock()};const child=spawn("/usr/bin/xcrun",args,{stdio:["ignore","pipe","pipe"]});state.child=child;
  state.recorderPid=child.pid;
  state.exited=new Promise(resolve=>{child.on("error",error=>resolve({error:String(error),...systemTraceClock()}));child.on("exit",(code,signal)=>resolve({code,signal,...systemTraceClock()}));});
  for(const channel of ["stdout","stderr"] as const)child[channel].on("data",chunk=>{state[channel]+=chunk.toString();if(Buffer.byteLength(state[channel])>128*1024){state.errors.push({stage:"log-bound",channel});child.kill("SIGINT");}});
  try{await bounded(ready,"System Trace readiness",15_000);}catch(error){state.errors.push({stage:"readiness",error:String(error)});await stopSystemTrace("readiness-failure");throw error;}
  state.monitor=setInterval(()=>{void promisify(execFile)("/usr/bin/du",["-sk",path]).then(({stdout})=>{const allocated=Number(stdout.split(/\s+/u)[0])*1024;
   state.allocationSamples.push({allocated,...systemTraceClock()});if(!Number.isSafeInteger(allocated)||allocated>state.allocatedOutputLimitBytes){state.errors.push({stage:"output-bound",allocated});void stopSystemTrace("output-bound");}},error=>{state.errors.push({stage:"output-stat",error:String(error)});});},1000);
 };
 const requestCriticalTraceStop=async(capture:any)=>{
  if(!capture.traceStarted||capture.traceEndAcknowledgedAt!==undefined)return;
  await browserCpu.send("Tracing.recordClockSyncMarker",{syncId:"r8-critical-"+capture.index+"-end"});capture.traceEndRequestedAt=performance.now();
  await bounded(browserCpu.send("Tracing.end"),"Tracing.end command");capture.traceEndAcknowledgedAt=performance.now();
 };
 const startCriticalWindow=async(meta:any)=>{
  if(activeCapture)throw new Error("overlapping critical capture windows");await initializeCritical();
  const capture:any={index:captureWindows.length,meta,requestedAt:performance.now(),contexts:[...contexts.values()],frames:page.frames().map(frame=>frame.url()),bufferUsage:[],errors:[]};
  const expectedOrigins=[local.origin,...clients.map(client=>client.origin)],observedOrigins=[...new Set(capture.contexts.filter((context:any)=>context.auxData?.isDefault===true&&!context.destroyed).map((context:any)=>context.origin))];
  capture.contextCoverage={expectedOrigins,observedOrigins,missingOrigins:expectedOrigins.filter(origin=>!observedOrigins.includes(origin)),
   qualification:"Default execution contexts observed on the one profiled renderer session. Missing origins mean incomplete VM coverage, not permission to create duplicate iframe sessions."};
  captureWindows.push(capture);activeCapture=capture;
  if(profileMode==="system-trace")await startSystemTrace();
  if(profileMode==="cpu-only"||profileMode==="trace-only"||profileMode==="allocation-only"||profileMode==="self-trace")capture.clockBegin=await criticalClockAnchor();
  if(bodyFunctionCalls)capture.realmBegin=await realmWindows("begin",meta);
  if(captureModes.nativeTracing&&profileMode==="self-trace"&&deferredCriticalExports.length){
   capture.traceSkipped={reason:"Seal trace end was requested; its completion/export is deferred until workflow owners join. No second trace was started."};
  }else if(captureModes.nativeTracing)try{
   if(criticalTraceFailed)throw Error("PRIOR_NATIVE_TRACE_DID_NOT_JOIN");
   const available=(await browserCpu.send("Tracing.getCategories")).categories;
   capture.traceCategories=selectCriticalTraceCategories(available,handoffOnly,rendererTraceOnly,rendererTaskTrace);
   capture.traceCompletePromise=new Promise(resolve=>{capture.traceCompleteListener=(value:any)=>{capture.traceComplete=value;capture.traceCompleteReceivedAt=performance.now();resolve(value);};browserCpu.once("Tracing.tracingComplete",capture.traceCompleteListener);});
   capture.traceBufferListener=(value:any)=>{if(capture.bufferUsage.length<180)capture.bufferUsage.push({at:performance.now(),...value});};browserCpu.on("Tracing.bufferUsage",capture.traceBufferListener);
   await browserCpu.send("Tracing.start",{transferMode:"ReturnAsStream",streamFormat:"json",streamCompression:"gzip",bufferUsageReportingInterval:1000,
    traceConfig:{recordMode:"recordContinuously",traceBufferSizeInKb:65536,includedCategories:capture.traceCategories}});capture.traceStarted=true;
   await browserCpu.send("Tracing.recordClockSyncMarker",{syncId:"r8-critical-"+capture.index+"-begin"});
  }catch(error){capture.errors.push({stage:"trace-start",error:String(error)});}
  if(exactFunctionCalls){capture.coverageStart=await cdp.send("Profiler.startPreciseCoverage",{callCount:true,detailed:false,allowTriggeredUpdates:false});capture.coverageStarted=true;capture.coverageReset=await cdp.send("Profiler.takePreciseCoverage");}
  if(captureModes.allocationSampling){
   capture.allocationSampling={samplingInterval:32768,stackDepth:128,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true};
   await cdp.send("HeapProfiler.startSampling",capture.allocationSampling);capture.allocationStarted=true;
  }
  capture.cpuBefore=(await browserCpu.send("SystemInfo.getProcessInfo")).processInfo;
  if(captureModes.v8CpuProfiling){await cdp.send("Profiler.start");capture.profileStarted=true;}capture.readyAt=performance.now();
  return {ok:true,index:capture.index,targetId};
 };
 const stopCriticalWindow=async(reason:string,snapshot?:unknown)=>{
  const capture=activeCapture;if(!capture)return;activeCapture=undefined;capture.reason=reason;capture.stopRequestedAt=performance.now();
  const prefix="healthy-critical-window-"+capture.index;let coverageForPinCheck:any;
  if(profileMode==="system-trace"){
   systemTrace?.phases.push({phase:capture.meta.phase,reason,...capture.endMeta,hostStop:systemTraceClock()});
   if(reason!=="api-return"||capture.meta.phase==="creator-adoption-inclusive")await stopSystemTrace(reason);
  }
  // Stop phase allocation collection before any profile/source/trace export or
  // test GC. Default sampling retains only live objects, so both collected-
  // object flags above are necessary to attribute short-lived allocation churn.
  if(capture.allocationStarted)try{
   const {profile}=await bounded(cdp.send("HeapProfiler.stopSampling"),"allocation sampling stop");capture.allocationStoppedAt=performance.now();
   capture.allocationValidation=validateCriticalAllocationProfile(profile);
   const allocationScriptIds=new Set<string>(),pending=capture.allocationValidation.valid?[profile.head]:[];while(pending.length){const node=pending.pop()!;if(node.callFrame.scriptId!=="0")allocationScriptIds.add(node.callFrame.scriptId);for(const child of node.children)pending.push(child);}
   capture.allocationScripts=[...allocationScriptIds].map(scriptId=>({scriptId,url:scripts.get(scriptId)?.url,parsed:scripts.get(scriptId)}));
   await attachJson(prefix+"-allocation",profile);
  }catch(error){capture.errors.push({stage:"allocation-stop",error:String(error)});}
  if(profileMode==="cpu-only"||profileMode==="trace-only"||profileMode==="allocation-only"||profileMode==="self-trace")try{capture.clockEnd=await criticalClockAnchor();}catch(error){capture.errors.push({stage:"clock-end",error:String(error)});}
  if(bodyFunctionCalls&&reason!=="api-return"&&snapshot===undefined){
   // A diagnostic checkpoint must not end/revoke an in-flight creator API.
   // Read its current counters directly; partial/open bodies remain explicit.
   capture.partialCreatorSnapshot=true;
   try{
    const creator=page.frames().find(frame=>frame.url().split("/").slice(0,3).join("/")===clients[0]?.origin);
    if(!creator)throw new Error("partial creator frame unavailable");
    snapshot=await bounded(creator.evaluate(()=>{
     const read=Reflect.get(globalThis,"__r8FunctionSnapshot");if(typeof read!=="function")throw new Error("partial creator snapshot hook unavailable");
     return read();
    }),"partial creator snapshot");
   }catch(error){capture.errors.push({stage:"partial-creator-snapshot",error:String(error)});}
  }
  if(capture.profileStarted)try{
   const {profile}=await bounded(cdp.send("Profiler.stop"),"CPU profile stop");capture.cpuValidation=validateCriticalCpuProfile(profile);
   capture.profileScripts=[...new Set(profile.nodes.map(node=>node.callFrame.scriptId))].filter(scriptId=>scriptId!=="0").map(scriptId=>({scriptId,url:scripts.get(scriptId)?.url,parsed:scripts.get(scriptId)}));
   await attachJson(prefix+"-cpu",profile);
  }catch(error){capture.errors.push({stage:"profile-stop",error:String(error)});}
  if(capture.coverageStarted)try{
   const coverage=await bounded(cdp.send("Profiler.takePreciseCoverage"),"precise coverage take");capture.coverageValidation=validateCriticalCoverage(coverage);
   coverageForPinCheck=coverage;
   await cdp.send("Profiler.stopPreciseCoverage");await attachJson(prefix+"-precise-coverage",coverage);
   capture.coveredScripts=coverage.result.map(script=>({scriptId:script.scriptId,url:script.url,parsed:scripts.get(script.scriptId)}));
  }catch(error){capture.errors.push({stage:"coverage-stop",error:String(error)});await cdp.send("Profiler.stopPreciseCoverage").catch(()=>{});}
  capture.cpuAfter=(await browserCpu.send("SystemInfo.getProcessInfo")).processInfo;
  const sourceScriptsAtBoundary=[...scripts.values()];
  // End selected body clocks at their original boundaries even if native trace
  // export is deferred. Other realms must not accidentally clock the rest of
  // the workflow while the creator continues.
  if(bodyFunctionCalls){capture.realmEnd=await realmWindows("end",capture.meta);await attachJson(prefix+"-function-snapshots",{creator:snapshot,realms:capture.realmEnd});}
  const finishExport=async()=>{
  const activeExportStartedAt=performance.now();capture.activeExportStartedAt=activeExportStartedAt;
  if(capture.traceStarted)try{
   if(capture.traceEndAcknowledgedAt===undefined){
   // Bound the end COMMAND as well as its later completion event. The previous
   // diagnostic bounded only the event after awaiting an unbounded command.
   await requestCriticalTraceStop(capture);
   }
   // Independent held-IDB smoke293 completed without data loss after 27.8s
   // even after its native read had joined. Finalization is outside the product
   // API timer/deadline; preserve the earlier 20s failures, bound export at45s.
   const completed=capture.traceComplete??await bounded(capture.traceCompletePromise,"Tracing.tracingComplete",45_000);
   if(!completed.stream)throw new Error("owned trace stream absent");
   capture.tracePath=info.outputPath(prefix+"-trace.json.gz");capture.traceBytes=0;const file=await open(capture.tracePath,"wx");
   try{for(;;){const chunk=await bounded(browserCpu.send("IO.read",{handle:completed.stream,size:1024*1024}),"trace IO.read");const bytes=Buffer.from(chunk.data,chunk.base64Encoded?"base64":"utf8");capture.traceBytes+=bytes.byteLength;
    if(capture.traceBytes>128*1024*1024)throw new Error("bounded trace output exceeds 128 MiB");await file.write(bytes);if(chunk.eof){capture.traceEof=true;break;}}}
   finally{await file.close();await browserCpu.send("IO.close",{handle:completed.stream});}
   await info.attach(prefix+"-browser-trace",{path:capture.tracePath,contentType:"application/gzip"});
  }catch(error){criticalTraceFailed=true;capture.errors.push({stage:"trace-stop",error:String(error),terminalStage:capture.traceEndAcknowledgedAt===undefined?"end-command":capture.traceComplete===undefined?"completion-event":capture.traceEof?"attachment":"stream-read"});}
  finally{if(capture.traceCompleteListener)browserCpu.off("Tracing.tracingComplete",capture.traceCompleteListener);if(capture.traceBufferListener)browserCpu.off("Tracing.bufferUsage",capture.traceBufferListener);}
  // Source retrieval and JSON attachment occur after profilers stop. They are
  // test-only export work, not product API computation or exact invocation work.
  // Trace-only has no CPU/coverage list. Pin observed scripts directly from the
  // existing Debugger events; allocation mode can pin only sampled script IDs.
  // Avoid spending the finite OS window exporting large sources between APIs.
  const deferSystemSources=profileMode==="system-trace"&&capture.meta.phase==="sealing-inclusive"&&reason==="api-return";
  const capturedScripts=deferSystemSources?[]:capture.coveredScripts??capture.profileScripts??capture.allocationScripts??
   (selfFunctionCalls||profileMode==="trace-only"||profileMode==="system-trace"?sourceScriptsAtBoundary.filter(script=>script.url?.endsWith("/r8-source-binding.mjs")):sourceScriptsAtBoundary);
  capture.sourcePinScope=selfFunctionCalls||profileMode==="trace-only"||profileMode==="system-trace"?"Observed application bundles only; other debugger/eval scripts are not claimed pinned":"All scripts selected by the existing profiler/source inventory";
  let capturedSourceBytes=0;
  for(const script of capturedScripts)if(!sourcePins.has(script.scriptId))try{
   // Debugger reports one source hash per script/realm. Reuse a fetched source
   // only when that exact reported SHA256 equals our independently computed
   // hash. Keep every script ID/context and state the different verification
   // basis; identical URLs or lengths alone never establish equal source.
   const parsed=scripts.get(script.scriptId),reportedHash=parsed?.hash;
   const prior=verifiedCriticalSourceReuse(reportedHash,sourcePins.values());
   if(prior){sourcePins.set(script.scriptId,{...script,utf16Length:prior.utf16Length,encodedBytes:prior.encodedBytes,sha256:prior.sha256,
    independentlyFetchedSource:false,verificationKind:"Debugger.scriptParsed.hash equals independently fetched exact-source SHA256",
    reportedSourceHash:reportedHash,independentSourceScriptId:prior.scriptId,
    ...(prior.expectedArtifactSha256===undefined?{}:{expectedArtifactSha256:prior.expectedArtifactSha256,exactArtifactMatch:prior.exactArtifactMatch})});continue;}
   const {scriptSource}=await cdp.send("Debugger.getScriptSource",{scriptId:script.scriptId});capturedSourceBytes+=Buffer.byteLength(scriptSource);
   if(capturedSourceBytes>128*1024*1024)throw new Error("bounded script source capture exceeds 128 MiB");
   const pin:any={...script,utf16Length:scriptSource.length,encodedBytes:Buffer.byteLength(scriptSource),sha256:createHash("sha256").update(scriptSource).digest("hex"),
    independentlyFetchedSource:true,verificationKind:"Debugger.getScriptSource independently hashed SHA256",reportedSourceHash:reportedHash};
   if(profileMode==="system-trace"&&script.url?.endsWith("/r8-source-binding.mjs")){
    const expected=JSON.parse(readFileSync(join(directory,"artifacts.json"),"utf8")).entries.find((entry:any)=>entry.name==="r8-source-binding")?.sha256;
    if(typeof expected!=="string")throw new Error("System Trace expected bundle pin absent");pin.expectedArtifactSha256=expected;pin.exactArtifactMatch=pin.sha256===expected;
    if(!pin.exactArtifactMatch&&!systemTraceRawSourceHashes.has(pin.sha256)){
     if(pin.encodedBytes>32*1024*1024||systemTraceRawSourceHashes.size>=1)throw new Error("System Trace mismatched raw source bound exceeded");
     const name="healthy-system-trace-mismatched-source-"+pin.sha256,path=info.outputPath(name+".js"),file=await open(path,"wx");
     try{await file.writeFile(scriptSource,"utf8");}finally{await file.close();}await info.attach(name,{path,contentType:"text/javascript"});
     systemTraceRawSourceHashes.add(pin.sha256);pin.rawSourceAttachment=name;
    }
   }
   sourcePins.set(script.scriptId,pin);
  }catch(error){capture.errors.push({stage:"script-source-pin",scriptId:script.scriptId,error:String(error)});}
  capture.sourcePinValidation={valid:true,failures:[] as any[]};
  for(const script of capturedScripts)if(!sourcePins.has(script.scriptId)){
   capture.sourcePinValidation.valid=false;capture.sourcePinValidation.failures.push({scriptId:script.scriptId,reason:"covered/profiled script source unpinned"});
  }
  if(profileMode==="system-trace")for(const pin of sourcePins.values())if(pin.exactArtifactMatch===false){capture.sourcePinValidation.valid=false;capture.sourcePinValidation.failures.push({scriptId:pin.scriptId,reason:"raw runtime bundle differs from exact artifact",sha256:pin.sha256,expectedArtifactSha256:pin.expectedArtifactSha256,rawSourceAttachment:pin.rawSourceAttachment});}
  for(const script of coverageForPinCheck?.result??[])for(const fn of script.functions)for(const range of fn.ranges){
   const pin=sourcePins.get(script.scriptId);if(pin&&range.endOffset>pin.utf16Length){capture.sourcePinValidation.valid=false;
    capture.sourcePinValidation.failures.push({scriptId:script.scriptId,functionName:fn.functionName,startOffset:range.startOffset,endOffset:range.endOffset,sourceUtf16Length:pin.utf16Length});}
  }
  capture.exportCompletedAt=performance.now();
  capture.validity={cpuTimeline:captureModes.v8CpuProfiling?capture.cpuValidation?.valid===true:"not-requested-"+profileMode,sourcePins:capture.sourcePinValidation.valid===true,
   allocationProfile:captureModes.allocationSampling?capture.allocationValidation?.valid===true:"not-requested-"+profileMode,
   preciseFunctionCounts:exactFunctionCalls?capture.coverageValidation?.valid===true:"not-requested-"+profileMode,
   allExpectedRealmContexts:capture.contextCoverage.missingOrigins.length===0,
   browserTrace:capture.traceSkipped?"not-requested-deferred-seal-only":captureModes.nativeTracing?capture.traceEof===true&&capture.traceComplete?.dataLossOccurred===false:"not-requested-"+profileMode,
   originalApiBoundary:reason==="api-return"&&Number.isFinite(capture.endMeta?.apiBegin)&&Number.isFinite(capture.endMeta?.apiEnd),errorsAbsent:capture.errors.length===0};
  capture.testOnlyExportMilliseconds=capture.exportCompletedAt-activeExportStartedAt;
  capture.deferredBeforeExportMilliseconds=activeExportStartedAt-capture.stopRequestedAt;
  capture.exportTimingQualification="Export elapsed includes trace finalization/IO waits, not CPU. Deferred-before-export time includes intervening product workflow and must not be labelled test/export overhead; original API interval remains separate.";
  // Promises/listener closures are neither evidence nor serializable metadata.
  delete capture.traceCompletePromise;delete capture.traceCompleteListener;delete capture.traceBufferListener;delete capture.coverageReset;
  return {ok:true,index:capture.index,cpuValid:capture.cpuValidation?.valid,coverageValid:capture.coverageValidation?.valid,traceComplete:capture.traceEof===true};
  };
  if(profileMode==="self-trace"&&reason==="api-return"){
   if(capture.traceStarted)try{
    await requestCriticalTraceStop(capture);
   }catch(error){criticalTraceFailed=true;capture.errors.push({stage:"deferred-trace-end",error:String(error)});}
   capture.exportDeferredUntilWorkflow=true;
   deferredCriticalExports.push({capture,finish:finishExport});
   return {ok:true,index:capture.index,exportDeferred:true};
  }
  return finishExport();
 };
 if(fullFunctionCalls&&!criticalTimingsOnly)await page.exposeFunction("__r8FunctionCaptureBoundary",async(kind:string,meta:any,snapshot?:unknown)=>{
  if(meta?.role!=="creator"||meta?.transition!==4||!["sealing-inclusive","creator-adoption-inclusive"].includes(meta?.phase))throw new Error("unexpected full-function capture boundary");
  if(criticalFinished){
   // The fixed predeadline checkpoint closes diagnostic collection only. A
   // later API return/next boundary must not become a synthetic product error
   // or restart profilers after the capture has already been exported.
   if(kind!=="begin"&&kind!=="end"&&kind!=="trace-stop")throw new Error("unexpected postcapture boundary kind");
   await attachJson("healthy-critical-postcapture-"+meta.rpcToken+"-"+kind,{kind,meta,snapshot,partial:true,
    reason:"diagnostic collection already closed; original product outcome remains independent"});
   return {ok:true,partial:true,captureClosed:true};
  }
  if(kind==="begin")return startCriticalWindow(meta);
  if(kind==="trace-stop"){
   if(!activeCapture||activeCapture.meta.rpcToken!==meta.rpcToken||activeCapture.meta.phase!==meta.phase)throw new Error("unpaired tiny trace-stop boundary");
   activeCapture.traceStopControl={receivedAt:performance.now(),apiBegin:meta.apiBegin,apiEnd:meta.apiEnd,timeOrigin:meta.timeOrigin,
    qualification:"Tiny metadata-only binding received before bulk exact-counter/body snapshots. API/body clocks already ended; no product owner is released."};
   try{await requestCriticalTraceStop(activeCapture);}
   catch(error){criticalTraceFailed=true;activeCapture.errors.push({stage:"tiny-trace-stop",error:String(error)});}
   finally{activeCapture.traceStopControl.returnedAt=performance.now();}
   return {ok:true,index:activeCapture.index,traceEndAcknowledged:activeCapture.traceEndAcknowledgedAt!==undefined};
  }
  if(kind!=="end"||!activeCapture||activeCapture.meta.rpcToken!==meta.rpcToken||activeCapture.meta.phase!==meta.phase)throw new Error("unpaired full-function capture boundary");
  activeCapture.endMeta={...meta};
  return stopCriticalWindow("api-return",snapshot);
 });
 if(criticalProfiling&&!criticalTimingsOnly&&!fullFunctionCalls)await startCriticalWindow({phase:"whole-workflow"});
 const saveCriticalCapture=async(reason:string)=>{
  if(!criticalProfiling||criticalTimingsOnly||criticalFinished)return;criticalFinished=true;
  if(activeCapture)await stopCriticalWindow(reason);
  for(const pending of deferredCriticalExports){pending.capture.deferredFinalization={reason,startedAt:performance.now(),qualification:"Original API timer ended and Tracing.end acknowledged at the original boundary. Native stream/source export now runs after the healthy workflow returned; predeadline finalization, if any, is explicitly partial."};await pending.finish();}
  if(profileMode==="system-trace")await stopSystemTrace(reason);
  await attachJson("healthy-critical-script-source-pins",[...sourcePins.values()]);
  if(fullFunctionCalls&&captureWindows.length!==2)criticalErrors.push({stage:"boundary-completeness",expected:2,actual:captureWindows.length});
  await attachJson("healthy-critical-capture-metadata",{reason,targetId,oneRendererSession:true,fullFunctionCalls,profileMode,exactFunctionCalls,captureModes,elapsedMilliseconds:performance.now()-cpuStarted,
   partial:reason==="predeadline",samplingIntervalMicroseconds:4000,windows:captureWindows,errors:criticalErrors,
   protocolVersion:"playwright-core@1.62.1 CDP",qualifications:[
    "Original product assertions/limits/deadline unchanged. Diagnostic instrumentation is not unprofiled performance acceptance.",
    "One renderer/isolate session; four client realms share it. Only execution contexts observed in that isolate are covered; native builtins/backend functions are not JavaScript call-count evidence.",
    "Precise function coverage includes bundled dependencies, uses callCount:true/detailed:false and resets at window boundaries; it prevents optimized execution. Counts are capture-interval work, not proof every call was caused by the selected API.",
    "CPU samples are validated independently; invalid deltas/IDs/bounds prohibit timeline/flamegraph attribution. Samples are not calls or every compute cycle.",
    "Allocation-only mode samples at a 32768-byte mean interval with both collected-object flags enabled, without V8 CPU profiling or precise coverage. Allocation estimates include temporary churn but do not identify individual object retention, every allocation, exact bytes or allocation timestamps. No forced GC is added inside a phase.",
    "Only actual full-function snapshot root intervals establish API timing. CDP windows bracket API plus explicit host/other-realm instrumentation; lingering command labels establish no causality.",
    "Browser trace covers selected available categories, automatic GC and instrumented native/backend events, not every native call or kernel wait. Ring data loss and stream completeness remain explicit.",
    "Realm snapshots outside the creator root have broader capture boundaries. Forced test GC, export, assertions, sampling and observer overhead must remain separate. Unknown wall time is not automatically contention."
   ]});
  const loop:any[]=[];for(const frame of page.frames())try{loop.push({url:frame.url(),value:await frame.evaluate(()=>Reflect.get(globalThis,"__r8EventLoopCheckpoint")?.())});}catch(error){loop.push({url:frame.url(),error:String(error)});}
  await attachJson("healthy-critical-event-loop-checkpoint",loop);
 };
 const criticalCheckpoint=criticalProfiling&&!criticalTimingsOnly?setTimeout(()=>{void saveCriticalCapture("predeadline").catch(error=>{console.info(JSON.stringify({kind:"healthy-critical-capture-unavailable",error:String(error)}));});},295_000):undefined;
 if(profileCpu){await cdp.send("Profiler.enable");await cdp.send("Profiler.setSamplingInterval",{interval:1000});await cdp.send("Profiler.start");}
 let receipt;
 const fixedIdentity=process.env.STARTUP_HEALTHY_GRID_IDENTITY;
 // Reproduce an existing generated identity as well as an explicit benchmark
 // identity; neither form permits unbounded names or changes product input.
 if(fixedIdentity!==undefined&&!/^(?:healthy-latency-[a-z0-9-]{1,48}|r8-integrated-[0-9]{13})$/u.test(fixedIdentity))throw new Error("bounded healthy latency identity invalid");
 const traceCheckpoint=setTimeout(()=>{
  const started=performance.now();
  void page.evaluate(()=>Reflect.get(globalThis,"__r8FrozenRouteObservation")?.()).then(async value=>{
   console.info(JSON.stringify({kind:"healthy-native-read-only-checkpoint",testOnlyMilliseconds:performance.now()-started,value}));
   const admissionStarted=performance.now();
   try{
    const admission=await page.evaluate(()=>Reflect.get(globalThis,"__r8FrozenRouteObservation")?.(true));
    console.info(JSON.stringify({kind:"healthy-native-admission-checkpoint",testOnlyMilliseconds:performance.now()-admissionStarted,value:admission}));
   }catch(error){console.info(JSON.stringify({kind:"healthy-native-admission-checkpoint-unavailable",testOnlyMilliseconds:performance.now()-admissionStarted,error:String(error)}));}
  },error=>console.info(JSON.stringify({kind:"healthy-native-read-only-checkpoint-unavailable",testOnlyMilliseconds:performance.now()-started,error:String(error)})));
 // The repeated terminal failure is a pending E4 admitted observation after
 // product calls finish. Re-time this SAME one-shot memory/journal checkpoint
 // so it inspects that wait; do not add queries or extend the test deadline.
 },enduranceDeadline===undefined?305_000:enduranceDeadline-55_000);
 // One late, explicitly partial checkpoint is attached before the original
 // deadline can prevent the final receipt. Reuse only completed observations
 // and already collected resource samples: no extra native scan or forced GC.
 const completedCheckpoint=setTimeout(()=>{
  const checkpointStarted=performance.now();
  void (async()=>{
   const value=await page.evaluate(()=>Reflect.get(globalThis,"__r8FrozenRouteObservation")?.(false,true));
   const cpuAtCheckpoint=(await browserCpu.send("SystemInfo.getProcessInfo")).processInfo;
   const snapshot={partial:true,completedOnly:true,checkpointElapsedMilliseconds:performance.now()-cpuStarted,
    testOnlyCheckpointMilliseconds:performance.now()-checkpointStarted,value,
    cpuBefore,cpuAtCheckpoint,matchedProcesses:cpuAtCheckpoint.flatMap(after=>{
     const before=cpuBefore.find(row=>row.id===after.id&&row.type===after.type);
     return before===undefined?[]:[{id:after.id,type:after.type,cpuSeconds:after.cpuTime-before.cpuTime}];}),
    resourceSampleCount:samples.length,lastResourceSample:samples.at(-1),
    sampledPeakJsHeapUsedBytes:Math.max(...samples.map(row=>row.jsHeapUsedBytes)),
    sampledPeakIndexedDbAllocatedBytes:Math.max(...samples.map(row=>row.indexedDbAllocatedBytes)),
    activeMemory:[...activeMemory],samplingErrors:samplingErrors.map(String),browserVersion,
    qualification:"Partial completed observations only; in-flight phase time is absent. Local publication completion is not remote application. CPU includes product/test/transport/automatic GC and only matched process lifetimes; automatic GC duration is unmeasured. Existing resource samples are lower-bound peaks, not RSS/hard maxima; activeMemory includes earlier separately measured forced GC, none performed by this checkpoint."};
   await info.attach("healthy-native-partial-completed-checkpoint",{body:Buffer.from(JSON.stringify(snapshot)),contentType:"application/json"});
   console.info(JSON.stringify({kind:"healthy-native-partial-completed-checkpoint-attached",phase:value?.phase,epoch:value?.epoch,
    ordinaryCount:value?.ordinaryCount,completedTransitions:value?.completedTransitions,testOnlyCheckpointMilliseconds:snapshot.testOnlyCheckpointMilliseconds}));
  })().catch(error=>console.info(JSON.stringify({kind:"healthy-native-partial-completed-checkpoint-unavailable",error:String(error),
   testOnlyCheckpointMilliseconds:performance.now()-checkpointStarted})));
 },enduranceDeadline===undefined?300_000:enduranceDeadline-60_000);
 const poolLull=process.env.STARTUP_HEALTHY_GRID_POOL_LULL;
 if(poolLull==="1"||poolLull==="concurrent")await page.evaluate(()=>Reflect.set(globalThis,"__rdPoolMaintenanceLull",true));
 // Gameplay moves issued while the creator's pool maintenance is running.
 if(poolLull==="concurrent")await page.evaluate(()=>Reflect.set(globalThis,"__rdPoolMaintenanceConcurrent",true));
 // Opt-in automatic idle trigger instead of the explicit lull call.
 if(process.env.STARTUP_HEALTHY_GRID_POOL_AUTO==="1")await page.evaluate(()=>Reflect.set(globalThis,"__rdPoolMaintenanceAuto",true));
 // Opt-in single room database for every owner (slice 14a); the default host is unchanged.
 if(process.env.STARTUP_HEALTHY_GRID_ROOM_DATABASE==="1")await page.evaluate(()=>Reflect.set(globalThis,"__rdRoomDatabase",true));
 // Opt-in verified retention decisions on the room database (slice 14b); needs ROOM_DATABASE.
 if(process.env.STARTUP_HEALTHY_GRID_ROOM_RETENTION==="1")await page.evaluate(()=>Reflect.set(globalThis,"__rdRoomRetention",true));
 // Measurement only: STARTUP_HEALTHY_GRID_SEAL_IDLE_GAP_MS waits that many milliseconds before each seal. Unset, none.
 const sealIdleGap=process.env.STARTUP_HEALTHY_GRID_SEAL_IDLE_GAP_MS;
 if(sealIdleGap!==undefined){const value=Number(sealIdleGap);if(!Number.isSafeInteger(value)||value<1||value>60_000)throw new Error("bounded seal idle gap required");
  await page.evaluate(gap=>Reflect.set(globalThis,"__rdSealIdleGapMilliseconds",gap),value);}
 // Opt-in speculative presentation: "1" overlay plus ephemeral intents, "overlay" without intents.
 const presentationMode=process.env.STARTUP_HEALTHY_GRID_PRESENTATION;
 if(presentationMode==="1"||presentationMode==="overlay")await page.evaluate(mode=>Reflect.set(globalThis,"__rdPresentation",mode),presentationMode);
 // Renderer task durations (toplevel RunTask) with user-timing clock marks from
 // each role frame, written next to the report. Observation only.
 // "window" traces only seal-4 through the next lull, with V8 CPU samples.
 const taskTrace=process.env.STARTUP_HEALTHY_GRID_TASK_TRACE==="1",taskTraceWindow=process.env.STARTUP_HEALTHY_GRID_TASK_TRACE==="window";
 let taskTraceOpen=false;
 // Measurement only: STARTUP_HEALTHY_GRID_TASK_TRACE_CATEGORIES (comma list, for example IndexedDB) adds trace categories to
 // the whole-run task trace. Unset by default (toplevel and blink.user_timing only).
 const extraTraceCategories=(process.env.STARTUP_HEALTHY_GRID_TASK_TRACE_CATEGORIES??"").split(",").map(category=>category.trim()).filter(Boolean);
 if(taskTrace){await ownedBrowser.startTracing(page,{path:join(process.env.STARTUP_EVIDENCE!,"task-trace.json"),categories:["toplevel","blink.user_timing",...extraTraceCategories]});taskTraceOpen=true;}
 if(taskTraceWindow)await page.exposeFunction("__rdTraceControl",async(command:string)=>{
  if(command==="start"&&!taskTraceOpen){await ownedBrowser.startTracing(page,{path:join(process.env.STARTUP_EVIDENCE!,"task-trace.json"),
   categories:["toplevel","blink.user_timing","disabled-by-default-v8.cpu_profiler"]});taskTraceOpen=true;}
  else if(command==="stop"&&taskTraceOpen){await ownedBrowser.stopTracing();taskTraceOpen=false;}
 });
 try{receipt=await page.evaluate(async({origins,rollovers,fixedIdentity,creatorProfile})=>{try{return await Reflect.get(globalThis,"r8HealthyGrid")(fixedIdentity??"r8-integrated-"+Date.now(),origins,rollovers,creatorProfile);}catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}},{origins:clients.map(client=>client.origin),rollovers,fixedIdentity,creatorProfile});}
 finally{
  if(taskTraceOpen){await ownedBrowser.stopTracing();taskTraceOpen=false;}
  if(criticalCheckpoint)clearTimeout(criticalCheckpoint);
  await saveCriticalCapture("terminal");
  clearTimeout(traceCheckpoint);
  clearTimeout(completedCheckpoint);
  const cpuEnded=performance.now(),cpuAfter=(await browserCpu.send("SystemInfo.getProcessInfo")).processInfo;
  await info.attach("healthy-native-process-cpu",{body:Buffer.from(JSON.stringify({cpuStarted,cpuEnded,wallMilliseconds:cpuEnded-cpuStarted,cpuBefore,cpuAfter,
   matchedProcesses:cpuAfter.flatMap(after=>{const before=cpuBefore.find(row=>row.id===after.id&&row.type===after.type);return before===undefined?[]:[{id:after.id,type:after.type,cpuSeconds:after.cpuTime-before.cpuTime}];}),
   qualification:"Actual owned test-browser process CPU counters, not CPU samples or per-client/product-only CPU. Healthy body includes labelled assertions, transport, logging, read-only measurements and forced GC. Unmatched/new or disappeared processes have no exact lifetime CPU delta; retain both snapshots. Automatic GC is not independently timed by this browser machinery; profiler GC samples are samples, not GC event durations."})),contentType:"application/json"});
  await browserCpu.detach();
  if(profileCpu){const cpu=await cdp.send("Profiler.stop");await info.attach("healthy-native-cpu-profile",{body:Buffer.from(JSON.stringify(cpu.profile)),contentType:"application/json"});}
  clearInterval(timer);await pending;await sample();const beforeGc=samples.at(-1),gcStarted=performance.now();
  await cdp.send("HeapProfiler.collectGarbage");const testOnlyGcMilliseconds=performance.now()-gcStarted;await sample();
  await info.attach("healthy-native-resource-measurements",{body:Buffer.from(JSON.stringify({intervalMilliseconds:200,samples,beforeGc,postGc:samples.at(-1),testOnlyGcMilliseconds,activeMemory,
   sampledPeakJsHeapUsedBytes:Math.max(...samples.map(row=>row.jsHeapUsedBytes)),sampledPeakIndexedDbAllocatedBytes:Math.max(...samples.map(row=>row.indexedDbAllocatedBytes)),
   samplingErrors:samplingErrors.map(String),browserVersion,
   qualification:"Native Chromium IndexedDB allocated profile blocks and renderer JS heap, sampled lower-bound peaks not hard maxima/RSS. Single-renderer four-client simulator plus retained test records, not distributed/device viability. Physical storage includes native metadata/WAL. Sampling, native read-only assertion scans and forced GC are test overhead; no absolute gameplay latency/physical-memory target defined."})),contentType:"application/json"});
  await cdp.detach();
  await Promise.all(clients.map(client=>client.close()));
 }
 if(heapSnapshots.length)await info.attach("healthy-native-heap-snapshots",{body:Buffer.from(JSON.stringify(heapSnapshots)),contentType:"application/json"});
 if(longTasks)await info.attach("healthy-native-longtasks",{body:Buffer.from(JSON.stringify(await page.evaluate(()=>Reflect.get(globalThis,"__rdLongTasks")?.()))),contentType:"application/json"});
 await info.attach("healthy-native-integrated-result",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
 if(suspendHealthyGrid){
  await info.attach("native-browser-suspension",{body:Buffer.from(JSON.stringify(suspensions)),contentType:"application/json"});
  expect(suspensions).toHaveLength(1);expect(receipt.suspensionEvents).toHaveLength(1);
 }
 expect(receipt.ok,JSON.stringify({phase:receipt.phase,error:receipt.error})).toBe(true);
 expect(receipt.profileId).toBe(creatorProfile);
 expect(samplingErrors.map(String)).toEqual([]);
 // Measurement only: with the harness's records counted, the lists are empty and their counts carry the same checks.
 const countedRecords=harnessRecords==="counted"?receipt.harnessRecordCounts:undefined;
 if(countedRecords!==undefined){
  expect(countedRecords.transitions).toBe(rollovers);expect(receipt.epoch).toBe(rollovers);expect(receipt.phase).toBe("continued-gameplay");
  expect(countedRecords.ordinary).toBe(rollovers*8+4);expect(countedRecords.snapshots).toBe(rollovers);
 }else{
 expect(receipt.transitions).toHaveLength(rollovers);expect(receipt.epoch).toBe(rollovers);expect(receipt.phase).toBe("continued-gameplay");
 expect(receipt.ordinary).toHaveLength(rollovers*8+4);expect(receipt.snapshots).toHaveLength(rollovers);
 }
 expect(activeMemory.length).toBeGreaterThan(0);
 expect(receipt.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
 expect(receipt.proofEventsTruncated).toBe(false);
 expect(receipt.roleObservers.every((row:any)=>!row.observer.proofEventsTruncated)).toBe(true);
 // Every role realm observed with exactly the scaled budget, not a silent default.
 expect(receipt.roleObservers.every((row:any)=>row.observer.proofEventBudget===proofEventBudget)).toBe(true);
 expect(receipt.roleObservers.reduce((count:number,row:any)=>count+row.observer.proofEvents.length,0)).toBeGreaterThan(0);
 if(finishingWindowFile!==undefined&&!incrementalNativeControls){
  const events=receipt.roleObservers.flatMap((row:any)=>row.observer.proofEvents);
  // Single-epoch ordinary work and later epochs share this same invariant.
  // Boundary preparation is allowed; silently reconstructing on ordinary calls
  // or declaring supported later work exceptional is not.
  expect(events.filter((event:any)=>event.kind==="ordinary-finishing-resource-program-build"&&event.phase!=="boundary-preparation")).toEqual([]);
  expect(events.filter((event:any)=>event.kind==="ordinary-incremental-fallback"||event.kind==="ordinary-window-delivery-declined")).toEqual([]);
  const hits=events.filter((event:any)=>event.kind==="ordinary-incremental-hit");
  for(let epoch=0;epoch<=rollovers;epoch++)for(const phase of ["local-issuance","received-append"])
   expect(hits.some((event:any)=>event.epoch===epoch&&event.phase===phase)).toBe(true);
 }
 if(incrementalNativeControls){
  const events=receipt.roleObservers.flatMap((row:any)=>row.observer.proofEvents),book=events.filter((event:any)=>event.kind==="incremental-native-current-book-control");
  expect(book.length).toBeGreaterThan(0);
  expect(new Set(book.map((event:any)=>event.phase))).toEqual(new Set(["local-issuance","received-append"]));
  expect(book.every((event:any)=>event.ok&&event.joined&&event.noFutureConstructors&&event.nativeCurrencyUnchanged&&event.chargedAfter===event.maxBytes&&/^[0-9a-f]{64}$/u.test(event.sourcePin))).toBe(true);
  expect(book.every((event:any)=>event.profileId===creatorProfile)).toBe(true);
  // This focused settlement repair must exercise later epochs, not obtain a
  // vacuous pass from genesis-only numerical/factory comparisons.
  if(creatorProfile==="creator-trusted-settlement-v1"){
   expect(new Set(book.map((event:any)=>event.epoch))).toEqual(new Set(Array.from({length:rollovers+1},(_,epoch)=>epoch)));
  }
  const factory=events.filter((event:any)=>event.kind==="incremental-original-factory-native-dominance");
  expect(factory).toHaveLength(book.length);
  expect(new Set(factory.map((event:any)=>event.phase))).toEqual(new Set(["local-issuance","received-append"]));
  expect(factory.every((event:any)=>event.ok&&event.joined&&event.distinctBook&&event.exactComposer&&event.profileId===creatorProfile&&event.chargedAfter>=event.chargedBefore)).toBe(true);
  for(const event of factory){
   expect(event.programEnvelopeByteLengths.length).toBeGreaterThan(0);expect(event.originalFactoryEnvelopeByteLengths.length).toBeGreaterThan(0);
   expect([...event.programEnvelopeByteLengths,...event.originalFactoryEnvelopeByteLengths].every(value=>Number.isSafeInteger(value)&&value>=0)).toBe(true);
   expect(Math.max(...event.programEnvelopeByteLengths)).toBeGreaterThanOrEqual(Math.max(...event.originalFactoryEnvelopeByteLengths));
  }
  expect(events.filter((event:any)=>event.kind==="incremental-native-valid-continuation-control")).toHaveLength(book.length);
  const sources=events.filter((event:any)=>event.kind==="incremental-native-copied-source-control"),charges=events.filter((event:any)=>event.kind==="incremental-native-current-charge-control");
  expect(sources.length).toBeGreaterThanOrEqual(book.length);expect(sources.every((event:any)=>event.ok&&event.joined)).toBe(true);
  // The separate unspent diagnostic probe has no admission context or I-spend.
  // Every real valid-continuation quote still owes the complete charge check.
  for(const epoch of new Set(book.map((event:any)=>event.epoch)))for(const phase of ["local-issuance","received-append"]){
   expect(charges.filter((event:any)=>event.epoch===epoch&&event.phase===phase).length).toBeGreaterThanOrEqual(
    book.filter((event:any)=>event.epoch===epoch&&event.phase===phase).length);
  }
  expect(charges.every((event:any)=>event.ok&&event.noFutureConstructors&&event.chargedAfter===event.chargedBefore+event.knownChargedBytes+event.unknownChargedBytes)).toBe(true);
 }
 if(countedRecords!==undefined)expect(receipt.transfers.length+receipt.roleObservers.reduce((count:number,row:any)=>count+(row.observer.harnessRecordsCounted?.streamBytes??0),0)).toBeGreaterThan(0);
 else expect(receipt.transfers.length).toBeGreaterThan(0);
 expect(Math.max(...samples.map(row=>row.indexedDbAllocatedBytes))).toBeGreaterThan(0);
});
test("public room pending bytes refuse before stalled native work drains and join every admitted caller",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8RoomPendingBytes")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8RoomPendingBytes")("r8-public-bytes-"+Date.now())};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("public-room-pending-bytes",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease.signCalls).toBe(1);
	expect(value.expectedRefused.length).toBeGreaterThan(0);
	expect(value.expectedHeldBytes).toBeLessThanOrEqual(value.limitBytes);
	expect(value.expectedHeldCount).toBeLessThan(value.limitEntries);
	expect(value.beforeRelease.settled.map((row:{index:number})=>row.index)).toEqual(value.expectedRefused);
	expect(value.beforeRelease.settled.every((row:{ok:boolean;reason:string})=>
		!row.ok&&row.reason.includes("pending input byte capacity"))).toBe(true);
	expect(value.settled).toHaveLength(300);
	expect(value.after.next).toBeGreaterThan(value.before.next);
	expect(value.firstOperation).toEqual({action:"message",clientOperationId:"entered",text:"entered"});
	expect(value.refillBytes).toBeGreaterThan(value.limitBytes-value.expectedHeldBytes);
	if(!value.refill.ok)expect(value.refill.reason).not.toContain("pending input");
	// Backend quota is not the public buffer: the joined next call must not
	// retain a stale buffer refusal, whether it publishes or hits native quota.
	if(!value.continuation.ok)expect(value.continuation.reason).not.toContain("pending input");
});
for (const [inheritedSnapshot,persistedReopen] of [[false,false],[true,false],[true,true]]) {
test(persistedReopen ? "native successor terminal migration reopens persisted redirect and continues target gameplay" : inheritedSnapshot ? "native terminal migration preserves inherited snapshot and current epoch through target continuation" : "healthy native terminal migration commits and publishes target continuation",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8HealthyTerminalMigration")==="function");
	// Read only the existing in-memory observations before timeout tears down
	// the page. This adds no await to the product scenario or native transaction.
	const traceCheckpoint = setTimeout(()=>{
		void page.evaluate(()=>Reflect.get(globalThis,"r8HealthyTerminalTrace")?.()).then(value=>{
			console.log(JSON.stringify({lane:"terminal-migration-stall-checkpoint",trace:value}));
		},error=>{console.log(JSON.stringify({lane:"terminal-migration-stall-checkpoint-unavailable",error:String(error)}));});
	},15_000);
	const receipt=await page.evaluate(async ([inheritedSnapshot,persistedReopen])=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8HealthyTerminalMigration")("r8-terminal-healthy-"+Date.now(), inheritedSnapshot,persistedReopen)};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	}, [inheritedSnapshot,persistedReopen]).catch(async error=>{
		clearTimeout(traceCheckpoint);
		const trace=await page.evaluate(()=>Reflect.get(globalThis,"r8HealthyTerminalTrace")?.()).catch(()=>undefined);
		if(trace!==undefined)await info.attach("healthy-native-terminal-unjoined-trace",{body:Buffer.from(JSON.stringify(trace)),contentType:"application/json"});
		throw error;
	});
	clearTimeout(traceCheckpoint);
	await info.attach("healthy-native-terminal-migration",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	if (inheritedSnapshot) {
		expect(value.before.accepted).toHaveLength(2);
		expect(value.before.accepted[0]).toMatchObject({provenance:"authenticated-snapshot",text:"native durable source"});
		expect(value.before.accepted[1]).toMatchObject({text:"native current epoch source"});
		expect(value.rehearsal.importedOperationCount).toBe(2);
	}
	expect(value.rehearsal).toMatchObject({activated:false});
	expect(value.rehearsal.importedOperationCount).toBeGreaterThan(0);
	expect(value.activation).toMatchObject({activated:true,targetAnchorDigest:value.targetRoomId});
	expect(value.objectId).toBe(value.targetObjectId);
	expect(value.sourceRefusal).toContain("terminal source cannot issue");
	// Registered vertex identity changes with the object. The application's
	// original migration owner, not a test-side projection reducer, defines state.
	expect(value.afterCanonicalStateBytes).toBe(value.beforeCanonicalStateBytes);
	expect(value.after.accepted).toHaveLength(value.before.accepted.length);
	expect(value.after.accepted[0].digest).not.toBe(value.before.accepted[0].digest);
	expect(JSON.stringify(value.continuation)).toContain("native target continuation");
	if (persistedReopen) {
		expect(value.reopened).toMatchObject({objectId:value.targetObjectId,roomId:value.targetRoomId});
		expect(value.reopened.recoveredCanonicalStateBytes).toBe(value.reopened.expectedCanonicalStateBytes);
		expect(JSON.stringify(value.continuation)).toContain("native reopened target continuation");
	}
	expect(value.staleSourceRefusal).toContain("issuance-rejected");
	expect(value.afterStaleRefusal).toEqual(value.continuation);
	expect(value.staleSourceNative).toHaveLength(1);
	expect(value.staleSourceNative[0].value).toMatchObject({error:"TypeError: migration source whole-floor is stale",cryptoEntered:false,terminalTransactionStarted:false});
	expect(value.resourceCharges.some((row:{site:string})=>row.site==="migration-proof-enforced-forecast")).toBe(true);
	for(const row of value.resourceCharges)expect(row.value.chargedBytes).toBeLessThanOrEqual(row.value.maxBytes);
	expect(value.joins).toHaveLength(persistedReopen?4:2);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
}
test("stalled native retained publisher joins duplicate demand but preserves later queue cuts and retries",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-retained-queue-"+Date.now(),"stalled-retained-publication")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-retained-publication",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease).toEqual({enteredJobs:1,signCalls:0,beforeIssueFlights:1,afterIssueFlights:1,distinctQueueCuts:true});
	expect(value.first).toMatchObject({ok:false,kind:"publish-failed"});
	expect(value.beforeIssue).toHaveLength(40);
	expect(value.afterIssue).toHaveLength(40);
	for(const result of [...value.beforeIssue,...value.afterIssue])expect(result).toMatchObject({ok:true,kind:"published"});
	expect(value.observations.some((row:{signCalls:number;enteredJob:number})=>row.enteredJob>1&&row.signCalls===0)).toBe(true);
	expect(value.observations.some((row:{signCalls:number})=>row.signCalls===1)).toBe(true);
	expect(value.prefix).toMatchObject({ok:true});
	expect(value.suffix).toMatchObject({ok:true});
	expect(value.publishedSuffix).toMatchObject({ok:true,kind:"published"});
	expect(value.signCalls).toBe(2);
	expect(value.joins).toHaveLength(10);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native pending publication explicitly bounds fresh FIFO requests and refunds after join",async({page},info)=>{
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-pending-admission-"+Date.now(),"stalled-pending-publication")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-pending-publication",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);const value=receipt.result;
	expect(value.beforeRelease.owners.admittedPendingPublicationJobs).toBe(32);
	expect(value.beforeRelease.settled).toHaveLength(8);
	for(const row of value.beforeRelease.settled)expect(row.value).toMatchObject({ok:false,kind:"admission-rejected"});
	expect(value.afterJoin.admittedPendingPublicationJobs).toBe(0);
	expect(value.settled.filter((row:any)=>row.value.ok)).toHaveLength(32);
	expect(value.settled.filter((row:any)=>row.value.ok).map((row:any)=>row.index)).toEqual(Array.from({length:32},(_,index)=>index));
	expect(value.admittedResultsDistinct).toBe(true);expect(value.retry.ok).toBe(true);
	expect(value.afterLineage).toEqual(value.beforeLineage);
	expect(value.prefix.ok).toBe(true);expect(value.suffix.ok).toBe(true);expect(value.signCalls).toBe(2);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native distinct publication cuts refuse before retaining excess work and resume after join",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-distinct-admission-"+Date.now(),"stalled-distinct-publication")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-distinct-publication",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);const value=receipt.result;
	expect(value.beforeRelease.owners.admittedEgressControlJobs).toBe(32);
	expect(value.beforeRelease.settled).toHaveLength(9);
	for(const row of value.beforeRelease.settled)expect(row.value).toMatchObject({ok:false,kind:"admission-rejected"});
	expect(value.afterJoin.admittedEgressControlJobs).toBe(0);
	expect(value.settled.filter((row:any)=>row.value.ok).map((row:any)=>row.index)).toEqual(Array.from({length:31},(_,index)=>index));
	expect(value.retry.ok).toBe(true);expect(value.afterLineage).toEqual(value.beforeLineage);
	expect(value.prefix.ok).toBe(true);expect(value.suffix.ok).toBe(true);expect(value.signCalls).toBe(2);
	expect(value.joins).toHaveLength(10);expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("native recovery census avoids a duplicate fresh replay scan and preserves source continuation",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-replay-reads-"+Date.now(),"replay-read-budget")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("native-replay-read-budget",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	// The preserved native baseline made 13 fresh scans in this exact lifetime.
	// This is a duplicate-read regression oracle, not a product capacity limit.
	expect(value.dependencyCalls.readiness).toBeLessThan(13);
	expect(value.dependencyCalls.pages).toBe(value.dependencyCalls.readiness);
	expect(value.censusBytes).toBeGreaterThan(0);expect(value.proofByteCharge).toBeGreaterThan(0);
	expect(value.prefix).toMatchObject({ok:true});expect(value.suffix).toMatchObject({ok:true});
	expect(value.signCalls).toBe(2);expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native ingress captures bounded private wire bytes before terminal barrier waits",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-ingress-barrier-"+Date.now(),"stalled-ingress-barrier")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-ingress-barrier",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	for(const name of ["routed","oversizedRouted","fillerRouted","overflowRouted"])expect(value[name]).toBe(true);
	expect(value.afterValid).toMatchObject({admittedInputJobs:1,admittedInputBytes:value.wireBytes});
	expect(value.afterOversized).toEqual(value.afterValid);
	expect(value.afterFill).toMatchObject({admittedInputJobs:2,admittedInputBytes:value.maxPendingBytes});
	expect(value.afterOverflow).toEqual(value.afterFill);
	expect(value.beforeResume).toMatchObject({admittedInputJobs:2,admittedInputBytes:value.maxPendingBytes,terminalBarrierPresent:1});
	expect(value.resumed).toEqual({ok:true,kind:"resumed"});
	expect(value.joinedRead.ok).toBe(true);
	expect(value.afterJoin).toMatchObject({admittedInputJobs:0,admittedInputBytes:0,terminalBarrierPresent:0});
	expect(value.ingressAppends).toHaveLength(1);
	expect(value.ingressAppends[0]).toMatchObject({...value.expected,result:{ok:true,idempotent:true}});
	expect(value.afterLineage).toEqual(value.beforeLineage);
	expect(value.floorAfter).toEqual(value.floorBefore);
	expect(value.prefix).toMatchObject({ok:true});expect(value.suffix).toMatchObject({ok:true});
	expect(value.signCalls).toBe(2);expect(value.publication).toMatchObject({ok:true,kind:"published"});
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native terminal publication admits one call and refuses premature resume until join",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-terminal-publish-"+Date.now(),"stalled-terminal-publish")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-terminal-publication",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease.enteredJobs).toBe(1);
	expect(value.beforeRelease.signCalls).toBe(0);
	expect(value.beforeRelease.captureEntries).toBe(1);
	expect(value.beforeRelease.settled).toHaveLength(39);
	expect(value.beforeRelease.settled.every((row:{value:{ok:boolean;kind:string;terminalIntent:string}})=>
		!row.value.ok&&row.value.kind==="admission-rejected"&&row.value.terminalIntent==="absent")).toBe(true);
	expect(value.prematureResume).toMatchObject({ok:false,kind:"invalid-state"});
	expect(value.settled).toHaveLength(40);
	expect(value.settled.find((row:{index:number})=>row.index===0).value).toMatchObject({ok:false,kind:"malformed-input",terminalIntent:"absent"});
	expect(value.retry).toMatchObject({ok:false,kind:"malformed-input",terminalIntent:"absent"});
	expect(value.publication).toMatchObject({ok:true,kind:"published"});
	expect(value.resumed).toEqual({ok:true,kind:"resumed"});
	expect(value.prefix).toMatchObject({ok:true});
	expect(value.suffix).toMatchObject({ok:true});
	expect(value.signCalls).toBe(2);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native terminal input is captured before waiting and retains bounded bytes until join",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-terminal-bytes-"+Date.now(),"stalled-terminal-bytes")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-terminal-input-bytes",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease.enteredJobs).toBe(1);
	expect(value.beforeRelease.signCalls).toBe(0);
	expect(value.beforeRelease.captureEntries).toBe(1);
	expect(value.beforeRelease.owners.terminalPublicationInputBytes).toBe(value.queuedInputBytes);
	expect(value.beforeRelease.settled).toHaveLength(39);
	expect(value.beforeRelease.settled.every((row:{value:{ok:boolean;kind:string;terminalIntent:string}})=>
		!row.value.ok&&row.value.kind==="admission-rejected"&&row.value.terminalIntent==="absent")).toBe(true);
	expect(value.prematureResume).toMatchObject({ok:false,kind:"invalid-state"});
	// Caller mutation after admission must not become queued protocol input.
	expect(value.settled.find((row:{index:number})=>row.index===0).value).toMatchObject({ok:false,kind:"malformed-input",terminalIntent:"absent"});
	expect(value.afterJoinOwners.terminalPublicationInputBytes).toBe(0);
	expect(value.overflow).toMatchObject({ok:false,kind:"graph-rejected",terminalIntent:"absent"});
	expect(value.afterOverflowOwners.terminalPublicationInputBytes).toBe(0);
	expect(value.retry).toMatchObject({ok:false,kind:"malformed-input",terminalIntent:"absent"});
	expect(value.resumed).toEqual({ok:true,kind:"resumed"});
	expect(value.prefix).toMatchObject({ok:true});
	expect(value.suffix).toMatchObject({ok:true});
	expect(value.signCalls).toBe(2);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native dependency reads bound control work and preserve required terminal continuation",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-control-"+Date.now(),"stalled-control")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-read-control",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease.enteredJobs).toBe(1);
	expect(value.beforeRelease.signCalls).toBe(0);
	expect(value.beforeRelease.settled).toHaveLength(9);
	expect(value.beforeRelease.settled.every((row:{ok:boolean;reason:string})=>!row.ok&&row.reason.includes("control task capacity"))).toBe(true);
	expect(value.beforeRelease.reads).toHaveLength(40);
	expect(value.beforeRelease.reads.every((row:{ok:boolean;kind:string})=>!row.ok&&row.kind==="admission-rejected")).toBe(true);
	expect(value.beforeRelease.transitions).toHaveLength(39);
	expect(value.beforeRelease.transitions.every((row:{ok:boolean;kind:string})=>!row.ok&&row.kind==="transition-active")).toBe(true);
	expect(value.settled).toHaveLength(40);
	expect(value.settled.filter((row:{ok:boolean})=>row.ok)).toHaveLength(31);
	expect(value.enteredJobs).toBe(32);
	expect(value.proofCharges.every((charge:number)=>charge>0)).toBe(true);
	expect(value.resumed).toEqual({ok:true,kind:"resumed"});
	expect(value.prefix).toMatchObject({ok:true});
	expect(value.suffix).toMatchObject({ok:true});
	expect(value.signCalls).toBe(2);
	expect(value.afterJoin).toBe(true);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native runtime input bytes refuse excess capture without authorizing foreign candidates",async({page},info)=>{
	test.setTimeout(180_000);
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-runtime-bytes-"+Date.now(),"stalled-bytes")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-runtime-input-bytes",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease.enteredJobs).toBe(1);
	expect(value.beforeRelease.signCalls).toBe(0);
	expect(value.expectedHeldCount).toBeLessThan(32);
	expect(value.expectedHeldBytes).toBeLessThanOrEqual(value.limitBytes);
	expect(value.beforeRelease.settled.map((row:{index:number})=>row.index)).toEqual(value.expectedRefused);
	expect(value.beforeRelease.settled.every((row:{value:{ok:boolean;kind:string;detail:string}})=>
		!row.value.ok&&row.value.kind==="admission-rejected"&&row.value.detail.includes("input byte capacity"))).toBe(true);
	expect(value.settled).toHaveLength(40);
	expect(value.settled.every((row:{value:{ok:boolean}})=>!row.value.ok)).toBe(true);
	expect(value.completedPrefix).toMatchObject({ok:true});
	expect(value.suffix).toMatchObject({ok:true});
	expect(value.signCalls).toBe(2);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test("stalled native settlement refuses excess tasks before capture and continues after admitted work joins",async({page},info)=>{
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-stalled-"+Date.now(),"stalled")};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("stalled-native-settlement",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	expect(value.beforeRelease.enteredJobs).toBe(1);
	expect(value.beforeRelease.signCalls).toBe(0);
	expect(value.beforeRelease.settled).toHaveLength(9);
	expect(value.beforeRelease.settled.every((row:{value:{ok:boolean;kind:string;detail:string}})=>
		!row.value.ok&&row.value.kind==="admission-rejected"&&row.value.detail.includes("task capacity"))).toBe(true);
	// The closed-input validator tries its two original permitted shapes;
	// only the31 admitted private inputs may reach it during the native stall.
	expect(value.beforeRelease.captureEntries).toBe(62);
	expect(value.beforeResume.barrierCaptures).toBe(0);
	expect(value.beforeResume.signCalls).toBe(1);
	expect(value.beforeResume.settled).toHaveLength(8);
	expect(value.beforeResume.settled.every((row:{ok:boolean;kind:string;detail:string})=>
		!row.ok&&row.kind==="admission-rejected"&&row.detail.includes("task capacity"))).toBe(true);
	expect(value.resumed).toEqual({ok:true,kind:"resumed"});
	expect(value.barrierSettled).toHaveLength(40);
	expect(value.barrierSettled.every((row:{ok:boolean})=>!row.ok)).toBe(true);
	expect(value.completedPrefix).toMatchObject({ok:true});
	expect(value.suffix).toMatchObject({ok:true});
	expect(value.settled).toHaveLength(40);
	expect(value.settled.every((row:{value:{ok:boolean}})=>!row.value.ok)).toBe(true);
	expect(value.enteredJobs).toBe(1);
	expect(value.signCalls).toBe(2);
	expect(value.plan.entries.at(-1).replacementProgress.chunks).toHaveLength(2);
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});
test.beforeAll(async()=>{
	if(process.env.STARTUP_ENTRY!=="r8-source-binding"||process.env.STARTUP_ARTIFACTS===undefined)throw new Error("explicit source-binding entry/artifacts required");
	local=await server(process.env.STARTUP_ARTIFACTS);
});
test.afterAll(async()=>{await local?.close();});
test("authenticated received pending retains certificate generation under completed native checkpoint", async ({page}, info) => {
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8ReceivedPending") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8ReceivedPending")("r8-received-" + Date.now())};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-received-pending", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result;
	expect(value.checkpointPremise).toBe("original-native-all-protected-metadata-only-not-seven-domain-migration");
	expect(value.before.ok).toBe(true);
	expect(value.before.value.control).toMatchObject({active: null, nominee: null, completed: {throughEpoch: 0}});
	expect(value.certificate.candidateGenerationId).not.toBe(value.head.generationId);
	expect(value.recovered, JSON.stringify(value)).toMatchObject({ok: true, lifecycle: "successor-published"});
	expect(value.afterHead).toMatchObject({ok: true, value: {generationId: value.certificate.candidateGenerationId,
		closureDigest: value.certificate.candidateClosureDigest}});
	expect(value.certificateUnchanged).toBe(true);
	expect(value.snapshotUnchanged).toBe(true);
	expect(value.beforeFloor.state.pending).not.toBeNull();
	expect(value.afterFloor.state).toEqual({stable: value.beforeFloor.state.pending.next, pending: null});
	for (const key of ["ok", "candidateExact", "scopeExact", "digestExact", "signatureValid", "outboxExact", "journalExact", "deliveryExact"])
		expect(value.continuation[key], key).toBe(true);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
});
test("authenticated inherited snapshot permits current continuation without a barrier bypass", async ({page}, info) => {
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-" + Date.now())};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-migration", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result;
	expect(value.sealed).toMatchObject({ok: true, epoch: 0, successorEpoch: 1});
	expect(value.authority).toMatchObject({epoch: 1, anchorDigest: value.sealed.successorAnchorDigest});
	expect(value.beforeStatus).toMatchObject({migration: "classification-required", legacyUnclassifiedScopes: 1, recoveryScopes: 0});
	expect(value.beforeStatus.legacyUnclassifiedContentBytes).toBeGreaterThan(0);
	expect(value.inspection).toMatchObject({kind: "present", status: {kind: "verified", retention: "legacy-unclassified"}});
	if (value.continuation.ok !== true) {
		expect(value.protectedInventory).toMatchObject({ok: true, owner: {migration: "classification-required"}});
		expect(value.afterHead).toEqual(value.beforeHead);
		expect(value.continuationSignCalls).toBe(0);
	} else {
		expect(value.afterStatus).toMatchObject({migration: "ready", legacyUnclassifiedScopes: 0,
			legacyUnclassifiedContentBytes: 0, recoveryScopes: 1,
			recoveryContentBytes: value.beforeStatus.legacyUnclassifiedContentBytes});
		expect(value.afterStatus.classificationIntent).toBeUndefined();
	}
	// Original physical payload/state/expiry/incarnations and floor STATE survive;
	// original cross-store metadata controls legitimately advance during R4 fences.
	expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
	// These preconditions discriminate a missing authenticated consumer/classifier
	// from absent bytes, corrupt schema, synthetic epoch or a harness-only failure.
	expect(value.cold.ok, JSON.stringify(value)).toBe(true);
	expect(value.cold).toMatchObject({epoch: value.authority.epoch, anchorDigest: value.authority.anchorDigest, currentWriter: true});
	expect(value.continuation.ok, JSON.stringify(value)).toBe(true);
	for (const key of ["ok", "candidateExact", "scopeExact", "digestExact", "signatureValid", "outboxExact", "journalExact", "deliveryExact"])
		expect(value.canonicalCorrespondence[key], JSON.stringify(value.canonicalCorrespondence)).toBe(true);
});
test("authenticated inherited classification resumes SAME intent after native apply interruption", async ({page}, info) => {
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-cold-" + Date.now(), "after-apply")};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-same-intent-resume", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result, interrupted = value.interruption;
	expect(interrupted.injected).toBe(true);
	expect(interrupted.interruptedBind.ok).toBe(false);
	expect(interrupted.pendingStatus).toMatchObject({migration: "classification-required", legacyUnclassifiedScopes: 0,
		recoveryScopes: 1, recoveryContentBytes: value.beforeStatus.legacyUnclassifiedContentBytes});
	expect(interrupted.pendingStatus.classificationIntent.promoted).toHaveLength(1);
	expect(interrupted.coldPendingStatus).toEqual(interrupted.pendingStatus);
	expect(interrupted.pendingCoordinator).toMatchObject({ok: true, value: {active: null, completed: {
		decisionDigest: interrupted.pendingStatus.classificationIntent.decisionDigest,
		sourceProofDigest: interrupted.pendingStatus.classificationIntent.sourceProofDigest}}});
	expect(interrupted.coldCoordinator).toEqual(interrupted.pendingCoordinator);
	expect(interrupted.afterCoordinator).toEqual(interrupted.pendingCoordinator);
	expect(interrupted.coldRefusal.ok).toBe(false);
	expect(interrupted.coldRefusalSignCalls).toBe(0);
	expect(interrupted.coldLineageAfter).toEqual(interrupted.coldLineageBefore);
	expect(interrupted.snapshotAfterRefusal).toEqual(interrupted.snapshotBeforeRefusal);
	expect(interrupted.issuanceAfterRefusal).toEqual(interrupted.issuanceBeforeRefusal);
	expect(interrupted.journalAfterRefusal).toEqual(interrupted.journalBeforeRefusal);
	expect(interrupted.refusalDeliveries).toBe(0);
	expect(interrupted.confirmBinding.ok).toBe(true);
	expect(interrupted.pendingPhysicalUnchanged).toBe(true);
	expect(value.afterStatus).toMatchObject({migration: "ready", legacyUnclassifiedScopes: 0,
		legacyUnclassifiedContentBytes: 0, recoveryScopes: 1, recoveryContentBytes: value.beforeStatus.legacyUnclassifiedContentBytes});
	expect(value.afterStatus.classificationIntent).toBeUndefined();
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
	expect(value.cold).toMatchObject({ok: true, epoch: value.authority.epoch, currentWriter: true});
	expect(value.binding.ok).toBe(true);
	expect(value.continuation.ok, JSON.stringify(value)).toBe(true);
	for (const key of ["ok", "candidateExact", "scopeExact", "digestExact", "signatureValid", "outboxExact", "journalExact", "deliveryExact"])
		expect(value.canonicalCorrespondence[key], JSON.stringify(value.canonicalCorrespondence)).toBe(true);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
	expect(value.joins.filter((row: {owner: string}) => row.owner.startsWith("interrupted-"))).toHaveLength(7);
});
test("authenticated inherited unknown debt retains unrelated bytes and refuses NEW", async ({page}, info) => {
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-unknown-" + Date.now(), "unknown")};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-unknown-refusal", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result;
	expect(value.beforeStatus).toMatchObject({migration: "classification-required", legacyUnclassifiedScopes: 2, recoveryScopes: 0});
	expect(value.afterStatus.migration).toBe("classification-required");
	expect(value.afterStatus.legacyUnclassifiedScopes).toBeGreaterThanOrEqual(1);
	expect(value.afterStatus.legacyUnclassifiedScopes + value.afterStatus.recoveryScopes).toBe(2);
	expect(value.afterStatus.legacyUnclassifiedContentBytes).toBeGreaterThan(0);
	expect(value.afterStatus.legacyUnclassifiedContentBytes + value.afterStatus.recoveryContentBytes)
		.toBe(value.beforeStatus.legacyUnclassifiedContentBytes);
	expect(value.unknown.scope.objectId).not.toBe(value.scope.objectId);
	expect(value.unknown.inspection).toMatchObject({kind: "present", status: {kind: "verified", retention: "legacy-unclassified"}});
	expect(value.continuation).toMatchObject({ok: false, kind: "admission-rejected"});
	expect(value.refusal).toEqual({signCalls: 0, deliveries: 0, lineageUnchanged: true,
		issuanceUnchanged: true, journalUnchanged: true, snapshotUnchanged: true});
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
});
test("authenticated inherited corrupt protected bytes refuse classification and NEW", async ({page}, info) => {
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-corrupt-" + Date.now(), "corrupt")};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-corrupt-refusal", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result;
	expect(value.corruption.beforeDigest).toBe(value.corruption.expectedDigest);
	expect(value.corruption.afterDigest).not.toBe(value.corruption.expectedDigest);
	expect(value.cold).toEqual({ok: false, kind: "snapshot-unavailable", detail: "creator successor snapshot is unavailable"});
	expect(value.deliveredCount).toBe(0);
	expect(value.afterHead).toEqual(value.beforeHead);
	expect(value.beforeStatus).toMatchObject({migration: "classification-required", legacyUnclassifiedScopes: 1, recoveryScopes: 0});
	expect(value.afterStatus).toEqual(value.beforeStatus);
	expect(value.continuation.ok).toBe(false);
	expect(value.continuationSignCalls).toBe(0);
	expect(value.applicationNativeUnchanged).toBe(true);
	expect(value.exactInheritedImageUnchanged).toBe(true);
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
});
test("authenticated inherited native quota 1370 retains genuine 1371 debt and refuses NEW", async ({page}, info) => {
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-quota-" + Date.now(), "quota")};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-custom-native-quota-refusal", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result;
	expect(value.configuredRecoveryLimits).toEqual({maxRecoveryScopes: 4, maxRecoveryContentBytes: 1370});
	expect(value.cold).toMatchObject({ok: true, currentWriter: true});
	expect(value.binding).toEqual({ok: false, reason: "CREATOR_CLOSE_BIND_FAILED"});
	expect(value.continuation).toMatchObject({ok: false, kind: "admission-rejected"});
	expect(value.refusal).toEqual({signCalls: 0, deliveries: 0, lineageUnchanged: true,
		issuanceUnchanged: true, journalUnchanged: true, snapshotUnchanged: true});
	expect(value.deliveredCount).toBe(0);
	expect(value.afterHead).toEqual(value.beforeHead);
	expect(value.beforeStatus).toMatchObject({limits: value.configuredRecoveryLimits, migration: "classification-required",
		legacyUnclassifiedScopes: 1, legacyUnclassifiedContentBytes: 1371, recoveryScopes: 0});
	expect(value.afterStatus).toEqual(value.beforeStatus);
	expect(value.continuation.ok).toBe(false);
	expect(value.continuationSignCalls).toBe(0);
	expect(value.applicationNativeUnchanged).toBe(true);
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
});
test("authenticated inherited mature current and two rollback scopes preserve shared native dependencies", async ({page}, info) => {
	// Three genuine setup transitions, not the one-transition starter case.
	// No protocol latency target or correctness/resource criterion is changed.
	test.setTimeout(270_000);
	page.on("console", message => {
		if (message.text().startsWith('{"lane":"inherited-migration-mature-phase"')) console.log(message.text());
	});
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-mature-" + Date.now(), "mature")};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-mature-union", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result, mature = value.mature;
	expect(value.transitions.map((row: {epoch: number; successorEpoch: number}) => [row.epoch, row.successorEpoch])).toEqual([[0, 1], [1, 2], [2, 3]]);
	expect(value.authority).toMatchObject({epoch: value.transitions[2].successorEpoch,
		anchorDigest: value.transitions[2].successorAnchorDigest});
	expect(mature.pendingCoverage).toBe("not-reached-no-synthetic-floor");
	expect(value.beforeFloor.state.pending).toBeNull();
	expect(value.beforeFloor.state.stable.epoch).toBe(value.authority.epoch);
	expect(mature.inheritedScopes).toHaveLength(3);
	const currentRoles = mature.signedRoleCuts[2].roles;
	expect(currentRoles.currentClose).toEqual(mature.signedRoleCuts[2].cutScope);
	expect(currentRoles.previousClose).toEqual(mature.signedRoleCuts[1].cutScope);
	expect(currentRoles.classifiedScopes).toContainEqual(mature.signedRoleCuts[0].cutScope);
	for (const scope of [currentRoles.currentClose, currentRoles.previousClose, mature.signedRoleCuts[0].cutScope])
		expect(mature.inheritedScopes).toContainEqual(scope);
	expect(value.beforeStatus).toMatchObject({migration: "classification-required", legacyUnclassifiedScopes: 3, recoveryScopes: 0});
	expect(value.beforeStatus.legacyUnclassifiedContentBytes).toBeGreaterThan(0);
	expect(value.afterStatus).toMatchObject({migration: "ready", legacyUnclassifiedScopes: 0,
		legacyUnclassifiedContentBytes: 0, recoveryScopes: 3, recoveryContentBytes: value.beforeStatus.legacyUnclassifiedContentBytes});
	expect(value.afterStatus.classificationIntent).toBeUndefined();
	expect(value.protectedInventory).toMatchObject({ok: true});
	for (const scope of mature.inheritedScopes) expect(value.protectedInventory.scopes.map((row: {scope: unknown}) => row.scope)).toContainEqual(scope);
	// These are actual identical addressed references retained in different roots,
	// not a count-only claim about shared dependency ancestry.
	expect(mature.sharedDependencies.length).toBeGreaterThan(0);
	for (const row of mature.sharedDependencies) {
		expect(row.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(row.byteLength).toBeGreaterThan(0);
		expect(new Set(row.generations).size).toBeGreaterThan(1);
	}
	expect(mature.sharedDependenciesAfter.map(({unchanged, ...row}: {unchanged: boolean}) => row)).toEqual(mature.sharedDependencies);
	expect(mature.sharedDependenciesAfter.every((row: {unchanged: boolean}) => row.unchanged)).toBe(true);
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
	expect(value.afterHead).toEqual(value.beforeHead);
	expect(value.cold).toMatchObject({ok: true, epoch: value.authority.epoch, anchorDigest: value.authority.anchorDigest, currentWriter: true});
	expect(value.binding).toEqual({ok: true});
	expect(value.continuation).toMatchObject({ok: true, authorSequence: mature.expectedContinuationSequence});
	for (const key of ["ok", "candidateExact", "scopeExact", "digestExact", "signatureValid", "outboxExact", "journalExact", "deliveryExact"])
		expect(value.canonicalCorrespondence[key], JSON.stringify(value.canonicalCorrespondence)).toBe(true);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
});
test("authenticated inherited pending snapshot classifies before native successor publication", async ({page}, info) => {
	test.setTimeout(270_000);
	await page.goto(local.origin + "/r8-source-binding");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "r8InheritedMigration") === "function");
	const receipt = await page.evaluate(async () => {
		try {return {ok: true, result: await Reflect.get(globalThis, "r8InheritedMigration")("r8-inherited-pending-" + Date.now(), "pending")};}
		catch (error) {return {ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined};}
	});
	await info.attach("authenticated-inherited-pending-union", {body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json"});
	expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
	const value = receipt.result;
	expect(value.transitions.map((row: {epoch: number; successorEpoch: number}) => [row.epoch, row.successorEpoch])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
	expect(value.pendingPublication.faultConsumed).toBe(true);
	expect(value.pendingPublication.publicationError).toBeTruthy();
	expect(value.beforeFloor.state.stable.epoch).toBe(3);
	expect(value.beforeFloor.state.pending).toMatchObject({previous: value.beforeFloor.state.stable,
		next: {epoch: 4, currentAnchorDigest: value.transitions[3].successorAnchorDigest}});
	expect(value.inheritedScopes).toHaveLength(4);
	for (const row of value.signedRoleCuts) expect(value.inheritedScopes).toContainEqual(row.cutScope);
	expect(value.beforeStatus).toMatchObject({migration: "classification-required", legacyUnclassifiedScopes: 4, recoveryScopes: 0});
	expect(value.publicRefusal.result).toMatchObject({ok: false, kind: "snapshot-migration-required"});
	expect(value.publicRefusal.afterStatus).toEqual(value.beforeStatus);
	expect(value.publicRefusal.afterHead).toEqual(value.beforeHead);
	expect(value.publicRefusal.afterFloor).toEqual(value.beforeFloor);
	for (const name of ["snapshotUnchanged", "issuanceUnchanged", "journalUnchanged", "applicationUnchanged"]) expect(value.publicRefusal[name], name).toBe(true);
	expect(value.exactInheritedContentUnchanged).toBe(true);
	expect(value.joins.every((row: {ok: boolean}) => row.ok)).toBe(true);
		expect(value.sharedDependencies.length).toBeGreaterThan(0);
		expect(value.sharedDependenciesAfter.map(({unchanged, ...row}: {unchanged: boolean}) => row)).toEqual(value.sharedDependencies);
		expect(value.sharedDependenciesAfter.every((row: {unchanged: boolean}) => row.unchanged)).toBe(true);
	// Intended positive remains RED until existing pending recovery composes
	// authenticated metadata classification and fresh native confirmation.
	expect(value.recovered, JSON.stringify(value.recovered)).toMatchObject({ok: true, authority: {epoch: 4, anchorDigest: value.beforeFloor.state.pending.next.currentAnchorDigest}});
	expect(value.afterStatus).toMatchObject({migration: "ready", legacyUnclassifiedScopes: 0, recoveryScopes: 4,
		recoveryContentBytes: value.beforeStatus.legacyUnclassifiedContentBytes});
		expect(value.publicationObservations).toHaveLength(1);
		const publication = value.publicationObservations[0].value;
		expect(publication.status).toMatchObject({migration: "ready", legacyUnclassifiedScopes: 0, recoveryScopes: 4});
		expect(publication.status.classificationIntent).toBeUndefined();
		expect(publication.expectedHead).toEqual(value.beforeHead.value);
		expect(publication.candidateHead.generationId).toBe(value.afterHead.value.generationId);
		expect(publication.candidateHead.closureDigest).toBe(value.afterHead.value.closureDigest);
		expect(publication.floor.state).toEqual(value.beforeFloor.state);
		expect(value.afterFloor.state.stable).toEqual(value.beforeFloor.state.pending.next);
		expect(value.afterFloor.state.pending).toBeNull();
		expect(value.signingReadiness.length).toBeGreaterThan(0);
		for (const status of value.signingReadiness) expect(status).toMatchObject({migration: "ready", legacyUnclassifiedScopes: 0});
		expect(value.continuation.startupOldRowsRetained).toBe(true);
		expect(value.continuation.startupProjection).toEqual(value.continuation.originalProjection);
		// The original room settles this fully covered close with exactly its
		// epoch-four author fence. No application replacement or NEW message may
		// hide in the allowed post-ready startup effects.
		const beforeSequence = value.continuation.applicationBeforeState.lineage.next;
		expect(value.continuation.startupApplication.lineage).toEqual({exhausted: false, next: beforeSequence + 1});
		expect(value.continuation.startupRows).toHaveLength(1);
		const fence = value.continuation.startupRows[0];
		expect(fence.sequence).toBe(beforeSequence);
		expect(fence.body).toMatchObject({authorSequence: beforeSequence, epoch: 4,
			anchor: value.beforeFloor.state.pending.next.currentAnchorDigest, objectId: value.beforeHead.value.objectId,
			author: value.continuation.startupPlan.scope.author,
			operation: {action: "$drp.author-fence.v1", version: 1, fenceSequence: beforeSequence}});
		expect(value.continuation.startupPlan).toMatchObject({fenceSequence: beforeSequence, entries: []});
		for (const field of ["signatureValid", "digestValid", "issuedExact", "journalExact"]) expect(fence[field], field).toBe(true);
		// Author fences are protocol controls, not application delivery.
		expect(fence.deliveries).toEqual([]);
		for (const name of ["ok", "applicationBeforeContinuation", "candidateExact", "scopeExact", "digestExact", "signatureValid", "outboxExact", "journalExact", "deliveryExact"]) expect(value.continuation[name], name).toBe(true);
});
const sourceResourceMode=process.env.STARTUP_SOURCE_RESOURCE_MODE;
if(sourceResourceMode!==undefined&&sourceResourceMode!=="stalled")throw new Error("source resource mode invalid");
test(sourceResourceMode==="stalled"?"held nonempty native replacement measures resource custody and joins with enforcement":"owned historical Referee transforms exact source intervals and refuses new stale foreign work",async({page},info)=>{
	page.on("pageerror",error=>console.log(String(error)));
	page.on("console",message=>{if(message.text().includes("R8_SETUP_"))console.log(message.text());});
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	// Optional direct measurements on this same original native body. CDP heap
	// and allocated IndexedDB directory blocks are not encoded proof charges,
	// quota estimates, total process RSS, or a hard maximum between samples.
	const measureResources=process.env.STARTUP_SOURCE_NATIVE_RESOURCES==="1";
	if(sourceResourceMode!==undefined&&!measureResources)throw new Error("held resource mode requires original native measurement");
	const sourcePayloadBytes=Number(process.env.STARTUP_SOURCE_RESOURCE_PAYLOAD_BYTES??0);
	if(!Number.isSafeInteger(sourcePayloadBytes)||sourcePayloadBytes<0||sourcePayloadBytes>8192||
		(sourcePayloadBytes!==0&&!measureResources))throw new Error("source resource payload requires the scoped native measurement");
	if(measureResources&&info.project.name!=="chromium")throw new Error("native source resource measurement requires Chromium CDP");
	const cdp=measureResources?await page.context().newCDPSession(page):undefined;
	const command=cdp===undefined?undefined:await cdp.send("Browser.getBrowserCommandLine");
	const browserVersion=cdp===undefined?undefined:(await cdp.send("Browser.getVersion")).product;
	const profile=command?.arguments.find(argument=>argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
	if(measureResources&&(profile===undefined||!isAbsolute(profile)))throw new Error("native browser profile unavailable for direct disk measurement");
	const physicalDirectory=profile===undefined?undefined:join(profile,"Default","IndexedDB");
	const samples:{elapsedMilliseconds:number;jsHeapUsedBytes:number;jsHeapTotalBytes:number;indexedDbAllocatedBytes:number}[]=[];
	const samplingErrors:unknown[]=[];
	const started=performance.now();
	const sample=async()=>{
		if(cdp===undefined||physicalDirectory===undefined)return;
		const {metrics}=await cdp.send("Performance.getMetrics");
		const used=metrics.find(metric=>metric.name==="JSHeapUsedSize")?.value;
		const total=metrics.find(metric=>metric.name==="JSHeapTotalSize")?.value;
		if(used===undefined||total===undefined)throw new Error("native heap metrics unavailable");
		const present=await stat(physicalDirectory).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error;});
		const allocated=present?Number((await promisify(execFile)("/usr/bin/du",["-sk",physicalDirectory])).stdout.split(/\s+/u)[0])*1024:0;
		if(!Number.isSafeInteger(allocated))throw new Error("native IndexedDB allocated byte measurement invalid");
		samples.push({elapsedMilliseconds:performance.now()-started,jsHeapUsedBytes:used,jsHeapTotalBytes:total,indexedDbAllocatedBytes:allocated});
	};
	await cdp?.send("Performance.enable");
	await sample();
	let pending=Promise.resolve();
	const timer=cdp===undefined?undefined:setInterval(()=>{pending=pending.then(sample).catch(error=>{samplingErrors.push(error);});},200);
	const activeMemory:unknown[]=[];
	if(sourceResourceMode==="stalled") {
		if(cdp===undefined)throw new Error("held resource checkpoint requires native CDP");
		const activeCdp=cdp;
		await page.exposeFunction("__r8ActiveResourceCheckpoint",async(label:string)=>{
		await pending;await sample();const before=samples.at(-1),start=performance.now();
		await activeCdp.send("HeapProfiler.collectGarbage");const testOnlyGcMilliseconds=performance.now()-start;await sample();
		activeMemory.push({label,before,after:samples.at(-1),testOnlyGcMilliseconds});
		});
	}
	let result;
	try{result=await page.evaluate(async({sourcePayloadBytes,mode})=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-source-"+Date.now(),mode,sourcePayloadBytes)};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	},{sourcePayloadBytes,mode:sourceResourceMode});}finally{
		if(timer!==undefined)clearInterval(timer);
		await pending;
		if(cdp!==undefined){
			let beforeGc:typeof samples[number]|undefined,testOnlyGcMilliseconds:number|undefined;
			try{
				await sample();beforeGc=samples.at(-1);
				const gcStarted=performance.now();
				await cdp.send("HeapProfiler.collectGarbage");
				testOnlyGcMilliseconds=performance.now()-gcStarted;
				await sample();
			}catch(error){samplingErrors.push(error);}
			await info.attach("native-source-resource-measurements",{body:Buffer.from(JSON.stringify({
				intervalMilliseconds:200,samples,beforeGc,postGc:samples.at(-1),testOnlyGcMilliseconds,activeMemory,
				sampledPeakJsHeapUsedBytes:Math.max(...samples.map(row=>row.jsHeapUsedBytes)),
				sampledPeakIndexedDbAllocatedBytes:Math.max(...samples.map(row=>row.indexedDbAllocatedBytes)),
				samplingErrors:samplingErrors.map(String),browserVersion,
				qualification:"Chromium native IndexedDB, renderer JS heap and allocated profile IndexedDB blocks; sampled not hard peaks, disk includes original fixture setup and native metadata/WAL, not logical bytes or total process memory. Sampling and forced GC are test overhead, not game latency. No absolute performance/physical-resource target supplied by this measurement."
			})),contentType:"application/json"});
			const detached=await Promise.allSettled([cdp.detach()]);
			samplingErrors.push(...detached.flatMap(row=>row.status==="rejected"?[row.reason]:[]));
		}
	}
	await info.attach("original-source-native-result",{body:Buffer.from(JSON.stringify(result)),contentType:"application/json"});
	expect(result.ok,JSON.stringify(result)).toBe(true);
	expect(samplingErrors.map(String)).toEqual([]);
	if(measureResources)expect(Math.max(...samples.map(row=>row.indexedDbAllocatedBytes)),"persistent native IndexedDB disk must be measured, not assumed absent").toBeGreaterThan(0);
	const value=result.result;
	expect(value.resourceWorkload.sourcePayloadBytes).toBe(sourcePayloadBytes);
	expect(value.resourceWorkload.sourceTextBytes).toEqual([sourcePayloadBytes||8,sourcePayloadBytes||8]);
	if(sourceResourceMode==="stalled") {
		expect(value.beforeRelease.enteredJobs).toBe(1);expect(value.beforeRelease.signCalls).toBe(0);
		expect(value.beforeRelease.settled).toHaveLength(9);expect(value.beforeRelease.captureEntries).toBe(62);
		for(const row of value.beforeRelease.settled)expect(row.value).toMatchObject({ok:false,kind:"admission-rejected"});
		expect(value.beforeRelease.owners.admittedInputJobs).toBe(32);
		expect(value.beforeRelease.owners.admittedInputBytes).toBeGreaterThan(0);
		for(const owners of [value.afterPrefixOwners,value.afterSuffixOwners]) {
			expect(owners.admittedInputJobs).toBe(0);expect(owners.admittedInputBytes).toBe(0);
		}
		expect(value.beforeResume.barrierCaptures).toBe(0);expect(value.beforeResume.signCalls).toBe(1);
		expect(value.beforeResume.settled).toHaveLength(8);expect(value.resumed).toEqual({ok:true,kind:"resumed"});
		expect(value.barrierSettled).toHaveLength(40);expect(value.barrierSettled.every((row:any)=>!row.ok)).toBe(true);
		expect(value.completedPrefix.ok).toBe(true);expect(value.suffix.ok).toBe(true);
		expect(value.settled).toHaveLength(40);expect(value.settled.every((row:any)=>!row.value.ok)).toBe(true);
		expect(value.signCalls).toBe(2);expect(value.plan.entries.at(-1).replacementProgress.chunks).toHaveLength(2);
		expect(value.joins).toHaveLength(10);expect(value.joins.every((row:any)=>row.ok)).toBe(true);
		expect(activeMemory).toHaveLength(3);
		const charges=value.resourceObservations.filter((row:any)=>row.site==="active-rebase-proof-charge").map((row:any)=>row.value);
		expect(charges.length).toBeGreaterThanOrEqual(2);
		for(const charge of charges){expect(charge.ownedIssue).toBe(true);expect(charge.proofByteCharge).toBeGreaterThan(0);expect(charge.proofByteCharge).toBeLessThanOrEqual(charge.proofLimit);}
		const censuses=value.resourceObservations.filter((row:any)=>row.site==="replacement-native-census").map((row:any)=>row.value);
		expect(censuses).toHaveLength(2);expect(censuses.map((row:any)=>row.replacementChunks)).toEqual([0,1]);
		for(const census of censuses){expect(census.intentCount).toBe(2);expect(census.logicalBytes).toBeGreaterThan(0);expect(census.logicalBytes).toBeLessThanOrEqual(census.maxBytes);}
		return;
	}
	expect(value.ordinaryNew.ok).toBe(false);expect(value.newSignCalls).toBe(0);expect(value.afterNew).toEqual(value.beforeNew);
	for(const key of ["wrongCandidate","wrongScope","wrongSource","stalePlan","revokedSource"])expect(value[key].ok,key).toBe(false);
	expect(value.negativeSignCalls).toBe(0);expect(value.prefix.ok,JSON.stringify(value.prefix)).toBe(true);expect(value.suffix.ok,JSON.stringify(value.suffix)).toBe(true);
	expect(value.signCalls).toBe(2);expect(value.lineage.next).toBe(value.beforePositive.next+2);
	expect(value.afterStaleSignCalls).toBe(1);
	expect(value.afterPrefix.entries.find((entry:{sourceSequence:number})=>entry.sourceSequence===value.source.authorSequence).replacementProgress.chunks).toHaveLength(1);
	const actual=value.plan.entries.find((entry:{sourceSequence:number})=>entry.sourceSequence===value.source.authorSequence);
	expect(actual.replacementProgress.chunks).toHaveLength(2);expect(actual.replacementProgress.chunks[1].throughIntent).toBe(2);
	expect(value.canonicalCorrespondence).toHaveLength(2);
	for(const row of value.canonicalCorrespondence)for(const key of ["ok","candidateExact","scopeExact","digestExact","signatureValid","outboxExact","journalExact","deliveryExact"])expect(row[key],JSON.stringify(row)).toBe(true);
	// Resource observations come from the same original consumers used by
	// actual replacement, not a source review or separate synthetic quote.
	const dependencyCharges=value.resourceObservations.filter((row:any)=>row.site==="active-rebase-proof-charge").map((row:any)=>row.value);
	const nativeCensuses=value.resourceObservations.filter((row:any)=>row.site==="replacement-native-census").map((row:any)=>row.value);
	expect(dependencyCharges.length).toBeGreaterThanOrEqual(2);
	for(const charge of dependencyCharges){expect(charge.ownedIssue).toBe(true);expect(charge.proofByteCharge).toBeGreaterThan(0);expect(charge.proofByteCharge).toBeLessThanOrEqual(charge.proofLimit);}
	expect(nativeCensuses).toHaveLength(2);
	expect(nativeCensuses.map((row:any)=>row.replacementChunks)).toEqual([0,1]);
	for(const census of nativeCensuses){expect(census.intentCount).toBe(2);expect(census.logicalBytes).toBeGreaterThan(0);expect(census.logicalBytes).toBeLessThanOrEqual(census.maxBytes);expect(census.creatorMaintenanceBound).not.toBe(true);}
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});

for(const mode of ["floor","journal","bootstrap","custody","release","ahe","ahe-stale"] as const)test(`owned historical source native ${mode} currency controls`,async({page},info)=>{
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8SourceBinding")==="function");
	const receipt=await page.evaluate(async(mode)=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8SourceBinding")("r8-currency-"+mode+"-"+Date.now(),mode)};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	},mode);
	await info.attach("native-currency-result",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const value=receipt.result;
	if(mode==="floor") {
		expect(value.staleFloor.ok,JSON.stringify(value.staleFloor)).toBe(false);
		expect(value.signCalls).toBe(0);expect(value.lineage).toEqual(value.beforePositive);expect(value.plan).toEqual(value.beforePlan);
		expect(value.afterFloor.state).toEqual(value.beforeFloor.state);
		expect(value.afterFloor.control.revision).toBe(value.beforeFloor.control.revision+2);
		expect(value.afterFloor.imageDigest).not.toBe(value.beforeFloor.imageDigest);
	}else if(mode==="ahe-stale") {
		expect(value.exactClosureUnchanged).toBe(true);expect(value.afterHead.closureDigest).toBe(value.beforeHead.closureDigest);
		expect(value.afterHead.generationId).not.toBe(value.beforeHead.generationId);expect(value.afterHead.revision).toBe(value.beforeHead.revision+1);
		expect(value.staleHead.ok,JSON.stringify(value.staleHead)).toBe(false);expect(value.staleHead.detail).toContain("replacement native AHE is stale");
		expect(value.signCalls).toBe(0);expect(value.lineage).toEqual(value.beforePositive);expect(value.plan).toEqual(value.beforePlan);expect(value.deliveryDelta).toBe(0);
	}else if(mode==="ahe") {
		expect(value.prefix.ok,JSON.stringify(value.prefix)).toBe(true);expect(value.signCalls).toBe(1);
		expect(value.lineage.next).toBe(value.beforePositive.next+1);expect(value.foreignAheCommitted).toBe(true);
		expect(value.atDelivery).toHaveLength(1);expect(value.atDelivery[0].foreignAheCommitted).toBe(false);
		expect(value.committed.ok,JSON.stringify(value.committed)).toBe(true);expect(value.committed.value.state).toBe("Staged");
		expect(value.afterImage.head).toEqual(value.beforeImage.head);expect(value.afterImage.imageDigest).not.toBe(value.beforeImage.imageDigest);
		expect(value.issuedExact).toBe(true);expect(value.journalExact).toBe(true);
		expect(value.plan.entries[0].replacementProgress.chunks).toHaveLength(1);
	}else if(mode==="release") {
		expect(value.refused).toEqual({ok:false,kind:"admission-rejected",detail:"replacement native custody joined release failed"});
		expect(value.halted.kind).toBe("admission-rejected");expect(value.halted.ok).toBe(false);
		expect(value.signCalls).toBe(1);expect(value.floorReleaseAttempts).toBe(2);expect(value.otherOwnersReacquired).toBe(true);
		expect(value.afterFault.next).toBe(value.beforePositive.next+1);expect(value.lineage).toEqual(value.afterFault);
		expect(value.committed.authorSequence).toBe(value.beforePositive.next);expect(value.plan.entries[0].replacementProgress.chunks).toHaveLength(1);
	}else if(mode==="bootstrap") {
		expect(value.refused.ok,JSON.stringify(value.refused)).toBe(false);
		expect(value.refused.detail).toContain("outbox-classification:3:displaced:published");
		expect(value.signCalls).toBe(0);expect(value.lineage).toEqual(value.beforePositive);expect(value.plan).toEqual(value.beforePlan);
	}else if(mode==="custody") {
		expect(value.prefix.ok,JSON.stringify(value.prefix)).toBe(true);expect(value.signCalls).toBe(1);
		expect(value.lineage.next).toBe(value.beforePositive.next+1);expect(value.foreignFloorCommitted).toBe(true);
		expect(value.atDelivery).toHaveLength(1);expect(value.atDelivery[0].foreignFloorCommitted).toBe(false);
		expect(value.plan.entries[0].replacementProgress.chunks).toHaveLength(1);
	}else {
		expect(value.currentAppend.ok).toBe(true);expect(value.earlierScopeAppend.ok,JSON.stringify(value.earlierScopeAppend)).toBe(true);
		expect(value.duplicate).toEqual(expect.objectContaining({ok:true,idempotent:true,nativeImage:value.point}));
		expect(value.afterDuplicate).toEqual(value.point);expect(value.stale).toEqual({ok:false,kind:"retirement-stale"});
		expect(value.oversized).toEqual({ok:false,kind:"malformed-input"});expect(value.finalPoint).toEqual(value.point);
	}
	expect(value.joins.every((row:{ok:boolean})=>row.ok)).toBe(true);
});

test("native cross-object completion captures exact source identity through stalled publication and reentry",async({page},info)=>{
	await page.goto(local.origin+"/r8-source-binding");
	await page.waitForFunction(()=>typeof Reflect.get(globalThis,"r8CrossObjectCompletion")==="function");
	const receipt=await page.evaluate(async()=>{
		try{return {ok:true,result:await Reflect.get(globalThis,"r8CrossObjectCompletion")()};}
		catch(error){return {ok:false,error:String(error),stack:error instanceof Error?error.stack:undefined};}
	});
	await info.attach("native-cross-object-completion",{body:Buffer.from(JSON.stringify(receipt)),contentType:"application/json"});
	expect(receipt.ok,JSON.stringify(receipt)).toBe(true);
	const result=receipt.result,value=result.stalledCompletion;
	expect(result.recovery).toMatchObject({ok:true});
	expect(result.sourceObjectId).not.toBe(result.targetObjectId);
	expect(result.sourceJournalRowCount).toBe(4);
	expect(value.beforeRelease).toMatchObject({firstCutFlights:1,secondCutFlights:1,distinctCuts:true,
		reentrantCompletionIsFresh:true,afterReentryFlights:1,afterReentryIsFresh:true});
	expect(value.beforeRelease.sourceStates.find((row:{authorSequence:number})=>row.authorSequence===value.sourceSequence)?.state).toBe("pending");
	for(const cut of [value.firstCut,value.secondCut,value.afterReentry]){
		expect(cut).toHaveLength(40);
		for(const completed of cut)expect(completed).toMatchObject({ok:true,kind:"published"});
	}
	expect(value.reentrantCompletion).toMatchObject({ok:true,kind:"published"});
	expect(value.reenteredPublication).toMatchObject({ok:true,kind:"published"});
	expect(value.wrong).toMatchObject({ok:false,kind:"record-rejected"});
	expect(value.afterSourceStates.find((row:{authorSequence:number})=>row.authorSequence===value.sourceSequence)?.state).toBe("published");
	for(const prior of value.beforeRelease.sourceStates.filter((row:{authorSequence:number})=>row.authorSequence!==value.sourceSequence)){
		expect(value.afterSourceStates.find((row:{authorSequence:number})=>row.authorSequence===prior.authorSequence)).toEqual(prior);
	}
	expect(result.targetReplacement).toMatchObject({ok:true,kind:"accepted"});
	expect(result.targetPublication).toMatchObject({ok:true,kind:"published"});
	expect(result.reopenRecovery).toMatchObject({ok:true});
	expect(result.targetPublishedDigests).not.toContain(result.activationVertexDigest);
	for(const digest of result.sourceDigests)expect(result.targetPublishedDigests).not.toContain(digest);
});
