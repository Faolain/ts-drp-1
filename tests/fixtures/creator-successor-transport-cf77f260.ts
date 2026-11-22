// The creator-successor transport as of cf77f260 (before fix/skip-scope-carrier), verbatim except for
// its three relative imports, for the cross-version probe (tests/app-rollover-skip-scope-carrier-version.test.ts).
/* eslint-disable */
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type SnapshotChunkProtocolPort, type SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import type { SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { OwnedIdentityChallengeAdmission, OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { CREATOR_SUCCESSOR_TRANSPORT_LIMITS } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { decodeCreatorReattachmentCheckpoint } from "@ts-drp/protocol-v3/creator-checkpoint";
import {
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES,
	CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES } from "@ts-drp/protocol-v3/creator-issuance-retirement";
import { capturePromotionArray } from "@ts-drp/protocol-v3/internal/creator-forward-promotion";

import {
	SNAPSHOT_PULL_INACTIVITY_MS,
	SNAPSHOT_PULL_MAX_ATTEMPTS,
	SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS,
	type SnapshotPeerAuthorization,
} from "../../packages/node/src/snapshot-transfer.js";
import { CREATOR_CLOSE_HISTORY_MAX_BYTES } from "../../packages/node/src/internal/creator-close-history.js";
import { CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES } from "../../packages/node/src/internal/creator-close-membership.js";

// One bounded checkpoint plus its compact close membership. Requests keep their
// original manifest-frame ceiling; a response additionally carries at most one
// journal image's worth of immutable membership data, never vertex bodies.
const MAX_BYTES = CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxResponseBytes;
const FRAME_LIMITS = { maxBytes: MAX_BYTES, maxDepth: 2, maxItems: 64 };
const REQUEST_LIMITS = { ...FRAME_LIMITS, maxBytes: CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes };

/**
 * Captures only the bounded attempt roster, without invoking caller array accessors or iterators.
 * @param value The untrusted recipient peer roster.
 * @returns Detached peer identities bounded by the existing attempt and frame ceilings.
 */
export function captureCreatorSuccessorPeers(value: unknown): readonly string[] {
	const captured = capturePromotionArray(value, SNAPSHOT_PULL_MAX_ATTEMPTS);
	if (captured === undefined || captured.length === 0)
		throw new TypeError("creator recipient peer attempts are unbounded");
	const peers: string[] = [];
	for (const peer of captured) {
		if (typeof peer !== "string" || peer.length === 0)
			throw new TypeError("creator recipient peer identity is invalid");
		peers.push(peer);
	}
	encodeCanonical(peers, REQUEST_LIMITS);
	return Object.freeze([...new Set(peers)]);
}

export interface CreatorSuccessorAuxiliaryMaterial {
	readonly exactCanonicalSettlementBytes: Uint8Array | null;
	readonly exactCanonicalHistoryBytes: Uint8Array;
	/** Digest membership authenticated by the offered Cut; contains no local witnesses. */
	readonly exactCanonicalCloseMembershipBytes?: Uint8Array;
	/** Current-point proof, requested separately from adjacent source membership. */
	readonly exactCanonicalReattachmentCheckpointBytes?: Uint8Array;
	readonly exactCanonicalRetirementBytes?: Uint8Array;
	readonly exactCanonicalAggregateBytes?: Uint8Array;
}
interface SigningIdentity {
	readonly author: string;
	readonly sign: SignRegisteredVertexDigest;
	isAuthorizedAuthor(author: string): boolean;
}
/** Authenticated current-point unavailability; the admitted fetch may retry until adoption. */
export class CreatorCheckpointMaterialUnavailable extends Error {
	readonly code = "creator-checkpoint-not-adopted";
	readonly retryClass = "transient";
	constructor() { super("creator checkpoint material is not yet adopted"); this.name = "CreatorCheckpointMaterialUnavailable"; }
}
function decode(bytes: Uint8Array, keys: readonly string[]): Record<string, unknown> {
	const limits = keys.includes("exactCanonicalSettlementBytes") ? FRAME_LIMITS : REQUEST_LIMITS;
	const value = decodeCanonical(bytes, limits);
	let expectedKeys =
		value !== null &&
		typeof value === "object" &&
		keys.includes("exactCanonicalSettlementBytes") &&
		Object.hasOwn(value, "exactCanonicalRetirementBytes")
			? [...keys, "exactCanonicalRetirementBytes", "exactCanonicalAggregateBytes"]
			: keys;
	if (value !== null && typeof value === "object" && keys.includes("exactCanonicalSettlementBytes") &&
		Object.hasOwn(value, "exactCanonicalCloseMembershipBytes"))
		expectedKeys = [...expectedKeys, "exactCanonicalCloseMembershipBytes"];
	if (value !== null && typeof value === "object" && keys.includes("exactCanonicalSettlementBytes") &&
		Object.hasOwn(value, "exactCanonicalReattachmentCheckpointBytes"))
		expectedKeys = [...expectedKeys, "exactCanonicalReattachmentCheckpointBytes"];
	if (value !== null && typeof value === "object" && !keys.includes("exactCanonicalSettlementBytes") &&
		Object.hasOwn(value, "materialKind")) expectedKeys = [...expectedKeys, "materialKind"];
	if (value !== null && typeof value === "object" && keys.includes("exactCanonicalSettlementBytes") &&
		Reflect.get(value, "kind") === "creator-successor-material-unavailable")
		expectedKeys = ["kind", "version", "nonce", "manifestDigest", "requesterPeer", "sourcePeer", "author", "signature", "reason"];
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		compareBytes(bytes, encodeCanonical(value, limits)) !== 0 ||
		Object.keys(value).sort().join(",") !== [...expectedKeys].sort().join(",")
	)
		throw new TypeError("creator material frame is invalid");
	return value as Record<string, unknown>;
}
function digest(value: unknown): Uint8Array {
	return hashDomain("ts-drp/creator-successor-transport/v1", encodeCanonical(value, FRAME_LIMITS));
}
const ownedTransportRequests = new WeakMap<OwnedSigningRequest, OwnedIdentityChallengeAdmission>();
/** Consumer only of this original transport owner's private request registry. */
export function consumeOwnedCreatorTransportSigningRequest(request: unknown): OwnedIdentityChallengeAdmission | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const captured = ownedTransportRequests.get(request as OwnedSigningRequest);
	ownedTransportRequests.delete(request as OwnedSigningRequest);
	return captured;
}
/** Original bounded transfer turn: routing possession never grants operation,
 * source membership, finality or successor validity. No caller mint is exported. */
async function signTransportFrame(identity: SigningIdentity, frame: Record<string, unknown>, signal: AbortSignal): Promise<Uint8Array> {
	const bytes = encodeCanonical(frame, FRAME_LIMITS), request = Object.freeze({}) as OwnedSigningRequest;
	if (frame.author !== identity.author || !/^[0-9a-f]{64}$/u.test(identity.author)) throw new TypeError("creator transport signing author is invalid");
	let active = true;
	const check = (): void => {
		if (!active) throw new TypeError("creator transport original signing turn is released");
		signal.throwIfAborted();
		if (compareBytes(bytes, encodeCanonical(frame, FRAME_LIMITS)) !== 0) throw new TypeError("creator transport exact frame changed");
	};
	ownedTransportRequests.set(request, Object.freeze({ kind: "transport", bytes,
		publicKey: Uint8Array.from(identity.author.match(/../gu) ?? [], byte => Number.parseInt(byte, 16)),
		checkWhile: async <T>(action: () => Promise<T>): Promise<T> => { check(); const value = await action(); check(); return value; } }));
	try { check(); const signature = await identity.sign(hashDomain("ts-drp/creator-successor-transport/v1", bytes), request); check(); return signature; }
	finally { active = false; ownedTransportRequests.delete(request); }
}
async function verify(author: unknown, signature: unknown, value: unknown): Promise<boolean> {
	if (
		typeof author !== "string" ||
		!/^[0-9a-f]{64}$/u.test(author) ||
		!(signature instanceof Uint8Array) ||
		signature.byteLength !== 64
	)
		return false;
	const key = Uint8Array.from(author.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
	const imported = await crypto.subtle.importKey("raw", key, "Ed25519", false, ["verify"]);
	return crypto.subtle.verify("Ed25519", imported, Uint8Array.from(signature), Uint8Array.from(digest(value)));
}
function auxiliary(record: Record<string, unknown>): CreatorSuccessorAuxiliaryMaterial {
	const settlement = record.exactCanonicalSettlementBytes,
		history = record.exactCanonicalHistoryBytes;
	if (
		(settlement !== null &&
			(!(settlement instanceof Uint8Array) ||
				settlement.byteLength === 0 ||
				settlement.byteLength > CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES)) ||
		!(history instanceof Uint8Array) ||
		history.byteLength === 0 ||
		history.byteLength > CREATOR_CLOSE_HISTORY_MAX_BYTES
	)
		throw new TypeError("creator material bounds are invalid");
	const retirement = record.exactCanonicalRetirementBytes,
		aggregate = record.exactCanonicalAggregateBytes;
	if (
		settlement === null
			? !(retirement instanceof Uint8Array) ||
				retirement.byteLength === 0 ||
				retirement.byteLength > CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES ||
				!(aggregate instanceof Uint8Array) ||
				aggregate.byteLength === 0 ||
				aggregate.byteLength > CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES
			: retirement !== undefined || aggregate !== undefined
	)
		throw new TypeError("creator material none companions are invalid");
	const membership = record.exactCanonicalCloseMembershipBytes;
	if (membership !== undefined && (!(membership instanceof Uint8Array) || membership.byteLength === 0 ||
		membership.byteLength > CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES))
		throw new TypeError("creator material membership bounds are invalid");
	const checkpoint = record.exactCanonicalReattachmentCheckpointBytes;
	if (checkpoint !== undefined && decodeCreatorReattachmentCheckpoint(checkpoint) === undefined)
		throw new TypeError("creator material checkpoint bounds are invalid");
	return Object.freeze({
		exactCanonicalSettlementBytes: settlement === null ? null : Uint8Array.from(settlement as Uint8Array),
		exactCanonicalHistoryBytes: Uint8Array.from(history),
		...(membership === undefined ? {} : { exactCanonicalCloseMembershipBytes: Uint8Array.from(membership as Uint8Array) }),
		...(checkpoint === undefined ? {} : { exactCanonicalReattachmentCheckpointBytes: Uint8Array.from(checkpoint as Uint8Array) }),
		...(settlement === null
			? {
					exactCanonicalRetirementBytes: Uint8Array.from(retirement as Uint8Array),
					exactCanonicalAggregateBytes: Uint8Array.from(aggregate as Uint8Array),
				}
			: {}),
	});
}

/** Why a creator's material server refused a request outright (it will never answer it). */
export type CreatorSuccessorMaterialRefusalReason = "unauthorized" | "stale";
const REFUSAL_REASONS: readonly string[] = ["unauthorized", "stale"];
const REFUSAL_KEYS = ["kind", "nonce", "reason", "requesterPeer", "sourcePeer", "version"] as const;
const REFUSAL_MAX_BYTES = 512;
const REFUSAL_LIMITS = { maxBytes: REFUSAL_MAX_BYTES, maxDepth: 2, maxItems: 64 };

/** The source refused this request explicitly: terminal for that source, never retried. */
export class CreatorSuccessorMaterialRefused extends Error {
	readonly code = "creator-successor-material-refused";
	readonly retryClass = "terminal";
	/**
	 * @param reason - Why the creator refused.
	 */
	constructor(readonly reason: CreatorSuccessorMaterialRefusalReason) {
		super(`creator material request was refused: ${reason}`);
		this.name = "CreatorSuccessorMaterialRefused";
	}
}

async function refuse(
	stream: SnapshotChunkProtocolStream,
	nonce: unknown,
	reason: CreatorSuccessorMaterialRefusalReason,
	sourcePeer: string
): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("creator material refusal timed out")),
		SNAPSHOT_PULL_INACTIVITY_MS
	);
	try {
		await stream.write(
			encodeCanonical(
				{
					kind: "creator-successor-material-refused",
					version: 1,
					reason,
					nonce: nonce instanceof Uint8Array && nonce.byteLength === 32 ? Uint8Array.from(nonce) : new Uint8Array(0),
					requesterPeer: stream.peerId,
					sourcePeer,
				},
				REFUSAL_LIMITS
			),
			{ signal: controller.signal }
		);
		await stream.close();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The source's explicit refusal of this exact request, or undefined when the frame is not one.
 * @param bytes - The response frame.
 * @param nonce - This request's nonce.
 * @param requesterPeer - This requester.
 * @param sourcePeer - The source asked.
 * @returns The refusal reason.
 */
function refusalOf(
	bytes: Uint8Array,
	nonce: Uint8Array,
	requesterPeer: string,
	sourcePeer: string
): CreatorSuccessorMaterialRefusalReason | undefined {
	if (bytes.byteLength > REFUSAL_MAX_BYTES) return undefined;
	let value: unknown;
	try {
		value = decodeCanonical(bytes, REFUSAL_LIMITS);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.kind !== "creator-successor-material-refused" ||
		Object.keys(record).sort().join(",") !== REFUSAL_KEYS.join(",") ||
		record.version !== 1 ||
		typeof record.reason !== "string" ||
		!REFUSAL_REASONS.includes(record.reason) ||
		record.requesterPeer !== requesterPeer ||
		record.sourcePeer !== sourcePeer ||
		!(record.nonce instanceof Uint8Array) ||
		compareBytes(record.nonce, nonce) !== 0
	)
		return undefined;
	return record.reason as CreatorSuccessorMaterialRefusalReason;
}

/**
 * Peer possession binds routing, while signed protocol carriers remain the only successor authority.
 * @param input Native source material, its current application identity and authenticated transport peers.
 * @returns A bounded transient peer binding and native control-frame handler.
 */
export function createCreatorSuccessorMaterialServer(
	input: Readonly<{
		identity: SigningIdentity;
		localPeerId: string;
		/** Explicit app reader policy, distinct from trusted source author admission. */
		isAuthorizedReader?(author: string): boolean;
		manifestDigest: string;
		material: CreatorSuccessorAuxiliaryMaterial;
		connectedPeers(): readonly string[];
		/**
		 * Optional gate before an authorized request's signed response (decision row 61: the room
		 * holds it until the creator has adopted the successor it serves). A refusal never waits.
		 */
		admitResponse?(peerId: string, signal: AbortSignal): Promise<void>;
	}>
): Readonly<{
	authorization: SnapshotPeerAuthorization;
	control(stream: SnapshotChunkProtocolStream, bytes: Uint8Array): Promise<boolean>;
}> {
	const authors = new Map<string, string>();
	return Object.freeze({
		authorization: Object.freeze({
			authorForPeer: (peer: string) => {
				if (!input.connectedPeers().includes(peer)) {
					authors.delete(peer);
					return undefined;
				}
				return authors.get(peer);
			},
			isAuthorizedAuthor: input.isAuthorizedReader ?? input.identity.isAuthorizedAuthor,
		}),
		control: async (stream: SnapshotChunkProtocolStream, bytes: Uint8Array): Promise<boolean> => {
			const first = decodeCanonical(bytes, FRAME_LIMITS) as Record<string, unknown>;
			if (first?.kind !== "creator-successor-material-request") return false;
			const request = decode(bytes, [
				"kind",
				"version",
				"nonce",
				"manifestDigest",
				"requesterPeer",
				"sourcePeer",
				"author",
				"signature",
			]);
			const { signature, ...proof } = request;
			const checkpointRequested = request.version === 2 && request.materialKind === "checkpoint";
			// A request this server will never answer gets an explicit refusal, so the requester stops
			// instead of retrying an abort it must treat as transient. The refusal is unsigned: it is
			// bound to the authenticated stream's peers and the request's nonce, grants nothing, and
			// only ends the requester's attempts at this one peer.
			const refusal: CreatorSuccessorMaterialRefusalReason | undefined =
				!(checkpointRequested || (request.version === 1 && !Object.hasOwn(request, "materialKind"))) ||
				request.requesterPeer !== stream.peerId ||
				request.sourcePeer !== input.localPeerId ||
				!(request.nonce instanceof Uint8Array) ||
				request.nonce.byteLength !== 32 ||
				typeof request.author !== "string" ||
				!(input.isAuthorizedReader ?? input.identity.isAuthorizedAuthor)(request.author) ||
				!(await verify(request.author, signature, proof))
					? "unauthorized"
					: request.manifestDigest !== input.manifestDigest
						? "stale"
						: undefined;
			if (refusal !== undefined) {
				await refuse(stream, request.nonce, refusal, input.localPeerId);
				return true;
			}
			// Routing possession is transient and bounded by the existing transfer session ceiling.
			const connected = new Set(input.connectedPeers());
			for (const peer of authors.keys()) if (!connected.has(peer)) authors.delete(peer);
			if (!connected.has(stream.peerId)) throw new TypeError("creator material requester disconnected");
			if (!authors.has(stream.peerId) && authors.size >= SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS)
				throw new TypeError("creator material requester session limit reached");
			// A string: any other author was refused above.
			authors.set(stream.peerId, request.author as string);
			const { exactCanonicalCloseMembershipBytes: membership,
				exactCanonicalReattachmentCheckpointBytes: checkpoint, ...common } = auxiliary(input.material as unknown as Record<string, unknown>);
			const unavailable = checkpointRequested && checkpoint === undefined;
			const response = {
				...(unavailable ? { kind: "creator-successor-material-unavailable", version: 1, reason: "checkpoint-not-adopted" } : {
				...common,
				...(checkpointRequested ? { exactCanonicalReattachmentCheckpointBytes: checkpoint }
					: membership === undefined ? {} : { exactCanonicalCloseMembershipBytes: membership }),
				kind: "creator-successor-material-response",
				version: checkpointRequested ? 3 : membership === undefined ? 1 : 2,
				}),
				nonce: request.nonce,
				manifestDigest: input.manifestDigest,
				requesterPeer: stream.peerId,
				sourcePeer: input.localPeerId,
				author: input.identity.author,
			};
			// Reserve the whole signed response before entering its signing turn.
			// The separately requested checkpoint never consumes membership space.
			const responseLimits = checkpointRequested ? REQUEST_LIMITS : FRAME_LIMITS;
			encodeCanonical({ ...response, signature: new Uint8Array(64) }, responseLimits);
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(new Error("creator material response timed out")),
				SNAPSHOT_PULL_INACTIVITY_MS
			);
			try {
				await input.admitResponse?.(stream.peerId, controller.signal);
				await stream.write(
					encodeCanonical({ ...response, signature: await signTransportFrame(input.identity, response, controller.signal) },
						responseLimits),
					{ signal: controller.signal }
				);
				await stream.close();
			} finally {
				clearTimeout(timer);
			}
			return true;
		},
	});
}

/**
 * Reviewed pacing of a Writer's retries of transient creator-successor material unavailability
 * (decision row 61, option E). After a round in which every connected candidate failed
 * transiently, or none was connected, the next round waits this long, doubling per round up to
 * the maximum. One attempt is in flight at a time and each keeps its own
 * SNAPSHOT_PULL_INACTIVITY_MS deadline, so a fetch makes at most one attempt per listed peer
 * (at most SNAPSHOT_PULL_MAX_ATTEMPTS) per round. There is no total deadline: a creator holds an
 * early request until it has adopted the successor it serves, and any finite total would only move
 * that cliff. The fetch ends when the material arrives, when every listed peer has failed
 * terminally, or when its caller's lifetime (`retryUntil`) ends.
 */
export const CREATOR_SUCCESSOR_MATERIAL_RETRY_INITIAL_MS = 250 as const;
/** The longest pause between two rounds of material attempts (see CREATOR_SUCCESSOR_MATERIAL_RETRY_INITIAL_MS). */
export const CREATOR_SUCCESSOR_MATERIAL_RETRY_MAX_MS = 5_000 as const;

type ReceivedCreatorSuccessorMaterial = CreatorSuccessorAuxiliaryMaterial &
	Readonly<{ authorization: SnapshotPeerAuthorization; peers: readonly string[] }>;

/**
 * One material attempt's outcome. Transient: the attempt's own deadline or the caller's lifetime
 * ended it, or opening, writing or reading the stream failed (a reset, an ended stream, no
 * connection). Terminal: signing failed, the source refused the request explicitly (an
 * unauthorized reader, or a successor it no longer serves), or the response itself is unacceptable (malformed frame,
 * wrong kind, version, manifest, peers or nonce, unauthorized author, bad signature, invalid
 * bounds). Uncertain cleanup: the stream's release could not be confirmed.
 */
type MaterialAttempt =
	| Readonly<{ kind: "received"; value: ReceivedCreatorSuccessorMaterial }>
	| Readonly<{ kind: "transient" | "terminal" | "uncertain-cleanup"; failure: unknown }>;

async function attemptCreatorSuccessorMaterial(
	input: Readonly<{
		transport: SnapshotChunkProtocolPort;
		identity: SigningIdentity;
		manifestDigest: string;
		materialKind?: "checkpoint";
	}>,
	peer: string,
	lifetime: AbortSignal | undefined
): Promise<MaterialAttempt> {
	const nonce = crypto.getRandomValues(new Uint8Array(32));
	const request = {
		kind: "creator-successor-material-request",
		version: input.materialKind === "checkpoint" ? 2 : 1,
		...(input.materialKind === "checkpoint" ? { materialKind: "checkpoint" } : {}),
		nonce,
		manifestDigest: input.manifestDigest,
		requesterPeer: input.transport.localPeerId,
		sourcePeer: peer,
		author: input.identity.author,
	};
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("creator material request timed out")),
		SNAPSHOT_PULL_INACTIVITY_MS
	);
	const lifetimeEnded = (): void => controller.abort(lifetime?.reason);
	lifetime?.addEventListener("abort", lifetimeEnded, { once: true });
	if (lifetime?.aborted === true) lifetimeEnded();
	let stream: SnapshotChunkProtocolStream | undefined;
	let received: ReceivedCreatorSuccessorMaterial | undefined;
	let retryableUnavailable = false;
	let phase: "stream" | "signing" | "response" = "stream";
	let failed = false;
	let cleanupFailed = false;
	let primary: unknown;
	const cleanupFailure = (error: unknown): void => {
		cleanupFailed = true;
		primary = failed
			? new AggregateError([primary, error], "creator material attempt and cleanup failed", { cause: primary })
			: error;
		failed = true;
	};
	try {
		stream = await input.transport.open(peer, { signal: controller.signal });
		phase = "signing";
		const signature = await signTransportFrame(input.identity, request, controller.signal);
		phase = "stream";
		await stream.write(encodeCanonical({ ...request, signature }, FRAME_LIMITS), { signal: controller.signal });
		const bytes = await stream.read(MAX_BYTES, { signal: controller.signal });
		phase = "response";
		const refused = refusalOf(bytes, nonce, input.transport.localPeerId, peer);
		if (refused !== undefined) throw new CreatorSuccessorMaterialRefused(refused);
		const response = decode(bytes, [
			"kind",
			"version",
			"nonce",
			"manifestDigest",
			"requesterPeer",
			"sourcePeer",
			"author",
			"signature",
			"exactCanonicalSettlementBytes",
			"exactCanonicalHistoryBytes",
		]);
		const { signature: responseSignature, ...proof } = response;
		const unavailable = response.kind === "creator-successor-material-unavailable";
		if (
			(unavailable
				? input.materialKind !== "checkpoint" || response.version !== 1 || response.reason !== "checkpoint-not-adopted" ||
					bytes.byteLength > REQUEST_LIMITS.maxBytes
				: response.kind !== "creator-successor-material-response" || (input.materialKind === "checkpoint"
				? response.version !== 3 || !Object.hasOwn(response, "exactCanonicalReattachmentCheckpointBytes") ||
					Object.hasOwn(response, "exactCanonicalCloseMembershipBytes") || bytes.byteLength > REQUEST_LIMITS.maxBytes
				: (response.version !== 1 && response.version !== 2) ||
					(response.version === 2) !== Object.hasOwn(response, "exactCanonicalCloseMembershipBytes") ||
					Object.hasOwn(response, "exactCanonicalReattachmentCheckpointBytes"))) ||
			response.manifestDigest !== input.manifestDigest ||
			response.requesterPeer !== input.transport.localPeerId ||
			response.sourcePeer !== peer ||
			!(response.nonce instanceof Uint8Array) ||
			compareBytes(response.nonce, nonce) !== 0 ||
			typeof response.author !== "string" ||
			!input.identity.isAuthorizedAuthor(response.author) ||
			!(await verify(response.author, responseSignature, proof))
		)
			throw new TypeError("creator material source is unauthorized");
		if (unavailable) {
			retryableUnavailable = true;
			throw new CreatorCheckpointMaterialUnavailable();
		}
		const author = response.author;
		received = Object.freeze({
			...auxiliary(response),
			peers: Object.freeze([peer]),
			authorization: Object.freeze({
				authorForPeer: (candidate: string) => (candidate === peer ? author : undefined),
				isAuthorizedAuthor: input.identity.isAuthorizedAuthor,
			}),
		});
	} catch (error) {
		failed = true;
		primary = error;
	}
	clearTimeout(timer);
	lifetime?.removeEventListener("abort", lifetimeEnded);
	if (failed) {
		try {
			stream?.abort(primary instanceof Error ? primary : undefined);
		} catch (error) {
			cleanupFailure(error);
		}
	}
	try {
		await stream?.close();
	} catch (error) {
		cleanupFailure(error);
		try {
			stream?.abort(error instanceof Error ? error : undefined);
		} catch (abortError) {
			cleanupFailure(abortError);
		}
	}
	if (cleanupFailed) return { kind: "uncertain-cleanup", failure: primary };
	if (!failed && received !== undefined) return { kind: "received", value: received };
	// The network port wraps both framing violations and ordinary resets in protocol-violation.
	// Only the length decoder's definite violations are terminal before a response is available.
	let framingViolation = false;
	let cause = primary;
	for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
		if (cause.name === "InvalidDataLengthError" || cause.name === "InvalidDataLengthLengthError") {
			framingViolation = true;
			break;
		}
		cause = cause.cause;
	}
	const terminal = framingViolation || (phase === "response" && !retryableUnavailable) || (phase === "signing" && !controller.signal.aborted);
	return { kind: terminal ? "terminal" : "transient", failure: primary };
}

/**
 * Waits between two rounds of material attempts.
 * @param ms The pause.
 * @param lifetime The caller's lifetime.
 * @returns Whether the pause completed (false when the lifetime ended first).
 */
function pauseMaterialRetry(ms: number, lifetime: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (lifetime.aborted) {
			resolve(false);
			return;
		}
		const done = (completed: boolean): void => {
			clearTimeout(timer);
			lifetime.removeEventListener("abort", ended);
			resolve(completed);
		};
		const ended = (): void => done(false);
		const timer = setTimeout(() => done(true), ms);
		lifetime.addEventListener("abort", ended, { once: true });
	});
}

/**
 * Fetches bounded operation-private native materials over existing unlimited authenticated streams.
 * Without `retryUntil`, one pass over the connected listed peers. With it (decision row 61, option
 * E), transient unavailability is retried with a fresh nonce, rotating over the listed peers that
 * are connected at each round, one attempt in flight, paced by CREATOR_SUCCESSOR_MATERIAL_RETRY_*,
 * until the material arrives, every listed peer has failed terminally, or `retryUntil` aborts.
 * Uncertain stream cleanup ends the fetch at once in both modes. The failure kept for the
 * diagnostic is one per listed peer, in first-failure order.
 * @param input The actual recipient transport, application identity and expected native manifest.
 * @returns Detached verified material and its operation-private source authorization.
 */
export async function receiveCreatorSuccessorMaterial(
	input: Readonly<{
		transport: SnapshotChunkProtocolPort;
		identity: SigningIdentity;
		peers: readonly string[];
		manifestDigest: string;
		/** A gap requests current-point proof instead of the unrelated final-close membership. */
		materialKind?: "checkpoint";
		/** The caller's lifetime; when present, transient unavailability is retried until it aborts. */
		retryUntil?: AbortSignal;
	}>
): Promise<ReceivedCreatorSuccessorMaterial> {
	const peers = captureCreatorSuccessorPeers(input.peers);
	const lifetime = input.retryUntil;
	const failures = new Map<string, unknown>();
	const terminal = new Set<string>();
	let pause: number = CREATOR_SUCCESSOR_MATERIAL_RETRY_INITIAL_MS;
	const failure = (): AggregateError => {
		const errors = [...failures.values()];
		const cause = errors[0] ?? lifetime?.reason;
		return new AggregateError(errors, "creator successor material transport failed", {
			cause: cause instanceof AggregateError ? (cause.cause ?? cause) : cause,
		});
	};
	for (;;) {
		const connected = new Set(input.transport.connectedPeers());
		for (const peer of peers) {
			if (lifetime?.aborted === true) throw failure();
			if (terminal.has(peer) || !connected.has(peer)) continue;
			const attempt = await attemptCreatorSuccessorMaterial(input, peer, lifetime);
			if (attempt.kind === "received") return attempt.value;
			failures.set(peer, attempt.failure);
			// A later peer must not hide uncertain native stream cleanup.
			if (attempt.kind === "uncertain-cleanup") throw failure();
			if (attempt.kind === "terminal") terminal.add(peer);
		}
		if (lifetime === undefined || peers.every((peer) => terminal.has(peer))) throw failure();
		if (!(await pauseMaterialRetry(pause, lifetime))) throw failure();
		pause = Math.min(pause * 2, CREATOR_SUCCESSOR_MATERIAL_RETRY_MAX_MS);
	}
}
