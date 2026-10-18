import {beforeEach, describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {context, criticalMetrics} from "./critical-observer.js";

const begin=(phase:string)=>Reflect.get(globalThis,"__warmMetricBegin")(phase);
const returned=<T>(token:unknown,value:T):T=>Reflect.get(globalThis,"__warmMetricReturned")(token,value);
const finish=(token:unknown)=>Reflect.get(globalThis,"__warmMetricFinish")(token);
const failed=(token:unknown)=>Reflect.get(globalThis,"__warmMetricFailure")(token);
const row=()=>[...criticalMetrics.values()][0]!;
function gate<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{criticalMetrics.clear();Reflect.set(globalThis,"__r8CriticalProfiling",true);
 Object.assign(context,{role:"creator",transition:4,command:"observer-regression"});});

describe("existing critical observer returned-promise completion",()=>{
 it("shares static attribution with the actual codec row without counting the wrapper twice",()=>{
  const wrap=Reflect.get(globalThis,"__warmMetricBegin")("canonical-decode-callsite:fixed",0,true);
  const codec=Reflect.get(globalThis,"__warmMetricBegin")("canonical-decode",0,true);
  Reflect.get(globalThis,"__warmMetricBytes")(codec,31);
  Reflect.get(globalThis,"__warmMetricEnd")(codec);
  Reflect.get(globalThis,"__warmMetricEnd")(wrap);
  expect(criticalMetrics.size).toBe(1);
  expect(row()).toMatchObject({phase:"canonical-decode",entered:1,completed:1,inputBytes:31,thrown:0});
  const next=Reflect.get(globalThis,"__warmMetricBegin")("canonical-decode",0,true);
  Reflect.get(globalThis,"__warmMetricEnd")(next);
  expect(criticalMetrics.has(JSON.stringify(["canonical-decode","unattributed"]))).toBe(true);
 });
 it("does not invent codec invocations when call argument evaluation fails",()=>{
  const wrap=Reflect.get(globalThis,"__warmMetricBegin")("canonical-encode-callsite:argument-failure",0,true);
  failed(wrap);Reflect.get(globalThis,"__warmMetricEnd")(wrap);
  expect(row()).toMatchObject({phase:"canonical-encode",entered:0,completed:0,thrown:0});
  const codec=Reflect.get(globalThis,"__warmMetricBegin")("canonical-encode",0,true);
  failed(codec);Reflect.get(globalThis,"__warmMetricEnd")(codec);
  const actual=criticalMetrics.get(JSON.stringify(["canonical-encode","unattributed"]));
  expect(actual).toMatchObject({entered:1,completed:1,thrown:1});
 });
 it("nests same-offset sequential closures inside the generic metric owner",async()=>{
  const source=readFileSync(new URL("./build.ts",import.meta.url),"utf8");
  const ast=ts.createSourceFile("build.ts",source,ts.ScriptTarget.Latest,true);
  const declaration=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="applyObservationInsertions");
  if(!declaration)throw Error("ORIGINAL_INSERTION_OWNER_MISSING");
  const apply=new Function(ts.transpile(declaration.getText(ast)+"\nreturn applyObservationInsertions;",{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}))();
  for(const throwing of [false,true]){
   const raw=`async function run(){${throwing?'throw failure;':'return 7;'}}`,start=raw.indexOf("{")+1,stop=raw.lastIndexOf("}");
   const code=apply(raw,[
    {offset:start,text:'const inner={};events.push("inner-start");try{'},
    {offset:stop,priority:-1,text:'}finally{if(!inner)throw Error("lost-inner");events.push("inner-end");}'},
    {offset:start,text:'events.push("outer-start");try{'},
    {offset:stop,text:'}finally{events.push("outer-end");}'},
   ]),events:string[]=[],failure=Error("original-failure");
   const run=new Function("events","failure",code+";return run;")(events,failure);
   if(throwing)await expect(run()).rejects.toBe(failure);else expect(await run()).toBe(7);
   expect(events).toEqual(["outer-start","inner-start","inner-end","outer-end"]);
  }
 });
 it("preserves the exact returned promise and waits for its settlement",async()=>{
  const g=gate<number>(),token=begin("returned-task");
  expect(returned(token,g.promise)).toBe(g.promise);finish(token);
  expect(row()).toMatchObject({entered:1,completed:0});
  g.resolve(7);expect(await g.promise).toBe(7);await Promise.resolve();
  expect(row()).toMatchObject({completed:1,thrown:0});
 });
 it("does not turn an un-awaited rejection into an original try/catch interception",async()=>{
  const g=gate<number>();let intercepted=false;
  const run=async()=>{const token=begin("rejected-task");
   try {try {return returned(token,g.promise);}catch(error){intercepted=true;throw error;}}
   catch(error){failed(token);throw error;}finally{finish(token);}};
  const result=run();expect(row().completed).toBe(0);g.reject(Error("original-rejection"));
  await expect(result).rejects.toThrow("original-rejection");await Promise.resolve();
  expect(intercepted).toBe(false);expect(row()).toMatchObject({completed:1,thrown:1});
 });
 it("times the selected original finally return, not an overridden pending task",async()=>{
  const g=gate<number>();
  const run=async()=>{const token=begin("finally-return");
   try {try {return returned(token,g.promise);}finally{return returned(token,11);}}
   catch(error){failed(token);throw error;}finally{finish(token);}};
  expect(await run()).toBe(11);expect(row()).toMatchObject({completed:1,thrown:0});
  g.resolve(7);await g.promise;expect(row().completed).toBe(1);
 });
 it("retains an original finally throw without waiting for the discarded task",async()=>{
  const g=gate<number>();
  const run=async()=>{const token=begin("finally-throw");
   try {try {return returned(token,g.promise);}finally{throw Error("original-finally");}}
   catch(error){failed(token);throw error;}finally{finish(token);}};
  await expect(run()).rejects.toThrow("original-finally");
  expect(row()).toMatchObject({completed:1,thrown:1});g.resolve(7);await g.promise;
 });
 it("retains a bare finally return and excludes the discarded task",async()=>{
  const g=gate<number>();
  const run=async()=>{const token=begin("finally-bare-return");
   try {try {return returned(token,g.promise);}finally{returned(token,undefined);return;}}
   catch(error){failed(token);throw error;}finally{finish(token);}};
  expect(await run()).toBeUndefined();expect(row().completed).toBe(1);g.resolve(7);await g.promise;
 });
});
