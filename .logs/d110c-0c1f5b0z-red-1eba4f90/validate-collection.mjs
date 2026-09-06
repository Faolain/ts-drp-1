import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=path.dirname(new URL(import.meta.url).pathname);
const matrix=JSON.parse(fs.readFileSync(path.join(out,'matrix.json'),'utf8'));
const selected=JSON.parse(fs.readFileSync(path.join(out,'isolated-collection/stdout'),'utf8'));
assert.equal(selected.length,16);
assert.deepEqual(selected.map(row=>({file:path.relative(process.cwd(),row.file),name:row.name.replaceAll(' > ',' ')})),matrix.entries.map(({file,name})=>({file,name})));
console.log(JSON.stringify({isolatedCollection:16,exactFrozenRoster:true,runtimeTestsExecuted:0}));
