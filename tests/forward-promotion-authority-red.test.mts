import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeCanonical } from '@ts-drp/canonical';
import * as protocol from '@ts-drp/protocol-v3/creator-close';
import * as seal from '@ts-drp/protocol-v3/seal';
import { openCreatorCheckpointTrust } from '@ts-drp/protocol-v3/creator-checkpoint';
import { CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL } from '@ts-drp/protocol-v3/creator-author-issuance-frontiers';
import { signSealRegisteredDigest, signCreatorAnchorRequest, createRecoverableFinalitySigner } from '@ts-drp/keychain/finality';
import { AHE_BOUNDED_READ_LIMITS } from '@ts-drp/storage';
import * as transition from '../packages/node/src/internal/creator-transition-advance.js';
import { createCreatorClosedRollbackProofAccounting } from '../packages/node/src/internal/creator-closed-rollback-data.js';
import { validateCreatorSnapshotData, creatorSnapshotProjectionMatches } from '../packages/node/src/internal/creator-snapshot-data.js';
import { makeChain, record, candidate, closure, signControl, author, removedAuthor, acl, digest, seed, unhex, type Chain, type Representation, closeResult } from './fixtures/forward-promotion/reference.mjs';
import { makePromotion, source, replaceCandidate, corrupt, actualUnion, proofBytes, type PromotionFixture, type Edits } from './fixtures/forward-promotion/promotion.mjs';

const forms: Representation[] = ['settlement', 'aggregate-retirement', 'retirement-only'];
const chains = new Map<Representation, Chain>();
let wideFixture: PromotionFixture;
before(async () => { for (const form of forms) chains.set(form, await makeChain(form)); wideFixture = makePromotion(await makeChain('settlement', false, 108), 1); }, { timeout: 90_000 });
const chain = (form: Representation = 'settlement'): Chain => chains.get(form)!;
const fixture = (form: Representation = 'settlement', epoch: 1 | 2 = 1, edits: Edits = {}): PromotionFixture => makePromotion(chain(form), epoch, edits);
type Result = { ok: boolean; reason?: string; promotion?: object; preparation?: object; trust?: object; exactCanonicalCutValueBytes?: Uint8Array;
  exactCanonicalAnchorPreimageBytes?: Uint8Array; exactCanonicalTrustStateRecordBytes?: Uint8Array; signingRequest?: unknown; valueDigest?: string; anchorDigest?: string };
function api(owner: object, name: string): (input: unknown) => Result {
  const fn = (owner as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `WIRING_RED:${name}; fixture/QC/old-controls reached, later behavioral assertions UNREACHED`);
  return fn as (input: unknown) => Result;
}
function open(f: PromotionFixture, input: unknown = f.input): Result { return api(transition, 'openCreatorForwardPromotion')(input); }
function refusal(f: PromotionFixture, input: unknown = f.input): void {
  const r = open(f, input); assert.equal(r.ok, false); assert.equal(r.promotion, undefined); assert.equal(r.trust, undefined);
}
function resolve(value: unknown): Record<string, unknown> | undefined {
  return api(transition, 'resolveCreatorForwardPromotion')(value) as unknown as Record<string, unknown> | undefined;
}
function accepted(f: PromotionFixture, input: unknown = f.input): object {
  const r = open(f, input); assert.equal(r.ok, true, r.reason); assert(r.promotion);
  assert.deepEqual(Reflect.ownKeys(r.promotion), []); assert(Object.isFrozen(r.promotion));
  const identity = resolve(r.promotion); assert(identity);
  assert.equal(identity.objectId, f.input.currentTrust.objectId); assert.equal(identity.genesisAnchorDigest, f.chain.pin);
  assert.equal(identity.currentEpoch, 3); assert.equal(identity.currentAnchorDigest, f.input.currentTrust.currentAnchorDigest);
  assert.equal(identity.successorEpoch, 4); assert.equal(identity.successorAnchorDigest, f.anchorDigest);
  const historical = identity.source as Record<string, unknown>;
  assert.equal(historical.closedEpoch, f.historical.currentTrust.currentEpoch); assert.equal(historical.stateDigest, f.forwardPromotion.source.stateDigest);
  assert.equal(historical.manifestRef && (historical.manifestRef as { digest: string }).digest, f.forwardPromotion.source.manifestRef.digest);
  assert.deepEqual(identity.roles, f.forwardPromotion.roles);
  assert(!JSON.stringify(identity).includes('exactCanonical'));
  return r.promotion;
}

test('G1 reference prerequisite: genuine two profiles/three forms and both sources; no promotion export required', () => {
  for (const form of forms) for (const e of [1, 2] as const) {
    const f = fixture(form, e);
    const q = seal.verifySealQC({ authority: f.authority, exactCanonicalQcBytes: f.qc.bytes }); assert(q.ok); assert.equal(q.valueDigest, f.valueDigest);
    const c = record(f.cut.bytes), a = record(f.anchorBytes), old = record(f.historical.cut.bytes);
    assert.notEqual(c.stateDigest, old.stateDigest); assert.equal(a.stateDigest, old.stateDigest);
    assert.equal(c.stateDigest, f.current.closeInput.stateDigest); assert.equal(c.snapshotManifestDigest, f.current.closeInput.snapshotManifestDigest);
    assert.equal(a.historyRoot, c.historyRoot); assert.equal(a.historySize, 4); assert.equal(c.closeSetCount, 1);
    assert.equal(a.previousAnchor, f.input.currentTrust.currentAnchorDigest); assert.equal(a.epoch, 4); assert.equal(a.aclDigest, c.aclDigest);
    assert.deepEqual(encodeCanonical(record(f.cut.bytes)), f.cut.bytes);
    assert(validateCreatorSnapshotData(f.historical.snapshot.exactCanonicalPayloadBytes, f.historical.snapshot.exactCanonicalManifestBytes, old, f.chain.profileId));
    assert.notEqual(f.forwardPromotion.source.manifestRef.digest, candidate(f.historical.snapshot.exactCanonicalManifestBytes).ref.digest);
    for (const s of [chain(form).steps[1]!, chain(form).steps[2]!]) {
      const material = closure([s.successorRecord, s.cut, s.qc, s.closedAcl, ...s.controls]);
      assert(transition.openCreatorTransitionClosedCutEvidence({ closure: material, floorTrust: s.successorTrust, currentTrust: s.currentTrust }));
    }
    console.log(JSON.stringify({ milestone: 'GENUINE_REFERENCE', form, source: e, qcVerified: true, oldControlsVerified: true, controlUnionBytes: actualUnion(proofBytes(f)) }));
  }
});
for (const form of forms) for (const e of [1, 2] as const)
  test(`G1 whole pure opening ${form} C${e} to operational N4`, { timeout: 90_000 }, () => { accepted(fixture(form, e)); });

test('G2 genuine governed promotion signing branch is distinct and whole-Cut-bound', async () => {
  const f = fixture(), signer = await createRecoverableFinalitySigner({ seed: Uint8Array.from(seed) });
  const prepared = api(protocol, 'prepareCreatorForwardPromotion')(f.preparationInput); assert(prepared.ok, prepared.reason); assert(prepared.promotion);
  assert.deepEqual(prepared.exactCanonicalCutValueBytes, f.cut.bytes); assert.equal(prepared.valueDigest, f.valueDigest);
  assert.equal(protocol.prepareCreatorSuccessor({ authority: f.authority, close: prepared.promotion, exactCanonicalCommitQcBytes: f.qc.bytes }).ok, false);
  const authority = closeResult(seal.openSealAuthority({ trust: f.input.currentTrust, signerPublicKey: signer.publicKey }), 'promotion authority').authority;
  for (const phase of ['prepare', 'commit'] as const) {
    const vote = seal.prepareSealVote({ authority, exactCanonicalCutValueBytes: f.cut.bytes, phase, round: 0 }); assert(vote.ok, vote.ok ? undefined : vote.reason);
    const signature = await signSealRegisteredDigest({ signer: signer.signer, request: vote.signingRequest });
    assert(ed25519.verify(signature, vote.registeredDigest, signer.publicKey, { zip215: false }));
    const { signedQc } = await import('./fixtures/forward-promotion/reference.mjs');
    const q = signedQc(f.cut.bytes, phase); assert(seal.verifySealQC({ authority, exactCanonicalQcBytes: q }).ok);
  }
  const next = api(protocol, 'prepareCreatorForwardPromotionSuccessor')({ authority, promotion: prepared.promotion, exactCanonicalCommitQcBytes: f.qc.bytes });
  assert(next.ok, next.reason); assert(next.preparation); assert.deepEqual(next.exactCanonicalAnchorPreimageBytes, f.anchorBytes);
  const signature = await signCreatorAnchorRequest({ signer: signer.signer, request: next.signingRequest as Parameters<typeof signCreatorAnchorRequest>[0]['request'] });
  const completed = api(protocol, 'completeCreatorForwardPromotionSuccessor')({ preparation: next.preparation, detachedSignature: signature });
  assert(completed.ok); assert.deepEqual(completed.exactCanonicalTrustStateRecordBytes, f.nextRecord.bytes);
  const explicit = api(protocol, 'openCreatorForwardPromotionSuccessorTrust')({ currentTrust: f.input.currentTrust, exactCanonicalCommitQcBytes: f.qc.bytes,
    exactCanonicalCutValueBytes: f.cut.bytes, exactCanonicalTrustStateRecordBytes: f.nextRecord.bytes }); assert(explicit.ok); assert(explicit.trust);
  assert.equal(protocol.openCreatorSuccessorTrust({ currentTrust: f.input.currentTrust, exactCanonicalCommitQcBytes: f.qc.bytes,
    exactCanonicalCutValueBytes: f.cut.bytes, exactCanonicalTrustStateRecordBytes: f.nextRecord.bytes }).ok, false);
  assert.equal(api(protocol, 'completeCreatorForwardPromotionSuccessor')({ preparation: next.preparation, detachedSignature: signature }).ok, false);
  await assert.rejects(signCreatorAnchorRequest({ signer: signer.signer, request: next.signingRequest as Parameters<typeof signCreatorAnchorRequest>[0]['request'] }));
  assert.equal(api(protocol, 'prepareCreatorForwardPromotionSuccessor')({ authority, promotion: prepared.promotion, exactCanonicalCommitQcBytes: f.current.qc.bytes }).ok, false);
  assert.equal(api(protocol, 'prepareCreatorForwardPromotion')({ ...f.preparationInput, targetEpoch: 1 }).ok, false);
  assert.equal(protocol.prepareCreatorClose(f.preparationInput).ok, false);
});
for (const [name, edits] of [
  ['selected source cut alias', { roles: { selectedSourceCutDigest: 'f'.repeat(64) } }],
  ['omit authenticated retained source', { roles: { retainedSources: [] } }],
  ['old controls as current roster', { roles: { currentControlRefs: [] } }],
  ['authorize another ACL digest', { promotion: { authorizedSuccessorAclDigest: 'f'.repeat(64) } }],
  ['signed wrong effective state', { anchor: { stateDigest: 'f'.repeat(64) } }],
  ['signed old history substitution', { anchor: { historySize: 2 } }],
  ['source state substitution', { source: { stateDigest: 'e'.repeat(64) } }],
  ['signed blueprint substitution', { anchor: { blueprintDigest: 'f'.repeat(64) } }],
  ['signed archive policy substitution', { anchor: { archiveIndexRoot: 'f'.repeat(64) } }],
  ['signed profile substitution', { anchor: { profileDigest: 'f'.repeat(64) } }],
] as const) test(`G2 fresh genuine QC/signature cannot grant ${name}`, () => {
  const changed: Edits = name === 'old controls as current roster'
    ? { roles: { currentControlRefs: chain().steps[1]!.controls.map(c => [String(record(c.bytes).kind), c.ref]) } } : edits;
  refusal(fixture('settlement', 1, changed));
});
test('G2 old ordinary QC and altered anchor signature cannot authorize promotion', () => {
  const f = fixture(); refusal(f, { ...f.input, proposed: replaceCandidate(f.input.proposed, f.qc, f.current.qc) });
  const r = record(f.nextRecord.bytes), replacement = candidate(encodeCanonical({ ...r, detachedCurrentAnchorSignature: corrupt(r.detachedCurrentAnchorSignature as Uint8Array) }));
  refusal(f, { ...f.input, proposed: replaceCandidate(f.input.proposed, f.nextRecord, replacement) });
  refusal(f, { ...f.input, administratorSignature: new Uint8Array(64), selectedSourceEpoch: 1 });
});
test('G2 old QC is genuinely valid but commits the ordinary value, not the new decision (no promotion API)', () => {
  const f = fixture(), old = seal.verifySealQC({ authority: f.authority, exactCanonicalQcBytes: f.current.qc.bytes });
  assert(old.ok); assert.notEqual(old.valueDigest, f.valueDigest);
  const changed = record(f.qc.bytes), votes = changed.votes as Record<string, unknown>[];
  const invalid = encodeCanonical({ ...changed, votes: [{ ...votes[0], signature: '0'.repeat(128) }] });
  assert.equal(seal.verifySealQC({ authority: f.authority, exactCanonicalQcBytes: invalid }).ok, false);
});

for (const [name, edits] of [
  ['closed historical ACL digest', { source: { closedAclDigest: 'e'.repeat(64) } }],
  ['embedded historical successor ACL digest', { source: { snapshotAclDigest: 'e'.repeat(64) } }],
  ['nonadjacent source epoch', { source: { closedEpoch: 0 } }],
  ['source signed successor identity', { source: { successorAnchorDigest: 'f'.repeat(64) } }],
] as const) test(`G3 reference-signed refusal ${name}`, () => { refusal(fixture('settlement', 1, edits)); });
for (const name of ['manifest domain', 'manifest length', 'QC length', 'Cut length'] as const) test(`G3 exact single reference killer: ${name}`, () => {
  const baseline = fixture(), s = baseline.forwardPromotion.source;
  const changed = name === 'manifest domain' ? { manifestRef: candidate(baseline.historical.snapshot.exactCanonicalManifestBytes).ref }
    : name === 'manifest length' ? { manifestRef: { ...s.manifestRef, byteLength: s.manifestRef.byteLength + 1 } }
      : name === 'QC length' ? { commitQcRef: { ...s.commitQcRef, byteLength: s.commitQcRef.byteLength + 1 } }
        : { cutRef: { ...s.cutRef, byteLength: s.cutRef.byteLength + 1 } };
  refusal(fixture('settlement', 1, { source: changed }));
});
test('G3 genuine same-pin signed fork cannot replace the adjacent predecessor source', async () => {
  const fork = await makeChain('settlement', true), s = fork.steps[1]!, f = fixture('settlement', 1, { source: source(fork, s) });
  assert.equal(fork.pin, f.chain.pin); assert.notEqual(s.successorTrust.currentAnchorDigest, f.historical.successorTrust.currentAnchorDigest);
  const predecessor = closure([s.successorRecord, s.cut, s.qc, s.closedAcl, fork.steps[2]!.closedAcl, ...s.controls]);
  const historicalSnapshots = f.input.historicalSnapshots.map(h => h.closedEpoch === 1 ? { closedEpoch: 1, ...s.snapshot, originalAnchorEnvelope: null } : h);
  refusal(f, { ...f.input, predecessor, historicalSnapshots });
});
test('G3 pin, floor/pending, actual snapshot scope/bytes and retirement anchor bind independently', () => {
  const f = fixture();
  refusal(f, { ...f.input, currentTrust: { ...f.input.currentTrust } });
  refusal(f, { ...f.input, exactCanonicalPinnedGenesisTrustStateRecordBytes: chain('aggregate-retirement').genesis.bytes });
  refusal(f, { ...f.input, expectedRoomHeadState: { ...f.input.expectedRoomHeadState, stable: { ...f.input.expectedRoomHeadState.stable, epoch: 2 } } });
  refusal(f, { ...f.input, expectedRoomHeadState: { ...f.input.expectedRoomHeadState, pending: { previous: f.input.expectedRoomHeadState.stable, next: { ...f.input.expectedRoomHeadState.stable, epoch: 4, currentAnchorDigest: f.anchorDigest } } } });
  const snapshots = f.input.historicalSnapshots.map(s => s.closedEpoch === 1 ? { ...s, exactCanonicalPayloadBytes: corrupt(s.exactCanonicalPayloadBytes) } : s);
  refusal(f, { ...f.input, historicalSnapshots: snapshots });
  refusal(f, { ...f.input, historicalSnapshots: f.input.historicalSnapshots.map(s => s.closedEpoch === 1 ? { ...s, ...chain().steps[2]!.snapshot } : s) });
  refusal(f, { ...f.input, predecessor: f.input.current });
  const retired = fixture('retirement-only');
  refusal(retired, { ...retired.input, historicalSnapshots: retired.input.historicalSnapshots.map(s => ({ ...s, originalAnchorEnvelope: null })) });
  refusal(retired, { ...retired.input, historicalSnapshots: retired.input.historicalSnapshots.map(s => ({ ...s, originalAnchorEnvelope: retired.input.historicalSnapshots[0]!.originalAnchorEnvelope })) });
});
test('G3 repaired old ACL occurrence/source digest cannot overrule the genuine old signed control', () => {
  const old = chain().steps[1]!.closedAcl, changed = candidate(acl(1, false, true));
  const f = fixture('settlement', 1, { source: { closedAclDigest: digest('ts-drp/latched-acl/v3', changed.bytes) } });
  refusal(f, { ...f.input, predecessor: replaceCandidate(f.input.predecessor, old, changed) });
});

test('G4 current-derived ACL/new admission control prerequisite (no promotion API)', () => {
  const prior = chain().steps[2]!.controls[0]!;
  const advance = { currentAcl: JSON.parse(JSON.stringify(record(acl(3, false, true)))), successorAcl: JSON.parse(JSON.stringify(record(acl(4, true, true)))),
    predecessor: { candidateDigest: prior.ref.digest, closedEpoch: 2, successorEpoch: 3, frontiers: [[author, 0, 2]] },
    proposed: { closedEpoch: 3, successorEpoch: 4, priorCheckpointKind: 'settled-v1', priorCheckpointDigest: prior.ref.digest,
      frontiers: [author, removedAuthor].sort().map(a => a === author ? [a, 0, 3] : [a, 4, null]) } };
  assert.deepEqual(transition.inspectCreatorAuthorSettlementAdvance(advance), { ok: true });
  for (const frontiers of [advance.proposed.frontiers.map(t => t[0] === author ? [author, 0, 1] : t), advance.proposed.frontiers.map(t => t[0] === author ? [author, 4, null] : t), [author, removedAuthor].sort().map(a => [a, 0, 3])])
    assert.equal(transition.inspectCreatorAuthorSettlementAdvance({ ...advance, proposed: { ...advance.proposed, frontiers } }).ok, false);
});
test('G4 current-derived terminal/frontier/prior-control law, not historical replay', () => {
  const f = fixture(), prior = record(chain().steps[2]!.controls[0]!.bytes);
  assert.deepEqual(f.forwardPromotion.roles.frontiers, [[author, 0, 3]]); assert.deepEqual(prior.frontiers, [[author, 0, 2]]);
  assert.equal((record(f.controls[0]!.bytes)).priorCheckpointDigest, chain().steps[2]!.controls[0]!.ref.digest);
  accepted(f);
  refusal(fixture('settlement', 1, { roles: { frontiers: [[author, 0, 1]] } }));
  refusal(fixture('settlement', 1, { roles: { frontiers: [[author, 4, null]] } }));
  refusal(fixture('settlement', 1, { control: { priorCheckpointDigest: chain().steps[1]!.controls[0]!.ref.digest } }));
  refusal(fixture('aggregate-retirement', 1, { roles: { frontiers: [[author, 1]] } }));
  refusal(fixture('aggregate-retirement', 1, { control: { priorRetirementCandidateDigest: chain('aggregate-retirement').steps[1]!.controls[0]!.ref.digest } }));
  const currentAcl = JSON.parse(JSON.stringify(record(acl(3, false, true)))), successorAcl = JSON.parse(JSON.stringify(record(acl(4, true, true))));
  const advance = { currentAcl, successorAcl, predecessor: { candidateDigest: chain().steps[2]!.controls[0]!.ref.digest, closedEpoch: 2, successorEpoch: 3, frontiers: [[author, 0, 2]] },
    proposed: { closedEpoch: 3, successorEpoch: 4, priorCheckpointKind: 'settled-v1', priorCheckpointDigest: chain().steps[2]!.controls[0]!.ref.digest,
      frontiers: [author, removedAuthor].sort().map(a => a === author ? [a, 0, 3] : [a, 4, null]) } };
  assert.deepEqual(transition.inspectCreatorAuthorSettlementAdvance(advance), { ok: true });
  assert.equal(transition.inspectCreatorAuthorSettlementAdvance({ ...advance, proposed: { ...advance.proposed, frontiers: [author, removedAuthor].sort().map(a => [a, 0, 3]) } }).ok, false);
  // The decision does not expose install, issuance, terminal plans or replacement-work custody.
  const decision = accepted(f); assert.equal((decision as Record<string, unknown>).install, undefined); assert.equal((decision as Record<string, unknown>).issuanceStore, undefined);
});
test('G4 reintroduced grant receives N4 admission, never its historical admission', () => {
  const vector = [author, removedAuthor].sort().map(a => a === author ? [a, 0, 3] : [a, 4, null]);
  const good = fixture('settlement', 1, { authorizedAcl: acl(4, true, true), roles: { frontiers: vector } });
  const bad = fixture('settlement', 1, { authorizedAcl: acl(4, true, true), roles: { frontiers: [author, removedAuthor].sort().map(a => [a, 0, 3]) } });
  assert(validateCreatorSnapshotData(good.input.currentCloseSnapshot.exactCanonicalPayloadBytes, good.input.currentCloseSnapshot.exactCanonicalManifestBytes, record(good.cut.bytes), good.chain.profileId));
  accepted(good); refusal(bad);
});

function aggregateOutputMutants(current: PromotionFixture['input']['current'], proposed: PromotionFixture['input']['proposed']) {
  const kind = 'drp-creator-author-issuance-frontiers-state';
  const existing = current.candidates.filter(c => record(c.bytes).kind === kind);
  const outputs = proposed.candidates.filter(c => record(c.bytes).kind === kind);
  assert.equal(existing.length, 1); assert.equal(outputs.length, 1);
  const aggregate = outputs[0]!, original = record(aggregate.bytes);
  assert.equal(original.priorAggregateCandidateDigest, existing[0]!.ref.digest);
  const reset = candidate(signControl({ ...original, priorAggregateCandidateDigest: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL }));
  const { detachedCreatorSignature: _oldSignature, ...oldUnsigned } = original;
  const { detachedCreatorSignature: _newSignature, ...newUnsigned } = record(reset.bytes);
  assert.deepEqual(encodeCanonical(newUnsigned), encodeCanonical({ ...oldUnsigned, priorAggregateCandidateDigest: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL }));
  const missing = closure(proposed.candidates.filter(c => c.ref.digest !== aggregate.ref.digest));
  const sentinel = replaceCandidate(proposed, aggregate, reset);
  for (const c of proposed.candidates.filter(c => c !== aggregate)) {
    assert(missing.candidates.includes(c)); assert(sentinel.candidates.includes(c));
  }
  return { missing, sentinel, reset };
}
test('G4 aggregate continuity mutant construction and ordinary controls (no promotion API)', () => {
  const f = fixture('aggregate-retirement'), s = f.current;
  const proposed = closure([s.successorRecord, s.cut, s.qc, s.closedAcl, ...s.controls]);
  const changed = aggregateOutputMutants(f.input.current, proposed);
  const inspect = (p: typeof proposed) => transition.inspectCreatorTransitionAdvance({ current: f.input.current, currentTrust: s.currentTrust, proposed: p,
    successorTrust: s.successorTrust, proofRefs: [s.cut.ref, s.qc.ref], mode: 'verify' });
  assert(inspect(proposed).ok);
  assert(transition.openCreatorTransitionAggregate(changed.reset, s.successorTrust, s.cut, s.qc, { trust: s.currentTrust }));
  assert.equal(inspect(changed.missing).ok, false); assert.equal(inspect(changed.sentinel).ok, false);
  const first = fixture('retirement-only'), initial = first.controls.filter(c => record(c.bytes).kind === 'drp-creator-author-issuance-frontiers-state');
  assert.equal(first.input.current.candidates.filter(c => record(c.bytes).kind === 'drp-creator-author-issuance-frontiers-state').length, 0);
  assert.equal(initial.length, 1); assert.equal(record(initial[0]!.bytes).priorAggregateCandidateDigest, CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL);
  aggregateOutputMutants(f.input.current, f.input.proposed);
});
test('G4 legacy forward output requires its proposed aggregate', () => {
  const f = fixture('aggregate-retirement'), changed = aggregateOutputMutants(f.input.current, f.input.proposed);
  refusal(f, { ...f.input, proposed: changed.missing });
});
test('G4 legacy forward output cannot reset an existing aggregate to genesis', () => {
  const f = fixture('aggregate-retirement'), changed = aggregateOutputMutants(f.input.current, f.input.proposed);
  refusal(f, { ...f.input, proposed: changed.sentinel });
});

function forbiddenAclCarriers(f: PromotionFixture): Uint8Array[] {
  const genuine = f.input.currentAclBytes;
  const shared = new Uint8Array(new SharedArrayBuffer(genuine.length)); shared.set(genuine);
  const offset = new Uint8Array(genuine.length + 1).subarray(1); offset.set(genuine);
  const carriers = [Buffer.from(genuine), shared, offset];
  for (const bytes of carriers) {
    assert.deepEqual(Uint8Array.from(bytes), genuine);
    assert.equal(digest('ts-drp/latched-acl/v3', bytes), digest('ts-drp/latched-acl/v3', genuine));
  }
  assert.equal(shared.byteOffset, 0); assert.equal(shared.byteLength, shared.buffer.byteLength);
  assert.equal(offset.byteOffset, 1);
  return carriers;
}
test('G5 forbidden carrier construction preserves genuine canonical ACL contents (no promotion API)', () => {
  const f = fixture();
  for (const bytes of forbiddenAclCarriers(f)) assert.deepEqual(record(bytes), record(f.input.currentAclBytes));
});

test('G5 intrinsic records/carriers are fail-closed before accessors, decoding or allocation', () => {
  const f = fixture(), carriers = forbiddenAclCarriers(f); let gets = 0;
  const getter = { ...f.input }; Object.defineProperty(getter, 'currentAclBytes', { enumerable: true, get() { gets++; throw new Error('must not execute'); } });
  refusal(f, getter); assert.equal(gets, 0);
  refusal(f, Object.assign(Object.create({}), f.input)); refusal(f, { ...f.input, [Symbol('extra')]: 1 }); refusal(f, { ...f.input, extra: true });
  const hidden = { ...f.input }; Object.defineProperty(hidden, 'currentAclBytes', { enumerable: false, value: f.input.currentAclBytes }); refusal(f, hidden);
  for (const bytes of [...carriers, new Uint8Array(65537)])
    refusal(f, { ...f.input, currentAclBytes: bytes });
  let reads = 0; const shadow = Uint8Array.from(f.input.currentAclBytes); Object.defineProperty(shadow, 'byteLength', { get() { reads++; return 0; } });
  // Intrinsics must not invoke the caller's shadow getter (acceptance or strict extra rejection is legal).
  const result = open(f, { ...f.input, currentAclBytes: shadow }); assert.equal(reads, 0); assert.equal(typeof result.ok, 'boolean');
  refusal(f, { ...f.input, currentAclBytes: new Uint8Array([...f.input.currentAclBytes, 0]) });
  let deep: unknown = 0; for (let i = 0; i < 100; i++) deep = [deep];
  refusal(f, { ...f.input, currentAclBytes: encodeCanonical(deep) });
  refusal(fixture('settlement', 1, { promotion: { extra: true } }));
  refusal(fixture('settlement', 1, { roles: { frontiers: Array.from({ length: 257 }, () => [author, 0, 3]) } }));
  assert.equal(resolve({}), undefined); assert.equal(resolve(JSON.parse('{}')), undefined);
  const decision = accepted(f); assert.equal(resolve({ ...decision }), undefined);
  accepted(f, Object.assign(Object.create(null), f.input));
  refusal(f, { ...f.input, currentCloseSnapshot: { ...f.input.currentCloseSnapshot, extra: true } });
  refusal(f, { ...f.input, currentCloseSnapshot: { ...f.input.currentCloseSnapshot, exactCanonicalManifestBytes: new Uint8Array(212388) } });
  refusal(f, { ...f.input, proposed: replaceCandidate(f.input.proposed, f.cut, candidate(new Uint8Array([...f.cut.bytes, 0]))) });
  refusal(fixture('settlement', 1, { promotion: { padding: new Uint8Array(65536) } }));
});
function boundaryFixture() {
  const wide = wideFixture, base = actualUnion(proofBytes(wide));
  const currentPadding = candidate(new Uint8Array(65536).fill(0x81));
  const oldLength = 262144 - base - currentPadding.bytes.length; assert(oldLength > 0 && oldLength < 65536);
  const oldPadding = candidate(new Uint8Array(oldLength).fill(0x82));
  const add = (c: typeof wide.input.current, additions: readonly typeof oldPadding[]) => closure([...c.candidates, ...additions]);
  const boundary = { ...wide.input, current: add(wide.input.current, [currentPadding]), predecessor: add(wide.input.predecessor, [oldPadding]), proposed: add(wide.input.proposed, [currentPadding]) };
  return { wide, currentPadding, oldPadding, oldLength, boundary };
}
test('G5 genuine exact-U twin construction and inherited ordinary classification (no promotion API)', () => {
  const { wide, currentPadding, oldPadding, oldLength, boundary } = boundaryFixture();
  const ledger = createCreatorClosedRollbackProofAccounting([]);
  for (const b of proofBytes(wide).concat([currentPadding.bytes, oldPadding.bytes])) assert(ledger.charge(b));
  assert.equal(ledger.chargedBytes, 262144); assert(ledger.charge(Uint8Array.from(oldPadding.bytes)));
  assert.equal(ledger.charge(new Uint8Array(oldLength + 1).fill(0x82)), false);
  const s = wide.chain.steps[3]!, ordinaryProposed = closure([s.successorRecord, s.cut, s.qc, s.closedAcl, ...s.controls, currentPadding]);
  const ordinary = transition.inspectCreatorTransitionAdvance({ current: boundary.current, currentTrust: s.currentTrust, proposed: ordinaryProposed, successorTrust: s.successorTrust,
    proofRefs: [s.cut.ref, s.qc.ref], mode: 'verify', settlementAcl: { current: s.closedAcl.bytes, successor: wide.input.authorizedSuccessorAclBytes } }); assert(ordinary.ok, ordinary.ok ? undefined : ordinary.reason);
  console.log(JSON.stringify({ milestone: 'SAME_U_REFERENCE', exactUnion: 262144, oneByteTwin: 262145, currentRefs: 7, predecessorRefs: 7, proposedRefs: 6, maxBlob: 65536, genuineWriters: 108, ordinaryClassification: true }));
});
test('G5 one actual-equality U262144 ledger; duplicate bytes discount, unequal bytes do not', () => {
  assert.deepEqual(AHE_BOUNDED_READ_LIMITS, { maxObjectGenerations: 7, maxHeadBytes: 3326, maxGenerationBytes: 7307, maxClosureReferences: 7, maxBlobBytes: 65536, maxUnionBytes: 262144 });
  const f = fixture(), bytes = proofBytes(f), ledger = createCreatorClosedRollbackProofAccounting([]);
  for (const b of bytes) assert(ledger.charge(b)); assert.equal(ledger.chargedBytes, actualUnion(bytes));
  for (const b of bytes) assert(ledger.charge(Uint8Array.from(b))); assert.equal(ledger.chargedBytes, actualUnion(bytes));
  const fill = new Uint8Array(262144 - ledger.chargedBytes).fill(0xa6); assert(ledger.charge(fill)); assert.equal(ledger.chargedBytes, 262144);
  assert(ledger.charge(Uint8Array.from(fill))); assert(!ledger.charge(new Uint8Array([0xee]))); assert.equal(ledger.chargedBytes, 262144);
  const duplicate = candidate(new Uint8Array(60000).fill(0xab));
  const add = (c: typeof f.input.current, additions: readonly typeof duplicate[]) => closure([...c.candidates, ...additions]);
  accepted(f, { ...f.input, current: add(f.input.current, [duplicate]), predecessor: add(f.input.predecessor, [duplicate]), proposed: add(f.input.proposed, [duplicate]) });
  const { wide, currentPadding, oldPadding, oldLength, boundary } = boundaryFixture();
  const boundaryUnion = proofBytes(wide).concat([currentPadding.bytes, oldPadding.bytes]); assert.equal(actualUnion(boundaryUnion), 262144);
  assert.equal(boundary.current.closure.length, 7); assert.equal(boundary.predecessor.closure.length, 7); assert.equal(boundary.proposed.closure.length, 6);
  accepted(wide, boundary);
  const oneMore = candidate(new Uint8Array(oldLength + 1).fill(0x82));
  const over = { ...boundary, predecessor: replaceCandidate(boundary.predecessor, oldPadding, oneMore) };
  assert.equal(actualUnion(proofBytes(wide).concat([currentPadding.bytes, oneMore.bytes])), 262145); refusal(wide, over);
  const tooMany = Array.from({ length: 3 }, (_, i) => candidate(new Uint8Array([i + 90]))); refusal(f, { ...f.input, current: add(f.input.current, tooMany) });
});

test('G6 unchanged ordinary close/checkpoint/current-derived controls and old/fork/gap refusal', () => {
  for (const form of forms) {
    const c = chain(form), s = c.steps[3]!, prior = c.steps[2]!;
    const checkpoint = openCreatorCheckpointTrust({ detachedGenesisSignature: record(c.genesis.bytes).detachedCurrentAnchorSignature,
      exactCanonicalGenesisAnchorPreimageBytes: record(c.genesis.bytes).exactCanonicalCurrentAnchorPreimageBytes,
      exactCanonicalPredecessorTrustStateRecordBytes: prior.currentRecord.bytes, exactCanonicalCurrentTrustStateRecordBytes: prior.successorRecord.bytes,
      exactCanonicalCutValueBytes: prior.cut.bytes, exactCanonicalCommitQcBytes: prior.qc.bytes, expectedObjectId: s.currentTrust.objectId, pinnedGenesisAnchorDigest: c.pin,
      expectedCurrentHead: { objectId: s.currentTrust.objectId, epoch: 3, currentAnchorDigest: s.currentTrust.currentAnchorDigest } }); assert(checkpoint.ok);
    assert(!Object.hasOwn(record(s.cut.bytes), 'forwardPromotion'));
    const ordinaryInput = { currentTrust: s.currentTrust, exactCanonicalCutValueBytes: s.cut.bytes, exactCanonicalCommitQcBytes: s.qc.bytes, exactCanonicalTrustStateRecordBytes: s.successorRecord.bytes };
    assert(protocol.openCreatorSuccessorTrust(ordinaryInput).ok);
    assert.equal(protocol.openCreatorSuccessorTrust({ ...ordinaryInput, exactCanonicalCutValueBytes: prior.cut.bytes, exactCanonicalCommitQcBytes: prior.qc.bytes, exactCanonicalTrustStateRecordBytes: prior.successorRecord.bytes }).ok, false);
    const next = record(s.successorRecord.bytes), nextAnchor = record(next.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
    for (const epoch of [3, 5]) {
      const anchor = encodeCanonical({ ...nextAnchor, epoch }), anchorDigest = digest('ts-drp/epoch-anchor/v3', anchor);
      const r = encodeCanonical({ ...next, currentEpoch: epoch, currentAnchorDigest: anchorDigest, exactCanonicalCurrentAnchorPreimageBytes: anchor, detachedCurrentAnchorSignature: ed25519.sign(unhex(anchorDigest), seed) });
      assert.equal(protocol.openCreatorSuccessorTrust({ ...ordinaryInput, exactCanonicalTrustStateRecordBytes: r }).ok, false);
    }
    const current = closure([prior.successorRecord, prior.cut, prior.qc, prior.closedAcl, s.closedAcl, ...prior.controls]), proposed = closure([s.successorRecord, s.cut, s.qc, s.closedAcl, ...s.controls]);
    const advance = transition.inspectCreatorTransitionAdvance({ current, currentTrust: s.currentTrust, proposed, successorTrust: s.successorTrust, proofRefs: [s.cut.ref, s.qc.ref], mode: 'verify',
      settlementAcl: { current: s.closedAcl.bytes, successor: encodeCanonical(record(s.snapshot.exactCanonicalPayloadBytes).acl) } }); assert(advance.ok, advance.ok ? undefined : advance.reason);
  }
  const f = fixture();
  const ordinary = f.current, ordinaryAnchor = record(record(ordinary.successorRecord.bytes).exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
  const ordinaryManifest = record(ordinary.snapshot.exactCanonicalManifestBytes), ordinaryManifestDigest = String(record(ordinary.cut.bytes).snapshotManifestDigest);
  assert.equal(digest('ts-drp/snapshot-manifest/v3', ordinary.snapshot.exactCanonicalManifestBytes), ordinaryManifestDigest);
  assert.equal(digest('ts-drp/snapshot-manifest/v3', f.historical.snapshot.exactCanonicalManifestBytes), f.forwardPromotion.source.manifestRef.digest);
  const projection = { kind: 'v3-live-generation-2', version: 2, trustProfile: 'creator-only', anchorDigest: ordinary.successorTrust.currentAnchorDigest,
    epoch: ordinaryAnchor.epoch, objectId: ordinaryAnchor.objectId, blueprintDigest: ordinaryAnchor.blueprintDigest, parametersDigest: ordinaryAnchor.parametersDigest,
    profileDigest: ordinaryAnchor.profileDigest, signerSetDigest: ordinaryAnchor.signerSetDigest, aclDigest: ordinaryAnchor.aclDigest,
    historyRoot: ordinaryAnchor.historyRoot, historySize: ordinaryAnchor.historySize, archiveIndexRoot: ordinaryAnchor.archiveIndexRoot,
    snapshotManifestDigest: ordinaryManifestDigest, snapshotPayloadDigest: ordinaryManifest.payloadDigest, stateDigest: ordinaryManifest.stateDigest };
  assert(creatorSnapshotProjectionMatches(projection, ordinaryAnchor, ordinary.successorTrust.currentAnchorDigest, ordinaryManifestDigest, ordinaryManifest));
  assert.notEqual(ordinaryManifestDigest, f.forwardPromotion.source.manifestRef.digest);
  assert.equal(creatorSnapshotProjectionMatches(projection, ordinaryAnchor, ordinary.successorTrust.currentAnchorDigest,
    f.forwardPromotion.source.manifestRef.digest, record(f.historical.snapshot.exactCanonicalManifestBytes)), false);
  const manifest = JSON.parse(readFileSync('packages/node/package.json', 'utf8'));
  assert(!JSON.stringify(manifest.exports).includes('forward-promotion'));
  console.log(JSON.stringify({ milestone: 'NORMAL_CONTROLS', profiles: 2, representations: 3, checkpointEpoch: 3, ordinaryEpoch: 4, oldForkGapRefused: true, native: 0, installs: 0, hostEdits: 0, issuanceMutations: 0 }));
});
