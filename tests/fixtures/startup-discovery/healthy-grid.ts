import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { createBrowserV3RoomDatabaseStorageHost, createV3RoomCreatorInviteMaterial, createV3RoomSession, waitForV3RoomStartupForDiagnostics } from "../../../examples/v3-room/src/index.js";
import { createBrowserRoomHeadAuthority } from "../../../packages/storage-browser/src/room-head.js";
import { createBrowserDurableIssuanceStore, createBrowserRoomDurableIssuanceStore } from "../../../packages/storage-browser/src/issuance.js";
import { createBrowserRoomSnapshotQuarantineStore, createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/src/snapshot-transfer.js";
import { browserIssuancePruningMaintenanceForStore } from "../../../packages/storage-browser/src/internal/browser-issuance-store.js";
import { ISSUANCE_RETIREMENT_LIMITS } from "@ts-drp/issuance-store/maintenance";
import { gridCorpus, gridOperation, gridSeed } from "../../../.logs/bounded-storage-lifecycle/r8-warm-capacity-01/grid-candidate-01/grid-corpus.ts";
import { begin, context, end, spans, proofEvents, proofEventsTruncated, proofObserverMilliseconds, proofOwnerSummaries,
 beginFullFunctionWindow, endFullFunctionWindow, proofEventBudget } from "./critical-observer.js";
import { workerPeer } from "../../../.logs/bounded-storage-lifecycle/r8-warm-capacity-01/worker-transport.ts";
import { CREATOR_SUCCESSOR_PROTOCOL } from "@ts-drp/network/snapshot-transfer";
import { createEphemeralChannel } from "../../../packages/ephemeral/src/index.js";
import { hex, parameters } from "./room.js";
import { control, trace } from "./observation.js";

function check(value:unknown,reason:string):asserts value {if(!value)throw new Error(reason);}
function errorEvidence(error:unknown):unknown {
 if(error===null||typeof error!=="object")return error;
 if(typeof Reflect.get(error,"message")!=="string")return structuredClone(error);
 const value=error as Error & {errors?:unknown[]};
 return {name:value.name,message:value.message,stack:value.stack,cause:value.cause===undefined?undefined:errorEvidence(value.cause),
  ...(value.errors===undefined?{}:{errors:Array.from(value.errors,errorEvidence)})};
}

// One original module/authority realm per client, as in the accepted worker
// benchmark. Separate loopback origins preserve the actual browser writer
// exclusion: each simulated client owns an independent native storage origin.
async function createHealthyGridRole(input:{index:number;database:string;identity:string;objectId:string;invite:Awaited<ReturnType<typeof createV3RoomCreatorInviteMaterial>>;
 kind:"create"|"reopen";peer:ReturnType<typeof workerPeer>}) {
 const {index,database,identity,objectId,kind,peer}=input,invite=structuredClone(input.invite);
 Reflect.set(globalThis,"__r8HealthyAdmissionDiagnosis",true);
 Object.assign(context,{role:index===0?"creator":"recipient-"+index,transition:Reflect.get(input,"epoch")??0,command:kind+"-session",preparation:false});
 const {members,application}=gridCorpus(identity),key=gridSeed(index),author=members[index]!.author,admitted=new Set<string>();
 // Optional host-local policy travels through the ORIGINAL public application
 // configuration and its data-only validator. No altered budget or native facts.
 const finishingWindow=Reflect.get(globalThis,"__r8OrdinaryFinishingWindow");
 const configuredApplication=finishingWindow===undefined?application:{...application,ordinaryFinishingWindow:finishingWindow};
 const deliveryObservations=new Map<string,{acceptedCallbackAt:number;projectionCallbackAt?:number}>(),awaitingProjection=new Set<string>();
 Reflect.set(globalThis,"__r8HealthyAcceptedDigestPresent",(digest:string)=>admitted.has(digest));
 const floor=await createBrowserRoomHeadAuthority({databaseName:database+"--startup-floor",initialization:{kind}});
 let session:Awaited<ReturnType<typeof createV3RoomSession>>|undefined,issuance:Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>|undefined,
  snapshot:Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>>|undefined;
 try {
  const finality=index===0?await createRecoverableFinalitySigner({seed:key}):undefined;
  // Opt-in speculative presentation (the base library ignores the absent option).
  const presentationMode=Reflect.get(input,"presentation");
  const presentation=presentationMode==="1"||presentationMode==="overlay"?{
   onSpeculativeProjection:observeVisible,
   onPresentationEvent:(event:any)=>{const key=event.kind+":"+event.entry.source+(event.kind==="rolled-back"?":"+event.reason:"");presentationCounts[key]=(presentationCounts[key]??0)+1;}}:undefined;
  // Opt-in automatic idle trigger (creator only); outcomes are observation only.
  const autoPool=index===0&&Reflect.get(input,"autoPool")===true?{idleMilliseconds:200,
   onResult:(outcome:any)=>{const endedAt=performance.now();autoPoolOutcomes.push({kind:outcome.kind,epoch:outcome.epoch,startedAt:endedAt-outcome.milliseconds,endedAt,
    milliseconds:outcome.milliseconds,...(outcome.kind==="result"?{result:outcome.result}:{error:errorEvidence(outcome.error)})});}}:undefined;
  // Opt-in single room database (slice 14a): every owner in one version-7 database
  // and each retirement install in one room session. The floor stays separate.
  const roomDatabase=Reflect.get(input,"roomDatabase")===true;
  session=await createV3RoomSession({...(roomDatabase?{storageHost:createBrowserV3RoomDatabaseStorageHost()}:{}),application:configuredApplication,author,...(autoPool===undefined?{}:{recoveryPoolAutoMaintenance:autoPool}),creatorInvite:invite,databaseName:database,issuanceDatabaseName:database,migrationDatabaseNamespace:database,
   objectId,publicKeyBytes:ed25519.getPublicKey(key),initialLogicalTime:3,...(finality?{creatorFinalitySigner:finality.signer}:{}),roomHeadAuthority:floor,
   ...(presentation===undefined?{}:{presentation}),
   openTransport:()=>({...peer.open(),openEphemeral:openFixtureEphemeral}),signRegisteredVertexDigest:async digest=>ed25519.sign(digest,key),onAcceptedVertex:vertex=>{
    const digest=hex(vertex.digest);admitted.add(digest);
    check(deliveryObservations.size<1024||deliveryObservations.has(digest),"bounded healthy delivery telemetry saturated");
    if(!deliveryObservations.has(digest))deliveryObservations.set(digest,{acceptedCallbackAt:performance.now()});
    if(Reflect.get(globalThis,"__r8CriticalProfiling")===true)performance.mark("drp:accepted-callback:"+index+":"+digest);
    awaitingProjection.add(digest);
   },onProjection:(value:any)=>{const at=performance.now();observeVisible(value);for(const digest of awaitingProjection){deliveryObservations.get(digest)!.projectionCallbackAt=at;if(Reflect.get(globalThis,"__r8CriticalProfiling")===true)performance.mark("drp:projection-callback:"+index+":"+digest);}awaitingProjection.clear();}});
  await waitForV3RoomStartupForDiagnostics(session);
  // Display-only intents for moves whose signing waits behind maintenance.
  if(presentationMode==="1")session.bindPresentationIntents(session.openEphemeral({maxMessageBytes:8192,maxSequencedKeys:8,maxSequencedSenders:8}));
  issuance=roomDatabase?await createBrowserRoomDurableIssuanceStore({databaseName:database}):await createBrowserDurableIssuanceStore({primaryDatabaseName:database});
  snapshot=roomDatabase?await createBrowserRoomSnapshotQuarantineStore({databaseName:database}):await createBrowserSnapshotQuarantineStore({primaryDatabaseName:database});
  const original=session;
  const native=browserIssuancePruningMaintenanceForStore(issuance);check(native,"healthy native census owner unavailable");
  const ownIssuance=issuance,ownSnapshot=snapshot,ownScope={objectId,author};
  return {index,database,application,session:original,floor,issuance,snapshot,admitted,deliveryObservations,native:browserIssuancePruningMaintenanceForStore(issuance),
   issue:(operation:Readonly<Record<string,unknown>>)=>original.issue(structuredClone(operation)),
   presentation:presentation!==undefined,
   issueWithReceipt:(operation:Readonly<Record<string,unknown>>)=>original.issueWithReceipt(structuredClone(operation)),
   install:(offer:Awaited<ReturnType<typeof original.exportCreatorSuccessor>>,peers:readonly string[])=>original.installCreatorSuccessor({offer:structuredClone(offer),peers:[...peers]}),
   lineage:()=>ownIssuance.readLineage(ownScope),
   outboxAfter:(next:number)=>ownIssuance.readOutboxPage({scope:ownScope,limit:128,afterKey:next===0?null:[objectId,author,next-1]}),
   checkpoint:async(epoch:number)=>{
    const census=await native.readBoundedRecoveryCensus({objectId,limits:ISSUANCE_RETIREMENT_LIMITS});
    const read=await floor.read({scope:{objectId,pinnedGenesisAnchorDigest:invite.pinnedGenesisAnchorDigest}});check(read.ok&&read.state,"native stable floor absent");
    check(read.state.stable.epoch===epoch&&read.state.pending===null,"native stable floor disagrees with integrated epoch");
    return {index,floor:read.state,issuanceImage:census.image,issuanceControl:census.control,pruning:await native.inspectPruningState(ownScope),
     settlementPlan:await ownIssuance.readSettlementPlan(ownScope),snapshot:await ownSnapshot.recoveryStatus(),
     stateBytes:application.migration!.canonicalStateBytes(original.projection()).byteLength,blockCount:original.projection().blocks.length};
   },
   snapshotBytes:async(raw:Awaited<ReturnType<typeof original.exportCreatorSuccessor>>,epoch:number)=>{
    const offer=structuredClone(raw),cut=decodeCanonical(offer.exactCanonicalCutValueBytes) as any;
    const lookup=await ownSnapshot.lookupRecoveryDeclaration({objectId,epoch,anchor:cut.previousAnchor,manifestDigest:cut.snapshotManifestDigest});
    check(lookup.kind==="present"&&lookup.state==="verified","native verified source snapshot absent");
    const handle=await ownSnapshot.openScope(lookup.declaration),port=handle.verificationQuarantine.open(new AbortController().signal);let payloadBytes=0;
    const nativeChunkPackets:{index:number;byteLength:number;packetDigest:string}[]=[];
    try{for(const descriptor of lookup.declaration.chunks){const bytes=await port.read(descriptor);check(bytes,"native source snapshot bytes absent");payloadBytes+=bytes.byteLength;
     nativeChunkPackets.push({index:descriptor.index,byteLength:bytes.byteLength,packetDigest:hex(hashDomain("ts-drp/native-freeze-test-packet/v1",bytes))});}}
    finally{const results=await Promise.allSettled([Promise.resolve().then(()=>port.discard()),Promise.resolve().then(()=>handle.release())]);const faults=results.flatMap(row=>row.status==="rejected"?[row.reason]:[]);if(faults.length)throw new AggregateError(faults,"native snapshot assertion owners failed to join");}
    return {epoch,payloadBytes,manifestBytes:lookup.declaration.exactCanonicalManifestBytes.byteLength,chunkCount:lookup.declaration.chunks.length,cutBytes:offer.exactCanonicalCutValueBytes.byteLength,nativeChunkPackets};
   },
   // Capture the existing bounded per-realm timer observations before close
   // reporting removes this frame. Terminal parent-only capture is too late.
   observer:()=>({timeOrigin:performance.timeOrigin,spans:[...spans],autoPool:[...autoPoolOutcomes],clockMark,longTasks:Reflect.get(globalThis,"__rdLongTasks")?.(),criticalProfiling:Reflect.get(globalThis,"__r8CriticalSnapshot")?.(),eventLoop:Reflect.get(globalThis,"__r8EventLoopCheckpoint")?.(),incrementalNativeControls:{enabled:Reflect.get(globalThis,"__r8IncrementalNativeControls")===true,sourcePin:Reflect.get(globalThis,"__r8IncrementalNativeControlSourcePin"),qualification:"Correctness-only extra quote/readout/UNKNOWN exhaustion and joined proof work; overlapping product metrics cannot be blindly subtracted. Disabled for matched latency and unprofiled runs."},proofEvents:[...proofEvents],proofEventsTruncated,proofEventBudget,proofObserverMilliseconds,proofOwnerSummaries:[...proofOwnerSummaries.values()],startupTrace:[...trace],publications:peer.publications,transfers:peer.streamBytes,transport:peer.status()}),
   setContext:(role:string,transition:number,command:string)=>{Object.assign(context,{role,transition,command,preparation:false});}
  };
 }catch(error){const joined=await Promise.allSettled([session?.close(),issuance?.close(),snapshot?.close(),floor.close()]);
  const faults=joined.flatMap(row=>row.status==="rejected"?[row.reason]:[]);if(faults.length)throw new AggregateError([error,...faults],"healthy role create failed with cleanup failures");throw error;}
}
// The accepted worker transport is reused unchanged. Only its parentPort is
// adapted to browser postMessage; this is a fixture route, not native authority.
let childPeer:ReturnType<typeof workerPeer>|undefined;
// Opt-in time-to-visible: first time each block placement (id:x:y) appears in
// what this client displays (the durable projection, or with presentation the
// speculative view). Same definition on both builds; observation only.
const visibleAt=new Map<string,number>(),presentationCounts:Record<string,number>={};
const blockKey=(block:{id:unknown;x:unknown;y:unknown})=>block.id+":"+block.x+":"+block.y;
function observeVisible(view:any){
 const at=performance.now();
 for(const block of view?.blocks??[]){const key=blockKey(block);if(!visibleAt.has(key)&&visibleAt.size<8192)visibleAt.set(key,at);}
}
// Fixture ephemeral route: the parent binds each frame to its source frame's
// peer id, as the worker route does; authority comes from the room provider.
let childId="",childConnected:string[]=[];
let ephemeralListener:((ingress:{bytes:Uint8Array;sender:string})=>void)|undefined;
function openFixtureEphemeral(provider:any,options:any){
 const writer=(peerId:string)=>{const author=provider.authorForPeer(peerId);return author!==undefined&&provider.isCurrentWriter(author);};
 const authorizedPeers=()=>provider.currentAuthority()===undefined?[]:childConnected.filter(writer).sort();
 return createEphemeralChannel({localPeerId:childId,authorizedPeers,isAuthorized:(sender:string)=>provider.currentAuthority()!==undefined&&writer(sender),
  maxEnvelopeBytes:(deliveryClass:string)=>deliveryClass==="reliable-unordered"?65_536:1_200,
  onMessage:(listener:(ingress:{bytes:Uint8Array;sender:string})=>void)=>{ephemeralListener=listener;return()=>{if(ephemeralListener===listener)ephemeralListener=undefined;};},
  send:async(input:{bytes:Uint8Array;recipients:"all"|readonly string[]})=>{
   const targets=input.recipients==="all"?authorizedPeers():input.recipients;
   for(const target of targets)window.parent.postMessage({kind:"r8-grid-ephemeral-route",target,bytes:Uint8Array.from(input.bytes)},"*");
   return targets.length>0;},
  authorForPeer:(peerId:string)=>provider.authorForPeer(peerId),currentAuthority:()=>provider.currentAuthority(),
  isCurrentWriter:(author:string)=>provider.isCurrentWriter(author),onPeerDisconnect:()=>()=>undefined} as any,options);
}
window.addEventListener("message",event=>{
 if(event.source!==window.parent||event.data?.kind!=="r8-grid-ephemeral-delivery")return;
 ephemeralListener?.({bytes:new Uint8Array(event.data.bytes),sender:event.data.source});
});
const autoPoolOutcomes:unknown[]=[];
let clockMark:{name:string;startTime:number}|undefined;
let childRole:Awaited<ReturnType<typeof createHealthyGridRole>>|undefined;
let childIndex=-1;
let childProbeTimer:number|undefined,childProbeTicks=0;
// Bounded, byte-free projection of existing completed observations only. This
// neither polls product/native owners nor retags an in-flight product phase.
function completedObserverCheckpoint(observer:any){
 const spanLimit=1024,ownerLimit=1024;
 return {timeOrigin:observer.timeOrigin,criticalProfiling:observer.criticalProfiling,spans:observer.spans.slice(-spanLimit),spanCount:observer.spans.length,
  spansTruncated:observer.spans.length>spanLimit,proofOwnerSummaries:observer.proofOwnerSummaries.slice(0,ownerLimit),
  proofOwnerCount:observer.proofOwnerSummaries.length,proofOwnersTruncated:observer.proofOwnerSummaries.length>ownerLimit,
  proofEventCount:observer.proofEvents.length,proofEventsTruncated:observer.proofEventsTruncated,
  proofObserverMilliseconds:observer.proofObserverMilliseconds,publicationCount:observer.publications.length,transferCount:observer.transfers.length};
}
window.addEventListener("message",event=>{
 if(event.source!==window.parent||event.data?.kind!=="r8-grid-rpc")return;
 const {token,command,args}=event.data;
 context.rpcToken=token;
 const run=async()=>{
  if(command==="init"){
   check(childPeer===undefined,"one original child transport");childIndex=args.index;childPeer=workerPeer(args.id,args.connected);
   childId=args.id;childConnected=[...args.connected];
   // Trace-clock anchor for this realm (user timing is observation only).
   const mark=performance.mark("rd-clock-"+args.index+"-"+Date.now());clockMark={name:mark.name,startTime:mark.startTime};
   if(args.suspensionProbe){
    childProbeTimer=window.setInterval(()=>{childProbeTicks++;},20);
    Reflect.set(globalThis,"__r8FrozenClientObservation",()=>({index:childIndex,ticks:childProbeTicks,
     spans:spans.length,proofEvents:proofEvents.length,transport:childPeer!.status()}));
   }
   return true;
  }
  check(childPeer,"original child transport required");
  if(command==="clock"){const mark=performance.mark("rd-clock-"+childIndex+"-"+Date.now());clockMark={name:mark.name,startTime:mark.startTime};return clockMark;}
  const phase=(name:string)=>{Object.assign(context,{role:childIndex===0?"creator":"recipient-"+childIndex,transition:args.epoch??0,command:name,ordinal:args.ordinal??-1,preparation:false});};
  const product=async<T>(name:string,action:()=>Promise<T>):Promise<T>=>{
   // Label only the three existing issue-command awaits. This notification is
   // observational, never awaited, and owns no product bytes or authority.
   if(command==="issue")try{window.parent.postMessage({kind:"r8-grid-rpc-segment",token,segment:name},event.origin);}catch{}
   phase(name);
   const fullBoundary=Reflect.get(globalThis,"__r8FunctionCaptureEnabled")===true&&childIndex===0&&args.epoch===4&&
    ["sealing-inclusive","creator-adoption-inclusive"].includes(name)
    ? Reflect.get(globalThis,"__r8FunctionCaptureBoundary") : undefined;
   const fullMeta={phase:name,role:"creator",transition:4,rpcToken:token,timeOrigin:performance.timeOrigin};
   // VM/native profiler control is test work OUTSIDE the existing API timer.
   // Never insert a profiler await into the room's durable implementation.
   if(typeof fullBoundary==="function")await fullBoundary("begin",fullMeta);
   if(typeof fullBoundary==="function")beginFullFunctionWindow(fullMeta);
   // Detach the existing finite counter table OUTSIDE the product timer. Static
   // codec rows aggregate a whole realm; only this before/after delta supplies
   // actual entries/bytes during the selected API, not their first-entry label.
   const exactCriticalBegin=typeof fullBoundary==="function"
    ? structuredClone(Reflect.get(globalThis,"__r8CriticalSnapshot")?.()) : undefined;
   const start=begin();
   let fullSnapshot:unknown;
   try{return await action();}
   finally{
    const apiEnd=performance.now();
    end(name,start);
    if(typeof fullBoundary==="function"){
     const exactCriticalEnd=structuredClone(Reflect.get(globalThis,"__r8CriticalSnapshot")?.());
     fullSnapshot=endFullFunctionWindow();
     // A tiny control packet stops trace production BEFORE serializing the
     // large exact counter/wait/gap tables across the exposed-function bridge.
     // Both original API and body clocks have already ended. Export stays out
     // of product time; this never releases or mutates a product/native owner.
     try{await fullBoundary("trace-stop",{...fullMeta,apiBegin:start.begin,apiEnd});
      await fullBoundary("end",{...fullMeta,apiBegin:start.begin,apiEnd,
      exactCriticalCounters:{begin:exactCriticalBegin,end:exactCriticalEnd,
       qualification:"Detached existing bounded counter snapshots outside the original API timer. Subtract matching keys; context fields on static codec rows remain first-entry labels. Counts include actual concurrent work in this realm, not proof of asynchronous causality."}},fullSnapshot);}
     catch(error){Reflect.set(globalThis,"__r8FullFunctionCaptureEndFailure",String(error));
      console.warn(JSON.stringify({kind:"full-function-capture-end-failed",phase:name,error:String(error)}));}
    }
   }
  };
  if(command==="open"){childRole=await product(args.kind==="create"?(childIndex===0?"create-session":"join-session"):"persisted-reopen",()=>createHealthyGridRole({...args,peer:childPeer!}));return true;}
  if(command==="history")return product("test-only-authenticated-history-synchronization",()=>childPeer!.synchronizeRetainedHistory());
  if(command==="observe-completed")return childRole===undefined?{index:childIndex,unavailable:"role not open"}:
   {index:childIndex,observer:completedObserverCheckpoint(childRole.observer())};
  if(command==="close"){
   const role=childRole,joins:unknown[]=[],faults:unknown[]=[];
   if(role!==undefined)for(const owner of [{name:"session",action:()=>role.session.close()},{name:"issuance-observer",action:()=>role.issuance.close()},
    {name:"snapshot-observer",action:()=>role.snapshot.close()},{name:"floor",action:()=>role.floor.close()}]){
    try{await product("persisted-close:"+owner.name,owner.action);joins.push({index:childIndex,owner:owner.name,ok:true});}
    catch(error){joins.push({index:childIndex,owner:owner.name,ok:false,error:errorEvidence(error)});faults.push(error);}
   }
   // A failed/open-unattempted native role still owns an initialized peer.
   // Revoke that SAME peer's producers, then join reciprocal readiness with
   // every peer. Do not fabricate native-owner joins for an absent role.
   childPeer.open().close();
   try{await childPeer.join();joins.push({index:childIndex,owner:"transport",ok:true});}catch(error){joins.push({index:childIndex,owner:"transport",ok:false,error:errorEvidence(error)});faults.push(error);}
   if(childProbeTimer!==undefined){clearInterval(childProbeTimer);childProbeTimer=undefined;}
   const observer=role?.observer();childRole=undefined;
   return {index:childIndex,epoch:args.epoch,joins,...(observer===undefined?{nativeRole:"absent"}:{observer}),ok:faults.length===0,errors:faults.map(errorEvidence)};
  }
  const role=childRole;check(role,"original native role required");
  // One checkpoint-only observation, outside product phase tagging. This reads
  // the two original assertion predicates without changing their semantics.
  if(command==="observe-admission"){
   const started=performance.now(),expectedBlock={id:args.expectedBlock.id,x:args.expectedBlock.x,y:args.expectedBlock.y};
   const accepted=role.admitted.has(args.digest),block=role.session.projection().blocks.find(value=>value.id===expectedBlock.id);
   const projectionMatches=block!==undefined&&block.x===expectedBlock.x&&block.y===expectedBlock.y;
   const memory={index:childIndex,requestedEpoch:args.requestedEpoch,observedEpoch:role.session.authority()?.epoch??0,
    ordinal:args.ordinal,digest:args.digest,acceptedCallbackMembership:accepted,projectionMatches,expectedBlock,
    actualBlock:block===undefined?null:{id:block.id,kind:block.kind,x:block.x,y:block.y},
    containedApplicationError:trace.find(value=>value.site==="healthy-application-contained"&&(value.value as any)?.digest===args.digest)?.value??null,
    deliveryBranchEvents:trace.filter(value=>value.site==="healthy-delivery-branch"&&(value.value as any)?.digest===args.digest).map(value=>value.value),
    deliveryBranchEventsTruncated:Number(Reflect.get(globalThis,"__r8HealthyDeliveryBranchCount")??0)>32,
    postAuthErrors:trace.filter(value=>(value.site==="healthy-ingress-post-auth-error"||value.site==="healthy-ingress-journal-error"||value.site==="healthy-ingress-custody-check-error"||value.site==="healthy-ingress-application-callback-error")&&(value.value as any)?.digest===args.digest).map(value=>({site:value.site,value:value.value})),
    postAuthErrorsTruncated:Number(Reflect.get(globalThis,"__r8HealthyPostAuthErrorCount")??0)>8,
    containedApplicationErrorsTruncated:Number(Reflect.get(globalThis,"__r8HealthyContainedErrorCount")??0)>32,
    testOnlyMemoryMilliseconds:performance.now()-started};
   // A single existing current-currency authenticated journal page, only when
   // both memory predicates are missing. Never infer absence from truncation,
   // refusal, quarantine exclusion or a different epoch; no continuation scan.
   if(accepted||projectionMatches)return memory;
   if(memory.observedEpoch!==memory.requestedEpoch)return {...memory,native:{inconclusive:true,reason:"checkpoint context changed before observation"}};
   window.parent.postMessage({kind:"r8-grid-checkpoint-memory",value:memory},event.origin);
   const nativeStarted=performance.now();
   try{
    const page=await role.session.queryRetainedHashes({limit:128});
    return {...memory,native:{coverage:page.coverage,scopeEpoch:page.scope.epoch,retainedRowCount:page.retainedRowCount,
     returnedEntries:page.entries.length,completePage:page.continuation===null,
     requestedDigestPresent:page.entries.some(value=>value.vertexDigest===args.digest),
     testOnlyMilliseconds:performance.now()-nativeStarted,
     qualification:"Authenticated non-quarantined current-epoch retained window only; incomplete/stale/refused reads are inconclusive."}};
   }catch(error){return {...memory,native:{error:errorEvidence(error),testOnlyMilliseconds:performance.now()-nativeStarted,inconclusive:true}};}
  }
  switch(command){
   case "issue":{
    const before=await product("test-only-issue-preimage",()=>role.lineage());
    const issueStarted=performance.now();let receiptStages:{visibleAt?:number;durableAt?:number}|undefined;
    await product("ordinary-issue-and-publication",()=>{
     if(!role.presentation)return role.issue(args.operation);
     const receipt=role.issueWithReceipt(args.operation),stages:{visibleAt?:number;durableAt?:number}={};receiptStages=stages;
     void receipt.visible.then(()=>{stages.visibleAt=performance.now();},()=>undefined);
     void receipt.durable.then(()=>{stages.durableAt=performance.now();},()=>undefined);
     return receipt.published;
    });const issueCompleted=performance.now();
    return product("test-only-native-publication-assertion",async()=>{
     const rows=await role.outboxAfter(before.next);
     const matches=rows.filter(row=>hex(encodeCanonical((decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as any).operation))===hex(encodeCanonical(args.operation)));
     check(matches.length===1&&matches[0]!.publishState==="published","healthy native publication absent");
     const row=matches[0]!;
	 // This lookup is inside the existing test-only native assertion phase,
	 // outside issueStarted/issueCompleted. Unprofiled builds emit no points.
	 const nativeCompletion=Reflect.get(globalThis,"__r8CriticalProfiling")===true?(()=>{
	  const digest=hex(row.commit.envelope.digest),roleName=childIndex===0?"creator":"recipient-"+childIndex;
	  const points=proofEvents.filter((event:any)=>event.digest===digest&&event.authorSequence===row.commit.authorSequence&&event.role===roleName);
	  const commits=points.filter((event:any)=>event.kind==="healthy-local-native-commit-completed") as any[],
	   acks=points.filter((event:any)=>event.kind==="healthy-durable-publication-ack-completed") as any[];
	  check(!proofEventsTruncated&&commits.length===1&&acks.length===1,"healthy exact native completion observations absent or ambiguous");
	  const commit=commits[0],ack=acks[0];
	  check(commit.timeOrigin===performance.timeOrigin&&ack.timeOrigin===performance.timeOrigin&&
	   Number.isFinite(commit.nativeCompletedAt)&&Number.isFinite(ack.nativeCompletedAt)&&
	   issueStarted<=commit.nativeCompletedAt&&commit.nativeCompletedAt<=ack.nativeCompletedAt&&ack.nativeCompletedAt<=issueCompleted,
	   "healthy native completion clock/order differs");
	  return {role:roleName,author:commit.author,authorSequence:row.commit.authorSequence,digest,timeOrigin:performance.timeOrigin,
	   localNativeCommittedAt:commit.nativeCompletedAt,durablePublicationAcknowledgedAt:ack.nativeCompletedAt,
	   qualification:"Original native commit and durable outbox-published await continuations; publication ACK is transport acceptance plus local durable marking, not remote application."};
	 })():undefined;
     return {epoch:args.epoch,index:childIndex,ordinal:args.ordinal,operation:args.operation,operationBytes:encodeCanonical(args.operation).byteLength,
      unsignedVertexBytes:row.commit.envelope.canonicalPreimageBytes.byteLength,signedEnvelopeBytes:encodeCanonical(row.commit.envelope).byteLength,
      digest:hex(row.commit.envelope.digest),sequence:row.commit.authorSequence,published:true,issueStarted,issueCompleted,timeOrigin:performance.timeOrigin,
      visibleAt:visibleAt.get(blockKey(args.operation)),...(receiptStages===undefined?{}:{receiptStages}),
	  ...(nativeCompletion===undefined?{}:{nativeCompletion})};
    });
   }
   case "admitted":return product("test-only-live-admission-and-projection",async()=>{
    const projected=()=>role.session.projection().blocks.some(block=>block.id===args.operation.id&&block.x===args.operation.x&&block.y===args.operation.y);
    check(Number.isSafeInteger(args.waitDeadline),"original bounded fixture deadline required");
    let assertionPolls=0;
    while(!(role.admitted.has(args.digest)&&projected())&&Date.now()<args.waitDeadline){assertionPolls++;await new Promise(resolve=>setTimeout(resolve,10));}
    check(role.admitted.has(args.digest)&&projected(),"healthy exact digest not live-admitted/projected before seal");
    return {index:childIndex,timeOrigin:performance.timeOrigin,digest:args.digest,...role.deliveryObservations.get(args.digest),observedProjectionAt:performance.now(),assertionPolls,
     visibleAt:visibleAt.get(blockKey(args.operation))};
   });
   case "world":return product("test-only-world-projection",async()=>{
    // With presentation, every settled point must show exactly the durable world.
    if(role.presentation){const pending=role.session.pendingOperations();
     check(pending.length===0&&role.session.speculativeProjection()===role.session.projection(),"speculative view did not converge:"+JSON.stringify(pending.map(entry=>[entry.source,entry.id])));}
    return role.session.projection();
   });
   case "presentation":return {index:childIndex,counts:{...presentationCounts},pending:role.presentation?role.session.pendingOperations().length:0};
   case "measure":return product("test-only-native-storage-and-settlement-measurement",async()=>{
    const value=await role.checkpoint(args.epoch),databases=[];
    for(const metadata of await indexedDB.databases()){
     if(!metadata.name?.startsWith(role.database))continue;
     const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(metadata.name!);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onupgradeneeded=()=>{request.transaction?.abort();reject(new Error("measurement must not create a database"));};});
     try{
      const names=Array.from(db.objectStoreNames);if(!names.length)continue;
      const tx=db.transaction(names,"readonly"),done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);});
      const stores=await Promise.all(names.map(name=>new Promise<{name:string;rows:number;binaryFieldBytes:number}>((resolve,reject)=>{
       let rows=0,binaryFieldBytes=0;
       const binary=(value:unknown,seen=new Set<object>()):number=>{if(value===null||typeof value!=="object"||seen.has(value))return 0;seen.add(value);if(ArrayBuffer.isView(value)||value instanceof ArrayBuffer)return value.byteLength;return Object.values(value).reduce((sum:number,child)=>sum+binary(child,seen),0);};
       const request=tx.objectStore(name).openCursor();request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor){resolve({name,rows,binaryFieldBytes});return;}rows++;binaryFieldBytes+=binary(cursor.value);cursor.continue();};
      })));
      await done;databases.push({name:metadata.name,version:metadata.version,stores});
     }finally{db.close();}
    }
    return {...value,databases};
   });
   case "maintain":return product("pool-maintenance-lull",()=>role.session.maintainRecoveryPool());
   case "seal":return product("sealing-inclusive",()=>role.session.sealEpoch());
   case "export":return product("successor-export",()=>role.session.exportCreatorSuccessor());
   case "snapshot":return product("test-only-exact-snapshot-bytes",()=>role.snapshotBytes(args.offer,args.epoch));
   case "adopt":return product("creator-adoption-inclusive",()=>role.session.adoptCreatorSuccessor());
   case "install":return product("recipient-install-inclusive",()=>role.install(args.offer,args.peers));
   default:throw new Error("unknown healthy native role command");
  }
 };
 void run().then(value=>window.parent.postMessage({kind:"r8-grid-rpc-result",token,ok:true,value},event.origin),
  error=>window.parent.postMessage({kind:"r8-grid-rpc-result",token,ok:false,error:errorEvidence(error)},event.origin));
});
if(window!==window.parent)window.parent.postMessage({kind:"r8-grid-ready"},"*");

// Representative healthy path, not an unchanged capacity-test replay.
export async function runHealthyGrid(identity:string,origins:readonly string[],rollovers=4,profileId="creator-trusted-settlement-v1") {
 const fixtureWaitDeadline=Date.now()+360_000; // Existing native test cap, not a gameplay latency target.
 check(origins.length===4&&new Set(origins).size===4,"four independent native storage origins required");
 check(rollovers===4||rollovers===5||(Number.isSafeInteger(rollovers)&&rollovers>=8&&rollovers<=32),"bounded native full-pool extension only");
 check(profileId==="creator-trusted-settlement-v1"||profileId==="creator-trusted-v1","existing creator profile required");
 const {members,application}=gridCorpus(identity),ids=members.slice(0,4).map(row=>row.peerId);
 const objectId="creator:"+hex(hashDomain("ts-drp/healthy-native-grid/v1",new TextEncoder().encode(identity))).slice(0,32);
 const signers=[{publicKey:members[0]!.author,signerId:"creator"}],startSpan=spans.length;
 const ordinary:any[]=[],snapshots:unknown[]=[],checkpoints:any[]=[],joins:any[]=[],transitions:unknown[]=[],roleObservers:any[]=[],presentationSummary:unknown[]=[];
 const frames:HTMLIFrameElement[]=[],ready=new Set<Window>();
 const waits=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void;index:number;command:string;epoch:number;ordinal?:number;
  digest?:string;expectedBlock?:{id:string;x:number;y:number};lastReportedSegment?:string}> ();
 let token=0,phase="invite",epoch=0,failure:unknown;
 const suspendTransfer=Reflect.get(globalThis,"__r8SuspendTransfer");
 const suspensionEvents:unknown[]=[];
 let selectedSnapshotStream:string|undefined,suspensionStarted=false,routeEvents=0,probeTicks=0;
 const probeTimer=typeof suspendTransfer==="function"?window.setInterval(()=>{probeTicks++;},20):undefined;
 Reflect.set(globalThis,"__r8FrozenRouteObservation",(inspectAdmission=false,inspectCompleted=false)=>{const value={ticks:probeTicks,phase,epoch,
  pendingRpc:waits.size,routeEvents,suspensionStarted,ordinaryCount:ordinary.length,completedTransitions:transitions.length,
  failureStatus:failure===undefined?"none-recorded":"recorded",
  ...(failure===undefined?{}:{error:errorEvidence(failure)}),
  pendingCalls:Array.from(waits,([token,{index,command,epoch,ordinal,digest,expectedBlock,lastReportedSegment}])=>({token,index,command,epoch,ordinal,digest,expectedBlock,lastReportedSegment}))};
  if(inspectCompleted)return Promise.all(active.map(role=>rpc(role.index,"observe-completed"))).then(observers=>({...value,
   partial:true,completedOnly:true,timeOrigin:performance.timeOrigin,
   ordinary:ordinary.slice(0,44).map(({epoch,index,ordinal,digest,sequence,published,issueStarted,issueCompleted,timeOrigin,nativeCompletion,
    operationBytes,unsignedVertexBytes,signedEnvelopeBytes,peerDelivery})=>({epoch,index,ordinal,digest,sequence,published,
     issueStarted,issueCompleted,timeOrigin,...(nativeCompletion===undefined?{}:{nativeCompletion}),operationBytes,unsignedVertexBytes,signedEnvelopeBytes,peerDelivery})),
   ordinaryTruncated:ordinary.length>44,transitions:transitions.slice(0,5),transitionsTruncated:transitions.length>5,
   spans:spans.slice(-1024),spanCount:spans.length,spansTruncated:spans.length>1024,observers,
   closedObservers:roleObservers.slice(0,8).map(row=>({index:row.index,epoch:row.epoch,observer:completedObserverCheckpoint(row.observer)})),
   closedObserversTruncated:roleObservers.length>8}));
  if(!inspectAdmission)return value;
  const requests=value.pendingCalls.filter(row=>row.command==="admitted"&&row.digest!==undefined&&row.expectedBlock!==undefined);
  return Promise.all(requests.map(row=>rpc(row.index,"observe-admission",{digest:row.digest,expectedBlock:row.expectedBlock,ordinal:row.ordinal,requestedEpoch:row.epoch})))
   .then(admission=>({...value,admission}));
 });
 let active:{index:number;frame:HTMLIFrameElement;origin:string}[]=[];
 const listener=(event:MessageEvent)=>{
  const index=active.findIndex(role=>role.frame.contentWindow===event.source&&role.origin===event.origin);
  if(index<0)return;
  const packet=event.data;
  if(packet?.kind==="r8-grid-ready"){ready.add(event.source as Window);return;}
  if(packet?.kind==="r8-grid-rpc-segment"){
   const pending=waits.get(packet.token);
   if(pending?.index===index&&pending.command==="issue"&&
    (packet.segment==="test-only-issue-preimage"||packet.segment==="ordinary-issue-and-publication"||packet.segment==="test-only-native-publication-assertion")){
    pending.lastReportedSegment=packet.segment;
   }
   return;
  }
  if(packet?.kind==="r8-grid-ephemeral-route"){
   const target=ids.indexOf(packet.target);check(target>=0&&target!==index,"fixed connected ephemeral peer");
   active[target]!.frame.contentWindow!.postMessage({kind:"r8-grid-ephemeral-delivery",source:ids[index],bytes:packet.bytes},active[target]!.origin);return;
  }
  if(packet?.kind==="r8-grid-checkpoint-memory"){
   console.info(JSON.stringify({kind:"healthy-native-admission-memory",value:packet.value}));return;
  }
  if(packet?.kind==="r8-grid-rpc-result"){
   const pending=waits.get(packet.token);if(!pending)return;waits.delete(packet.token);
   if(packet.ok)pending.resolve(packet.value);else pending.reject(packet.error);return;
  }
  if(packet?.kind==="r8-grid-worker-route"){
   routeEvents++;
   check(packet.packet.kind==="route","original warm worker route only");
   const target=ids.indexOf(packet.packet.target);check(target>=0&&target!==index,"fixed connected native peer");
   const originalPacket=packet.packet.packet;
   const forward=()=>active[target]!.frame.contentWindow!.postMessage({kind:"r8-grid-worker-delivery",packet:{kind:"routed",source:ids[index],packet:originalPacket}},active[target]!.origin);
   if(phase==="recipient-install-4:1"&&index===1&&target===0&&originalPacket.type==="request"&&originalPacket.action==="open"
    &&originalPacket.protocol===CREATOR_SUCCESSOR_PROTOCOL)selectedSnapshotStream=originalPacket.streamId;
   const nativeSnapshotPacket=typeof suspendTransfer==="function"&&!suspensionStarted&&phase==="recipient-install-4:1"&&index===0&&target===1&&originalPacket.action==="chunk"
    ?(snapshots.at(-1) as {nativeChunkPackets?:{index:number;byteLength:number;packetDigest:string}[]}|undefined)?.nativeChunkPackets
    ?.find(row=>originalPacket.bytes instanceof Uint8Array&&row.byteLength===originalPacket.bytes.byteLength
     &&row.packetDigest===hex(hashDomain("ts-drp/native-freeze-test-packet/v1",originalPacket.bytes))):undefined;
   if(typeof suspendTransfer==="function"&&!suspensionStarted&&selectedSnapshotStream!==undefined&&phase==="recipient-install-4:1"
    &&index===0&&target===1&&originalPacket.type==="request"&&originalPacket.action==="chunk"&&originalPacket.streamId===selectedSnapshotStream&&nativeSnapshotPacket!==undefined){
    suspensionStarted=true;
    const bytes=originalPacket.bytes as Uint8Array,packetDigest=hex(hashDomain("ts-drp/native-freeze-test-packet/v1",bytes));
    const metadata={phase,epoch,source:index,target,streamId:selectedSnapshotStream,protocol:CREATOR_SUCCESSOR_PROTOCOL,
     packetBytes:bytes.byteLength,packetDigest,nativeSnapshotChunkIndex:nativeSnapshotPacket.index,pendingRpc:waits.size};
    const record:{metadata:typeof metadata;outcome?:unknown;error?:unknown}={metadata};suspensionEvents.push(record);
    const start=begin();
    // One test-only route hold at a genuine native server response. The
    // unchanged worker and native authorities own the admitted transfer.
    void Promise.resolve().then(async()=>{
     try{record.outcome=await suspendTransfer(metadata);check(hex(hashDomain("ts-drp/native-freeze-test-packet/v1",bytes))===packetDigest,"suspension changed original native transfer bytes");}
     finally{end("test-only-browser-suspension-and-route-hold",start);}
    }).then(forward,error=>{record.error=errorEvidence(error);failure=error;forward();});
    return;
   }
   forward();
  }
 };
 window.addEventListener("message",listener);
 const rpc=(index:number,command:string,args:Record<string,unknown>={})=>{
  const target=active[index];check(target,"original native role unavailable");
 const sequence=++token;context.rpcToken=sequence;const start=begin();
  if(command!=="observe-admission"&&command!=="observe-completed"){context.role=index===0?"creator":"recipient-"+index;context.transition=epoch;}
  return new Promise<any>((resolve,reject)=>{
   waits.set(sequence,{resolve:value=>{end("simulator-rpc:"+command,start);resolve(value);},reject,index,command,epoch,
    ...(typeof args.ordinal==="number"?{ordinal:args.ordinal}:{}),
    ...(command==="admitted"?{digest:String(args.digest),expectedBlock:{id:String((args.operation as any).id),x:(args.operation as any).x,y:(args.operation as any).y}}:{})});
   target.frame.contentWindow!.postMessage({kind:"r8-grid-rpc",token:sequence,command,args:{...args,epoch}},target.origin);
  });
 };
 const invite=await createV3RoomCreatorInviteMaterial({blueprintDigest:application.catalog.blueprintDigests[0]!,objectId,
  exactCanonicalApplicationStateBytes:application.migration!.canonicalStateBytes(application.projectAcceptedOperations({authenticatedBase:undefined,currentEpochOperations:[]})),
  exactCanonicalLatchedAclBytes:encodeCanonical({epoch:0,kind:"drp-v3-latched-acl",members:members.map((row,i)=>({author:row.author,finalityKey:i===0?row.author:null,groups:i===0?["admin","finality","writer"]:["writer"]})).sort((a,b)=>a.author<b.author?-1:1),objectId,permissionless:false,version:profileId==="creator-trusted-settlement-v1"?3:1}),
  exactCanonicalParametersCarrierBytes:encodeCanonical(parameters),exactCanonicalProfileBytes:encodeCanonical({cryptoSuiteId:"ed25519-sha256-v3",profileId,quorum:1,signers}),
  exactCanonicalSignerSetBytes:encodeCanonical(signers),signGenesisAnchorDigest:async digest=>ed25519.sign(digest,gridSeed(0))});
 async function open(kind:"create"|"reopen"){
  active=origins.map((origin,index)=>{const frame=document.createElement("iframe");frame.hidden=true;frame.src=origin+"/r8-source-binding";frames.push(frame);document.body.append(frame);return {index,frame,origin};});
  for(let turn=0;turn<2000&&!active.every(role=>ready.has(role.frame.contentWindow!));turn++)await new Promise(resolve=>setTimeout(resolve,10));
  check(active.every(role=>ready.has(role.frame.contentWindow!)),"isolated browser client bundle unavailable");
  for(let index=0;index<4;index++)await rpc(index,"init",{index,id:ids[index],connected:ids.filter((_,other)=>other!==index),suspensionProbe:typeof suspendTransfer==="function"});
  for(let index=0;index<4;index++)await rpc(index,"open",{index,database:identity+"-role-"+index,identity,objectId,invite,kind,
   autoPool:Reflect.get(globalThis,"__rdPoolMaintenanceAuto")===true,presentation:Reflect.get(globalThis,"__rdPresentation"),
   roomDatabase:Reflect.get(globalThis,"__rdRoomDatabase")===true});
  await Promise.all(active.map(role=>rpc(role.index,"history")));
 }
 async function close(){
  if(!active.length)return;
  const outcomes=await Promise.allSettled(active.map(role=>rpc(role.index,"close")));
  const faults:unknown[]=[];
  for(const result of outcomes)if(result.status==="fulfilled"){
   joins.push(...result.value.joins);if(result.value.observer!==undefined)roleObservers.push(result.value);
   if(!result.value.ok)faults.push(...result.value.errors);
  }else faults.push(result.reason);
  for(const role of active){ready.delete(role.frame.contentWindow!);role.frame.remove();}
  frames.length=0;active=[];
  if(faults.length)throw new AggregateError(faults,"healthy original native owners failed to join");
 }
 async function world(){
  const worlds=await Promise.all(active.map(role=>rpc(role.index,"world")));
  check(worlds.every(value=>hex(encodeCanonical(value))===hex(encodeCanonical(worlds[0]))),"healthy worlds differ at "+phase);
  check(worlds.every(value=>hex(encodeCanonical(value.roster))===hex(encodeCanonical(members))),"healthy roster changed");
  return hex(encodeCanonical(worlds[0]));
 }
 async function gameplay(count:number){
  for(let ordinal=0;ordinal<count;ordinal++){
   const index=ordinal%4,operation={...gridOperation(index,epoch),id:"integrated-block-"+(ordinal%8)};
   const value=await rpc(index,"issue",{operation,ordinal});ordinary.push(value);
   value.peerDelivery=await Promise.all(active.map(role=>rpc(role.index,"admitted",{digest:value.digest,operation,ordinal,waitDeadline:fixtureWaitDeadline})));
  }
  await world();
 }
 // Real-time hazard probe: moves issued while the creator runs pool maintenance.
 // Each must be admitted by every peer (bounded wait), never dropped or halted.
 // Kept out of `ordinary`; ordinals >= 1000 mark them in spans.
 // With `target` a recipient, the moves come from the creator and another
 // recipient while that recipient runs its own lull (slots 4-5, rows 4-5).
 async function concurrentMaintenance(target=0){
  const started=performance.now(),maintaining=rpc(target,"maintain").then(value=>({value,endedAt:performance.now()-started}));
  const move=async(index:number,delay:number,slot:number)=>{
   await new Promise(resolve=>setTimeout(resolve,delay));
   const ordinal=1000+slot,operation={...gridOperation(index,epoch),id:"integrated-block-"+(slot%8),y:4+(slot%4)},issuedAt=performance.now()-started;
   const value=await rpc(index,"issue",{operation,ordinal});
   const peerDelivery=await Promise.all(active.map(role=>rpc(role.index,"admitted",{digest:value.digest,operation,ordinal,waitDeadline:Date.now()+60_000})));
   const since=(at:number|undefined,origin:number)=>at===undefined?null:at+origin-(value.issueStarted+value.timeOrigin);
   return {index,delay,issuedAt,issueMilliseconds:value.issueCompleted-value.issueStarted,digest:value.digest,
    deliveredAt:peerDelivery.map(row=>row.acceptedCallbackAt+row.timeOrigin-(value.issueStarted+value.timeOrigin)),
    visibleAfter:peerDelivery.map(row=>since(row.visibleAt,row.timeOrigin)),
    ...(value.receiptStages===undefined?{}:{receiptStages:{visible:since(value.receiptStages.visibleAt,value.timeOrigin),durable:since(value.receiptStages.durableAt,value.timeOrigin)}})};
  };
  const moves=await Promise.all(target===0?[move(1,250,0),move(0,250,1),move(2,1500,2),move(3,2700,3)]:
   [move(0,150,4),move(target===1?2:1,400,5)]);
  return {target,maintenance:await maintaining,moves};
 }
 async function measure(label:string){const values=await Promise.all(active.map(role=>rpc(role.index,"measure")));checkpoints.push({label,epoch,values});
  const memory=Reflect.get(globalThis,"__r8ActiveResourceCheckpoint");if(typeof memory==="function"){const start=begin();try{await memory(label);}finally{end("test-only-active-native-GC-and-memory",start);}}
  return values;}
 try{
  check(!control.publicationFault&&!control.issueAfterSignFault,"healthy run must not inject failures");
  phase="create-join";await open("create");await measure("created");
  for(let transition=0;transition<rollovers;transition++){
   phase="ordinary-gameplay-"+epoch;await gameplay(8);
   // Optional bounded renderer trace window: seal-4 through the next lull and
   // the following ordinary gameplay (stopped before its forced-GC measurement).
   const traceControl=Reflect.get(globalThis,"__rdTraceControl");
   if(typeof traceControl==="function"&&epoch===5)await traceControl("stop");
   await measure("before-rollover-"+epoch);
   if(typeof traceControl==="function"&&epoch===4){await traceControl("start");await Promise.all(active.map(role=>rpc(role.index,"clock")));}
   phase="seal-"+epoch;const closed=await rpc(0,"seal");check(closed.ok,"healthy seal refused:"+JSON.stringify(closed));
   const offer=await rpc(0,"export");snapshots.push(await rpc(0,"snapshot",{offer}));
   phase="creator-adoption-"+epoch;await rpc(0,"adopt");
   for(let index=1;index<4;index++){phase="recipient-install-"+epoch+":"+index;await rpc(index,"install",{offer,peers:[ids[0]]});}
   epoch=closed.successorEpoch;phase="settlement-cleanup-"+epoch;
   await Promise.all(active.map(role=>rpc(role.index,"history")));await world();await measure("adopted-"+epoch);
   // Opt-in idle lull after the measured rollover: creator, then each recipient, pool maintenance.
   // Every rollover, including the last: the persisted close cancels the final lull's unawaited
   // retained repair instead of failing on it, and the reopened recipients discharge the halt on
   // the retirement that lull completed before they admit the next live move.
   const lull=Reflect.get(globalThis,"__rdPoolMaintenanceLull")===true,recipientLull=lull;
   const poolMaintenance=!lull?undefined:
    Reflect.get(globalThis,"__rdPoolMaintenanceConcurrent")===true?(phase="pool-maintenance-concurrent-"+epoch,await concurrentMaintenance()):
    (phase="pool-maintenance-"+epoch,await rpc(0,"maintain"));
   const recipientPoolMaintenance:unknown[]=[];
   const concurrent=Reflect.get(globalThis,"__rdPoolMaintenanceConcurrent")===true;
   if(recipientLull)for(let index=1;index<4;index++){phase="pool-maintenance-"+epoch+":"+index;
    recipientPoolMaintenance.push(concurrent&&index===1?await concurrentMaintenance(1):await rpc(index,"maintain"));}
   transitions.push({closedEpoch:closed.epoch,successorEpoch:closed.successorEpoch,sessionRecreations:0,fixtureDatabaseCopies:0,
    ...(poolMaintenance===undefined?{}:{poolMaintenance}),...(recipientLull?{recipientPoolMaintenance}:{})});
  }
  const expectedReopenWorld=await world();
  presentationSummary.push(await Promise.all(active.map(role=>rpc(role.index,"presentation"))));
  phase="persisted-close";await close();
  phase="persisted-reopen";await open("reopen");
  check(await world()===expectedReopenWorld,"persisted reopen lost/changed the authenticated world");await measure("reopened");
  phase="continued-gameplay";await gameplay(4);await measure("continued-gameplay");
  presentationSummary.push(await Promise.all(active.map(role=>rpc(role.index,"presentation"))));
 }catch(error){failure=error;}
 finally{try{await close();}catch(error){failure=failure===undefined?error:new AggregateError([failure,error],"integrated failure plus joined cleanup failure");}
  window.removeEventListener("message",listener);for(const frame of frames)frame.remove();
  if(probeTimer!==undefined)clearInterval(probeTimer);
  Reflect.deleteProperty(globalThis,"__r8FrozenRouteObservation");}
 return {ok:failure===undefined,phase,epoch,...(failure===undefined?{}:{error:errorEvidence(failure)}),identity,objectId,profileId,activeClients:4,rosterMembers:members.length,requestedRollovers:rollovers,timeOrigin:performance.timeOrigin,
  ordinary,snapshots,transitions,checkpoints,joins,suspensionEvents,spans:spans.slice(startSpan),roleObservers,presentation:Reflect.get(globalThis,"__rdPresentation")??null,roomDatabase:Reflect.get(globalThis,"__rdRoomDatabase")===true,presentationSummary,proofEventsTruncated:roleObservers.some(row=>row.observer.proofEventsTruncated),
  transfers:roleObservers.flatMap(row=>row.observer.transfers),publications:roleObservers.flatMap(row=>row.observer.publications),
  qualification:"Genuine browser IndexedDB and browser writer locks on four independent localhost storage origins; original Grid/room/native/protocol owners in four frame realms. Reuses unchanged accepted warm worker byte-routing transport through a browser parentPort adapter. Local serialized postMessage routing and shared browser renderer/profile are simulator costs, not network/device viability. Healthy rollovers keep original sessions/transports; only explicit persisted-reopen recreates clients on their SAME original origins/databases. No fixture copying/injected failures. "+(profileId==="creator-trusted-settlement-v1"?"Fully settled ordinary contributions exercise genuine settlement/fence/rebase and native cleanup, not fabricated nonempty displacement. ":"The original no-settlement profile has no author fence or settlement plan; its zero-fence adoption and lawful cleanup are not settlement-enabled evidence. ")+"Native read-only scans/assertions, simulator RPC and forced GC overhead are separate; no absolute gameplay latency/physical-memory target defined."};
}
