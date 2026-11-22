import fs from 'node:fs';
import path from 'node:path';
const out = path.dirname(new URL(import.meta.url).pathname);
const corrected = fs.readFileSync(path.join(out, 'equivalence.mjs'), 'utf8');
const restriction = " && (text.startsWith('expect(') || text.startsWith('expect.soft('))";
if (!corrected.includes(restriction)) throw Error('Exact one-line verifier correction missing');
fs.writeFileSync(path.join(out, 'equivalence-correction-one-failed.mjs'), corrected, { flag: 'wx' });
fs.writeFileSync(path.join(out, 'equivalence-initial-failed.mjs'), corrected.replace(restriction, ''), { flag: 'wx' });
console.log(JSON.stringify({ correctionOneSnapshot: true, initialVersionRestoredFromExactSingleClauseReversal: true, noSourceChange: true }));
