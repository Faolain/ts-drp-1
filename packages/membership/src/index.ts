export type MembershipMode = "allowlist" | "invite" | "threshold-certificate";

export interface InviteCredential {
	readonly kind: "invite";
	readonly token: string;
}

export interface MembershipVerificationRequest<Credential = unknown> {
	readonly credential?: Credential;
	readonly peerId: string;
	readonly signal: AbortSignal;
}

export type MembershipDecision =
	| { readonly accepted: true; readonly mode: MembershipMode }
	| { readonly accepted: false; readonly mode: MembershipMode; readonly reason: string };

export type InviteMembershipDecision =
	| { readonly accepted: true; readonly mode: "invite" }
	| { readonly accepted: false; readonly mode: "invite"; readonly reason: "invite-invalid" };

export type AllowlistMembershipDecision =
	| { readonly accepted: true; readonly mode: "allowlist" }
	| { readonly accepted: false; readonly mode: "allowlist"; readonly reason: "peer-not-allowlisted" };

export interface MembershipVerifier<Credential = unknown> {
	verify(request: MembershipVerificationRequest<Credential>): Promise<MembershipDecision>;
}

export interface InviteVerifierOptions {
	readonly inviteToken: string;
}

/** Verifies one bounded invite secret without retaining or returning caller credentials. */
export class InviteVerifier implements MembershipVerifier<InviteCredential> {
	readonly #inviteToken: string;

	/**
	 *
	 * @param options
	 */
	constructor(options: InviteVerifierOptions) {
		if (typeof options.inviteToken !== "string" || options.inviteToken.length < 16) {
			throw new Error("invite token must contain at least 16 characters");
		}
		this.#inviteToken = options.inviteToken;
	}

	/**
	 *
	 * @param request
	 */
	async verify(request: MembershipVerificationRequest<InviteCredential>): Promise<InviteMembershipDecision> {
		await Promise.resolve();
		return request.credential?.kind === "invite" && constantTimeEqual(request.credential.token, this.#inviteToken)
			? { accepted: true, mode: "invite" }
			: { accepted: false, mode: "invite", reason: "invite-invalid" };
	}
}

export interface AllowlistVerifierOptions {
	readonly allowedPeerIds: readonly string[];
}

/** Verifies exact, case-sensitive peer identities against an immutable allowlist snapshot. */
export class AllowlistVerifier implements MembershipVerifier<unknown> {
	readonly #allowedPeerIds: ReadonlySet<string>;

	/**
	 *
	 * @param options
	 */
	constructor(options: AllowlistVerifierOptions) {
		this.#allowedPeerIds = new Set(options.allowedPeerIds);
	}

	/**
	 *
	 * @param request
	 */
	async verify(request: MembershipVerificationRequest<unknown>): Promise<AllowlistMembershipDecision> {
		await Promise.resolve();
		return this.#allowedPeerIds.has(request.peerId)
			? { accepted: true, mode: "allowlist" }
			: { accepted: false, mode: "allowlist", reason: "peer-not-allowlisted" };
	}
}

/** Type-level extension point; threshold-certificate verification is intentionally not implemented in Phase 1. */
export interface ThresholdCertificateVerifier extends MembershipVerifier<unknown> {
	readonly mode?: "threshold-certificate";
}

/**
 *
 * @param left
 * @param right
 */
export function constantTimeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	let difference = leftBytes.byteLength ^ rightBytes.byteLength;
	const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < length; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}
