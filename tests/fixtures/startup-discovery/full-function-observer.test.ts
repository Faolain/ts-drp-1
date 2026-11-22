import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {beginFullFunctionWindow,endFullFunctionWindow} from "./critical-observer.js";

const api=(name:string,...args:unknown[])=>Reflect.get(globalThis,"__r8Function"+name)(...args);
const meta={phase:"sealing-inclusive",role:"creator",transition:4,rpcToken:9,timeOrigin:0};
let now=0;
beforeEach(()=>{now=0;vi.spyOn(performance,"now").mockImplementation(()=>now);
 Reflect.set(globalThis,"__r8FullFunctionCalls",true);Reflect.set(globalThis,"__r8FunctionManifestSize",32);
 beginFullFunctionWindow(meta);});
afterEach(()=>{endFullFunctionWindow();vi.restoreAllMocks();});
function row(snapshot:any,id:number){return snapshot.rows.find((r:any)=>r.id===id);}
describe("complete function observer execution ownership",()=>{
 it("refuses selected-clock measurements from a mismatched build",()=>{
  endFullFunctionWindow();Reflect.set(globalThis,"__r8RequiredFunctionClockScope","retirement");
  Reflect.set(globalThis,"__r8FunctionClockScope","all");
  try{expect(()=>beginFullFunctionWindow(meta)).toThrow("FUNCTION_CLOCK_BUILD_SCOPE_MISMATCH");}
  finally{Reflect.deleteProperty(globalThis,"__r8RequiredFunctionClockScope");Reflect.deleteProperty(globalThis,"__r8FunctionClockScope");}
 });
 it("partitions nested execution and genuinely unowned gaps without double counting inclusive times",()=>{
  expect(Reflect.get(globalThis,"__r8FunctionWindowActive")).toBe(true);
  const a=api("Enter",1);now=2;const b=api("Enter",2);now=7;api("Exit",b);now=10;api("Exit",a);now=12;
  const s:any=endFullFunctionWindow();
  expect(Reflect.get(globalThis,"__r8FunctionWindowActive")).toBe(false);
  expect(row(s,1)).toMatchObject({entered:1,bodyExited:1,selfMilliseconds:5,bodyElapsedMilliseconds:10});
  expect(row(s,2)).toMatchObject({entered:1,bodyExited:1,selfMilliseconds:5});
  expect(s).toMatchObject({elapsedMilliseconds:12,selfExecutionWallMilliseconds:10,unownedWallMilliseconds:2,
   reconciliationResidualMilliseconds:0,invalid:[],waitsTruncated:false,edgesTruncated:false,openBodies:[]});
  expect(s.unownedIntervals).toEqual([{begin:10,end:12,milliseconds:2,previous:{kind:"exit",id:1},next:{kind:"capture-end"}}]);
  expect(s.unownedIntervalsTruncated).toBe(false);
 });
 it("does not count an unrelated callback's work as the suspended function's self time",()=>{
  const a=api("Enter",1,undefined,1);now=2;const promise=Promise.resolve(7);
  expect(api("Suspend",a,promise)).toBe(promise);now=5;
  const callback=api("Enter",2);now=9;api("Exit",callback);now=12;
  expect(api("Resume",a,7)).toBe(7);now=14;api("Exit",a);
  const s:any=endFullFunctionWindow();
  expect(row(s,1)).toMatchObject({selfMilliseconds:4,awaitMilliseconds:10,suspensions:1,resumptions:1});
  expect(row(s,2).selfMilliseconds).toBe(4);
  expect(s).toMatchObject({selfExecutionWallMilliseconds:8,unownedWallMilliseconds:6,reconciliationResidualMilliseconds:0,invalid:[]});
  expect(s.unownedIntervals).toEqual([
   {begin:2,end:5,milliseconds:3,previous:{kind:"suspend",id:1},next:{kind:"enter",id:2}},
   {begin:9,end:12,milliseconds:3,previous:{kind:"exit",id:2},next:{kind:"resume",id:1}}]);
  expect(s.unownedIntervals.reduce((n:number,row:any)=>n+row.milliseconds,0)).toBe(s.unownedWallMilliseconds);
 });
 it("enrolls pre-capture continuations without inventing a new body invocation",()=>{
  endFullFunctionWindow();const a=api("Enter",1,undefined,1);expect(a).toBeDefined();
  now=5;beginFullFunctionWindow(meta);api("Resume",a,undefined);now=8;api("Exit",a);
  const s:any=endFullFunctionWindow();
  expect(row(s,1)).toMatchObject({entered:0,enteredBeforeCapture:1,bodyExited:1,selfMilliseconds:3});
  expect(s.invalid).toEqual([]);
 });
 it("closes rejection gaps at the actual catch continuation and keeps original errors",()=>{
  const a=api("Enter",1,undefined,1);now=1;api("Suspend",a,undefined);now=6;
  api("ResumeOnError",a);now=8;const failure=Error("original");api("Thrown",a,failure);api("Exit",a);
  const s:any=endFullFunctionWindow();expect(row(s,1)).toMatchObject({selfMilliseconds:3,awaitMilliseconds:5,thrown:1});
  expect(s.reconciliationResidualMilliseconds).toBe(0);
 });
 it("preserves selected original promises and does not inspect or assimilate hostile return values",async()=>{
  const a=api("Enter",1),promise=Promise.resolve(7);expect(api("Returned",a,promise)).toBe(promise);api("Exit",a);
  const b=api("Enter",2);let accesses=0;const thenable={get then(){accesses++;throw Error("must not read");}};
  expect(api("Returned",b,thenable)).toBe(thenable);api("Exit",b);
  const c=api("Enter",3),proxy=new Proxy({},{getPrototypeOf(){throw Error("must not inspect");}});
  expect(api("Returned",c,proxy)).toBe(proxy);api("Exit",c);
  await promise;await Promise.resolve();const s:any=endFullFunctionWindow();
  expect(accesses).toBe(0);expect(row(s,1)).toMatchObject({selectedReturns:1});
  expect(row(s,2).selectedReturns).toBe(1);
  expect(row(s,3).selectedReturns).toBe(1);
 });
 it("keeps delegated generator elapsed separate from an asserted pure wait",()=>{
  const a=api("Enter",1,undefined,2);now=1;api("Suspend",a,{},"yield*");now=11;api("Resume",a,undefined);now=12;api("Exit",a);
  const s:any=endFullFunctionWindow();expect(row(s,1)).toMatchObject({selfMilliseconds:2,delegatedMilliseconds:10,awaitMilliseconds:0});
 });
 it("reports open work, unknown IDs and stack failures instead of declaring complete attribution",()=>{
  const a=api("Enter",1);api("Enter",2);api("Suspend",a,undefined);api("Enter",99);
  const s:any=endFullFunctionWindow();expect(s.invalid.length).toBeGreaterThan(0);expect(s.openBodies.length).toBeGreaterThan(0);
 });
 it("retains legitimately suspended lifetime bodies as censored, not executing or fabricated closed calls",()=>{
  const held=api("Enter",1,undefined,1);now=1;api("Suspend",held,undefined,"await","lifetime-held");now=4;
  const s:any=endFullFunctionWindow();expect(s.currentExecutingBody).toBeNull();expect(s.invalid).toEqual([]);
  expect(s.openBodies).toEqual([{id:1,call:1,waiting:{begin:1,kind:"await",site:"lifetime-held"},started:0}]);
  expect(s).toMatchObject({selfExecutionWallMilliseconds:1,unownedWallMilliseconds:3,reconciliationResidualMilliseconds:0,waitLimit:100000});
 });
 it("lets the creator reset the wider profiler prefix at the exact API boundary and ends idempotently",()=>{
  const a=api("Enter",1,undefined,1);now=4;api("Suspend",a,undefined);
  now=7;beginFullFunctionWindow(meta);api("Resume",a,undefined);now=9;api("Exit",a);
  const s:any=endFullFunctionWindow();expect(s.begin).toBe(7);expect(row(s,1).enteredBeforeCapture).toBe(1);
  expect(endFullFunctionWindow()).toBe(s);
 });
});
