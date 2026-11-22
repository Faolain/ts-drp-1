import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeCanonical, hashDomain } from '@ts-drp/canonical';
import * as seal from '@ts-drp/protocol-v3/seal';
import { inspectCreatorHistoricalAnchorEnvelope } from '@ts-drp/protocol-v3/creator-close';
import { candidate, closure, digest, record, seed, unhex, hex, signedQc, signControl, type Chain, type Step, type Candidate, parameters } from './reference.mjs';

export type SourceRecord = {
  closedEpoch: number; closedAnchorDigest: string; successorEpoch: number; successorAnchorDigest: string;
  cutValueDigest: string; cutRef: Candidate['ref']; commitQcRef: Candidate['ref']; manifestRef: { digest: string; byteLength: number };
  payloadDigest: string; stateDigest: string; closedAclDigest: string; snapshotAclDigest: string;
  checkpointRepresentation: Chain['representation']; checkpointRefs: readonly (readonly [string, Candidate['ref']])[];
};
export function source(chain: Chain, step: Step): SourceRecord {
  const c = record(step.cut.bytes), m = record(step.snapshot.exactCanonicalManifestBytes);
  return { closedEpoch: Number(c.epoch), closedAnchorDigest: String(c.previousAnchor), successorEpoch: step.successorTrust.currentEpoch,
    successorAnchorDigest: step.successorTrust.currentAnchorDigest, cutValueDigest: digest('ts-drp/hard-epoch-cut/v3', step.cut.bytes),
    cutRef: step.cut.ref, commitQcRef: step.qc.ref, manifestRef: { digest: String(c.snapshotManifestDigest), byteLength: step.snapshot.exactCanonicalManifestBytes.byteLength },
    payloadDigest: String(m.payloadDigest), stateDigest: String(c.stateDigest), closedAclDigest: digest('ts-drp/latched-acl/v3', step.closedAcl.bytes), snapshotAclDigest: String(c.aclDigest),
    checkpointRepresentation: chain.representation, checkpointRefs: step.controls.map(c => [String(record(c.bytes).kind), c.ref] as const) };
}
export function envelope(step: Step) {
  const r = record(step.currentRecord.bytes);
  return { objectId: step.currentTrust.objectId, exactCanonicalAnchorPreimageBytes: step.currentAnchorBytes,
    detachedAnchorSignature: r.detachedCurrentAnchorSignature as Uint8Array, exactCanonicalParametersCarrierBytes: encodeCanonical(parameters) };
}
export interface Edits {
  authorizedAcl?: Uint8Array;
  source?: Record<string, unknown>;
  roles?: Record<string, unknown>;
  promotion?: Record<string, unknown>;
  cut?: Record<string, unknown>;
  anchor?: Record<string, unknown>;
  control?: Record<string, unknown>;
}
export function makePromotion(chain: Chain, selectedEpoch: 1 | 2, edits: Edits = {}) {
  const current = chain.steps[3]!, historical = chain.steps[selectedEpoch]!, c = record(current.cut.bytes);
  let currentCloseSnapshot = current.snapshot;
  if (edits.authorizedAcl !== undefined) {
    const payload = encodeCanonical({ ...record(current.snapshot.exactCanonicalPayloadBytes), acl: record(edits.authorizedAcl) });
    const manifest = encodeCanonical({ ...record(current.snapshot.exactCanonicalManifestBytes), aclDigest: digest('ts-drp/latched-acl/v3', edits.authorizedAcl),
      payloadDigest: digest('ts-drp/snapshot-payload/v3', payload), totalBytes: payload.length,
      chunks: [{ index: 0, byteLength: payload.length, digest: hex(hashDomain('ts-drp/snapshot-chunk/v3', encodeCanonical(0), payload)) }] });
    currentCloseSnapshot = { exactCanonicalManifestBytes: manifest, exactCanonicalPayloadBytes: payload };
    c.aclDigest = digest('ts-drp/latched-acl/v3', edits.authorizedAcl); c.snapshotManifestDigest = digest('ts-drp/snapshot-manifest/v3', manifest);
  }
  const available = [chain.steps[2]!, chain.steps[1]!];
  const chosen = { ...source(chain, historical), ...edits.source } as SourceRecord;
  const controlVector = record(current.controls.at(-1)!.bytes).frontiers;
  const roles = { selectedSourceCutDigest: chosen.cutValueDigest, retainedSources: available.filter(s => s !== historical).map(s => source(chain, s)),
    currentControlRefs: chain.steps[2]!.controls.map(c => [String(record(c.bytes).kind), c.ref]), frontiers: controlVector, ...edits.roles };
  const forwardPromotion = { kind: 'forward-historical-promotion', version: 1, genesisAnchorDigest: chain.pin, source: chosen, roles,
    authorizedSuccessorAclDigest: c.aclDigest, ...edits.promotion };
  const cutBytes = encodeCanonical({ ...c, forwardPromotion, ...edits.cut });
  const cut = candidate(cutBytes), valueDigest = digest('ts-drp/hard-epoch-cut/v3', cutBytes), qc = candidate(signedQc(cutBytes, 'commit'));
  const authority = seal.openSealAuthority({ trust: current.currentTrust, signerPublicKey: ed25519.getPublicKey(seed) }); assert(authority.ok);
  const verifiedQc = seal.verifySealQC({ authority: authority.authority, exactCanonicalQcBytes: qc.bytes });
  assert(verifiedQc.ok); assert.equal(verifiedQc.valueDigest, valueDigest); assert.equal(verifiedQc.phase, 'commit');
  const ordinaryNext = record(current.successorRecord.bytes), oldAnchor = record(ordinaryNext.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
  const anchorBytes = encodeCanonical({ ...oldAnchor, aclDigest: c.aclDigest, cutDigest: valueDigest, stateDigest: chosen.stateDigest, ...edits.anchor });
  const anchorDigest = digest('ts-drp/epoch-anchor/v3', anchorBytes), signature = ed25519.sign(unhex(anchorDigest), seed);
  assert(ed25519.verify(signature, unhex(anchorDigest), ed25519.getPublicKey(seed), { zip215: false }));
  const nextRecord = candidate(encodeCanonical({ ...ordinaryNext, currentAnchorDigest: anchorDigest, currentEpoch: record(anchorBytes).epoch,
    exactCanonicalCurrentAnchorPreimageBytes: anchorBytes, detachedCurrentAnchorSignature: signature }));
  const controls = current.controls.map(control => candidate(signControl({ ...record(control.bytes), cutValueDigest: valueDigest, commitQcRef: qc.ref,
    snapshotManifestDigest: c.snapshotManifestDigest, successorAnchorDigest: anchorDigest,
    ...(record(control.bytes).kind === 'drp-creator-issuance-retirement-state' ? {} : { frontiers: roles.frontiers, successorAclDigest: c.aclDigest }), ...edits.control })));
  const currentStep = chain.steps[2]!, predecessorStep = chain.steps[1]!;
  const historicalSnapshots = available.map(step => {
    const originalAnchorEnvelope = chain.representation === 'retirement-only' ? envelope(step) : null;
    if (originalAnchorEnvelope !== null) assert(inspectCreatorHistoricalAnchorEnvelope({ successorTrust: step.successorTrust, envelope: originalAnchorEnvelope }).ok);
    return { closedEpoch: step.currentTrust.currentEpoch, ...step.snapshot, originalAnchorEnvelope };
  });
  const input = {
    currentTrust: current.currentTrust, exactCanonicalPinnedGenesisTrustStateRecordBytes: chain.genesis.bytes,
    expectedRoomHeadState: { stable: { objectId: current.currentTrust.objectId, epoch: 3, currentAnchorDigest: current.currentTrust.currentAnchorDigest }, pending: null },
    current: closure([currentStep.successorRecord, currentStep.cut, currentStep.qc, currentStep.closedAcl, current.closedAcl, ...currentStep.controls]),
    predecessor: closure([predecessorStep.successorRecord, predecessorStep.cut, predecessorStep.qc, predecessorStep.closedAcl, currentStep.closedAcl, ...predecessorStep.controls]),
    proposed: closure([nextRecord, cut, qc, current.closedAcl, ...controls]), currentAclBytes: current.closedAcl.bytes,
    authorizedSuccessorAclBytes: encodeCanonical(record(currentCloseSnapshot.exactCanonicalPayloadBytes).acl),
    currentCloseSnapshot, historicalSnapshots,
  };
  return { chain, input, forwardPromotion, cut, qc, nextRecord, anchorBytes, anchorDigest, controls, valueDigest, historical, current,
    preparationInput: { ...current.closeInput, aclDigest: c.aclDigest, snapshotManifestDigest: c.snapshotManifestDigest,
      exactCanonicalSnapshotManifestBytes: currentCloseSnapshot.exactCanonicalManifestBytes, forwardPromotion }, authority: authority.authority };
}
export type PromotionFixture = ReturnType<typeof makePromotion>;
export function replaceCandidate<T extends { candidates: readonly Candidate[]; closure: readonly Candidate['ref'][] }>(value: T, old: Candidate, replacement: Candidate): T {
  const candidates = value.candidates.map(c => c.ref.digest === old.ref.digest ? replacement : c);
  return { ...value, ...closure(candidates) };
}
export function corrupt(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes); copy[copy.length - 1] = copy[copy.length - 1]! ^ 1; return copy;
}
export function proofBytes(f: PromotionFixture): Uint8Array[] {
  return [...f.input.current.candidates, ...f.input.predecessor.candidates, ...f.input.proposed.candidates].map(c => c.bytes)
    .concat([f.input.exactCanonicalPinnedGenesisTrustStateRecordBytes, f.input.currentAclBytes, f.input.authorizedSuccessorAclBytes]);
}
export function actualUnion(bytes: readonly Uint8Array[]): number {
  const seen = new Map<string, Uint8Array>(); for (const b of bytes) seen.set(hex(b), b); return [...seen.values()].reduce((n, b) => n + b.byteLength, 0);
}
