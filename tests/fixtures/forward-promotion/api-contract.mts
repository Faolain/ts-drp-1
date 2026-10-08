import type { CurrentAnchorTrust } from '@ts-drp/protocol-v3';
import {
  prepareCreatorForwardPromotion, prepareCreatorForwardPromotionSuccessor,
  completeCreatorForwardPromotionSuccessor, openCreatorForwardPromotionSuccessorTrust,
  type CreatorForwardPromotionPreparation, type CreatorForwardPromotionAnchorPreparation,
  type VerifiedCreatorClose, type CreatorAnchorPreparation,
} from '@ts-drp/protocol-v3/creator-close';
import {
  openCreatorForwardPromotion, resolveCreatorForwardPromotion,
  type VerifiedCreatorForwardPromotion,
} from '../../../packages/node/src/internal/creator-transition-advance.js';
import type { CreatorSuccessorLiveMaterial } from '../../../packages/node/src/internal/creator-successor-live.js';
import type { CreatorAnchorSigningRequest } from '@ts-drp/protocol-v3/internal/creator-anchor-signing-request';
import type { SealAuthority } from '@ts-drp/protocol-v3/seal';
import type { PromotionFixture } from './promotion.mjs';

declare const fixture: PromotionFixture;
declare const authority: SealAuthority;
declare const promotion: CreatorForwardPromotionPreparation;
declare const preparation: CreatorForwardPromotionAnchorPreparation;
declare const decision: VerifiedCreatorForwardPromotion;

const authored = prepareCreatorForwardPromotion(fixture.preparationInput);
if (authored.ok) {
  const prepared: CreatorForwardPromotionPreparation = authored.promotion;
  const bytes: Uint8Array = authored.exactCanonicalCutValueBytes;
  const digest: string = authored.valueDigest;
  void [prepared, bytes, digest];
}
const next = prepareCreatorForwardPromotionSuccessor({ authority, promotion, exactCanonicalCommitQcBytes: fixture.qc.bytes });
if (next.ok) {
  const request: CreatorAnchorSigningRequest = next.signingRequest;
  const prepared: CreatorForwardPromotionAnchorPreparation = next.preparation;
  void [request, prepared];
}
completeCreatorForwardPromotionSuccessor({ preparation, detachedSignature: new Uint8Array(64) });
openCreatorForwardPromotionSuccessorTrust({ currentTrust: fixture.input.currentTrust, exactCanonicalCutValueBytes: fixture.cut.bytes,
  exactCanonicalCommitQcBytes: fixture.qc.bytes, exactCanonicalTrustStateRecordBytes: fixture.nextRecord.bytes });
const opened = openCreatorForwardPromotion(fixture.input);
if (opened.ok) {
  const genuine: VerifiedCreatorForwardPromotion = opened.promotion;
  const identity = resolveCreatorForwardPromotion(genuine);
  void identity;
}
// New fieldless decisions must still have nominal, foreign-refusing custody.
// @ts-expect-error observer facts cannot mint a decision
const forged: VerifiedCreatorForwardPromotion = {};
// @ts-expect-error pure promotion is not ordinary close authority
const ordinaryClose: VerifiedCreatorClose = decision;
// @ts-expect-error pure promotion is not live material or install custody
const live: CreatorSuccessorLiveMaterial = decision;
// @ts-expect-error pure promotion is not current trust
const trust: CurrentAnchorTrust = decision;
// @ts-expect-error signing-only preparation cannot mint whole source-authenticated Node decision
const signingOnly: VerifiedCreatorForwardPromotion = promotion;
// @ts-expect-error promotion signing branch cannot silently enter ordinary close
const oldClose: VerifiedCreatorClose = promotion;
// @ts-expect-error dedicated promotion anchor preparation is not the ordinary branch
const oldPreparation: CreatorAnchorPreparation = preparation;
void [forged, ordinaryClose, live, trust, signingOnly, oldClose, oldPreparation];
