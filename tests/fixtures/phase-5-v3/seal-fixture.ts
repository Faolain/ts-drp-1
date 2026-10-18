import { encodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { slotKey, votePreimage } from "./seal-contract.js";
import type { CandidateSealModules, ExactSealCarrier, SealPhase } from "./seal-types.js";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const REQUIRED_OWNER_PATHS = Object.freeze(
	(
		JSON.parse(readFileSync(resolve(import.meta.dirname, "seal-safety-contract.json"), "utf8")) as {
			readonly requiredOwners: readonly string[];
		}
	).requiredOwners
);

/**
 * Resolves the four production owners without importing an absent RED module.
 * @returns Closed readiness and missing-owner roster.
 */
export function ownerReadiness(): Readonly<{ missing: readonly string[]; ready: boolean }> {
	const missing = REQUIRED_OWNER_PATHS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

/**
 * Loads the four candidate modules after the composite readiness fact is true.
 * @returns Candidate module graph.
 */
export async function loadCandidateSealModules(): Promise<CandidateSealModules> {
	const specifiers = {
		browser: "@ts-drp/storage-browser/seal-vote",
		keychain: "@ts-drp/keychain/finality",
		protocol: "@ts-drp/protocol-v3/seal",
		seal: "@ts-drp/seal",
	} as const;
	const [browser, keychain, protocol, seal] = await Promise.all(
		Object.values(specifiers).map(async (specifier) => import(specifier))
	);
	return { browser, keychain, protocol, seal } as unknown as CandidateSealModules;
}

function copiedCarrier(carrier: ExactSealCarrier): ExactSealCarrier {
	return Object.freeze({
		exactCanonicalPreimageBytes: Uint8Array.from(carrier.exactCanonicalPreimageBytes),
		signature: Uint8Array.from(carrier.signature),
	});
}

function carrierIdentity(carrier: ExactSealCarrier): string {
	return createHash("sha256").update(carrier.exactCanonicalPreimageBytes).update(carrier.signature).digest("hex");
}

export interface OracleState {
	readonly enteredRound: number;
	readonly incarnation: string;
	readonly outbox: ReadonlyMap<string, ExactSealCarrier>;
	readonly revision: number;
	readonly slots: ReadonlyMap<string, ExactSealCarrier>;
}

/**
 * Creates an empty durable-state oracle.
 * @param incarnation - Owner-generated storage incarnation.
 * @returns Frozen initial oracle state.
 */
export function emptyOracleState(incarnation = "incarnation-A"): OracleState {
	return Object.freeze({
		enteredRound: 0,
		incarnation,
		outbox: new Map(),
		revision: 0,
		slots: new Map(),
	});
}

/**
 * Applies the independent exact-slot/four-store commit oracle.
 * @param input - Candidate carrier, slot and expected durable revision.
 * @returns Accepted next state or typed fail-closed result.
 */
export function oracleCommit(
	input: Readonly<{
		carrier: ExactSealCarrier;
		expectedIncarnation: string;
		expectedRevision: number;
		phase: SealPhase;
		round: number;
		signerId: string;
		state: OracleState;
	}>
):
	| Readonly<{ ok: false; reason: "STORAGE_LOSS" | "REVALIDATION_REQUIRED" }>
	| Readonly<{ ok: false; reason: "VOTE_CONFLICT"; existing: ExactSealCarrier }>
	| Readonly<{ ok: true; duplicate: boolean; state: OracleState; stored: ExactSealCarrier }> {
	if (input.expectedIncarnation !== input.state.incarnation)
		return Object.freeze({ ok: false, reason: "STORAGE_LOSS" });
	if (input.expectedRevision !== input.state.revision) {
		return Object.freeze({ ok: false, reason: "REVALIDATION_REQUIRED" });
	}
	if (input.round < input.state.enteredRound) return Object.freeze({ ok: false, reason: "REVALIDATION_REQUIRED" });
	const key = slotKey(input);
	const occupied = input.state.slots.get(key);
	if (occupied !== undefined) {
		if (
			Buffer.from(occupied.exactCanonicalPreimageBytes).equals(Buffer.from(input.carrier.exactCanonicalPreimageBytes))
		) {
			return Object.freeze({ duplicate: true, ok: true, state: input.state, stored: copiedCarrier(occupied) });
		}
		return Object.freeze({ existing: copiedCarrier(occupied), ok: false, reason: "VOTE_CONFLICT" });
	}
	const stored = copiedCarrier(input.carrier);
	const slots = new Map(input.state.slots).set(key, stored);
	const outbox = new Map(input.state.outbox).set(key, stored);
	return Object.freeze({
		duplicate: false,
		ok: true,
		state: Object.freeze({
			enteredRound: Math.max(input.state.enteredRound, input.round),
			incarnation: input.state.incarnation,
			outbox,
			revision: input.state.revision + 1,
			slots,
		}),
		stored: copiedCarrier(stored),
	});
}

/**
 * Authors one deterministic exact test carrier.
 * @param input - Exact phase, round and signer identity.
 * @returns Detached canonical preimage and 64-byte signature carrier.
 */
export function oracleCarrier(
	input: Readonly<{ phase: SealPhase; round: number; signerId: string }>
): ExactSealCarrier {
	const exactCanonicalPreimageBytes = encodeCanonical(votePreimage(input));
	const signature = Uint8Array.from({ length: 64 }, (_, index) => (index + input.round + input.signerId.length) & 0xff);
	return Object.freeze({ exactCanonicalPreimageBytes, signature });
}

/**
 * Computes the test-only carrier identity used by custody assertions.
 * @param carrier - Exact preimage and signature bytes.
 * @returns Lowercase SHA-256 identity.
 */
export function carrierDigest(carrier: ExactSealCarrier): string {
	return carrierIdentity(carrier);
}
