import {readFileSync} from "node:fs";
import ts from "typescript";
import {describe,expect,it} from "vitest";

const source=readFileSync(new URL("../../../tests/fixtures/startup-discovery/r8-source-binding.pw.ts",import.meta.url),"utf8");
const ast=ts.createSourceFile("r8-source-binding.pw.ts",source,ts.ScriptTarget.Latest,true);
const names=["validateCriticalCpuProfile","validateCriticalCoverage","selectCriticalTraceCategories","criticalCaptureModes"];
const declarations=names.map(name=>{
 const declaration=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 if(!declaration)throw Error("PROFILE_VALIDATOR_MISSING:"+name);return declaration.getText(ast);
});
const code=ts.transpile(declarations.join("\n"),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None});
const {validateCriticalCpuProfile:cpu,validateCriticalCoverage:coverage,selectCriticalTraceCategories:categories,criticalCaptureModes:modes}=new Function(code+";return {validateCriticalCpuProfile,validateCriticalCoverage,selectCriticalTraceCategories,criticalCaptureModes};")();
const valid=()=>({nodes:[{id:1,children:[2]},{id:2}],startTime:100,endTime:200,samples:[1,2,2],timeDeltas:[0,30,40]});
const validCoverage=()=>({timestamp:1.5,result:[{scriptId:"17",url:"http://localhost/bundle.js",functions:[
 {functionName:"",ranges:[{startOffset:0,endOffset:100,count:1}],isBlockCoverage:false},
 {functionName:"ordinary",ranges:[{startOffset:10,endOffset:80,count:12345}],isBlockCoverage:false},
]}]});

describe("healthy native profiler evidence validation",()=>{
 it("accepts complete monotone CPU samples and leaves the original profile unchanged",()=>{
  const profile=valid(),before=JSON.stringify(profile);expect(cpu(profile)).toMatchObject({valid:true,samples:3,sumTimeDeltas:70,negativeDeltas:0});expect(JSON.stringify(profile)).toBe(before);
 });
 it("rejects negative deltas instead of clamping the recorded timeline",()=>{
  const profile=valid();profile.timeDeltas[1]=-1;expect(cpu(profile)).toMatchObject({valid:false,negativeDeltas:1,invalidDeltas:1});expect(profile.timeDeltas[1]).toBe(-1);
 });
 it("checks every sample including late invalid deltas",()=>{
  const profile=valid();profile.timeDeltas[2]=Number.NaN;expect(cpu(profile)).toMatchObject({valid:false,invalidDeltas:1});
 });
 it("rejects cumulative sample timestamps beyond the actual profile end",()=>{
  const profile=valid();profile.timeDeltas[2]=100;expect(cpu(profile)).toMatchObject({valid:false,outOfBoundsSamples:1});
 });
 it("rejects reversed or absent profile timestamps",()=>{
  expect(cpu({...valid(),endTime:50}).valid).toBe(false);expect(cpu({...valid(),startTime:undefined}).valid).toBe(false);
 });
 it("rejects a sample referring to an absent node",()=>{
  const profile=valid();profile.samples[2]=99;expect(cpu(profile)).toMatchObject({valid:false,unknownSampleIds:1});
 });
 it("rejects duplicate IDs and dangling tree children",()=>{
  expect(cpu({...valid(),nodes:[{id:1},{id:1}]}).valid).toBe(false);
  expect(cpu({...valid(),nodes:[{id:1,children:[99]},{id:2}]}).valid).toBe(false);
 });
 it("refuses absent or mismatched sampled timelines",()=>{
  expect(cpu({...valid(),timeDeltas:undefined}).valid).toBe(false);expect(cpu({...valid(),samples:[1]}).valid).toBe(false);expect(cpu({nodes:{}}).valid).toBe(false);
 });
 it("uses V8 invocation counts independently of CPU sampling",()=>{
  expect(coverage(validCoverage())).toMatchObject({valid:true,scripts:1,functions:2,calls:12346,timestamp:1.5});
 });
 it("rejects malformed function ranges and nonintegral counts",()=>{
  const result=validCoverage();result.result[0].functions[1].ranges[0].count=0.5;expect(coverage(result).valid).toBe(false);
  result.result[0].functions[1].ranges[0]={startOffset:80,endOffset:10,count:0};expect(coverage(result).valid).toBe(false);
 });
 it("rejects missing script identity or coverage timestamp",()=>{
  expect(coverage({...validCoverage(),timestamp:undefined}).valid).toBe(false);
  const result=validCoverage();Reflect.deleteProperty(result.result[0],"scriptId");expect(coverage(result).valid).toBe(false);
 });
 it("does not create repeated iframe CDP sessions and bounds the trace end command",()=>{
  expect(source).not.toContain("newCDPSession(frame)");expect(source).not.toContain("discoverTargets");
  expect(source).toContain('bounded(browserCpu.send("Tracing.end"),"Tracing.end command")');
  expect(source).toContain('callCount:true,detailed:false,allowTriggeredUpdates:false');
  expect(source).toContain('capture.traceEof=true');expect(source).toContain('profileMode===');
  expect(source).toContain('activeCapture.endMeta={...meta}');
 });
 it("selects exact native categories without accidentally enabling profilers or scheduler snapshots",()=>{
  expect(categories(["disabled-by-default-cpu_profiler","disabled-by-default-cpu_profiler.debug","disabled-by-default-v8.cpu_profiler",
   "disabled-by-default-java-heap-profiler","disabled-by-default-sequence_manager.verbose_snapshots","renderer.scheduler","file_system_provider",
   "indexeddb","leveldb"])).toEqual(["devtools.timeline","blink.user_timing","disabled-by-default-v8.gc","indexeddb","leveldb"]);
 });
 it("reads partial creator counters without ending the API and does not restart a closed capture",()=>{
  expect(source).toContain('capture.partialCreatorSnapshot=true');
  expect(source).toContain('Reflect.get(globalThis,"__r8FunctionSnapshot")');
  const closed=source.slice(source.indexOf('if(criticalFinished){'),source.indexOf('if(kind==="begin")return startCriticalWindow(meta)'));
  expect(closed).toContain('return {ok:true,partial:true,captureClosed:true}');expect(closed).not.toContain('startCriticalWindow');
 });
 it("never concurrently starts native tracing and the V8 CPU profiler",()=>{
  expect(modes("full-calls")).toEqual({v8CpuProfiling:false,nativeTracing:true});
  expect(modes("cpu-only")).toEqual({v8CpuProfiling:true,nativeTracing:false});
  expect(source).toContain('if(captureModes.nativeTracing)try{');
  expect(source).toContain('if(captureModes.v8CpuProfiling){await cdp.send("Profiler.start")');
 });
});
