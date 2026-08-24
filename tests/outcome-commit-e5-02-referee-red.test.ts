import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import * as outcomeCommit from "../packages/outcome-commit/src/index.js";

type Prepared = ReturnType<typeof outcomeCommit.prepareOutcomeIntent>;
type Admission = outcomeCommit.OutcomeCommitAdmissionOperation;

type CreateRefereeAdmission = (
	input: Readonly<{
		readonly decision: outcomeCommit.OutcomeApproval;
		readonly prepared: Prepared;
	}>
) => Admission;

type CreateAclBoundPolicy = (
	input: Readonly<{
		readonly aclDigest: string;
		readonly anchorDigest: string;
		readonly epoch: number;
		readonly exactCanonicalLatchedAclBytes: Uint8Array;
		readonly maxEntries: number;
		readonly objectId: string;
	}>
) => outcomeCommit.OutcomeCommitAdmissionPolicy;

const createRefereeAdmission = Reflect.get(outcomeCommit, "createRefereeOutcomeCommitAdmissionOperation") as
	| CreateRefereeAdmission
	| undefined;
const createAclBoundPolicy = outcomeCommit.createOutcomeCommitAdmissionPolicy as unknown as CreateAclBoundPolicy;
const refereeOwnerReady = typeof createRefereeAdmission === "function";

const ALICE_SEED = "11".repeat(32);
const BOB_SEED = "22".repeat(32);
const REFEREE_SEED = "33".repeat(32);
const ADMIN_SEED = "44".repeat(32);
const FINALITY_SEED = "55".repeat(32);
const WRITER_SEED = "66".repeat(32);
const objectId = "e5-02:referee-outcome";
const anchorDigest = "aa".repeat(32);

function author(seed: string): string {
	return Buffer.from(ed25519.getPublicKey(Buffer.from(seed, "hex"))).toString("hex");
}

const ALICE = author(ALICE_SEED);
const BOB = author(BOB_SEED);
const REFEREE = author(REFEREE_SEED);
const ADMIN = author(ADMIN_SEED);
const FINALITY = author(FINALITY_SEED);
const WRITER = author(WRITER_SEED);

function aclBytes(
	referee = REFEREE,
	epoch = 7,
	selectedObjectId = objectId,
	version: 1 | 2 = 2,
	includeReferee = true
): Uint8Array {
	const members = [
		{ author: ADMIN, finalityKey: ADMIN, groups: ["admin", "finality", "writer"] },
		{ author: FINALITY, finalityKey: FINALITY, groups: ["finality"] },
		...(includeReferee
			? [{ author: referee, finalityKey: null, groups: version === 2 ? ["referee"] : ["writer"] }]
			: []),
		{ author: WRITER, finalityKey: null, groups: ["writer"] },
	]
		.sort((left, right) => left.author.localeCompare(right.author))
		.map((member) => Object.freeze(member));
	return encodeCanonical({
		epoch,
		kind: "drp-v3-latched-acl",
		members,
		objectId: selectedObjectId,
		permissionless: false,
		version,
	});
}

function context(
	exactCanonicalLatchedAclBytes = aclBytes(),
	epoch = 7,
	selectedObjectId = objectId
): Readonly<{
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly maxEntries: number;
	readonly objectId: string;
}> {
	return Object.freeze({
		aclDigest: Buffer.from(hashDomain("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes)).toString("hex"),
		anchorDigest,
		epoch,
		exactCanonicalLatchedAclBytes,
		maxEntries: 8,
		objectId: selectedObjectId,
	});
}

function prepared(clientOperationId = "trade-referee-0001", selected = context()): Prepared {
	return outcomeCommit.prepareOutcomeIntent({
		aclDigest: selected.aclDigest,
		anchorDigest: selected.anchorDigest,
		clientOperationId,
		counterparties: [ALICE, BOB],
		epoch: selected.epoch,
		exactCanonicalPayloadBytes: encodeCanonical({ offered: "crystal", requested: "ore", version: 1 }),
		objectId: selected.objectId,
		outcomeKind: "same-zone-trade-v1",
	});
}

function approval(selected: Prepared, seed: string): outcomeCommit.OutcomeApproval {
	return Object.freeze({
		signature: ed25519.sign(selected.registeredDigest, Buffer.from(seed, "hex")),
		signer: author(seed),
	});
}

function refereeAdmission(selected = prepared(), seed = REFEREE_SEED): Admission {
	if (createRefereeAdmission === undefined) throw new TypeError("referee outcome owner is unavailable");
	return createRefereeAdmission({ decision: approval(selected, seed), prepared: selected });
}

it("E5-02 RED has one causal failure for the missing referee outcome owner", () => {
	expect(refereeOwnerReady, "GREEN must install the ACL-bound referee outcome owner").toBe(true);
});

describe.skipIf(!refereeOwnerReady)("E5-02 authenticated referee outcome admission", () => {
	it("accepts one current referee decision and keeps exact replay idempotent", () => {
		const selectedContext = context();
		const selected = prepared("trade-referee-0001", selectedContext);
		const operation = refereeAdmission(selected);
		expect(operation.proof.approvals).toHaveLength(1);
		expect(operation.proof.approvals[0]?.signer).toBe(REFEREE);
		const policy = createAclBoundPolicy(selectedContext);
		const reservation = policy.reserve(operation);
		expect(reservation.kind).toBe("fresh");
		if (reservation.kind !== "fresh") return;
		expect(reservation.commit()).toBe("committed");
		expect(policy.reserve(operation)).toEqual({ kind: "duplicate" });
		expect(policy.reserve(refereeAdmission(prepared("trade-referee-0001", selectedContext)))).toEqual({
			kind: "duplicate",
		});
		const conflicting = outcomeCommit.prepareOutcomeIntent({
			aclDigest: selected.intent.aclDigest,
			anchorDigest: selected.intent.anchorDigest,
			clientOperationId: selected.intent.clientOperationId,
			counterparties: selected.intent.counterparties,
			epoch: selected.intent.epoch,
			exactCanonicalPayloadBytes: encodeCanonical({ offered: "ore", requested: "crystal", version: 1 }),
			objectId: selected.intent.objectId,
			outcomeKind: selected.intent.outcomeKind,
		});
		expect(policy.reserve(refereeAdmission(conflicting))).toEqual({ kind: "conflict" });
	});

	it("preserves the complete two-counterparty branch without requiring referee custody", () => {
		const selected = prepared();
		const proof = outcomeCommit.createOutcomeCommitOperation({
			approvals: [approval(selected, BOB_SEED), approval(selected, ALICE_SEED)],
			prepared: selected,
		});
		const policy = outcomeCommit.createOutcomeCommitAdmissionPolicy({
			aclDigest: selected.intent.aclDigest,
			anchorDigest: selected.intent.anchorDigest,
			epoch: selected.intent.epoch,
			maxEntries: 8,
			objectId: selected.intent.objectId,
		});
		expect(policy.reserve(outcomeCommit.createOutcomeCommitAdmissionOperation(proof)).kind).toBe("fresh");
		expect(
			policy.reserve({
				action: "commit-outcome-v1",
				proof: { ...proof, approvals: [proof.approvals[0] as outcomeCommit.OutcomeApproval] },
			})
		).toEqual({ kind: "rejected" });
	});

	it.each([
		["admin", ADMIN_SEED],
		["finality", FINALITY_SEED],
		["writer", WRITER_SEED],
	])("does not reinterpret a %s as a referee", (_role, seed) => {
		const selectedContext = context();
		expect(
			createAclBoundPolicy(selectedContext).reserve(refereeAdmission(prepared("trade-role", selectedContext), seed))
		).toEqual({
			kind: "rejected",
		});
	});

	it("rejects a revoked decision at the authenticated next ACL epoch", () => {
		const priorContext = context();
		const prior = refereeAdmission(prepared("trade-revoked", priorContext));
		const nextBytes = aclBytes(REFEREE, 8, objectId, 2, false);
		const nextContext = context(nextBytes, 8);
		expect(createAclBoundPolicy(nextContext).reserve(prior)).toEqual({ kind: "rejected" });
		expect(
			createAclBoundPolicy(nextContext).reserve(refereeAdmission(prepared("trade-revoked-next", nextContext)))
		).toEqual({
			kind: "rejected",
		});
	});

	it("rejects foreign object, epoch, v1 and malformed referee carriers", () => {
		const selectedContext = context();
		const selected = prepared("trade-foreign", selectedContext);
		const operation = refereeAdmission(selected);
		const foreignObjectBytes = aclBytes(REFEREE, 7, "e5-02:foreign-object");
		expect(createAclBoundPolicy(context(foreignObjectBytes, 7, "e5-02:foreign-object")).reserve(operation)).toEqual({
			kind: "rejected",
		});
		const v1Bytes = aclBytes(REFEREE, 7, objectId, 1);
		const v1Context = context(v1Bytes);
		expect(createAclBoundPolicy(v1Context).reserve(refereeAdmission(prepared("trade-v1", v1Context)))).toEqual({
			kind: "rejected",
		});
		const badSignature = new Uint8Array(operation.proof.approvals[0]?.signature ?? []);
		badSignature[0] = (badSignature[0] ?? 0) ^ 1;
		expect(
			createAclBoundPolicy(selectedContext).reserve({
				...operation,
				proof: {
					...operation.proof,
					approvals: [{ signature: badSignature, signer: REFEREE }],
				},
			})
		).toEqual({ kind: "rejected" });
	});

	it("authenticates the exact ACL carrier instead of trusting caller-supplied role bytes", () => {
		const noRefereeBytes = aclBytes(REFEREE, 7, objectId, 2, false);
		const authenticated = context(noRefereeBytes);
		const refereeBytes = aclBytes();
		const mismatchedCarrier = Object.freeze({
			...authenticated,
			exactCanonicalLatchedAclBytes: refereeBytes,
		});
		expect(
			createAclBoundPolicy(mismatchedCarrier).reserve(refereeAdmission(prepared("trade-acl-mismatch", authenticated)))
		).toEqual({ kind: "rejected" });

		const malformedBytes = Uint8Array.of(0xff);
		const malformedContext = context(malformedBytes);
		expect(
			createAclBoundPolicy(malformedContext).reserve(
				refereeAdmission(prepared("trade-acl-malformed", malformedContext))
			)
		).toEqual({ kind: "rejected" });

		const wrongEpochContext = Object.freeze({ ...context(), epoch: 8 });
		expect(
			createAclBoundPolicy(wrongEpochContext).reserve(refereeAdmission(prepared("trade-acl-epoch", wrongEpochContext)))
		).toEqual({ kind: "rejected" });
	});

	it("detaches the decision and ACL carriers from caller mutation", () => {
		const selectedContext = context();
		const selected = prepared("trade-detached", selectedContext);
		const decision = approval(selected, REFEREE_SEED);
		const signatureBefore = new Uint8Array(decision.signature);
		const operation = createRefereeAdmission?.({ decision, prepared: selected });
		const policy = createAclBoundPolicy(selectedContext);
		decision.signature.fill(0);
		selectedContext.exactCanonicalLatchedAclBytes.fill(0);
		expect(operation?.proof.approvals[0]?.signature).toEqual(signatureBefore);
		expect(policy.reserve(operation as Admission).kind).toBe("fresh");
	});
});
