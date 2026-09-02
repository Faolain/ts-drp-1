import { decodeCanonical } from "@ts-drp/canonical";

import { inspectCreatorTrustAdvance } from "../../../packages/control-plane/src/creator-trust-advance.js";
import { openCurrentAnchorTrust } from "../../../packages/protocol-v3/src/anchor-trust-singleton.js";
import { openCreatorSuccessorTrust } from "../../../packages/protocol-v3/src/creator-close.js";
import { type D110c0b1RedMaterial, openD110cARepeatCloseFixture } from "../phase-6b-d110c-a/repeat-close-contract.js";

export const D110C_0B1_CHECKPOINT_OPENER_MISSING = "D110C_0B1_CHECKPOINT_OPENER_MISSING";
export const D110C_0B1_BOUNDED_ADVANCE_MISSING = "D110C_0B1_BOUNDED_ADVANCE_MISSING";
export const D110C_0B1_COLD_REOPEN_EPOCH_PINNED = "D110C_0B1_COLD_REOPEN_EPOCH_PINNED";

export interface D110c0b1ClosureEntry {
	readonly byteLength: number;
	readonly digest: string;
	readonly epoch: number | undefined;
	readonly kind: string;
	readonly phase: string | undefined;
}

export interface D110c0b1RedEvidence {
	readonly activeCensus: readonly D110c0b1ClosureEntry[];
	readonly coldReopen: Readonly<Record<string, unknown>>;
	readonly currentCensus: readonly D110c0b1ClosureEntry[];
	readonly currentOpenReasons: readonly [string, string];
	readonly durableHeads: Readonly<{
		readonly active: Readonly<Record<string, unknown>>;
		readonly current: Readonly<Record<string, unknown>>;
		readonly proposed: Readonly<Record<string, unknown>>;
	}>;
	readonly existingAdvance: Readonly<Record<string, unknown>>;
	readonly oneStepFromGenesis: Readonly<Record<string, unknown>>;
	readonly proposedCensus: readonly D110c0b1ClosureEntry[];
}

export interface D110c0b1RedFixture {
	readonly evidence: D110c0b1RedEvidence;
	close(): Promise<void>;
}

type Candidate = D110c0b1RedMaterial["active"]["candidates"][number];

function record(candidate: Candidate): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(candidate.bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_0B1_CLOSURE_RECORD_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function candidate(candidates: readonly Candidate[], kind: string, epoch: number, phase?: string): Candidate {
	const matches = candidates.filter((entry) => {
		const decoded = record(entry);
		return (
			decoded.kind === kind &&
			(decoded.kind === "drp-anchor-trust-state" ? decoded.currentEpoch : decoded.epoch) === epoch &&
			(phase === undefined || decoded.phase === phase)
		);
	});
	if (matches.length !== 1) throw new TypeError(`D110C_0B1_CANDIDATE_INVALID:${kind}:${epoch}:${String(phase)}`);
	return matches[0] as Candidate;
}

function census(candidates: readonly Candidate[]): readonly D110c0b1ClosureEntry[] {
	return Object.freeze(
		candidates
			.map((entry) => {
				const decoded = record(entry);
				return Object.freeze({
					byteLength: entry.ref.byteLength,
					digest: entry.ref.digest,
					epoch:
						typeof decoded.currentEpoch === "number"
							? decoded.currentEpoch
							: typeof decoded.epoch === "number"
								? decoded.epoch
								: undefined,
					kind: String(decoded.kind),
					phase: typeof decoded.phase === "string" ? decoded.phase : undefined,
				});
			})
			.sort((left, right) =>
				left.kind !== right.kind
					? left.kind.localeCompare(right.kind)
					: (left.epoch ?? -1) !== (right.epoch ?? -1)
						? (left.epoch ?? -1) - (right.epoch ?? -1)
						: left.digest.localeCompare(right.digest)
			)
	);
}

/**
 * Executes the inherited genuine 0→1→2 lifecycle once and retains only diagnostic RED facts.
 * @returns Three causal missing-seam observations plus the inherited cleanup owner.
 */
export async function openD110c0b1RedFixture(): Promise<D110c0b1RedFixture> {
	const fixture = await openD110cARepeatCloseFixture({ retainedControls: false });
	try {
		await fixture.advancePendingSuccessor();
		const material = await fixture.captureD110c0b1RedMaterial();
		const epochOneTrust = candidate(material.current.candidates, "drp-anchor-trust-state", 1);
		const epochTwoTrust = candidate(material.active.candidates, "drp-anchor-trust-state", 2);
		const newCut = candidate(material.proposed.candidates, "drp-hard-epoch-cut", 1);
		const newQc = candidate(material.proposed.candidates, "drp-seal-qc", 1, "commit");
		const expectedObjectId = material.genesisTrust.objectId;
		const pinnedGenesisAnchorDigest = material.genesisTrust.genesisAnchorDigest;
		const openedEpochOne = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: epochOneTrust.bytes,
			expectedObjectId,
			pinnedGenesisAnchorDigest,
		});
		const openedEpochTwo = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: epochTwoTrust.bytes,
			expectedObjectId,
			pinnedGenesisAnchorDigest,
		});
		if (openedEpochOne.ok || openedEpochTwo.ok) throw new TypeError("D110C_0B1_CURRENT_OPENER_UNEXPECTED_SUCCESS");
		return Object.freeze({
			close: fixture.close,
			evidence: Object.freeze({
				activeCensus: census(material.active.candidates),
				coldReopen: material.coldReopen,
				currentCensus: census(material.current.candidates),
				currentOpenReasons: Object.freeze([openedEpochOne.reason, openedEpochTwo.reason]),
				durableHeads: Object.freeze({
					active: Object.freeze({ ...material.active.head }),
					current: Object.freeze({ ...material.current.head }),
					proposed: Object.freeze({ ...material.proposed.head }),
				}),
				existingAdvance: inspectCreatorTrustAdvance({
					current: { candidates: material.current.candidates, closure: material.current.references },
					proofRefs: [newCut.ref, newQc.ref],
					proposed: { candidates: material.proposed.candidates, closure: material.proposed.references },
				}),
				oneStepFromGenesis: openCreatorSuccessorTrust({
					currentTrust: material.genesisTrust,
					exactCanonicalCommitQcBytes: newQc.bytes,
					exactCanonicalCutValueBytes: newCut.bytes,
					exactCanonicalTrustStateRecordBytes: epochTwoTrust.bytes,
				}),
				proposedCensus: census(material.proposed.candidates),
			}),
		});
	} catch (error) {
		await fixture.close();
		throw error;
	}
}
