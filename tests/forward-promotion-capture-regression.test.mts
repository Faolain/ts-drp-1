import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePromotionBytes, promotionByteLength } from '@ts-drp/protocol-v3/internal/creator-forward-promotion';
import { openCreatorForwardPromotion } from '../packages/node/src/internal/creator-transition-advance.js';
import { createCreatorClosedRollbackProofAccounting } from '../packages/node/src/internal/creator-closed-rollback-data.js';
import { makeChain } from './fixtures/forward-promotion/reference.mjs';
import { makePromotion } from './fixtures/forward-promotion/promotion.mjs';

for (const [brand, carrier] of [
  ['Uint8ClampedArray', new Uint8ClampedArray([1, 2])],
  ['Uint16Array', new Uint16Array([257, 258])],
] as const) test(`capture refuses re-prototyped ${brand} before charge or element conversion`, () => {
  Object.setPrototypeOf(carrier, Uint8Array.prototype);
  let charges = 0;
  const captured = capturePromotionBytes(carrier, 65_536, () => { charges++; return true; });
  assert.equal(charges, 0, 'foreign element brand must refuse before charging');
  assert.equal(captured, undefined, 'foreign elements must not be converted into supplied-byte authority');
  assert.equal(promotionByteLength(carrier, 65_536), undefined);
});

test('bounded byte capture does not enumerate a per-index property roster', () => {
  const source = new Uint8Array(262_144);
  source[0] = 7; source[source.length - 1] = 11;
  const ownKeys = Reflect.ownKeys;
  let indexedRosters = 0;
  let copied: Uint8Array | undefined;
  // Isolated unit mechanism instrumentation, not heap/crash/native telemetry.
  Reflect.ownKeys = target => { if (target === source) indexedRosters++; return ownKeys(target); };
  try { copied = capturePromotionBytes(source, 268_435_456); }
  finally { Reflect.ownKeys = ownKeys; }
  assert.equal(Reflect.ownKeys, ownKeys, 'instrumentation restored before assertions');
  assert.equal(indexedRosters, 0, 'capture must not materialize one key per payload byte');
  assert(copied); assert.notEqual(copied.buffer, source.buffer);
  assert.equal(copied.length, 262_144); assert.equal(copied[0], 7); assert.equal(copied.at(-1), 11);
});

test('genuine full-span capture detaches exact bytes and never invokes caller shadows during accounting', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  let getters = 0;
  const shadow = () => { getters++; throw new Error('caller byte shadow invoked'); };
  for (const key of ['byteLength', 'byteOffset', 'buffer', 'length', Symbol.toStringTag, Symbol.iterator])
    Object.defineProperty(source, key, { get: shadow });
  const accounting = createCreatorClosedRollbackProofAccounting([]);
  let charges = 0;
  const captured = capturePromotionBytes(source, 65_536, bytes => {
    charges++;
    assert.notEqual(bytes, source, 'accounting receives sanitized intrinsic bytes');
    assert.equal(bytes.byteLength, 4);
    return accounting.charge(bytes);
  });
  assert.equal(getters, 0); assert.equal(charges, 1); assert(captured);
  assert.deepEqual(Array.from(captured), [1, 2, 3, 4]); assert.equal(accounting.chargedBytes, 4);
  source[0] = 99; assert.equal(captured[0], 1);
  assert(accounting.charge(captured)); assert.equal(accounting.chargedBytes, 4);
});

test('intrinsic capture keeps full-span and backing exclusions', () => {
  assert.equal(capturePromotionBytes(new Uint8Array(new ArrayBuffer(4), 1, 3), 4), undefined);
  assert.equal(capturePromotionBytes(new Uint8Array(new ArrayBuffer(4), 0, 3), 4), undefined);
  assert.equal(capturePromotionBytes(new Uint8Array(new SharedArrayBuffer(4)), 4), undefined);
  const detached = new Uint8Array(4);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.equal(capturePromotionBytes(detached, 4), undefined);
  const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
  if (resizable.resizable) assert.equal(capturePromotionBytes(new Uint8Array(resizable), 4), undefined);
  class Foreign extends Uint8Array {}
  assert.equal(capturePromotionBytes(new Foreign(4), 4), undefined);
});

test('genuine Node promotion refuses a foreign-brand current ACL with genuine canonical contents', async () => {
  const fixture = makePromotion(await makeChain('settlement'), 1);
  assert(openCreatorForwardPromotion(fixture.input).ok, 'genuine baseline reaches authenticated opener');
  const foreignAcl = Uint8ClampedArray.from(fixture.input.currentAclBytes);
  Object.setPrototypeOf(foreignAcl, Uint8Array.prototype);
  const result = openCreatorForwardPromotion({ ...fixture.input, currentAclBytes: foreignAcl });
  assert.equal(result.ok, false, 'genuine ACL contents cannot authorize a foreign byte-carrier brand');
  assert.equal('promotion' in result, false);
}, { timeout: 90_000 });
