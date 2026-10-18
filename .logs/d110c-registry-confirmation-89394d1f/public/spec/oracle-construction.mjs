// Reproduce design literals independently of every workspace codec/hash helper.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const vectors = JSON.parse(readFileSync(new URL('./oracle-vectors.json', import.meta.url)));
function varuint(value) {
  const result = [];
  do {
    const low = Number(value & 127n); value >>= 7n;
    result.push(low + (value === 0n ? 0 : 128));
  } while (value !== 0n);
  return Buffer.from(result);
}
function encodedKey(value) {
  assert.match(value, /^[\x00-\x7f]*$/u);
  const bytes = Buffer.from(value, 'ascii');
  return Buffer.concat([Buffer.from([5]), varuint(BigInt(bytes.length)), bytes]);
}
function encode(value) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  const entries = Object.entries(value).map(([key, number]) => {
    assert.ok(Number.isSafeInteger(number) && number >= 0);
    return { key: encodedKey(key), value: Buffer.concat([Buffer.from([3]), varuint(BigInt(number) * 2n)]) };
  }).sort((a, b) => Buffer.compare(a.key, b.key));
  return Buffer.concat([Buffer.from([8]), varuint(BigInt(entries.length)), ...entries.flatMap(entry => [entry.key, entry.value])]);
}
function digest(bytes) {
  const domain = Buffer.from(vectors.domain, 'utf8'), domainLength = Buffer.alloc(4), partLength = Buffer.alloc(8);
  domainLength.writeUInt32BE(domain.length); partLength.writeBigUInt64BE(BigInt(bytes.length));
  return createHash('sha256').update(Buffer.concat([Buffer.from([68, 82, 80, 0]), domainLength, domain, partLength, bytes])).digest('hex');
}
for (const vector of vectors.cases) {
  const bytes = encode(vector.input);
  assert.equal(bytes.length, vector.byteLength); assert.equal(bytes.toString('hex'), vector.canonicalHex); assert.equal(digest(bytes), vector.digestHex);
}
process.stdout.write(JSON.stringify({ scope: 'independent design-literal reproduction, not project runtime verification', cases: vectors.cases.map(({ id, byteLength, digestHex }) => ({ id, byteLength, digestHex })) }) + '\n');
