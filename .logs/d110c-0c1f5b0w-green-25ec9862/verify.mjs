import ts from "typescript";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd(), evidence = import.meta.dirname;
const anchor = "25ec98628eba5d348086ba18d6481544803e03c9";
const changed = ["examples/v3-room/src/index.ts", "packages/issuance-store/src/contract.ts"];
const git = (...args) => {
 const result = spawnSync("git",args,{cwd:root,encoding:"utf8",maxBuffer:128*1024*1024});
 if(result.status!==0) throw new Error(result.stderr);
 return result.stdout;
};
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (name,value) => writeFileSync(resolve(evidence,name),JSON.stringify(value,null,2)+"\n");
function diagnostics(configFile, baseline, sourceMapped, entries) {
 const configPath = resolve(root,configFile);
 const config = ts.readConfigFile(configPath,ts.sys.readFile);
 const parsed = ts.parseJsonConfigFileContent(config.config,ts.sys,resolve(configPath,".."));
 const options = {...parsed.options,noEmit:true,incremental:false};
 if(sourceMapped) {
  const paths = {};
  for(const directory of readdirSync(resolve(root,"packages"))) {
   const file = resolve(root,"packages",directory,"package.json");
   if(!existsSync(file)) continue;
   const pkg = JSON.parse(readFileSync(file));
   for(const [key,value] of Object.entries(pkg.exports??{})) {
    if(key.includes("*")) continue;
    const target = typeof value === "string" ? value : value.import ?? value.types;
    if(typeof target !== "string") continue;
    const source = resolve(root,"packages",directory,target.replace("./dist/","./").replace(/\.d\.ts$/,".ts").replace(/\.js$/,".ts"));
    paths[pkg.name+(key==="."?"":key.slice(1))] = [existsSync(source)?source:resolve(root,"packages",directory,typeof value==="object"?value.types??target:target)];
   }
  }
  Object.assign(options,{paths,composite:false,declaration:false,declarationMap:false});
 }
 const host=ts.createCompilerHost(options), read=host.readFile;
 if(baseline) host.readFile=file => changed.includes(relative(root,file))?git("show",anchor+":"+relative(root,file)):read(file);
 const program=ts.createProgram(entries??parsed.fileNames,options,host);
 return ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?relative(root,d.file.fileName):null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,"\n")}));
}
if(process.argv[2]==="types") {
 const selection=JSON.parse(readFileSync(resolve(root,".logs/d110c-0c1f5b0w-red-final-import-corrected-56a264ce/selection.json"))).selected;
 for(const [name,config,mapped,entries] of [
  ["source-mapped","tsconfig.json",true,[...changed,...selection]],
  ["browser-native","packages/storage-browser/tsconfig.json",false],
  ["node-native","packages/storage-node/tsconfig.json",false]
 ]) {
  const baseline=diagnostics(config,true,mapped,entries), current=diagnostics(config,false,mapped,entries);
  const added=current.filter(d=>!baseline.some(b=>JSON.stringify(d)===JSON.stringify(b)));
  save("typecheck-delta-"+name+".json",{baseline,current,added,pass:added.length===0});
  console.log(JSON.stringify({name,baseline:baseline.length,current:current.length,added:added.length}));
  if(added.length) process.exitCode=1;
 }
} else if(process.argv[2]==="source") {
 const printer=ts.createPrinter({removeComments:true});
 const publicShape=source=> {
  const parsed=ts.createSourceFile("input.ts",source,ts.ScriptTarget.Latest,true);
  return parsed.statements.filter(n=>ts.isExportDeclaration(n)||n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(n=>{
   const selected=ts.isFunctionDeclaration(n)?ts.factory.updateFunctionDeclaration(n,n.modifiers,n.asteriskToken,n.name,n.typeParameters,n.parameters,n.type,undefined):n;
   return printer.printNode(ts.EmitHint.Unspecified,selected,parsed);
  });
 };
 const shape=changed.map(path=>{const before=git("show",anchor+":"+path),after=readFileSync(resolve(root,path),"utf8");return {path,sha256:hash(after),unchangedExports:JSON.stringify(publicShape(before))===JSON.stringify(publicShape(after))};});
 const room=readFileSync(resolve(root,changed[0]),"utf8");
 const diff=git("diff",anchor,"--",...changed);
 const checks={exactPaths:JSON.stringify(git("diff","--name-only",anchor).trim().split("\n"))===JSON.stringify(changed),exportShape:shape.every(s=>s.unchangedExports),noLifetimeHold:!room.includes("await settlementHold")&&!room.includes("releaseSettlementHold"),holdBeforeFence:room.indexOf("settlementHeld = true")<room.indexOf('const sourceBySequence = new Map(sources.map'),noWireOrTimeoutChange:!/^\+.*(?:setTimeout|testTimeout|hookTimeout|protobuf)/m.test(diff),testsUnchanged:git("diff",anchor,"--","tests")===""};
 save("source-check.json",{anchor,shape,checks});
 writeFileSync(resolve(evidence,"production.diff"),diff);
 if(Object.values(checks).includes(false)) throw new Error("SOURCE_CHECK_FAILED");
} else throw new Error("Unknown mode");
