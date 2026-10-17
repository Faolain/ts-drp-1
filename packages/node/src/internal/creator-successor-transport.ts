import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type SnapshotChunkProtocolPort, type SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import type { SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { OwnedIdentityChallengeAdmission, OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
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
} from "../snapshot-transfer.js";
import { CREATOR_CLOSE_HISTORY_MAX_BYTES } from "./creator-close-history.js";

// One checkpoint, one compact accumulator and framing, within the existing manifest-frame ceiling.
const MAX_BYTES = 212_387;
const FRAME_LIMITS = { maxBytes: MAX_BYTES, maxDepth: 2, maxItems: 64 };

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
	encodeCanonical(peers, FRAME_LIMITS);
	return Object.freeze([...new Set(peers)]);
}

export interface CreatorSuccessorAuxiliaryMaterial {
	readonly exactCanonicalSettlementBytes: Uint8Array | null;
	readonly exactCanonicalHistoryBytes: Uint8Array;
	readonly exactCanonicalRetirementBytes?: Uint8Array;
	readonly exactCanonicalAggregateBytes?: Uint8Array;
}
interface SigningIdentity {
	readonly author: string;
	readonly sign: SignRegisteredVertexDigest;
	isAuthorizedAuthor(author: string): boolean;
}
function decode(bytes: Uint8Array, keys: readonly string[]): Record<string, unknown> {
	const value = decodeCanonical(bytes, FRAME_LIMITS);
	const expectedKeys =
		value !== null &&
		typeof value === "object" &&
		keys.includes("exactCanonicalSettlementBytes") &&
		Object.hasOwn(value, "exactCanonicalRetirementBytes")
			? [...keys, "exactCanonicalRetirementBytes", "exactCanonicalAggregateBytes"]
			: keys;
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		compareBytes(bytes, encodeCanonical(value, FRAME_LIMITS)) !== 0 ||
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
	return Object.freeze({
		exactCanonicalSettlementBytes: settlement === null ? null : Uint8Array.from(settlement as Uint8Array),
		exactCanonicalHistoryBytes: Uint8Array.from(history),
		...(settlement === null
			? {
					exactCanonicalRetirementBytes: Uint8Array.from(retirement as Uint8Array),
					exactCanonicalAggregateBytes: Uint8Array.from(aggregate as Uint8Array),
				}
			: {}),
	});
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
			if (
				request.version !== 1 ||
				request.manifestDigest !== input.manifestDigest ||
				request.requesterPeer !== stream.peerId ||
				request.sourcePeer !== input.localPeerId ||
				!(request.nonce instanceof Uint8Array) ||
				request.nonce.byteLength !== 32 ||
				typeof request.author !== "string" ||
				!(input.isAuthorizedReader ?? input.identity.isAuthorizedAuthor)(request.author) ||
				!(await verify(request.author, signature, proof))
			)
				throw new TypeError("creator material requester is unauthorized");
			// Routing possession is transient and bounded by the existing transfer session ceiling.
			const connected = new Set(input.connectedPeers());
			for (const peer of authors.keys()) if (!connected.has(peer)) authors.delete(peer);
			if (!connected.has(stream.peerId)) throw new TypeError("creator material requester disconnected");
			if (!authors.has(stream.peerId) && authors.size >= SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS)
				throw new TypeError("creator material requester session limit reached");
			authors.set(stream.peerId, request.author);
			const response = {
				...input.material,
				kind: "creator-successor-material-response",
				version: 1,
				nonce: request.nonce,
				manifestDigest: input.manifestDigest,
				requesterPeer: stream.peerId,
				sourcePeer: input.localPeerId,
				author: input.identity.author,
			};
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(new Error("creator material response timed out")),
				SNAPSHOT_PULL_INACTIVITY_MS
			);
			try {
				await stream.write(
					encodeCanonical({ ...response, signature: await signTransportFrame(input.identity, response, controller.signal) }, FRAME_LIMITS),
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
 * Fetches bounded operation-private native materials over existing unlimited authenticated streams.
 * @param input The actual recipient transport, application identity and expected native manifest.
 * @returns Detached verified material and its operation-private source authorization.
 */
export async function receiveCreatorSuccessorMaterial(
	input: Readonly<{
		transport: SnapshotChunkProtocolPort;
		identity: SigningIdentity;
		peers: readonly string[];
		manifestDigest: string;
	}>
): Promise<
	CreatorSuccessorAuxiliaryMaterial & Readonly<{ authorization: SnapshotPeerAuthorization; peers: readonly string[] }>
> {
	const peers = captureCreatorSuccessorPeers(input.peers);
	const connected = new Set(input.transport.connectedPeers());
	const candidates = peers.filter((peer) => connected.has(peer));
	const failures: unknown[] = [];
	for (let attempt = 0; attempt < Math.min(candidates.length, SNAPSHOT_PULL_MAX_ATTEMPTS); attempt += 1) {
		const peer = candidates[attempt] as string;
		const nonce = crypto.getRandomValues(new Uint8Array(32));
		const request = {
			kind: "creator-successor-material-request",
			version: 1,
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
		let stream: SnapshotChunkProtocolStream | undefined;
		let received:
			| (CreatorSuccessorAuxiliaryMaterial &
					Readonly<{ authorization: SnapshotPeerAuthorization; peers: readonly string[] }>)
			| undefined;
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
			await stream.write(
				encodeCanonical({ ...request, signature: await signTransportFrame(input.identity, request, controller.signal) }, FRAME_LIMITS),
				{ signal: controller.signal }
			);
			const response = decode(await stream.read(MAX_BYTES, { signal: controller.signal }), [
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
			const { signature, ...proof } = response;
			if (
				response.kind !== "creator-successor-material-response" ||
				response.version !== 1 ||
				response.manifestDigest !== input.manifestDigest ||
				response.requesterPeer !== input.transport.localPeerId ||
				response.sourcePeer !== peer ||
				!(response.nonce instanceof Uint8Array) ||
				compareBytes(response.nonce, nonce) !== 0 ||
				typeof response.author !== "string" ||
				!input.identity.isAuthorizedAuthor(response.author) ||
				!(await verify(response.author, signature, proof))
			)
				throw new TypeError("creator material source is unauthorized");
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
		if (failed) {
			failures.push(primary);
			// A later peer must not hide uncertain native stream cleanup.
			if (cleanupFailed) break;
		} else if (received !== undefined) return received;
	}
	const cause = failures[0];
	throw new AggregateError(failures, "creator successor material transport failed", {
		cause: cause instanceof AggregateError ? (cause.cause ?? cause) : cause,
	});
}
