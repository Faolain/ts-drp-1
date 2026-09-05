import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const OWNER_PATH = "packages/outcome-commit/src/index.ts";
const PACKAGE_PATH = "packages/outcome-commit/package.json";
const ownerExists =
	existsSync(OWNER_PATH) &&
	existsSync(PACKAGE_PATH) &&
	Object.hasOwn(
		(JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as { readonly exports?: Readonly<Record<string, unknown>> })
			.exports ?? {},
		"."
	);

interface OutcomeIntent {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly clientOperationId: string;
	readonly counterparties: readonly string[];
	readonly epoch: number;
	readonly kind: "ts-drp-outcome-intent";
	readonly objectId: string;
	readonly outcomeKind: string;
	readonly payloadDigest: string;
	readonly version: 1;
}

interface PreparedOutcomeIntent {
	readonly exactCanonicalIntentBytes: Uint8Array;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly intent: OutcomeIntent;
	readonly intentDigest: string;
	readonly registeredDigest: Uint8Array;
}

interface OutcomeApproval {
	readonly signature: Uint8Array;
	readonly signer: string;
}

interface OutcomeCommitOperation {
	readonly action: "commit-outcome-v1";
	readonly approvals: readonly OutcomeApproval[];
	readonly clientOperationId: string;
	readonly exactCanonicalIntentBytes: Uint8Array;
	readonly exactCanonicalPayloadBytes: Uint8Array;
}

interface VerifiedOutcomeCommit {
	readonly clientOperationId: string;
	readonly intentDigest: string;
	readonly operation: OutcomeCommitOperation;
}

interface OutcomeCommitRegistry {
	readonly size: number;
	classify(value: VerifiedOutcomeCommit): "conflict" | "duplicate" | "fresh" | "full";
	commit(value: VerifiedOutcomeCommit): "committed" | "conflict" | "duplicate" | "full";
}

type VerificationResult =
	| Readonly<{
			readonly ok: false;
			readonly reason:
				| "approval-mismatch"
				| "context-mismatch"
				| "malformed-proof"
				| "payload-mismatch"
				| "proof-too-large";
	  }>
	| Readonly<{ readonly ok: true; readonly verified: VerifiedOutcomeCommit }>;

interface OutcomeCommitModule {
	readonly OUTCOME_COMMIT_MAX_PAYLOAD_BYTES: number;
	readonly OUTCOME_COMMIT_MAX_PROOF_BYTES: number;
	createOutcomeCommitOperation(
		input: Readonly<{
			readonly approvals: readonly OutcomeApproval[];
			readonly prepared: PreparedOutcomeIntent;
		}>
	): OutcomeCommitOperation;
	createOutcomeCommitRegistry(input: Readonly<{ readonly maxEntries: number }>): OutcomeCommitRegistry;
	prepareOutcomeIntent(
		input: Readonly<{
			readonly aclDigest: string;
			readonly anchorDigest: string;
			readonly clientOperationId: string;
			readonly counterparties: readonly string[];
			readonly epoch: number;
			readonly exactCanonicalPayloadBytes: Uint8Array;
			readonly objectId: string;
			readonly outcomeKind: string;
		}>
	): PreparedOutcomeIntent;
	verifyOutcomeCommitOperation(
		input: Readonly<{
			readonly expectedAclDigest: string;
			readonly expectedAnchorDigest: string;
			readonly expectedEpoch: number;
			readonly expectedObjectId: string;
			readonly operation: OutcomeCommitOperation;
		}>
	): VerificationResult;
}

const DOMAIN = "ts-drp/outcome-intent/v1";
const alicePrivateKey = Uint8Array.from({ length: 32 }, () => 0x11);
const bobPrivateKey = Uint8Array.from({ length: 32 }, () => 0x22);
const malloryPrivateKey = Uint8Array.from({ length: 32 }, () => 0x33);

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

const alice = hex(ed25519.getPublicKey(alicePrivateKey));
const bob = hex(ed25519.getPublicKey(bobPrivateKey));
const mallory = hex(ed25519.getPublicKey(malloryPrivateKey));
const scope = Object.freeze({
	aclDigest: "22".repeat(32),
	anchorDigest: "11".repeat(32),
	epoch: 7,
	objectId: "zone:e5-00",
});

async function owner(): Promise<OutcomeCommitModule> {
	return (await import(pathToFileURL(OWNER_PATH).href)) as OutcomeCommitModule;
}

function payload(quantity = 3): Uint8Array {
	return encodeCanonical({ asset: "crystal", from: alice, quantity, to: bob });
}

function canonicalPayloadOfByteLength(target: number): Uint8Array {
	for (let length = Math.max(0, target - 16); length <= target; length += 1) {
		const candidate = encodeCanonical(new Uint8Array(length));
		if (candidate.byteLength === target) return candidate;
	}
	throw new Error(`no canonical byte carrier has length ${String(target)}`);
}

function prepare(
	module: OutcomeCommitModule,
	overrides: Partial<Parameters<OutcomeCommitModule["prepareOutcomeIntent"]>[0]> = {}
): PreparedOutcomeIntent {
	return module.prepareOutcomeIntent({
		...scope,
		clientOperationId: "trade-0001",
		counterparties: [bob, alice],
		exactCanonicalPayloadBytes: payload(),
		outcomeKind: "same-zone-trade-v1",
		...overrides,
	});
}

function approval(signer: string, privateKey: Uint8Array, registeredDigest: Uint8Array): OutcomeApproval {
	return Object.freeze({ signature: ed25519.sign(registeredDigest, privateKey), signer });
}

function approvals(prepared: PreparedOutcomeIntent): readonly OutcomeApproval[] {
	return Object.freeze([
		approval(bob, bobPrivateKey, prepared.registeredDigest),
		approval(alice, alicePrivateKey, prepared.registeredDigest),
	]);
}

function operation(module: OutcomeCommitModule, prepared = prepare(module)): OutcomeCommitOperation {
	return module.createOutcomeCommitOperation({ approvals: approvals(prepared), prepared });
}

function verify(module: OutcomeCommitModule, selected: OutcomeCommitOperation): VerificationResult {
	return module.verifyOutcomeCommitOperation({
		expectedAclDigest: scope.aclDigest,
		expectedAnchorDigest: scope.anchorDigest,
		expectedEpoch: scope.epoch,
		expectedObjectId: scope.objectId,
		operation: selected,
	});
}

it("E5-00 RED exposes the missing canonical outcome-commit owner", () => {
	expect(ownerExists).toBe(true);
});

describe.skipIf(!ownerExists)("E5-00 canonical co-signed intent", () => {
	it("prepares one domain-separated canonical intent independent of counterparty input order", async () => {
		const module = await owner();
		const left = prepare(module, { counterparties: [bob, alice] });
		const right = prepare(module, { counterparties: [alice, bob] });

		expect(module.OUTCOME_COMMIT_MAX_PAYLOAD_BYTES).toBe(8_192);
		expect(module.OUTCOME_COMMIT_MAX_PROOF_BYTES).toBe(32_768);
		expect(left.exactCanonicalIntentBytes).toEqual(right.exactCanonicalIntentBytes);
		expect(left.registeredDigest).toEqual(hashDomain(DOMAIN, left.exactCanonicalIntentBytes));
		expect(left.intentDigest).toBe(hex(left.registeredDigest));
		expect(left.intent).toEqual({
			aclDigest: scope.aclDigest,
			anchorDigest: scope.anchorDigest,
			clientOperationId: "trade-0001",
			counterparties: [alice, bob].sort(),
			epoch: scope.epoch,
			kind: "ts-drp-outcome-intent",
			objectId: scope.objectId,
			outcomeKind: "same-zone-trade-v1",
			payloadDigest: hex(hashDomain("ts-drp/outcome-payload/v1", payload())),
			version: 1,
		});
		expect(decodeCanonical(left.exactCanonicalIntentBytes)).toEqual(left.intent);
	});

	it("requires exactly two distinct canonical counterparties", async () => {
		const module = await owner();
		for (const [id, counterparties] of [
			["none", []],
			["one", [alice]],
			["duplicate", [alice, alice]],
			["three", [alice, bob, mallory]],
		] as const) {
			expect(() => prepare(module, { counterparties }), id).toThrowError(/counterpart/iu);
		}
	});

	it("constructs and verifies one exact two-party operation with detached proof bytes", async () => {
		const module = await owner();
		const payloadCarrier = payload();
		const prepared = prepare(module, { exactCanonicalPayloadBytes: payloadCarrier });
		const sourceApprovals = approvals(prepared);
		const selected = module.createOutcomeCommitOperation({ approvals: sourceApprovals, prepared });
		const verified = verify(module, selected);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(Reflect.ownKeys(selected).sort()).toEqual([
			"action",
			"approvals",
			"clientOperationId",
			"exactCanonicalIntentBytes",
			"exactCanonicalPayloadBytes",
		]);
		expect(selected.action).toBe("commit-outcome-v1");
		expect(selected.approvals.map(({ signer }) => signer)).toEqual([alice, bob].sort());
		expect(verified.verified.clientOperationId).toBe("trade-0001");
		expect(verified.verified.intentDigest).toBe(prepared.intentDigest);
		const stableIntent = selected.exactCanonicalIntentBytes.slice();
		const stablePayload = selected.exactCanonicalPayloadBytes.slice();
		const stableSignatures = selected.approvals.map(({ signature }) => signature.slice());
		payloadCarrier.fill(0);
		prepared.exactCanonicalIntentBytes.fill(0);
		prepared.exactCanonicalPayloadBytes.fill(0);
		prepared.registeredDigest.fill(0);
		for (const { signature } of sourceApprovals) signature.fill(0);
		expect(selected.exactCanonicalIntentBytes).toEqual(stableIntent);
		expect(selected.exactCanonicalPayloadBytes).toEqual(stablePayload);
		expect(selected.approvals.map(({ signature }) => signature)).toEqual(stableSignatures);
		selected.exactCanonicalIntentBytes.fill(0);
		selected.exactCanonicalPayloadBytes.fill(0);
		selected.approvals[0]?.signature.fill(0);
		expect(verified.verified.operation.exactCanonicalIntentBytes).toEqual(stableIntent);
		expect(verified.verified.operation.exactCanonicalPayloadBytes).toEqual(stablePayload);
		expect(verified.verified.operation.approvals.map(({ signature }) => signature)).toEqual(stableSignatures);
	});

	it("rejects missing, duplicate, foreign, extra and malformed approvals", async () => {
		const module = await owner();
		const prepared = prepare(module);
		const aliceApproval = approval(alice, alicePrivateKey, prepared.registeredDigest);
		const bobApproval = approval(bob, bobPrivateKey, prepared.registeredDigest);
		const malloryApproval = approval(mallory, malloryPrivateKey, prepared.registeredDigest);
		const malformed = { signer: bob, signature: bobApproval.signature.slice(0, 63) };
		const cases: readonly (readonly [string, readonly OutcomeApproval[]])[] = [
			["missing", [aliceApproval]],
			["duplicate", [aliceApproval, aliceApproval]],
			["foreign", [aliceApproval, malloryApproval]],
			["extra", [aliceApproval, bobApproval, malloryApproval]],
			["malformed", [aliceApproval, malformed]],
		];
		for (const [id, candidate] of cases) {
			expect(() => module.createOutcomeCommitOperation({ approvals: candidate, prepared }), id).toThrowError(
				/approval/iu
			);
		}

		const selected = operation(module, prepared);
		const flipped = aliceApproval.signature.slice();
		flipped[0] = (flipped[0] ?? 0) ^ 0xff;
		const otherIntent = prepare(module, { clientOperationId: "trade-other" });
		const wireCases: readonly (readonly [string, readonly OutcomeApproval[]])[] = [
			["wire-missing", [aliceApproval]],
			["wire-duplicate", [aliceApproval, aliceApproval]],
			["wire-foreign", [aliceApproval, malloryApproval]],
			["wire-extra", [aliceApproval, bobApproval, malloryApproval]],
			["wire-truncated", [aliceApproval, malformed]],
			["wire-flipped", [{ signer: alice, signature: flipped }, bobApproval]],
			[
				"wire-swapped",
				[
					{ signer: alice, signature: bobApproval.signature },
					{ signer: bob, signature: aliceApproval.signature },
				],
			],
			[
				"wire-other-digest",
				[
					approval(alice, alicePrivateKey, otherIntent.registeredDigest),
					approval(bob, bobPrivateKey, otherIntent.registeredDigest),
				],
			],
		];
		for (const [id, candidate] of wireCases) {
			expect(verify(module, { ...selected, approvals: candidate }), id).toEqual({
				ok: false,
				reason: "approval-mismatch",
			});
		}
	});

	it("fails closed on foreign scope, altered ordering, payload substitution and oversized proof", async () => {
		const module = await owner();
		const prepared = prepare(module);
		const selected = operation(module, prepared);
		for (const [field, value] of [
			["expectedObjectId", "zone:foreign"],
			["expectedEpoch", 8],
			["expectedAnchorDigest", "33".repeat(32)],
			["expectedAclDigest", "44".repeat(32)],
		] as const) {
			const result = module.verifyOutcomeCommitOperation({
				expectedAclDigest: scope.aclDigest,
				expectedAnchorDigest: scope.anchorDigest,
				expectedEpoch: scope.epoch,
				expectedObjectId: scope.objectId,
				operation: selected,
				[field]: value,
			});
			expect(result, field).toEqual({ ok: false, reason: "context-mismatch" });
		}

		const substitutedPayload = { ...selected, exactCanonicalPayloadBytes: payload(4) };
		expect(verify(module, substitutedPayload)).toEqual({ ok: false, reason: "payload-mismatch" });

		const intent = decodeCanonical(selected.exactCanonicalIntentBytes) as Record<string, unknown>;
		intent.counterparties = [...(intent.counterparties as readonly string[])].reverse();
		const reordered = { ...selected, exactCanonicalIntentBytes: encodeCanonical(intent) };
		expect(verify(module, reordered)).toEqual({ ok: false, reason: "malformed-proof" });
		expect(verify(module, { ...selected, clientOperationId: "trade-outer-mismatch" })).toEqual({
			ok: false,
			reason: "malformed-proof",
		});

		const oversized = {
			...selected,
			exactCanonicalIntentBytes: new Uint8Array(module.OUTCOME_COMMIT_MAX_PROOF_BYTES),
		};
		expect(verify(module, oversized)).toEqual({ ok: false, reason: "proof-too-large" });

		expect(() =>
			prepare(module, {
				exactCanonicalPayloadBytes: canonicalPayloadOfByteLength(module.OUTCOME_COMMIT_MAX_PAYLOAD_BYTES),
			})
		).not.toThrow();
		expect(() =>
			prepare(module, {
				exactCanonicalPayloadBytes: canonicalPayloadOfByteLength(module.OUTCOME_COMMIT_MAX_PAYLOAD_BYTES + 1),
			})
		).toThrowError(/payload/iu);
	});

	it("classifies exact replay and conflicting client-operation identity before durable admission", async () => {
		const module = await owner();
		const registry = module.createOutcomeCommitRegistry({ maxEntries: 64 });
		const first = verify(module, operation(module));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(registry.classify(first.verified)).toBe("fresh");
		expect(registry.commit(first.verified)).toBe("committed");
		expect(registry.classify(first.verified)).toBe("duplicate");
		expect(registry.commit(first.verified)).toBe("duplicate");

		const changed = prepare(module, { exactCanonicalPayloadBytes: payload(4) });
		const conflict = verify(module, operation(module, changed));
		expect(conflict.ok).toBe(true);
		if (!conflict.ok) return;
		expect(registry.classify(conflict.verified)).toBe("conflict");
		expect(registry.commit(conflict.verified)).toBe("conflict");
		expect(registry.size).toBe(1);

		const bounded = module.createOutcomeCommitRegistry({ maxEntries: 1 });
		expect(bounded.commit(first.verified)).toBe("committed");
		const secondPrepared = prepare(module, { clientOperationId: "trade-0002" });
		const second = verify(module, operation(module, secondPrepared));
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(bounded.classify(second.verified)).toBe("full");
		expect(bounded.commit(second.verified)).toBe("full");
		expect(bounded.size).toBe(1);
		expect(bounded.classify(first.verified)).toBe("duplicate");
	});
});
