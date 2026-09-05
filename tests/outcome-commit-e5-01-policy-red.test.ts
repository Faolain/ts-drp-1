import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
import * as outcomeCommit from "@ts-drp/outcome-commit";
import { describe, expect, it } from "vitest";

type Operation = ReturnType<typeof outcomeCommit.createOutcomeCommitOperation>;
type Verified = Extract<ReturnType<typeof outcomeCommit.verifyOutcomeCommitOperation>, { readonly ok: true }>;

type AdmissionReservation =
	| Readonly<{ readonly kind: "fresh"; commit(): "committed"; release(): void }>
	| Readonly<{ readonly kind: "duplicate" | "conflict" | "rejected" }>;

interface OutcomeAdmissionPolicy {
	readonly size: number;
	reserve(operation: Readonly<Record<string, unknown>>): AdmissionReservation;
}

type CreatePolicy = (
	input: Readonly<{
		readonly aclDigest: string;
		readonly anchorDigest: string;
		readonly epoch: number;
		readonly maxEntries: number;
		readonly objectId: string;
	}>
) => OutcomeAdmissionPolicy;

const createPolicy = Reflect.get(outcomeCommit, "createOutcomeCommitAdmissionPolicy") as CreatePolicy | undefined;
const alicePrivateKey = Uint8Array.from({ length: 32 }, () => 0x11);
const bobPrivateKey = Uint8Array.from({ length: 32 }, () => 0x22);
const alice = Buffer.from(ed25519.getPublicKey(alicePrivateKey)).toString("hex");
const bob = Buffer.from(ed25519.getPublicKey(bobPrivateKey)).toString("hex");
const scope = Object.freeze({
	aclDigest: "22".repeat(32),
	anchorDigest: "11".repeat(32),
	epoch: 7,
	objectId: "zone:e5-01",
});

function operation(clientOperationId = "trade-0001", quantity = 3): Operation {
	const prepared = outcomeCommit.prepareOutcomeIntent({
		...scope,
		clientOperationId,
		counterparties: [bob, alice],
		exactCanonicalPayloadBytes: encodeCanonical({ asset: "crystal", quantity }),
		outcomeKind: "same-zone-trade-v1",
	});
	return outcomeCommit.createOutcomeCommitOperation({
		approvals: [
			Object.freeze({ signature: ed25519.sign(prepared.registeredDigest, bobPrivateKey), signer: bob }),
			Object.freeze({ signature: ed25519.sign(prepared.registeredDigest, alicePrivateKey), signer: alice }),
		],
		prepared,
	});
}

function verified(selected: Operation): Verified {
	const result = outcomeCommit.verifyOutcomeCommitOperation({
		expectedAclDigest: scope.aclDigest,
		expectedAnchorDigest: scope.anchorDigest,
		expectedEpoch: scope.epoch,
		expectedObjectId: scope.objectId,
		operation: selected,
	});
	if (!result.ok) throw new TypeError(`fixture verification failed: ${result.reason}`);
	return result;
}

describe.skipIf(createPolicy === undefined)("E5-01 outcome admission policy", () => {
	it("reserves without committing and releases a definitely pre-durable attempt", () => {
		const policy = createPolicy?.({ ...scope, maxEntries: 8 });
		if (policy === undefined) throw new TypeError("outcome admission policy is unavailable");
		const selected = operation();
		const reservation = policy.reserve(selected);
		expect(reservation.kind).toBe("fresh");
		expect(policy.size).toBe(0);
		if (reservation.kind !== "fresh") return;
		reservation.release();
		expect(policy.size).toBe(0);
		expect(policy.reserve(selected).kind).toBe("fresh");
	});

	it("commits exactly once and distinguishes duplicate from conflict", () => {
		const policy = createPolicy?.({ ...scope, maxEntries: 8 });
		if (policy === undefined) throw new TypeError("outcome admission policy is unavailable");
		const selected = operation();
		const first = policy.reserve(selected);
		expect(first.kind).toBe("fresh");
		if (first.kind !== "fresh") return;
		expect(first.commit()).toBe("committed");
		expect(policy.size).toBe(1);
		expect(policy.reserve(selected)).toEqual({ kind: "duplicate" });
		expect(policy.reserve(operation("trade-0001", 4))).toEqual({ kind: "conflict" });
	});

	it("creates an independent empty registry for every same-context policy", () => {
		const first = createPolicy?.({ ...scope, maxEntries: 8 });
		const second = createPolicy?.({ ...scope, maxEntries: 8 });
		if (first === undefined || second === undefined) throw new TypeError("outcome admission policy is unavailable");
		const selected = operation();
		const reservation = first.reserve(selected);
		if (reservation.kind !== "fresh") throw new TypeError("first policy did not reserve a fresh outcome");
		expect(reservation.commit()).toBe("committed");
		expect(first.size).toBe(1);
		expect(second.size).toBe(0);
		expect(second.reserve(selected).kind).toBe("fresh");
	});

	it("fails the reserved discriminator closed and leaves ordinary operations alone", () => {
		const policy = createPolicy?.({ ...scope, maxEntries: 8 });
		if (policy === undefined) throw new TypeError("outcome admission policy is unavailable");
		const selected = operation();
		const malformed = { ...selected, approvals: [] };
		expect(policy.reserve(malformed)).toEqual({ kind: "rejected" });
		expect(policy.reserve({ action: "placeBlock", id: "block-1" })).toEqual({
			commit: expect.any(Function),
			kind: "fresh",
			release: expect.any(Function),
		});
		expect(policy.size).toBe(0);
	});

	it("rejects a reserved outcome nested inside an application batch", () => {
		const policy = createPolicy?.({ ...scope, maxEntries: 8 });
		if (policy === undefined) throw new TypeError("outcome admission policy is unavailable");
		expect(
			policy.reserve({
				action: "applicationBatch",
				batch: Object.freeze({
					entries: Object.freeze([
						Object.freeze({ logicalTime: 1, operation: Object.freeze({ action: "add", value: 1 }) }),
						Object.freeze({ logicalTime: 2, operation: operation() }),
					]),
					version: 1,
				}),
			})
		).toEqual({ kind: "rejected" });
		const ordinary = policy.reserve({
			action: "applicationBatch",
			batch: Object.freeze({
				entries: Object.freeze([
					Object.freeze({ logicalTime: 1, operation: Object.freeze({ action: "add", value: 1 }) }),
					Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "set", value: 2 }) }),
				]),
				version: 1,
			}),
		});
		expect(ordinary.kind).toBe("fresh");
		if (ordinary.kind === "fresh") ordinary.release();
		expect(policy.size).toBe(0);
	});

	it("rejects foreign authenticated context and consumes only genuine verified operations", () => {
		const policy = createPolicy?.({ ...scope, anchorDigest: "33".repeat(32), maxEntries: 8 });
		if (policy === undefined) throw new TypeError("outcome admission policy is unavailable");
		const selected = operation();
		expect(verified(selected).verified.operation).toEqual(selected);
		expect(policy.reserve(selected)).toEqual({ kind: "rejected" });
	});
});
