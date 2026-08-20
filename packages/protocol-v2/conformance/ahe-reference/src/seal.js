import { bytesEqual, encodeCanonical } from "./canonical.js";
import { bytesToHex, hashDomain } from "./hash.js";
import { normalizeDigest, normalizeSignerSet } from "./protocol.js";

export class SealProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SealProtocolError";
    this.code = code;
  }
}

export function quorumSize(signerCount, maxByzantine = Math.floor((signerCount - 1) / 3)) {
  if (!Number.isSafeInteger(signerCount) || signerCount <= 0) throw new RangeError("signerCount must be positive");
  if (!Number.isSafeInteger(maxByzantine) || maxByzantine < 0 || signerCount < 3 * maxByzantine + 1) {
    throw new RangeError("invalid Byzantine fault bound");
  }
  return Math.floor((signerCount + maxByzantine) / 2) + 1;
}

export function votePreimage(vote) {
  if (!Number.isSafeInteger(vote.epoch) || vote.epoch < 0 || !Number.isSafeInteger(vote.round) || vote.round < 0) {
    throw new TypeError("invalid vote epoch/round");
  }
  if (!['prepare', 'commit'].includes(vote.phase)) throw new TypeError("invalid vote phase");
  return Object.freeze({
    kind: "drp-seal-vote",
    objectId: vote.objectId,
    epoch: vote.epoch,
    round: vote.round,
    phase: vote.phase,
    proposalDigest: normalizeDigest(vote.proposalDigest, "proposalDigest"),
    proposalHash: normalizeDigest(vote.proposalHash, "proposalHash"),
    signerId: vote.signerId,
  });
}

export async function voteSigningDigest(vote) {
  return bytesToHex(await hashDomain("ts-drp/seal-vote/v2", encodeCanonical(votePreimage(vote))));
}

function qcPreimage(qc) {
  return Object.freeze({
    kind: "drp-seal-qc",
    objectId: qc.objectId,
    epoch: qc.epoch,
    round: qc.round,
    phase: qc.phase,
    proposalDigest: qc.proposalDigest,
    proposalHash: qc.proposalHash,
    votes: qc.votes.map((vote) => ({ ...votePreimage(vote), signature: vote.signature })),
  });
}

export async function buildQC(votes, signerSet, verifySignature, { maxByzantine } = {}) {
  if (!Array.isArray(votes) || votes.length === 0) throw new SealProtocolError("EMPTY_QC", "cannot build an empty quorum certificate");
  const signers = normalizeSignerSet(signerSet);
  const allowed = new Set(signers.map((entry) => entry.signerId));
  const first = votePreimage(votes[0]);
  const unique = new Set();
  const normalized = [];
  for (const vote of votes) {
    const preimage = votePreimage(vote);
    for (const field of ["objectId", "epoch", "round", "phase", "proposalDigest", "proposalHash"]) {
      if (preimage[field] !== first[field]) throw new SealProtocolError("MIXED_QC", `QC mixes ${field}`);
    }
    if (!allowed.has(preimage.signerId)) throw new SealProtocolError("UNKNOWN_SIGNER", `vote from non-signer ${preimage.signerId}`);
    if (unique.has(preimage.signerId)) throw new SealProtocolError("DUPLICATE_SIGNER", `duplicate vote from ${preimage.signerId}`);
    if (typeof verifySignature !== "function" || !(await verifySignature(vote, preimage))) {
      throw new SealProtocolError("INVALID_SIGNATURE", `invalid vote signature from ${preimage.signerId}`);
    }
    unique.add(preimage.signerId);
    normalized.push(Object.freeze({ ...preimage, signature: vote.signature }));
  }
  const required = quorumSize(signers.length, maxByzantine ?? Math.floor((signers.length - 1) / 3));
  if (normalized.length < required) throw new SealProtocolError("SUBQUORUM", `QC has ${normalized.length} votes; ${required} required`);
  normalized.sort((left, right) => left.signerId.localeCompare(right.signerId));
  const qc = {
    kind: "drp-seal-qc",
    objectId: first.objectId,
    epoch: first.epoch,
    round: first.round,
    phase: first.phase,
    proposalDigest: first.proposalDigest,
    proposalHash: first.proposalHash,
    votes: Object.freeze(normalized),
  };
  const digest = bytesToHex(await hashDomain("ts-drp/seal-qc/v2", encodeCanonical(qcPreimage(qc))));
  return Object.freeze({ ...qc, digest });
}

export async function verifyQC(qc, signerSet, verifySignature, expected = {}, options = {}) {
  if (!qc || qc.kind !== "drp-seal-qc" || !Array.isArray(qc.votes)) throw new SealProtocolError("INVALID_QC", "malformed quorum certificate");
  const rebuilt = await buildQC(qc.votes, signerSet, verifySignature, options);
  if (rebuilt.digest !== qc.digest) throw new SealProtocolError("INVALID_QC_DIGEST", "quorum certificate digest mismatch");
  for (const field of ["objectId", "epoch", "round", "phase", "proposalDigest", "proposalHash"]) {
    if (expected[field] !== undefined && rebuilt[field] !== expected[field]) {
      throw new SealProtocolError("QC_MISMATCH", `quorum certificate ${field} mismatch`);
    }
  }
  return rebuilt;
}

function proposalFields(proposal) {
  if (!proposal || typeof proposal !== "object") throw new SealProtocolError("INVALID_PROPOSAL", "proposal is required");
  return {
    objectId: proposal.objectId,
    epoch: proposal.epoch,
    round: proposal.round,
    digest: normalizeDigest(proposal.digest, "proposal digest"),
    proposalHash: normalizeDigest(proposal.proposalHash ?? proposal.digest, "proposal hash"),
    validRound: proposal.validRound ?? -1,
    prepareQC: proposal.prepareQC,
  };
}

export class SealSignerState {
  constructor({ objectId, epoch, signerId, validateProposal, durableState } = {}) {
    this.objectId = objectId;
    this.epoch = epoch;
    this.signerId = signerId;
    this.validateProposal = validateProposal ?? (async () => true);
    this.enteredRound = durableState?.enteredRound ?? 0;
    this.prepareVotes = new Map(durableState?.prepareVotes ?? []);
    this.commitVotes = new Map(durableState?.commitVotes ?? []);
    this.lock = durableState?.lock ?? null;
    this.highestPrepareQC = durableState?.highestPrepareQC ?? null;
    this.committedDigest = durableState?.committedDigest ?? null;
  }

  enterRound(round) {
    if (!Number.isSafeInteger(round) || round < this.enteredRound) {
      throw new SealProtocolError("ROUND_REGRESSION", `cannot enter round ${round} from ${this.enteredRound}`);
    }
    this.enteredRound = round;
    return round;
  }

  catchUp(round) {
    if (round > this.enteredRound) this.enteredRound = round;
    return this.enteredRound;
  }

  async prepareVote(proposal, { signerSet, verifySignature, maxByzantine } = {}) {
    const fields = proposalFields(proposal);
    if (fields.objectId !== this.objectId || fields.epoch !== this.epoch) throw new SealProtocolError("WRONG_INSTANCE", "proposal is for another object or epoch");
    if (fields.round !== this.enteredRound) {
      throw new SealProtocolError(fields.round < this.enteredRound ? "RETROACTIVE_VOTE" : "ROUND_NOT_ENTERED", `signer is in round ${this.enteredRound}`);
    }
    const existing = this.prepareVotes.get(fields.round);
    if (existing) {
      if (existing.proposalDigest !== fields.digest || existing.proposalHash !== fields.proposalHash) {
        throw new SealProtocolError("DOUBLE_PREPARE", "signer already prepared another proposal in this round");
      }
      return existing;
    }
    if (!(await this.validateProposal(proposal))) throw new SealProtocolError("INVALID_PROPOSAL", "proposal validation failed");

    let justification = null;
    if (fields.validRound >= 0 || fields.prepareQC) {
      if (!fields.prepareQC || !signerSet || !verifySignature) throw new SealProtocolError("MISSING_JUSTIFICATION", "proposal justification cannot be verified");
      justification = await verifyQC(
        fields.prepareQC,
        signerSet,
        verifySignature,
        { objectId: this.objectId, epoch: this.epoch, round: fields.validRound, phase: "prepare", proposalDigest: fields.digest },
        { maxByzantine }
      );
      if (justification.round >= fields.round) throw new SealProtocolError("INVALID_JUSTIFICATION_ROUND", "prepare QC must come from an earlier round");
      if (!this.highestPrepareQC || justification.round > this.highestPrepareQC.round) this.highestPrepareQC = justification;
    }
    if (this.lock && this.lock.proposalDigest !== fields.digest) {
      if (!justification || justification.round < this.lock.round) {
        throw new SealProtocolError("LOCKED_OTHER_VALUE", "proposal does not carry a sufficiently high prepare QC to unlock this signer");
      }
    }
    const vote = Object.freeze({
      ...votePreimage({
        objectId: this.objectId,
        epoch: this.epoch,
        round: fields.round,
        phase: "prepare",
        proposalDigest: fields.digest,
        proposalHash: fields.proposalHash,
        signerId: this.signerId,
      }),
    });
    this.prepareVotes.set(fields.round, vote);
    return vote;
  }

  async commitVote(prepareQC, { signerSet, verifySignature, maxByzantine } = {}) {
    const qc = await verifyQC(
      prepareQC,
      signerSet,
      verifySignature,
      { objectId: this.objectId, epoch: this.epoch, phase: "prepare" },
      { maxByzantine }
    );
    if (qc.round !== this.enteredRound) {
      throw new SealProtocolError(
        qc.round < this.enteredRound ? "RETROACTIVE_VOTE" : "ROUND_NOT_ENTERED",
        "cannot commit a prepare QC outside the current round"
      );
    }
    const existing = this.commitVotes.get(qc.round);
    if (existing) {
      if (existing.proposalDigest !== qc.proposalDigest || existing.proposalHash !== qc.proposalHash) {
        throw new SealProtocolError("DOUBLE_COMMIT", "signer already committed another proposal in this round");
      }
      return existing;
    }
    this.lock = Object.freeze({ round: qc.round, proposalDigest: qc.proposalDigest, proposalHash: qc.proposalHash, qcDigest: qc.digest });
    if (!this.highestPrepareQC || qc.round >= this.highestPrepareQC.round) this.highestPrepareQC = qc;
    const vote = Object.freeze({
      ...votePreimage({
        objectId: this.objectId,
        epoch: this.epoch,
        round: qc.round,
        phase: "commit",
        proposalDigest: qc.proposalDigest,
        proposalHash: qc.proposalHash,
        signerId: this.signerId,
      }),
    });
    this.commitVotes.set(qc.round, vote);
    return vote;
  }

  async observeCommitQC(commitQC, options) {
    const qc = await verifyQC(
      commitQC,
      options.signerSet,
      options.verifySignature,
      { objectId: this.objectId, epoch: this.epoch, phase: "commit" },
      { maxByzantine: options.maxByzantine }
    );
    if (this.committedDigest && this.committedDigest !== qc.proposalDigest) {
      throw new SealProtocolError("CONFLICTING_COMMIT_QC", "observed two committed values for one epoch");
    }
    this.committedDigest = qc.proposalDigest;
    if (qc.round > this.enteredRound) this.enteredRound = qc.round;
    return this.committedDigest;
  }

  exportDurableState() {
    return Object.freeze({
      enteredRound: this.enteredRound,
      prepareVotes: [...this.prepareVotes.entries()],
      commitVotes: [...this.commitVotes.entries()],
      lock: this.lock,
      highestPrepareQC: this.highestPrepareQC,
      committedDigest: this.committedDigest,
    });
  }
}

export class AtomicVoteStore {
  constructor() {
    this.records = new Map();
  }
  key(vote) {
    const preimage = votePreimage(vote);
    return `${preimage.objectId}\u0000${preimage.epoch}\u0000${preimage.round}\u0000${preimage.phase}\u0000${preimage.signerId}`;
  }
  putIfAbsent(vote) {
    const key = this.key(vote);
    const existing = this.records.get(key);
    if (existing) {
      if (!bytesEqual(encodeCanonical(existing), encodeCanonical(vote))) {
        throw new SealProtocolError("DURABLE_DOUBLE_VOTE", "durable vote slot already contains another value");
      }
      return { inserted: false, vote: existing };
    }
    this.records.set(key, vote);
    return { inserted: true, vote };
  }
}
