import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import ts from "typescript";
import {describe, expect, it} from "vitest";

const {TraceMap, originalPositionFor} = createRequire(import.meta.url)("@jridgewell/trace-mapping");

const file = new URL("./build.ts", import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
	ts.isFunctionDeclaration(node) && node.name?.text === "instrumentFullFunctionBundle");
if (declaration === undefined) throw Error("FULL_CALL_ORIGINAL_TRANSFORM_MISSING");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const instrument = new Function("ts", "TraceMap", "originalPositionFor", "hash", "Buffer",
	`${ts.transpile(declaration.getText(ast), {target: ts.ScriptTarget.ES2022})};return instrumentFullFunctionBundle;`)
	(ts, TraceMap, originalPositionFor, hash, Buffer) as (value: string, clockedOwners?: boolean, retirementScope?: boolean) => {code: string; manifest: any};
function source(code: string, path = "tests/product.js") {
	const map = {version: 3, sources: [path], sourcesContent: [code], names: [],
		mappings: code.split("\n").map((_, index) => index === 0 ? "AAAA" : "AACA").join(";")};
	return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
}
function fixture(code: string, names: string[], bindings: Record<string, unknown> = {}, active = true,
	clockedOwners = false, path = "tests/product.js", retirementScope = false) {
	const events: any[] = [];
	const global: any = {__r8FunctionWindowActive: active, __r8FunctionEnter: (id: number, parent: unknown, flags: number) => {
		const token = {id, parent, flags}; events.push(["enter", token]); return token;
	}};
	for (const kind of ["Suspend", "Resume", "Returned"])
		global[`__r8Function${kind}`] = (token: unknown, value: unknown, detail?: unknown) => {events.push([kind, token, value, detail]); return value;};
	for (const kind of ["ResumeOnError", "Thrown", "Exit"])
		global[`__r8Function${kind}`] = (...args: unknown[]) => events.push([kind, ...args]);
	const result = instrument(source(code, path), clockedOwners, retirementScope);
	const compiled = new Function("globalThis", ...Object.keys(bindings), `${result.code}\nreturn {${names.join(",")}};`)
		(global, ...Object.values(bindings));
	return {result, compiled, events, global};
}

describe("full bundle function instrumentation semantics", () => {
	it("selectively clocks original owners and callbacks inside omitted parents without clocking unrelated helpers", async () => {
		const f=fixture(`
function unrelated(v){return v+1;}
function container(){return async function authenticate(v){const local=()=>unrelated(v);await Promise.resolve();return local();};}
`,["container","unrelated"],{},true,false,"packages/node/src/internal/creator-closed-rollback-data.ts",true);
		expect(await f.compiled.container()(6)).toBe(7);expect(f.compiled.unrelated(1)).toBe(2);
		const selected=f.result.manifest.functions.filter((row:any)=>!row.scopeOmitted&&!row.excluded);
		expect(selected.map((row:any)=>row.name)).toEqual(["authenticate","local"]);
		expect(f.result.manifest.scopeOmittedFunctions).toBe(2);
		expect(f.result.manifest.vmCountOnlyFunctions).toBe(0);
		expect(f.result.manifest.coverageMode).toBe("selected-retirement-owner-wall-clocks-no-vm-count-claim");
		expect(f.events.filter(e=>e[0]==="enter").map(e=>e[1].id)).toEqual(selected.map((row:any)=>row.id));
		expect(f.events.filter(e=>e[0]==="Suspend")).toHaveLength(1);
		expect(f.global.__r8FunctionClockScope).toBe("retirement");
	});
	it("refuses a selected-clock build without an original source-bound root",()=>{
		expect(()=>instrument(source("function authenticate(){return 1;}","tests/foreign.js"),false,true)).toThrow("RETIREMENT_CLOCK_ROOTS_MISSING");
	});
	it("clocks omitted asynchronous recovery and native continuations with their callbacks, not arbitrary codec leaves",async()=>{
		const source= `async function openSource(){await Promise.resolve();return (()=>7)();} function codecLeaf(){return 2;}`;
		for(const path of ["packages/node/src/internal/creator-transition-advance.ts","packages/storage-browser/src/internal/idb-adapter.ts"]){
			const f=fixture(source,["openSource","codecLeaf"],{},true,false,path,true);
			expect(await f.compiled.openSource()).toBe(7);expect(f.compiled.codecLeaf()).toBe(2);
			expect(f.result.manifest.functions.filter((r:any)=>!r.excluded&&!r.scopeOmitted).map((r:any)=>r.name)).toHaveLength(2);
			expect(f.result.manifest.functions.find((r:any)=>r.name==="codecLeaf").scopeOmitted).toBe(true);
		}
	});
	it("keeps every function in VM coverage while explicitly making only syntax-checked hash arithmetic leaves count-only", () => {
		const code = `
function rotr(a,b){return a << (32-b) | a >>> b;}
function Chi(a,b,c){return a & b ^ ~a & c;}
function Maj(a,b,c){return a & b ^ a & c ^ b & c;}
function rotr3(a,b){return helper(a,b);}
function rotr4(a){return a.value;}
function rotr5(a){return a=2;}
async function rotr6(a){return a+1;}
function rotr7(a){throw a;}
function rotr8(a=1){return a+1;}
`;
		const f = fixture(code, ["rotr", "Chi", "Maj"], {}, true, true, "node_modules/@noble/hashes/src/utils.ts");
		expect(f.compiled.rotr(8, 1)).toBe(4); expect(f.compiled.Chi(1, 2, 3)).toBe(2);
		expect(f.result.manifest.vmCountOnlyFunctions).toBe(3);
		expect(f.result.manifest.eligibleProductFunctions).toBe(9); expect(f.result.manifest.eligibleFunctions).toBe(6);
		expect(f.result.manifest.functions.filter((row: any) => row.vmCountOnly).map((row: any) => row.name)).toEqual(["rotr", "Chi", "Maj"]);
		expect(f.result.manifest.functions.every((row: any) => row.generatedFunctionStart >= 0 && row.generatedFunctionEnd > row.generatedFunctionStart)).toBe(true);
		expect(f.events).toEqual([]);
		const full = instrument(source(code, "node_modules/@noble/hashes/src/utils.ts"));
		expect(full.manifest.vmCountOnlyFunctions).toBe(0); expect(full.manifest.eligibleFunctions).toBe(9);
		const foreign = instrument(source(code, "tests/product.js"), true);
		expect(foreign.manifest.vmCountOnlyFunctions).toBe(0);
	});
	it("skips synchronous off-window dispatches without duplicating bodies and retains dormant async/generator probes", async () => {
		const f = fixture(`
function sync(value){return value;}
function throwing(){throw failure;}
async function suspended(){await Promise.resolve(1);return 2;}
function* generator(){yield 3;}
`, ["sync", "throwing", "suspended", "generator"], {failure: Error("same")}, false);
		const value = {exact: true}; expect(f.compiled.sync(value)).toBe(value);
		expect(() => f.compiled.throwing()).toThrow("same"); expect(f.events).toEqual([]);
		expect(await f.compiled.suspended()).toBe(2); expect(f.compiled.generator().next()).toEqual({value: 3, done: false});
		expect(f.events.filter(event => event[0] === "enter").map(event => event[1].flags)).toEqual([1, 2]);
		f.global.__r8FunctionWindowActive = true;
		expect(f.compiled.sync(value)).toBe(value);
		expect(f.events.filter(event => event[0] === "enter").map(event => event[1].flags)).toEqual([1, 2, 0]);
		expect(f.result.manifest.eligibleFunctions).toBe(4);
	});
	it("extracts multi-megabyte inline maps without a recursive regexp and rejects non-map trailing content", () => {
		const code = "function largeMap(){return 7;}", padding = "x".repeat(8 * 1024 * 1024);
		const map = {version: 3, sources: ["tests/large-map.js"], sourcesContent: [code + "\n//" + padding], names: [], mappings: "AAAA"};
		const raw = `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\r\n`;
		const result = instrument(raw);
		expect(result.manifest.eligibleFunctions).toBe(1);
		expect(result.manifest.functions[0].sourceHash).toBe(hash(map.sourcesContent[0]!));
		expect(() => instrument(raw + "not-map")).toThrow("INLINE_SOURCE_MAP_REQUIRED");
	});
	it("covers declarations, expressions, arrow forms, nested/default callbacks, methods, accessors and constructors", () => {
		const f = fixture(`
function outer(a = (() => 3)()) { const nested = function named(){return a;}; return nested(); }
const object = () => ({v: 4}); const sequence = () => (1, 5);
class Base { constructor(){this.v=2;} get value(){return this.v;} set value(v){this.v=v;} }
class Derived extends Base { #x=7; constructor(){super();this.target=new.target.name;} method(){return this.#x+super.value;} static method(){return 9;} }
`, ["outer", "object", "sequence", "Derived"]);
		expect(f.compiled.outer()).toBe(3); expect(f.compiled.object()).toEqual({v: 4}); expect(f.compiled.sequence()).toBe(5);
		const d = new f.compiled.Derived(); expect(d.method()).toBe(9); d.value = 6; expect(d.value).toBe(6);
		expect(d.target).toBe("Derived"); expect(f.compiled.Derived.method()).toBe(9);
		expect(f.result.manifest.eligibleFunctions).toBe(11);
		expect(f.result.manifest.functions.every((row: any) => row.generatedFinalLine > 0)).toBe(true);
		expect(f.result.manifest.functions.some((row: any) => row.parametersPreBody.length === 1)).toBe(true);
		expect(f.global.__r8FunctionManifestSize).toBe(11);
	});
	it("preserves Promise/thenable identity, optional calls, receiver mutation, function names/arity and original this/arguments", () => {
		const shared = Promise.resolve(7), thenable = {then() {throw Error("must not inspect");}};
		const f = fixture(`
function identity(a,b){ return shared; }
function opaque(){return thenable;}
const holder={n:1, method(value){this.n+=value;return arguments[0];}};
const arrow = function(a){return (()=>[this.n,arguments[0]])();};
function optional(value){return value?.method?.(2);}
function shadows(globalThis,undefined){return;}
`, ["identity", "opaque", "holder", "arrow", "optional", "shadows"], {shared, thenable});
		expect(f.compiled.identity()).toBe(shared); expect(f.compiled.opaque()).toBe(thenable);
		expect(f.compiled.identity.name).toBe("identity"); expect(f.compiled.identity.length).toBe(2);
		expect(f.compiled.optional(f.compiled.holder)).toBe(2); expect(f.compiled.holder.n).toBe(3);
		expect(f.compiled.optional(null)).toBeUndefined(); expect(f.compiled.arrow.call({n: 8}, 4)).toEqual([8, 4]);
		expect(f.compiled.shadows({}, 8)).toBeUndefined();
	});
	it("closes rejected await gaps before original catch/finally and preserves return/throw overrides and fallthrough", async () => {
		const failure = Error("original");
		const f = fixture(`
async function rejected(){try{await Promise.reject(failure);}catch(error){return error;}finally{record('finally');}}
async function override(){try{return await Promise.resolve(1);}finally{return 2;}}
function cancelled(){label:{try{return 1;}finally{break label;}}}
async function escapes(){try{await Promise.reject(failure);}finally{record('escape-finally');}}
`, ["rejected", "override", "cancelled", "escapes"], {failure, record: () => undefined});
		expect(await f.compiled.rejected()).toBe(failure); expect(await f.compiled.override()).toBe(2);
		expect(f.compiled.cancelled()).toBeUndefined(); await expect(f.compiled.escapes()).rejects.toBe(failure);
		expect(f.events.filter(e => e[0] === "enter").map(e => e[1].flags)).toEqual([1, 1, 0, 1]);
		expect(f.events.some(e => e[0] === "Thrown" && e[2] === failure)).toBe(true);
		expect(f.events.filter(e => e[0] === "Suspend")).toHaveLength(3);
		expect(f.events.filter(e => e[0] === "Exit")).toHaveLength(4);
	});
	it("preserves generator next/throw/return, delegated iteration and async iterator closing without wrapping iterators", async () => {
		const f = fixture(`
function* values(){try{yield 1;yield* [2,3];}finally{record('closed');}}
async function collect(iterable){let sum=0;for await(const value of iterable){sum+=value;if(value===2)break;}return sum;}
async function* asyncValues(){yield await Promise.resolve(4);}
`, ["values", "collect", "asyncValues"], {record: () => undefined});
		const gen = f.compiled.values(); expect(gen.next()).toEqual({done: false, value: 1});
		expect(gen.next()).toEqual({done: false, value: 2}); expect(gen.return(9)).toEqual({done: true, value: 9});
		const thrown = Error("generator-throw"), other = f.compiled.values(); other.next(); expect(() => other.throw(thrown)).toThrow(thrown);
		let closed = 0, n = 0; const iterable = {[Symbol.asyncIterator]() {return this;},
			next: async () => ({value: ++n, done: false}), return: async () => {closed++;return {done: true};}};
		expect(await f.compiled.collect(iterable)).toBe(3); expect(closed).toBe(1);
		expect(await f.compiled.asyncValues().next()).toEqual({done: false, value: 4});
		expect(f.result.manifest.functions.flatMap((row: any) => row.yields).some((site: any) => site.delegated)).toBe(true);
		expect(f.events.some(e => e[0] === "Suspend" && e[3] === "for-await")).toBe(true);
	});
	it("explicitly audits observer exclusions, preserves labelled implicit awaits and refuses missing maps instead of omitting bodies", async () => {
		const excluded = instrument(source("function observer(){return ()=>1;}", "tests/fixtures/startup-discovery/critical-observer.ts"));
		expect(excluded.manifest.eligibleFunctions).toBe(0); expect(excluded.manifest.excludedObserverFunctions).toBe(2);
		expect(() => instrument("function f(){};")).toThrow("INLINE_SOURCE_MAP_REQUIRED");
		const f = fixture("async function f(xs){let n=0;outer:inner:for await(const x of xs){n+=x;if(x===1)continue outer;break inner;}return n;}", ["f"]);
		expect(await f.compiled.f([1, 2, 3])).toBe(3);
	});
});
