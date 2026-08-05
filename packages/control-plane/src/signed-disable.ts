import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";

/** The sole signature domain recognized by the version-one disable envelope. */
export const DISABLE_ENVELOPE_DOMAIN_V1 = "ts-drp/control-plane/disable/v1";

const DISABLE_ENVELOPE_VERSION = 1;
const DISABLE_STATE_VERSION = 1;
const DISABLE_SUITE = "ed25519-sha256-v1";
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const COMMAND_ID_BYTES = 16;
const ENVELOPE_KEYS = ["canonicalBytes", "signature"] as const;
const COMMAND_KEYS = [
	"authority",
	"authoritySetVersion",
	"capability",
	"commandId",
	"counter",
	"scope",
	"suite",
	"version",
] as const;
const STATE_KEYS = [
	"authoritySetVersion",
	"envelopeBytes",
	"envelopeDigest",
	"envelopeVersion",
	"highestCounter",
	"latch",
	"scope",
	"stateVersion",
] as const;

/** Raw Ed25519 key material for the configured disable authority. */
export interface DisableAuthorityPublicKey {
	readonly bytes: Uint8Array;
	readonly format: "raw";
}

/** The locally pinned authority tuple accepted by a signed-disable controller. */
export interface DisableAuthority {
	readonly authorityId: string;
	readonly authoritySetVersion: number;
	readonly publicKey: DisableAuthorityPublicKey;
}

/** Exact signed fields decoded from a version-one canonical preimage. */
export interface DisableCommandPreimage {
	readonly authority: string;
	readonly authoritySetVersion: number;
	readonly capability: "disable";
	readonly commandId: Uint8Array;
	readonly counter: number;
	readonly scope: string;
	readonly suite: "ed25519-sha256-v1";
	readonly version: 1;
}

/** Detached canonical command bytes and their Ed25519 signature. */
export interface SignedDisableEnvelope {
	readonly canonicalBytes: Uint8Array;
	readonly signature: Uint8Array;
}

/** Latest-only tuple owned by one atomic state-port transaction. */
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

/**
 * Required host-owned atomic persistence boundary.
 *
 * Phase 1m-a intentionally provides no default implementation and makes no
 * durability claim. Only an exact `{ outcome: "committed" }` response makes a
 * proposed latch locally observable.
 */
export interface DisableLatchStatePort {
	load(): Promise<unknown>;
	compareAndCommit(expected: DisableLatchState, next: DisableLatchState): Promise<unknown>;
}

/** Fail-closed state exposed to a local consumer. */
export interface DisableConsumerState {
	readonly highestCounter: number | null;
	readonly status: "blocked" | "disabled" | "enabled";
}

/** Stable rejection classifications for a submitted signed-disable envelope. */
export type DisableApplyFailureReason =
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

/** Result of attempting to advance the local disable latch. */
export type DisableApplyResult =
	| { readonly applied: true; readonly counter: number }
	| { readonly applied: false; readonly reason: DisableApplyFailureReason };

/** Construction inputs for the local signed-disable controller. */
export interface SignedDisableControllerOptions {
	readonly authority: DisableAuthority;
	readonly scope: string;
	readonly statePort: DisableLatchStatePort;
}

interface VerifiedEnvelope {
	readonly bytes: Uint8Array;
	readonly command: DisableCommandPreimage;
	readonly digest: Uint8Array;
}

type EnvelopeVerification =
	| { readonly accepted: true; readonly envelope: VerifiedEnvelope }
	| { readonly accepted: false; readonly reason: DisableApplyFailureReason };

/**
 * Verifies and atomically applies disable-only commands for one pinned scope.
 *
 * The controller is a local state machine. The injected port owns persistence;
 * transport, compaction integration, and durable restoration remain external.
 */
export class SignedDisableController {
	readonly #authorityId: string;
	readonly #authoritySetVersion: number;
	readonly #publicKey: Uint8Array;
	readonly #scope: string;
	readonly #statePort: DisableLatchStatePort;
	#publicationToken: object = {};
	#state: DisableLatchState | undefined;

	/** @param options - Pinned authority/scope and the mandatory atomic state port. */
	constructor(options: SignedDisableControllerOptions) {
		if (options === null || typeof options !== "object") throw new TypeError("options are required");
		const { authority, scope, statePort } = options;
		if (authority === null || typeof authority !== "object") throw new TypeError("authority is required");
		if (typeof authority.authorityId !== "string" || authority.authorityId.length === 0) {
			throw new TypeError("authorityId must be a non-empty string");
		}
		if (!isNonNegativeSafeInteger(authority.authoritySetVersion)) {
			throw new TypeError("authoritySetVersion must be a non-negative safe integer");
		}
		if (
			authority.publicKey === null ||
			typeof authority.publicKey !== "object" ||
			authority.publicKey.format !== "raw" ||
			!(authority.publicKey.bytes instanceof Uint8Array) ||
			authority.publicKey.bytes.byteLength !== ED25519_PUBLIC_KEY_BYTES
		) {
			throw new TypeError("authority public key must be a 32-byte raw Ed25519 key");
		}
		if (typeof scope !== "string" || scope.length === 0) throw new TypeError("scope must be a non-empty string");
		if (
			statePort === null ||
			typeof statePort !== "object" ||
			typeof statePort.load !== "function" ||
			typeof statePort.compareAndCommit !== "function"
		) {
			throw new TypeError("an atomic disable latch state port is required");
		}

		this.#authorityId = authority.authorityId;
		this.#authoritySetVersion = authority.authoritySetVersion;
		this.#publicKey = new Uint8Array(authority.publicKey.bytes);
		this.#scope = scope;
		this.#statePort = statePort;
	}

	/**
	 * Loads and validates the complete latest-only tuple before enabling consumption.
	 * @returns The restored fail-closed consumer state.
	 */
	async restore(): Promise<DisableConsumerState> {
		const publicationToken = {};
		this.#publicationToken = publicationToken;
		this.#state = undefined;
		try {
			const restored = await this.#statePort.load();
			const validated = this.#validateRestoredState(restored);
			if (this.#publicationToken === publicationToken) this.#state = validated;
		} catch {
			if (this.#publicationToken === publicationToken) this.#state = undefined;
		}
		return this.consumerState();
	}

	/**
	 * Returns a fresh, non-live view of the effective local latch.
	 * @returns The current fail-closed consumer state.
	 */
	consumerState(): DisableConsumerState {
		const state = this.#state;
		if (state === undefined) return { highestCounter: null, status: "blocked" };
		return { highestCounter: state.highestCounter, status: state.latch };
	}

	/**
	 * Verifies a detached envelope and proposes one atomic tuple transition.
	 * The in-memory effective state advances only after an exact committed outcome.
	 * @param envelope - Untrusted canonical preimage and signature bytes.
	 * @returns The applied counter or stable rejection classification.
	 */
	async apply(envelope: SignedDisableEnvelope): Promise<DisableApplyResult> {
		const detached = detachEnvelope(envelope);
		if (detached === undefined) return { applied: false, reason: "invalid-signature" };
		const verification = this.#verifyEnvelope(detached);
		if (!verification.accepted) return { applied: false, reason: verification.reason };

		const current = this.#state;
		if (current === undefined) return { applied: false, reason: "state-unavailable" };
		const { bytes, command, digest } = verification.envelope;
		if (command.counter < current.highestCounter) return { applied: false, reason: "stale-counter" };
		if (command.counter === current.highestCounter) {
			const exactReplay =
				current.envelopeBytes !== null &&
				current.envelopeDigest !== null &&
				bytesEqual(bytes, current.envelopeBytes) &&
				bytesEqual(digest, current.envelopeDigest);
			return {
				applied: false,
				reason: exactReplay ? "replay" : "equivocation",
			};
		}

		const next: DisableLatchState = {
			authoritySetVersion: this.#authoritySetVersion,
			envelopeBytes: new Uint8Array(bytes),
			envelopeDigest: new Uint8Array(digest),
			envelopeVersion: DISABLE_ENVELOPE_VERSION,
			highestCounter: command.counter,
			latch: "disabled",
			scope: this.#scope,
			stateVersion: DISABLE_STATE_VERSION,
		};

		try {
			const outcome = await this.#statePort.compareAndCommit(cloneState(current), cloneState(next));
			if (!isCommittedOutcome(outcome)) return { applied: false, reason: "state-commit-failed" };
		} catch {
			return { applied: false, reason: "state-commit-failed" };
		}

		this.#publicationToken = {};
		this.#state = cloneState(next);
		return { applied: true, counter: command.counter };
	}

	#verifyEnvelope(envelope: SignedDisableEnvelope): EnvelopeVerification {
		const decoded = decodeCommandRecord(envelope.canonicalBytes);
		if (decoded === undefined) return { accepted: false, reason: "invalid-signature" };
		const commandFailure = this.#commandFailureReason(decoded);
		if (commandFailure !== undefined) return { accepted: false, reason: commandFailure };

		const digest = hashDomain(DISABLE_ENVELOPE_DOMAIN_V1, envelope.canonicalBytes);
		let validSignature = false;
		try {
			validSignature =
				envelope.signature.byteLength === ED25519_SIGNATURE_BYTES &&
				ed25519.verify(envelope.signature, digest, this.#publicKey, { zip215: false });
		} catch {
			validSignature = false;
		}
		if (!validSignature) return { accepted: false, reason: "invalid-signature" };

		return {
			accepted: true,
			envelope: {
				bytes: envelope.canonicalBytes,
				command: decoded as unknown as DisableCommandPreimage,
				digest,
			},
		};
	}

	#commandFailureReason(
		decoded: Record<(typeof COMMAND_KEYS)[number], unknown>
	): DisableApplyFailureReason | undefined {
		if (decoded.version !== DISABLE_ENVELOPE_VERSION) {
			return "unsupported-version";
		}
		if (decoded.authority !== this.#authorityId) return "wrong-authority";
		if (decoded.authoritySetVersion !== this.#authoritySetVersion) {
			return "wrong-authority-set";
		}
		if (decoded.scope !== this.#scope) return "wrong-scope";
		if (decoded.capability !== "disable") return "wrong-capability";
		if (decoded.suite !== DISABLE_SUITE) return "wrong-suite";
		if (
			!isPositiveSafeInteger(decoded.counter) ||
			!(decoded.commandId instanceof Uint8Array) ||
			decoded.commandId.byteLength !== COMMAND_ID_BYTES
		) {
			return "invalid-signature";
		}
		return undefined;
	}

	#validateRestoredState(value: unknown): DisableLatchState {
		if (!isExactRecord(value, STATE_KEYS)) throw new TypeError("disable latch state has an invalid shape");
		if (
			value.stateVersion !== DISABLE_STATE_VERSION ||
			value.envelopeVersion !== DISABLE_ENVELOPE_VERSION ||
			value.authoritySetVersion !== this.#authoritySetVersion ||
			value.scope !== this.#scope ||
			!isNonNegativeSafeInteger(value.highestCounter) ||
			(value.latch !== "enabled" && value.latch !== "disabled")
		) {
			throw new TypeError("disable latch state metadata is invalid");
		}

		if (value.highestCounter === 0) {
			if (value.latch !== "enabled" || value.envelopeBytes !== null || value.envelopeDigest !== null) {
				throw new TypeError("empty disable latch state is inconsistent");
			}
			return cloneState(value as unknown as DisableLatchState);
		}

		if (
			value.latch !== "disabled" ||
			!(value.envelopeBytes instanceof Uint8Array) ||
			!(value.envelopeDigest instanceof Uint8Array) ||
			value.envelopeDigest.byteLength !== 32
		) {
			throw new TypeError("committed disable latch state is inconsistent");
		}
		const bytes = new Uint8Array(value.envelopeBytes);
		const digest = hashDomain(DISABLE_ENVELOPE_DOMAIN_V1, bytes);
		if (!bytesEqual(digest, value.envelopeDigest)) throw new TypeError("stored disable envelope digest is invalid");

		const decoded = decodeCommandRecord(bytes);
		if (
			decoded === undefined ||
			this.#commandFailureReason(decoded) !== undefined ||
			decoded.counter !== value.highestCounter ||
			!isPositiveSafeInteger(decoded.counter)
		) {
			throw new TypeError("stored disable envelope tuple is invalid");
		}

		return {
			authoritySetVersion: value.authoritySetVersion,
			envelopeBytes: bytes,
			envelopeDigest: new Uint8Array(value.envelopeDigest),
			envelopeVersion: value.envelopeVersion,
			highestCounter: value.highestCounter,
			latch: value.latch,
			scope: value.scope,
			stateVersion: value.stateVersion,
		};
	}
}

function detachEnvelope(value: unknown): SignedDisableEnvelope | undefined {
	try {
		if (!isExactRecord(value, ENVELOPE_KEYS)) return undefined;
		const candidate = value;
		if (!(candidate.canonicalBytes instanceof Uint8Array) || !(candidate.signature instanceof Uint8Array)) {
			return undefined;
		}
		return {
			canonicalBytes: new Uint8Array(candidate.canonicalBytes),
			signature: new Uint8Array(candidate.signature),
		};
	} catch {
		return undefined;
	}
}

function decodeCommandRecord(bytes: Uint8Array): Record<(typeof COMMAND_KEYS)[number], unknown> | undefined {
	try {
		const decoded = decodeCanonical(bytes, { maxBytes: 4096, maxDepth: 2, maxItems: 128 });
		return isExactRecord(decoded, COMMAND_KEYS) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function cloneState(state: DisableLatchState): DisableLatchState {
	return {
		...state,
		envelopeBytes: state.envelopeBytes === null ? null : new Uint8Array(state.envelopeBytes),
		envelopeDigest: state.envelopeDigest === null ? null : new Uint8Array(state.envelopeDigest),
	};
}

function isCommittedOutcome(value: unknown): boolean {
	return isExactRecord(value, ["outcome"] as const) && value.outcome === "committed";
}

function isExactRecord<const Keys extends readonly string[]>(
	value: unknown,
	expectedKeys: Keys
): value is Record<Keys[number], unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) return false;
	const keys = (ownKeys as string[]).sort();
	const expected = [...expectedKeys].sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => {
			if (key !== expected[index]) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
		})
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return isNonNegativeSafeInteger(value) && value > 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] as number) ^ (right[index] as number);
	}
	return difference === 0;
}
