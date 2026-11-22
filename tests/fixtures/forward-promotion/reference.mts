import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeCanonical, encodeCanonical, hashDomain } from '@ts-drp/canonical';
import { CompactMerkleAccumulator, deriveCloseSetHistoryCommitment, type EpochVertex } from '@ts-drp/compaction';
import { installCreatorAnchorTrustRoot, type CurrentAnchorTrust } from '@ts-drp/protocol-v3';
import * as close from '@ts-drp/protocol-v3/creator-close';
import * as seal from '@ts-drp/protocol-v3/seal';
import * as frontiers from '@ts-drp/protocol-v3/creator-author-issuance-frontiers';
import * as retirement from '@ts-drp/protocol-v3/creator-issuance-retirement';
import { createRecoverableFinalitySigner, signSealRegisteredDigest, signCreatorAnchorRequest, signCreatorIssuanceRetirementRequest } from '@ts-drp/keychain/finality';
import { digestBlob, type GenerationRef } from '@ts-drp/storage';
import { openCreatorTransitionClosedCutEvidence, type CreatorTransitionClosure } from '../../../packages/node/src/internal/creator-transition-advance.js';
import { validateCreatorSnapshotData } from '../../../packages/node/src/internal/creator-snapshot-data.js';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));
export const digest = (domain: string, b: Uint8Array): string => hex(hashDomain(domain, b));
export const record = (b: Uint8Array): Record<string, unknown> => decodeCanonical(b) as Record<string, unknown>;
export const seed = new Uint8Array(32).fill(0x31);
export const author = hex(ed25519.getPublicKey(seed));
export const removedAuthor = hex(ed25519.getPublicKey(new Uint8Array(32).fill(0x52)));
export const objectId = `creator:${'5'.repeat(32)}`;
const zero = '0'.repeat(64), blueprint = '8'.repeat(64), archive = '3'.repeat(64);
export const parameters = { maxDependencies: 16, maxEpochBytes: 8388608, maxEpochVertices: 8192, maxPendingBytes: 16777216, maxPendingEntries: 4096, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 };
export const availability = { minLocalCopies: 1, minMirrorReceipts: 0, minRollbackGenerations: 2, mode: 'local-only' };
const signerSet = [{ publicKey: author, signerId: 'creator' }];
export type Representation = 'settlement' | 'aggregate-retirement' | 'retirement-only';
export type Candidate = Readonly<{ bytes: Uint8Array; ref: GenerationRef }>;
export function candidate(bytes: Uint8Array): Candidate {
  const d = digestBlob(bytes); assert(d.ok);
  return { bytes: Uint8Array.from(bytes), ref: { digest: d.value, byteLength: bytes.byteLength } };
}
export function closure(candidates: readonly Candidate[]): CreatorTransitionClosure {
  return { candidates, closure: candidates.map(c => c.ref).sort((a, b) => a.digest.localeCompare(b.digest)) };
}
export function acl(epoch: number, removed = false, settlement = false, writers: readonly string[] = [author]): Uint8Array {
  return encodeCanonical({ kind: 'drp-v3-latched-acl', version: settlement ? 3 : 1, objectId, epoch, permissionless: false,
    members: [...writers, ...(removed ? [removedAuthor] : [])].sort().map(a => ({ author: a, finalityKey: author, groups: ['admin', 'finality', 'writer'] })) });
}
export function signedQc(cutBytes: Uint8Array, phase: 'prepare' | 'commit', round = 0): Uint8Array {
  const c = record(cutBytes), valueDigest = digest('ts-drp/hard-epoch-cut/v3', cutBytes);
  const proposalHash = digest('ts-drp/seal-proposal/v3', encodeCanonical({ kind: 'drp-seal-proposal', objectId: c.objectId, epoch: c.epoch, round, valueDigest }));
  const vote = encodeCanonical({ kind: 'drp-seal-vote', objectId: c.objectId, epoch: c.epoch, round, phase, proposalDigest: valueDigest, proposalHash, signerId: 'creator' });
  const voteDigest = digest('ts-drp/seal-vote/v3', vote);
  return encodeCanonical({ kind: 'drp-seal-qc', objectId: c.objectId, epoch: c.epoch, round, phase, proposalDigest: valueDigest, proposalHash,
    votes: [{ signerId: 'creator', voteDigest, signature: hex(ed25519.sign(unhex(voteDigest), seed)) }] });
}
export function signControl(preimage: Record<string, unknown>): Uint8Array {
  const domains: Record<string, string> = {
    'drp-creator-author-settlement-state': 'ts-drp/creator-author-settlement/v1',
    'drp-creator-author-issuance-frontiers-state': 'ts-drp/creator-author-issuance-frontiers/v1',
    'drp-creator-issuance-retirement-state': 'ts-drp/creator-issuance-retirement/v1',
  };
  const { detachedAuthoritySignature: _a, detachedCreatorSignature: _b, ...p } = preimage;
  const field = p.kind === frontiers.CREATOR_AUTHOR_SETTLEMENT_KIND ? 'detachedAuthoritySignature' : 'detachedCreatorSignature';
  const signature = ed25519.sign(unhex(digest(domains[String(p.kind)]!, encodeCanonical(p))), seed);
  assert(ed25519.verify(signature, unhex(digest(domains[String(p.kind)]!, encodeCanonical(p))), ed25519.getPublicKey(seed), { zip215: false }));
  return encodeCanonical({ ...p, [field]: signature });
}
export interface Snapshot { exactCanonicalManifestBytes: Uint8Array; exactCanonicalPayloadBytes: Uint8Array }
export interface Step {
  currentTrust: CurrentAnchorTrust; successorTrust: CurrentAnchorTrust;
  currentRecord: Candidate; successorRecord: Candidate; cut: Candidate; qc: Candidate;
  snapshot: Snapshot; closedAcl: Candidate; controls: readonly Candidate[];
  currentAnchorBytes: Uint8Array; closeInput: Record<string, unknown>;
}
export interface Chain { steps: readonly Step[]; pin: string; genesis: Candidate; representation: Representation; profileId: string }
export async function makeChain(representation: Representation, fork = false, writerCount = 1): Promise<Chain> {
  const writers = [author, ...Array.from({ length: writerCount - 1 }, (_, i) => {
    const writerSeed = new Uint8Array(32).fill(0x7d); writerSeed[0] = i; return hex(ed25519.getPublicKey(writerSeed));
  })];
  const profileId = representation === 'settlement' ? 'creator-trusted-settlement-v1' : 'creator-trusted-v1';
  const profileBytes = encodeCanonical({ cryptoSuiteId: 'ed25519-sha256-v3', profileId, quorum: 1, signers: signerSet });
  const signerBytes = encodeCanonical(signerSet), parameterBytes = encodeCanonical(parameters);
  const finality = await createRecoverableFinalitySigner({ seed: Uint8Array.from(seed) });
  let history = new CompactMerkleAccumulator();
  const genesisAnchorBytes = encodeCanonical({ kind: 'drp-epoch-anchor', protocolMajor: 3, objectId, epoch: 0, previousAnchor: zero, cutDigest: zero,
    stateDigest: digest('ts-drp/state/v3', encodeCanonical(0)), aclDigest: digest('ts-drp/latched-acl/v3', acl(0, true, representation === 'settlement', writers)),
    blueprintDigest: blueprint, historyRoot: hex(history.root()), historySize: 0, archiveIndexRoot: archive,
    parametersDigest: digest('ts-drp/parameters/v3', parameterBytes), signerSetDigest: digest('ts-drp/signer-set/v3', signerBytes),
    profileDigest: digest('ts-drp/profile/v3', profileBytes), cryptoSuiteId: 'ed25519-sha256-v3' });
  const pin = digest('ts-drp/epoch-anchor/v3', genesisAnchorBytes);
  const installed = closeResult(installCreatorAnchorTrustRoot({ detachedGenesisSignature: ed25519.sign(unhex(pin), seed), exactCanonicalGenesisAnchorPreimageBytes: genesisAnchorBytes,
    exactCanonicalProfileBytes: profileBytes, exactCanonicalSignerSetBytes: signerBytes, pinnedGenesisAnchorDigest: pin }), 'genesis');
  let trust = installed.trust, trustRecord = candidate(installed.exactCanonicalTrustStateRecordBytes), anchorBytes = genesisAnchorBytes;
  const genesis = trustRecord, steps: Step[] = []; let counter = 0;
  for (let epoch = 0; epoch < 4; epoch++) {
    const anchor = record(anchorBytes), anchorDigest = trust.currentAnchorDigest;
    const successorAcl = acl(epoch + 1, epoch === 0, representation === 'settlement', writers);
    const value = fork && epoch === 1 ? 111 : 11; counter += value;
    const application = { counter };
    const stateDigest = digest('ts-drp/state/v3', encodeCanonical(application));
    const payload = encodeCanonical({ kind: 'drp-snapshot-payload', protocolMajor: 3, schemaVersion: 1, objectId, epoch,
      anchor: anchorDigest, application, acl: record(successorAcl), archiveIndexRoot: archive, blueprintDigest: blueprint });
    const manifestBytes = encodeCanonical({ kind: 'drp-snapshot-manifest', protocolMajor: 3, encodingVersion: 'drp-canonical-profile-1', schemaVersion: 1,
      objectId, epoch, anchor: anchorDigest, stateDigest, aclDigest: digest('ts-drp/latched-acl/v3', successorAcl),
      payloadDigest: digest('ts-drp/snapshot-payload/v3', payload), totalBytes: payload.byteLength,
      chunks: [{ index: 0, byteLength: payload.byteLength, digest: hex(hashDomain('ts-drp/snapshot-chunk/v3', encodeCanonical(0), payload)) }] });
    const vertexBytes = encodeCanonical({ kind: 'drp-vertex', protocolMajor: 3, objectId, epoch, anchor: anchorDigest, author, authorSequence: epoch,
      logicalTime: epoch + 1, dependencies: [anchorDigest], operation: { action: 'add', value } });
    const vertexHash = digest('ts-drp/vertex/v3', vertexBytes);
    const vertexSignature = ed25519.sign(unhex(vertexHash), seed);
    assert(ed25519.verify(vertexSignature, unhex(vertexHash), ed25519.getPublicKey(seed), { zip215: false }));
    const v: EpochVertex = { kind: 'drp-vertex', objectId, epoch, anchor: anchorDigest, dependencies: [anchorDigest], operation: { action: 'add', value }, hash: vertexHash };
    const commitment = await deriveCloseSetHistoryCommitment({ exactCanonicalEpochAnchorPreimageBytes: anchorBytes,
      previousHistorySnapshot: history.snapshot(), frontier: [vertexHash], vertices: new Map([[anchorDigest, { kind: 'drp-epoch-anchor', objectId, epoch, hash: anchorDigest, dependencies: [] } as EpochVertex], [vertexHash, v]]),
      authenticatedCanonicalPreimageByteLengths: new Map([[vertexHash, vertexBytes.byteLength]]), maxEpochBytes: parameters.maxEpochBytes, maxEpochVertices: parameters.maxEpochVertices });
    // Keep the actual prior accumulator, rather than replacing history with the chosen old state.
    history = CompactMerkleAccumulator.fromSnapshot(commitment.historySnapshot);
    const closeInput = { currentTrust: trust, aclDigest: digest('ts-drp/latched-acl/v3', successorAcl), archiveIndexRoot: archive, blueprintDigest: blueprint,
      closeReason: 'creator-requested', closeSetCount: commitment.closeSetCount, closeSetRoot: commitment.closeSetRoot, historyRoot: commitment.historyRoot, historySize: commitment.historySize,
      snapshotManifestDigest: digest('ts-drp/snapshot-manifest/v3', manifestBytes), stateDigest,
      exactCanonicalSnapshotManifestBytes: manifestBytes, exactCanonicalAvailabilityPolicyBytes: encodeCanonical(availability), exactCanonicalNextSignerSetBytes: signerBytes, exactCanonicalParametersBytes: parameterBytes };
    const prepared = closeResult(close.prepareCreatorClose(closeInput), 'ordinary close');
    const authority = closeResult(seal.openSealAuthority({ trust, signerPublicKey: finality.publicKey }), 'seal authority').authority;
    let qcBytes = new Uint8Array();
    for (const phase of ['prepare', 'commit'] as const) {
      const vote = closeResult(seal.prepareSealVote({ authority, exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes, phase, round: 0 }), `ordinary ${phase}`);
      const signature = await signSealRegisteredDigest({ request: vote.signingRequest, signer: finality.signer });
      qcBytes = signedQc(prepared.exactCanonicalCutValueBytes, phase);
      assert.deepEqual(hex(signature), String((record(qcBytes).votes as Record<string, unknown>[])[0]!.signature));
      assert.equal(seal.verifySealQC({ authority, exactCanonicalQcBytes: qcBytes }).ok, true);
    }
    const successor = closeResult(close.prepareCreatorSuccessor({ authority, close: prepared.close, exactCanonicalCommitQcBytes: qcBytes }), 'ordinary successor prepare');
    const signature = await signCreatorAnchorRequest({ request: successor.signingRequest, signer: finality.signer });
    const completed = closeResult(close.completeCreatorSuccessor({ preparation: successor.preparation, detachedSignature: signature }), 'ordinary complete');
    const next = closeResult(close.openCreatorSuccessorTrust({ currentTrust: trust, exactCanonicalCommitQcBytes: qcBytes, exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes,
      exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes }), 'ordinary reopen').trust;
    const cut = candidate(prepared.exactCanonicalCutValueBytes), qc = candidate(qcBytes), currentAclBytes = acl(epoch, epoch <= 1, representation === 'settlement', writers);
    const prior = steps.at(-1);
    const common = { currentTrust: trust, successorTrust: next, commitQcRef: qc.ref, cutValueDigest: prepared.valueDigest,
      snapshotManifestDigest: closeInput.snapshotManifestDigest, currentAclDigest: String(anchor.aclDigest), successorAclDigest: closeInput.aclDigest };
    const controls: Candidate[] = [];
    const governed = async (p: { ok: boolean; reason?: string; digest?: string; preparation?: unknown; signingRequest?: unknown }, complete: (input: unknown) => { ok: boolean; reason?: string; exactCanonicalRecordBytes?: Uint8Array }): Promise<Candidate> => {
      assert(p.ok, p.reason); assert(p.preparation); assert(p.signingRequest);
      const sig = await signCreatorIssuanceRetirementRequest({ request: p.signingRequest as Parameters<typeof signCreatorIssuanceRetirementRequest>[0]['request'], signer: finality.signer });
      const done = complete({ preparation: p.preparation, detachedSignature: sig }); assert(done.ok, done.reason); assert(done.exactCanonicalRecordBytes);
      return candidate(done.exactCanonicalRecordBytes);
    };
    if (representation === 'settlement') {
      controls.push(await governed(frontiers.prepareCreatorAuthorSettlement({ ...common, frontiers: [...writers, ...(epoch === 0 ? [removedAuthor] : [])].sort().map(a => [a, 0, epoch]), historyRoot: commitment.historyRoot, historySize: commitment.historySize,
        priorCheckpointKind: epoch === 0 ? 'genesis' : 'settled-v1', priorCheckpointDigest: prior?.controls[0]?.ref.digest ?? frontiers.CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL }), frontiers.completeCreatorAuthorSettlement));
    } else {
      const { currentAclDigest: _a, successorAclDigest: _b, ...retCommon } = common;
      controls.push(await governed(retirement.prepareCreatorIssuanceRetirement({ ...retCommon, author, admittedAuthorSequence: epoch, observedLineage: { exhausted: false, next: epoch + 1 },
        priorAdmittedAuthorSequence: epoch === 0 ? null : epoch - 1, priorRetirementCandidateDigest: prior?.controls[0]?.ref.digest ?? retirement.CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL }), retirement.completeCreatorIssuanceRetirement));
      if (representation === 'aggregate-retirement' || epoch === 3) controls.push(await governed(frontiers.prepareCreatorAuthorIssuanceFrontiers({ ...common, frontiers: [author, ...(epoch === 0 ? [removedAuthor] : [])].sort().map(a => [a, epoch]),
        priorAggregateCandidateDigest: prior?.controls[1]?.ref.digest ?? frontiers.CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL }), frontiers.completeCreatorAuthorIssuanceFrontiers));
    }
    const snapshot = { exactCanonicalManifestBytes: manifestBytes, exactCanonicalPayloadBytes: payload };
    assert(validateCreatorSnapshotData(payload, manifestBytes, record(cut.bytes), profileId));
    const step = { currentTrust: trust, successorTrust: next, currentRecord: trustRecord, successorRecord: candidate(completed.exactCanonicalTrustStateRecordBytes), cut, qc, snapshot,
      controls, closedAcl: candidate(currentAclBytes), currentAnchorBytes: anchorBytes, closeInput };
    const evidence = openCreatorTransitionClosedCutEvidence({ closure: closure([step.successorRecord, cut, qc, step.closedAcl, ...controls]), floorTrust: next, currentTrust: trust });
    assert(evidence, `genuine old signed ${representation} controls`); assert.equal(evidence.representation, representation === 'retirement-only' && epoch === 3 ? 'aggregate-retirement' : representation);
    steps.push(step); trust = next; trustRecord = step.successorRecord; anchorBytes = successor.exactCanonicalAnchorPreimageBytes;
  }
  return { steps, pin, genesis, representation, profileId };
}
export function closeResult<T extends { ok: boolean; reason?: string }>(result: T, label: string): Extract<T, { ok: true }> {
  assert(result.ok, `${label}: ${result.reason}`); return result as Extract<T, { ok: true }>;
}
