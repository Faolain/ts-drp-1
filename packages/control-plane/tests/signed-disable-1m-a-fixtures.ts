/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- bounded test-fixture helpers are described inline */
import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash } from "node:crypto";

export const DISABLE_DOMAIN_V1 = "ts-drp/control-plane/disable/v1";
export const DISABLE_SCOPE = "compaction/history-v1";
export const OPERATOR_AUTHORITY = "operator-primary";
export const OPERATOR_AUTHORITY_SET_VERSION = 3;
export const OPERATOR_PRIVATE_KEY = Uint8Array.from([
	0x71, 0x12, 0x4a, 0x83, 0x9f, 0x01, 0x25, 0x60, 0x44, 0x37, 0xab, 0xc1, 0x93, 0x58, 0xf2, 0x06, 0xe2, 0x2d, 0x3f,
	0x94, 0x69, 0x77, 0x08, 0xb1, 0x5a, 0xcc, 0x36, 0xdf, 0x81, 0x42, 0x19, 0x05,
]);
export const OPERATOR_PUBLIC_KEY = ed25519.getPublicKey(OPERATOR_PRIVATE_KEY);

const ALTERNATE_PRIVATE_KEY = Uint8Array.from([
	0x3a, 0x81, 0x12, 0x57, 0xbc, 0x95, 0x2c, 0x11, 0xef, 0x09, 0x32, 0x74, 0x65, 0x8d, 0xa0, 0x43, 0x49, 0xfa, 0x17,
	0x72, 0xd4, 0x3e, 0x61, 0x8a, 0x25, 0x50, 0x98, 0xcb, 0x04, 0x31, 0x76, 0xee,
]);

export interface DisableCommandPreimage {
	readonly authority: string;
	readonly authoritySetVersion: number;
	readonly capability: string;
	readonly commandId: Uint8Array;
	readonly counter: number;
	readonly scope: string;
	readonly suite: string;
	readonly version: number;
}

export interface SignedDisableEnvelope {
	readonly canonicalBytes: Uint8Array;
	readonly signature: Uint8Array;
}

export interface DisableLatchState {
	readonly authoritySetVersion: number;
	readonly envelopeBytes: Uint8Array | null;
	readonly envelopeDigest: Uint8Array | null;
	readonly envelopeVersion: number;
	readonly highestCounter: number;
	readonly latch: "disabled" | "enabled";
	readonly scope: string;
	readonly stateVersion: number;
}

export interface DisableLatchStatePort {
	load(): Promise<unknown>;
	compareAndCommit(expected: DisableLatchState, next: DisableLatchState): Promise<unknown>;
}

export interface DisableConsumerState {
	readonly highestCounter: number | null;
	readonly status: "blocked" | "disabled" | "enabled";
}

export interface DisableApplyResult {
	readonly applied: boolean;
	readonly counter?: number;
	readonly reason?:
		| "equivocation"
		| "invalid-signature"
		| "replay"
		| "stale-counter"
		| "state-commit-failed"
		| "state-unavailable"
		| "unsupported-version"
		| "wrong-authority"
		| "wrong-authority-set"
		| "wrong-capability"
		| "wrong-suite"
		| "wrong-scope";
}

export interface SignedDisableController {
	apply(envelope: SignedDisableEnvelope): Promise<DisableApplyResult>;
	consumerState(): DisableConsumerState;
	restore(): Promise<DisableConsumerState>;
}

export type SignedDisableControllerConstructor = new (options: {
	readonly authority: {
		readonly authorityId: string;
		readonly authoritySetVersion: number;
		readonly publicKey: { readonly bytes: Uint8Array; readonly format: "raw" };
	};
	readonly scope: string;
	readonly statePort: DisableLatchStatePort;
}) => SignedDisableController;

/** Returns the one recognized empty state; this is a test value, not a default production store. */
export function emptyLatchState(): DisableLatchState {
	return {
		authoritySetVersion: OPERATOR_AUTHORITY_SET_VERSION,
		envelopeBytes: null,
		envelopeDigest: null,
		envelopeVersion: 1,
		highestCounter: 0,
		latch: "enabled",
		scope: DISABLE_SCOPE,
		stateVersion: 1,
	};
}

/** Builds an independent signing reference for the production verifier. */
export function signedDisable(
	counter: number,
	overrides: Partial<DisableCommandPreimage> = {},
	options: { readonly domain?: string; readonly privateKey?: Uint8Array } = {}
): SignedDisableEnvelope {
	const preimage: DisableCommandPreimage = {
		authority: OPERATOR_AUTHORITY,
		authoritySetVersion: OPERATOR_AUTHORITY_SET_VERSION,
		capability: "disable",
		commandId: commandId(counter),
		counter,
		scope: DISABLE_SCOPE,
		suite: "ed25519-sha256-v1",
		version: 1,
		...overrides,
	};
	const canonicalBytes = encodeDisablePreimage(preimage);
	const digest = hashDomainReference(options.domain ?? DISABLE_DOMAIN_V1, canonicalBytes);
	return {
		canonicalBytes,
		signature: ed25519.sign(digest, options.privateKey ?? OPERATOR_PRIVATE_KEY),
	};
}

/** Returns a valid envelope from a different signing authority. */
export function alternateAuthorityDisable(counter: number): SignedDisableEnvelope {
	return signedDisable(counter, { authority: "operator-alternate" }, { privateKey: ALTERNATE_PRIVATE_KEY });
}

/** Returns the expected committed state for a valid envelope. */
export function committedState(
	prior: DisableLatchState,
	envelope: SignedDisableEnvelope,
	counter: number
): DisableLatchState {
	return {
		...prior,
		envelopeBytes: new Uint8Array(envelope.canonicalBytes),
		envelopeDigest: hashDomainReference(DISABLE_DOMAIN_V1, envelope.canonicalBytes),
		highestCounter: counter,
		latch: "disabled",
	};
}

/**
 * NON-PRODUCTION EPHEMERAL IN-MEMORY TEST MODEL.
 *
 * It models one atomic CAS and deliberately makes rejected, throwing and ambiguous
 * outcomes non-committing. It is neither a default store nor durability evidence.
 */
export class EphemeralDisableLatchStatePort implements DisableLatchStatePort {
	readonly commits: { readonly expected: DisableLatchState; readonly next: DisableLatchState }[] = [];
	loadMode: "success" | "throw" = "success";
	mode: "ambiguous" | "deferred" | "reject" | "success" | "throw" = "success";
	#deferred:
		| {
				resolve(value: unknown): void;
		  }
		| undefined;
	#state: unknown;

	/** @param restoredState - Exact ephemeral state returned by load. */
	constructor(restoredState: unknown = emptyLatchState()) {
		this.#state = cloneUnknown(restoredState);
	}

	/** Returns a detached test snapshot. */
	async load(): Promise<unknown> {
		await Promise.resolve();
		if (this.loadMode === "throw") throw new Error("ephemeral restored state is unreadable");
		return cloneUnknown(this.#state);
	}

	/** Models an atomic compare-and-commit operation. */
	async compareAndCommit(expected: DisableLatchState, next: DisableLatchState): Promise<unknown> {
		this.commits.push({ expected: cloneState(expected), next: cloneState(next) });
		if (this.mode === "throw") throw new Error("ephemeral state-port commit failed");
		if (this.mode === "reject") return { outcome: "rejected" };
		if (this.mode === "ambiguous") return { outcome: "unknown" };
		if (this.mode === "deferred") {
			return new Promise((resolve) => {
				this.#deferred = { resolve };
			});
		}
		return this.#commit(expected, next);
	}

	/** Resolves a pending commit successfully and atomically stores its proposed tuple. */
	resolveDeferredCommit(): void {
		const pending = this.#deferred;
		const proposed = this.commits.at(-1);
		if (pending === undefined || proposed === undefined) throw new Error("no deferred commit is pending");
		this.#deferred = undefined;
		pending.resolve(this.#commit(proposed.expected, proposed.next));
	}

	/** Returns a detached view of the ephemeral stored value. */
	stored(): unknown {
		return cloneUnknown(this.#state);
	}

	#commit(expected: DisableLatchState, next: DisableLatchState): { readonly outcome: "committed" | "rejected" } {
		if (!statesEqual(this.#state, expected)) return { outcome: "rejected" };
		this.#state = cloneState(next);
		return { outcome: "committed" };
	}
}

/** Creates a controller against the pinned operator and explicitly injected test port. */
export function createController(
	Constructor: SignedDisableControllerConstructor,
	statePort: DisableLatchStatePort,
	publicKey: Uint8Array = OPERATOR_PUBLIC_KEY
): SignedDisableController {
	return new Constructor({
		authority: {
			authorityId: OPERATOR_AUTHORITY,
			authoritySetVersion: OPERATOR_AUTHORITY_SET_VERSION,
			publicKey: { bytes: publicKey, format: "raw" },
		},
		scope: DISABLE_SCOPE,
		statePort,
	});
}

/** Converts bytes to stable lowercase hexadecimal. */
export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function commandId(counter: number): Uint8Array {
	const bytes = new Uint8Array(16);
	new DataView(bytes.buffer).setUint32(12, counter, false);
	return bytes;
}

function encodeDisablePreimage(preimage: DisableCommandPreimage): Uint8Array {
	return encodeCanonicalReference({ ...preimage });
}

function encodeCanonicalReference(value: Readonly<Record<string, unknown>>): Uint8Array {
	const entries = Object.entries(value).map(([key, item]) => ({
		key: encodeString(key),
		value: encodeScalar(item),
	}));
	entries.sort((left, right) => compareBytes(left.key, right.key));
	return concat([
		Uint8Array.of(0x08),
		encodeVarUint(entries.length),
		...entries.flatMap(({ key, value: encodedValue }) => [key, encodedValue]),
	]);
}

function encodeScalar(value: unknown): Uint8Array {
	if (typeof value === "string") return encodeString(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		const integer = BigInt(value);
		const zigZag = integer >= BigInt(0) ? integer << BigInt(1) : (-integer << BigInt(1)) - BigInt(1);
		return concat([Uint8Array.of(0x03), encodeVarUint(zigZag)]);
	}
	if (value instanceof Uint8Array) {
		return concat([Uint8Array.of(0x06), encodeVarUint(value.byteLength), value]);
	}
	throw new TypeError("disable fixture contains a value outside its narrow canonical reference domain");
}

function encodeString(value: string): Uint8Array {
	const bytes = new TextEncoder().encode(value);
	return concat([Uint8Array.of(0x05), encodeVarUint(bytes.byteLength), bytes]);
}

function encodeVarUint(input: number | bigint): Uint8Array {
	let value = typeof input === "bigint" ? input : BigInt(input);
	const output: number[] = [];
	do {
		let byte = Number(value & BigInt(0x7f));
		value >>= BigInt(7);
		if (value !== BigInt(0)) byte |= 0x80;
		output.push(byte);
	} while (value !== BigInt(0));
	return Uint8Array.from(output);
}

function hashDomainReference(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	const framed = [Uint8Array.of(0x44, 0x52, 0x50, 0x00), u32be(domainBytes.byteLength), domainBytes];
	for (const part of parts) framed.push(u64be(part.byteLength), part);
	return new Uint8Array(createHash("sha256").update(concat(framed)).digest());
}

function u32be(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function u64be(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = (left[index] as number) - (right[index] as number);
		if (difference !== 0) return difference;
	}
	return left.byteLength - right.byteLength;
}

function cloneState(state: DisableLatchState): DisableLatchState {
	return {
		...state,
		envelopeBytes: state.envelopeBytes === null ? null : new Uint8Array(state.envelopeBytes),
		envelopeDigest: state.envelopeDigest === null ? null : new Uint8Array(state.envelopeDigest),
	};
}

function cloneUnknown(value: unknown): unknown {
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (Array.isArray(value)) return value.map(cloneUnknown);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneUnknown(entry)]));
	}
	return value;
}

function statesEqual(left: unknown, right: DisableLatchState): boolean {
	if (left === null || typeof left !== "object") return false;
	const candidate = left as Partial<DisableLatchState>;
	return (
		candidate.stateVersion === right.stateVersion &&
		candidate.authoritySetVersion === right.authoritySetVersion &&
		candidate.scope === right.scope &&
		candidate.envelopeVersion === right.envelopeVersion &&
		candidate.highestCounter === right.highestCounter &&
		bytesEqual(candidate.envelopeBytes, right.envelopeBytes) &&
		bytesEqual(candidate.envelopeDigest, right.envelopeDigest) &&
		candidate.latch === right.latch
	);
}

function bytesEqual(left: Uint8Array | null | undefined, right: Uint8Array | null): boolean {
	if (left === null || left === undefined || right === null) return left === right;
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
