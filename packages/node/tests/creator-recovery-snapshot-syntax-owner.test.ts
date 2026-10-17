import {readFileSync} from "node:fs";
import ts from "typescript";
import {describe,expect,it} from "vitest";

const path=new URL("../src/internal/creator-closed-rollback-data.ts",import.meta.url);
const source=readFileSync(path,"utf8"),ast=ts.createSourceFile(path.pathname,source,ts.ScriptTarget.Latest,true);
function declaration(name:string){
 const found=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 if(!found)throw Error("SNAPSHOT_SOURCE_OWNER_MISSING:"+name);return found;
}
// Execute the actual acquisition wrapper and snapshot-opening owner. Native
// storage, signed Cut/catalog and quarantine-state premises are controlled here;
// genuine native acceptance and the full snapshot predicate have separate tests.
function fixture(){
 const events:string[]=[],payload=Uint8Array.of(1,2,3),manifest=Uint8Array.of(4,5);
 let current=true,corrupt=false,accept=true,readerFailure:Error|undefined;
 const result={payload:{kind:"payload"},manifest:{payloadDigest:"payload"},successorAclBytes:Uint8Array.of(6)};
 const calls:{owner:number;fresh:number;args:unknown[][];factories:number}={owner:0,fresh:0,args:[],factories:0};
 const snapshot=(...args:unknown[])=>{calls.owner++;calls.args.push(args);events.push("same-syntax");return accept?result:undefined;};
 const reader={read:async()=>{events.push("native-read");return corrupt?Uint8Array.of(9,9,9):payload.slice();},
  release:async()=>{events.push("reader-release");if(readerFailure)throw readerFailure;}};
 const protection={check:async()=>{events.push("native-check");if(!current)throw Error("NATIVE_REVOKED");},release:async()=>{events.push("protection-release");}};
 const descriptor={index:0,byteLength:payload.byteLength,digest:"chunk"};
 const stored={exactCanonicalManifestBytes:manifest,totalBytes:payload.length,chunks:[descriptor]};
 const input={objectId:"room",signal:undefined,snapshotProtection:async()=>({kind:"held",protection}),
  lookup:async()=>{events.push("native-lookup");return {kind:"present",state:"verified",retention:{},declaration:stored};},
  snapshotAcquire:async()=>{events.push("native-acquire");return {kind:"present",state:"verified",retention:{},declaration:stored,reader};},capturedCatalog:{}};
 const target={cut:{epoch:0,previousAnchor:"old",snapshotManifestDigest:"manifest",stateDigest:"state",aclDigest:"acl",blueprintDigest:"blueprint"},
  successorTrust:{currentAnchorDigest:"next",profileId:"profile"},successorAnchor:{},projection:{},closedAclDigest:"closed-acl",
  evidence:{cut:{ref:{digest:"cut"}},qc:{ref:{digest:"qc"}},representation:"closed"}};
 class Refusal extends Error{constructor(readonly result:{kind:string}){super(result.kind);}}
 const context={createCreatorCanonicalSyntaxReader:()=>{calls.factories++;return {snapshot,record:()=>undefined};},
  record:()=>undefined,anchorOf:()=>undefined,unique:()=>undefined,uniqueCreatorTransitionCandidate:()=>undefined,canonicalCreatorDataRecord:()=>undefined,
  validateCreatorSnapshotData:(...args:unknown[])=>{calls.fresh++;calls.args.push(args);events.push("fresh-syntax");return accept?result:undefined;},
  checkAbort:()=>{},bindMethod:(owner:Record<string,any>,key:string)=>owner[key].bind(owner),
  snapshotCall:<T>(call:()=>Promise<T>)=>call(),snapshotRoleReadable:()=>true,
  decodeSnapshotManifest:()=>({manifest:{totalBytes:payload.length},chunks:[descriptor]}),snapshotQuarantineContract:{limits:{}},
  snapshotChunkDigest:(_index:number,bytes:Uint8Array)=>{events.push("chunk-hash");return bytes[0]===payload[0]?"chunk":"altered";},
  creatorSnapshotCatalogIdentity:()=>({}),verifiedCreatorSnapshotCatalog:()=>({}),creatorSnapshotProjectionMatches:()=>true,
  requireLaw:(condition:unknown,kind="chain-invalid")=>{if(!condition)throw new Refusal({kind});},Refusal,failure:(kind:string)=>({kind})};
 const js=ts.transpile([declaration("createCreatorClosedAcquisitionSyntax").getText(ast),declaration("readTarget").getText(ast),
  "({create:createCreatorClosedAcquisitionSyntax,read:readTarget});"].join("\n"),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None});
 const actual=new Function(...Object.keys(context),`return eval(${JSON.stringify(js)});`)(...Object.values(context));
 const parsing=actual.create(),held:any[]=[];
 return {events,calls,parsing,held,target,input,payload,manifest,
  read:(owner=parsing,targets:any[]|undefined=held)=>actual.read(input,target,targets,owner),
  readFresh:()=>actual.read(input,target,held),
  revoke:()=>{current=false;},corrupt:()=>{corrupt=true;},refuse:()=>{accept=false;},
  failReaderRelease:(error:Error)=>{readerFailure=error;}};
}

describe("recovery source snapshot syntax ownership",()=>{
 it("reuses the same bounded syntax owner while independently acquiring, reading and hashing every snapshot",async()=>{
  const f=fixture();await f.read();await f.read();
  expect(f.calls.factories).toBe(1);expect(f.calls.owner).toBe(2);expect(f.calls.fresh).toBe(0);
  for(const event of ["native-lookup","native-acquire","native-read","native-check","chunk-hash"])expect(f.events.filter(value=>value===event)).toHaveLength(2);
  expect(f.held).toHaveLength(2);await Promise.all(f.held.map(target=>target.release()));
 });
 it("takes the original fresh validator after the acquisition syntax lifetime is released",async()=>{
  const f=fixture();await f.read();f.parsing.release();await f.read();
  expect(f.calls.owner).toBe(1);expect(f.calls.fresh).toBe(1);expect(f.calls.factories).toBe(1);
  await Promise.all(f.held.map(target=>target.release()));
 });
 it("keeps callers without the private acquisition owner on the original full boundary",async()=>{
  const f=fixture();await f.readFresh();expect(f.calls.owner).toBe(0);expect(f.calls.fresh).toBe(1);
  await f.held[0].release();
 });
 it("does not turn a reusable syntax fact into native currency authority",async()=>{
  const f=fixture();await f.read();f.revoke();await expect(f.read()).rejects.toThrow("NATIVE_REVOKED");
  expect(f.calls.owner).toBe(1);expect(f.events.slice(-2)).toEqual(["reader-release","protection-release"]);
  await f.held[0].release();
 });
 it("refuses changed native bytes before consulting retained syntax",async()=>{
  const f=fixture();await f.read();f.corrupt();await expect(f.read()).rejects.toThrow("snapshot-invalid");
  expect(f.calls.owner).toBe(1);expect(f.held).toHaveLength(1);await f.held[0].release();
 });
 it("forwards the exact fresh cut/profile and preserves full predicate refusal",async()=>{
  const f=fixture();await f.read();f.target.cut.stateDigest="changed";f.target.successorTrust.profileId="foreign";f.refuse();
  await expect(f.read()).rejects.toThrow("snapshot-invalid");expect(f.calls.owner).toBe(2);
  expect(f.calls.args[1]?.[2]).toBe(f.target.cut);expect(f.calls.args[1]?.[3]).toBe("foreign");await f.held[0].release();
 });
 it("keeps the admitted snapshot reader and protection until joined release, including failure",async()=>{
  const f=fixture();await f.read();expect(f.events).not.toContain("reader-release");
  f.parsing.release();await f.held[0].check();expect(f.events.filter(value=>value==="native-read")).toHaveLength(2);
  const error=Error("READER_RELEASE_FAILED");f.failReaderRelease(error);await expect(f.held[0].release()).rejects.toBe(error);
  expect(f.events.slice(-2)).toEqual(["reader-release","protection-release"]);
 });
 it("threads the original owner through certificate, authenticated, installed and pending source paths only",()=>{
  let total=0;for(const name of ["acquireRecoveryRoleCertificate","acquireInstalledPromotion","authenticate","authenticateHeldPendingRole"]){
   const calls:ts.CallExpression[]=[];const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==="readTarget")calls.push(node);ts.forEachChild(node,visit);};visit(declaration(name));
   for(const call of calls){expect(call.arguments).toHaveLength(4);expect(call.arguments[3]?.getText(ast)).toBe("parsing");total++;}
  }expect(total).toBe(5);
 });
});
