import assert from "node:assert";
// Installed browser polyfill, retaining node:assert/strict comparisons for the
// unchanged warm worker fixture. This is not a protocol validation replacement.
export default Object.assign((value:unknown,message?:string)=>assert(value,message),assert,{
 equal:assert.strictEqual,notEqual:assert.notStrictEqual,deepEqual:assert.deepStrictEqual,notDeepEqual:assert.notDeepStrictEqual
});
