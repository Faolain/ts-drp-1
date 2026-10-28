import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { V3RoomCurrencyStatement, V3RoomSession } from "@ts-drp/node/v3-room";
import { Message, MessageType } from "@ts-drp/types";

import type { V3RoomSuccessorOffer } from "./rollover.js";

/**
 * Successor-offer delivery over the page's existing network node (no new transport): direct
 * `/drp/message` streams carrying `MESSAGE_TYPE_CUSTOM` frames on a per-room queue, the same
 * path the room's settlement-source selection already uses.
 *
 * - The creator announces each adopted offer to the room peers it knows (its live-topic peers and
 *   every peer that asked), and answers a member's request with its latest offer.
 * - A member asks the creator (the room's creator routing hint) when it binds, whenever the creator
 *   (re)connects, while a move of its waits for the next epoch, and on a slow poll. Catch-up is
 *   pull-driven by the party that knows it is behind, so a missed announcement, a late join or a
 *   reconnect needs no creator memory of members. The creator serves only its latest successor,
 *   so a member that missed rollovers installs the latest offer directly (the install fetches the
 *   creator's reattachment checkpoint for the gap).
 * - An offer is authenticated only by `installCreatorSuccessor` (its commit QC, trust record and
 *   manifest against the member's own current trust). The envelope's epoch is an untrusted hint
 *   used to skip offers that cannot be newer; a forged or stale offer is refused by the install
 *   with no state change, and is not retried before a backoff.
 * - Material comes from the creator only (members never serve successor material), so the
 *   install's peers are the creator.
 * - Sync before sending (owner decision B): a member already at the creator's epoch gets the
 *   creator's currency statement instead (its current epoch, anchor and admitted frontiers). The
 *   member hands it to its room (`confirmCurrent`) only when it came from the creator's peer, the
 *   stream's authenticated sender; the room checks the epoch, anchor and its own frontier.
 *
 * Size: `/drp/message` and the creator-successor material protocol do not run on limited (relayed)
 * connections, so a member reachable only over a relay waits for a direct connection, as live
 * sync does. Offers are still capped below Circuit Relay v2's 128 KiB per-connection data limit
 * (V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES) so that enabling limited connections later cannot strand them.
 */

/** The largest offer frame sent or accepted: below Circuit Relay v2's 128 KiB data limit. */
export const V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES = 120 * 1024;
/** A member's slow poll for the creator's latest offer. */
export const V3_ROOM_SUCCESSOR_POLL_MS = 15_000;
const REQUEST_MIN_INTERVAL_MS = 1_000;
const ANSWER_MIN_INTERVAL_MS = 500;
const SEND_DEADLINE_MS = 10_000;
const KNOWN_PEERS_MAX = 64;
const FAILED_OFFERS_MAX = 8;
const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const;
const OFFER_KIND = "ts-drp-v3-successor-offer";
const REQUEST_KIND = "ts-drp-v3-successor-offer-request";
const CURRENCY_KIND = "ts-drp-v3-room-currency";
// Depth 3: a currency frame's frontiers are [author, sequence] pairs.
const FRAME_LIMITS = { maxBytes: V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES, maxDepth: 3, maxItems: 64 };
const OFFER_KEYS = ["cut", "kind", "manifest", "qc", "successorEpoch", "trust", "version"];
const REQUEST_KEYS = ["epoch", "kind", "version"];
const CURRENCY_KEYS = ["anchorDigest", "epoch", "frontiers", "kind", "objectId", "version"];

/** The page's network node as the delivery uses it (a `DRPNode`). */
export interface V3RoomSuccessorNode {
	readonly networkNode: Readonly<{
		peerId: string;
		getAllPeers(): string[];
		sendMessage(peerId: string, message: Message, options?: { readonly signal?: AbortSignal }): Promise<void>;
		subscribeToPeerConnections?(handler: (peerId: string) => void): () => void;
	}>;
	readonly messageQueueManager: Readonly<{
		subscribe(queueId: string, handler: (message: Message) => void | Promise<void>): void;
		close(queueId: string): void;
	}>;
}

/** The byte channel the delivery runs on; `createV3RoomSuccessorChannel` binds it to a node. */
export interface V3RoomSuccessorChannel {
	readonly localPeerId: string;
	/** Peers connected now. */
	peers(): readonly string[];
	send(peerId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
	listen(listener: (sender: string, bytes: Uint8Array) => void): () => void;
	onPeerConnected(listener: (peerId: string) => void): () => void;
	close(): void;
}

/**
 * The room's successor channel on the page's node: one message queue per room, frames sent on
 * direct authenticated streams. The sender is the stream's authenticated peer.
 * @param node - The page's started node.
 * @param objectId - The room.
 * @returns The channel; close it with the room.
 */
export function createV3RoomSuccessorChannel(node: V3RoomSuccessorNode, objectId: string): V3RoomSuccessorChannel {
	const queueId = `ts-drp-v3-successor/${objectId}`;
	// A node without a message queue or direct sends (a test stub; every DRPNode has both) gets an
	// inert channel: nothing is announced or received, and the room never follows a successor.
	if (
		typeof Reflect.get(node, "messageQueueManager")?.subscribe !== "function" ||
		typeof Reflect.get(node.networkNode, "sendMessage") !== "function"
	)
		return Object.freeze({
			localPeerId: String(Reflect.get(node.networkNode ?? {}, "peerId") ?? ""),
			peers: () => [],
			send: () => Promise.reject(new TypeError("v3 room successor channel is inert")),
			listen: () => () => undefined,
			onPeerConnected: () => () => undefined,
			close: () => undefined,
		});
	const listeners = new Set<(sender: string, bytes: Uint8Array) => void>();
	let closed = false;
	node.messageQueueManager.subscribe(queueId, (message) => {
		if (closed || message.type !== MessageType.MESSAGE_TYPE_CUSTOM || message.objectId !== queueId) return;
		if (!(message.data instanceof Uint8Array) || message.data.byteLength > V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES) return;
		for (const listener of [...listeners]) listener(message.sender, Uint8Array.from(message.data));
	});
	return Object.freeze({
		localPeerId: node.networkNode.peerId,
		peers: () => node.networkNode.getAllPeers(),
		send: (peerId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> =>
			node.networkNode.sendMessage(
				peerId,
				Message.create({
					sender: node.networkNode.peerId,
					type: MessageType.MESSAGE_TYPE_CUSTOM,
					objectId: queueId,
					data: bytes,
				}),
				{ signal }
			),
		listen: (listener: (sender: string, bytes: Uint8Array) => void): (() => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onPeerConnected: (listener: (peerId: string) => void): (() => void) =>
			node.networkNode.subscribeToPeerConnections?.(listener) ?? ((): void => undefined),
		close: (): void => {
			if (closed) return;
			closed = true;
			listeners.clear();
			node.messageQueueManager.close(queueId);
		},
	});
}

/**
 * The creator's peer for a room: its object id's creator routing hint (`<creatorPeer>:<suffix>`).
 * @param objectId - The room.
 * @returns The creator's peer id, or undefined.
 */
export function v3RoomCreatorPeer(objectId: string): string | undefined {
	const separator = objectId.lastIndexOf(":");
	return separator <= 0 ? undefined : objectId.slice(0, separator);
}

export type V3RoomSuccessorDeliveryStats = Readonly<{
	announced: number;
	answered: number;
	requested: number;
	received: number;
	/** Offers whose hint could not be newer than the member's epoch (no install attempted). */
	ignored: number;
	installed: number;
	/** Installs that refused an offer (forged, stale, or the material was unavailable). */
	refused: number;
	oversize: number;
	malformed: number;
	lastError: string | undefined;
	/** Bytes of the largest offer frame sent or received. */
	largestOfferBytes: number;
	/** Creator: currency statements sent to members at its epoch. */
	currencyAnswered: number;
	/** Member: creator statements its room confirmed as current. */
	currencyConfirmed: number;
}>;

export interface V3RoomSuccessorDeliveryHooks {
	onInstalled?(epoch: number): void;
	onRefused?(error: unknown): void;
	onError?(error: unknown): void;
}

type DeliveryRoom = Pick<V3RoomSession, "authority" | "connectedPeers" | "installCreatorSuccessor"> &
	Partial<Pick<V3RoomSession, "currencyStatement" | "confirmCurrent" | "localIssueCurrency">>;

export interface V3RoomSuccessorDelivery {
	readonly role: "creator" | "member";
	bind(room: DeliveryRoom): void;
	/** Creator: the adopted successor's offer (the rollover policy's `publishSuccessor`). */
	publish(offer: V3RoomSuccessorOffer, successorEpoch: number): Promise<void>;
	/** Member: ask the creator for its latest offer now (rate limited). */
	request(): void;
	/** Settles when no install is running or queued (tests and orderly shutdown). */
	idle(): Promise<void>;
	stats(): V3RoomSuccessorDeliveryStats;
	close(): void;
}

function encodeOffer(offer: V3RoomSuccessorOffer, successorEpoch: number): Uint8Array {
	return encodeCanonical(
		{
			kind: OFFER_KIND,
			version: 1,
			successorEpoch,
			cut: offer.exactCanonicalCutValueBytes,
			qc: offer.exactCanonicalCommitQcBytes,
			trust: offer.exactCanonicalTrustStateRecordBytes,
			manifest: offer.exactCanonicalSnapshotManifestBytes,
		},
		FRAME_LIMITS
	);
}

type Frame =
	| Readonly<{ kind: "offer"; offer: V3RoomSuccessorOffer; successorEpoch: number; bytes: Uint8Array }>
	| Readonly<{ kind: "request"; epoch: number }>
	| Readonly<{ kind: "currency"; statement: V3RoomCurrencyStatement }>;

function encodeCurrency(statement: V3RoomCurrencyStatement): Uint8Array {
	return encodeCanonical(
		{
			kind: CURRENCY_KIND,
			version: 1,
			objectId: statement.objectId,
			epoch: statement.epoch,
			anchorDigest: statement.anchorDigest,
			frontiers: statement.frontiers.map(([author, admittedThrough]) => [author, admittedThrough]),
		},
		FRAME_LIMITS
	);
}

function decodeCurrency(record: Record<string, unknown>): Frame | undefined {
	const { objectId, epoch, anchorDigest, frontiers } = record;
	if (
		typeof objectId !== "string" ||
		!Number.isSafeInteger(epoch) ||
		Number(epoch) < 0 ||
		typeof anchorDigest !== "string" ||
		!Array.isArray(frontiers)
	)
		return undefined;
	const pairs: (readonly [string, number])[] = [];
	for (const entry of frontiers) {
		if (!Array.isArray(entry) || entry.length !== 2) return undefined;
		const [author, admittedThrough] = entry as unknown[];
		if (typeof author !== "string" || !Number.isSafeInteger(admittedThrough) || Number(admittedThrough) < 0) return undefined;
		pairs.push(Object.freeze([author, Number(admittedThrough)] as const));
	}
	return {
		kind: "currency",
		statement: Object.freeze({ objectId, epoch: Number(epoch), anchorDigest, frontiers: Object.freeze(pairs) }),
	};
}

function decodeFrame(bytes: Uint8Array): Frame | undefined {
	let value: unknown;
	try {
		value = decodeCanonical(bytes, FRAME_LIMITS);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort().join(",");
	if (record.version !== 1) return undefined;
	if (record.kind === CURRENCY_KIND && keys === CURRENCY_KEYS.join(",")) return decodeCurrency(record);
	if (record.kind === REQUEST_KIND && keys === REQUEST_KEYS.join(",")) {
		return Number.isSafeInteger(record.epoch) && Number(record.epoch) >= 0
			? { kind: "request", epoch: Number(record.epoch) }
			: undefined;
	}
	if (record.kind !== OFFER_KIND || keys !== OFFER_KEYS.join(",")) return undefined;
	const { cut, qc, trust, manifest, successorEpoch } = record;
	if (
		!(cut instanceof Uint8Array) ||
		!(qc instanceof Uint8Array) ||
		!(trust instanceof Uint8Array) ||
		!(manifest instanceof Uint8Array) ||
		!Number.isSafeInteger(successorEpoch) ||
		Number(successorEpoch) < 1
	)
		return undefined;
	return {
		kind: "offer",
		successorEpoch: Number(successorEpoch),
		bytes,
		offer: Object.freeze({
			exactCanonicalCutValueBytes: cut,
			exactCanonicalCommitQcBytes: qc,
			exactCanonicalTrustStateRecordBytes: trust,
			exactCanonicalSnapshotManifestBytes: manifest,
		}),
	};
}

function message(error: unknown): string {
	if (error instanceof AggregateError)
		return `${error.message} ${error.errors.map(message).join(" ")} ${message(error.cause)}`.trim();
	if (error instanceof Error) return `${error.message} ${message(error.cause)}`.trim();
	return error === undefined ? "" : String(error);
}

/**
 * The room's successor-offer delivery (see the module comment).
 * @param input - Role, room, channel, and optional poll interval and hooks.
 * @returns The delivery; bind it once the room is open, close it with the room.
 */
export function createV3RoomSuccessorDelivery(
	input: Readonly<{
		role: "creator" | "member";
		objectId: string;
		channel: V3RoomSuccessorChannel;
		/**
		 * The creator's peer when the room's object id carries no routing hint for it (a scripted
		 * transport whose peer names are not the object's creator hint). Defaults to the hint.
		 */
		creatorPeer?: string;
		pollMs?: number;
		hooks?: V3RoomSuccessorDeliveryHooks;
	}>
): V3RoomSuccessorDelivery {
	const { role, channel } = input;
	const hooks = input.hooks ?? {};
	const creatorPeer = input.creatorPeer ?? v3RoomCreatorPeer(input.objectId);
	if (role === "member" && creatorPeer === undefined) throw new TypeError("v3 room creator peer is unknown");
	const pollMs = input.pollMs ?? V3_ROOM_SUCCESSOR_POLL_MS;
	let room: DeliveryRoom | undefined;
	let closed = false;
	const lifetime = new AbortController();
	const stats = {
		announced: 0,
		answered: 0,
		requested: 0,
		received: 0,
		ignored: 0,
		installed: 0,
		refused: 0,
		oversize: 0,
		malformed: 0,
		largestOfferBytes: 0,
		currencyAnswered: 0,
		currencyConfirmed: 0,
		lastError: undefined as string | undefined,
	};
	// Creator.
	let latest: Readonly<{ successorEpoch: number; bytes: Uint8Array }> | undefined;
	const known = new Set<string>();
	const answeredAt = new Map<string, number>();
	// Member.
	let candidate: Extract<Frame, { kind: "offer" }> | undefined;
	// Sync before sending (live install rule): the creator's statement for an epoch ahead of the
	// room, kept for the install of that epoch; and an offer refused only for want of it.
	let aheadStatement: V3RoomCurrencyStatement | undefined;
	let awaitingStatement: Extract<Frame, { kind: "offer" }> | undefined;
	let installing: Promise<void> | undefined;
	let requestedAt = 0;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	const failed: { bytes: Uint8Array; retryAt: number; failures: number }[] = [];
	const unsubscribe: (() => void)[] = [];

	const epoch = (): number => room?.authority()?.epoch ?? 0;
	const report = (error: unknown): void => {
		stats.lastError = message(error).slice(0, 400);
		hooks.onError?.(error);
	};
	const send = (peerId: string, bytes: Uint8Array): Promise<boolean> => {
		if (closed) return Promise.resolve(false);
		const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(SEND_DEADLINE_MS)]);
		return channel.send(peerId, bytes, signal).then(
			() => true,
			(error: unknown) => {
				if (!closed) report(error);
				return false;
			}
		);
	};
	const remember = (peerId: string): void => {
		if (peerId === channel.localPeerId || known.has(peerId)) return;
		if (known.size >= KNOWN_PEERS_MAX) {
			const oldest = known.values().next().value;
			if (oldest !== undefined) known.delete(oldest);
		}
		known.add(peerId);
	};

	const request = (): void => {
		if (closed || role !== "member" || room === undefined || creatorPeer === undefined) return;
		const now = Date.now();
		if (now - requestedAt < REQUEST_MIN_INTERVAL_MS) return;
		if (!channel.peers().includes(creatorPeer)) return;
		requestedAt = now;
		stats.requested++;
		void send(creatorPeer, encodeCanonical({ kind: REQUEST_KIND, version: 1, epoch: epoch() }, FRAME_LIMITS));
	};
	const poll = (): void => {
		if (closed) return;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			request();
			poll();
		}, pollMs);
	};

	const backoffOf = (bytes: Uint8Array): (typeof failed)[number] | undefined =>
		failed.find((entry) => compareBytes(entry.bytes, bytes) === 0);
	const install = (): void => {
		if (installing !== undefined || closed) return;
		installing = (async (): Promise<void> => {
			while (!closed && candidate !== undefined) {
				const selected = candidate;
				candidate = undefined;
				const selectedRoom = room;
				if (selectedRoom === undefined || creatorPeer === undefined) return;
				if (selected.successorEpoch <= epoch()) {
					stats.ignored++;
					continue;
				}
				const previous = backoffOf(selected.bytes);
				if (previous !== undefined && Date.now() < previous.retryAt) {
					stats.ignored++;
					continue;
				}
				const currency = aheadStatement?.epoch === selected.successorEpoch ? aheadStatement : undefined;
				try {
					await selectedRoom.installCreatorSuccessor({
						offer: selected.offer,
						peers: [creatorPeer],
						...(currency === undefined ? {} : { currency }),
					});
					stats.installed++;
					if (previous !== undefined) failed.splice(failed.indexOf(previous), 1);
					hooks.onInstalled?.(epoch());
				} catch (error) {
					if (closed) return;
					// Only the creator's statement is missing: it travels with the offer and installs on arrival.
					if (Reflect.get(error as object, "reason") === "statement-required") awaitingStatement = selected;
					stats.refused++;
					stats.lastError = message(error).slice(0, 400);
					const entry = previous ?? { bytes: selected.bytes, retryAt: 0, failures: 0 };
					entry.failures++;
					entry.retryAt =
						Date.now() + (RETRY_BACKOFF_MS[Math.min(entry.failures, RETRY_BACKOFF_MS.length) - 1] ?? 30_000);
					if (previous === undefined) {
						failed.push(entry);
						if (failed.length > FAILED_OFFERS_MAX) failed.shift();
					}
					hooks.onRefused?.(error);
					// The creator may have rolled over meanwhile; ask for its latest after the backoff.
					if (!closed) setTimeout(() => request(), Math.max(REQUEST_MIN_INTERVAL_MS, entry.retryAt - Date.now()));
				}
			}
		})().finally(() => {
			installing = undefined;
			if (candidate !== undefined && !closed) install();
		});
	};

	const receive = (sender: string, bytes: Uint8Array): void => {
		if (closed) return;
		if (bytes.byteLength > V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES) {
			stats.oversize++;
			return;
		}
		const frame = decodeFrame(bytes);
		if (frame === undefined) {
			stats.malformed++;
			return;
		}
		if (frame.kind === "request") {
			if (role !== "creator") return;
			remember(sender);
			const now = Date.now();
			const newer = latest !== undefined && latest.successorEpoch > frame.epoch;
			// Sync before sending: a member at this creator's epoch learns that it is current.
			let currency: Uint8Array | undefined;
			if (!newer && frame.epoch === epoch() && room?.currencyStatement !== undefined) {
				try {
					currency = encodeCurrency(room.currencyStatement());
				} catch (error) {
					report(error);
				}
			}
			if (!newer && currency === undefined) return;
			if (now - (answeredAt.get(sender) ?? 0) < ANSWER_MIN_INTERVAL_MS) return;
			answeredAt.set(sender, now);
			if (answeredAt.size > KNOWN_PEERS_MAX) answeredAt.delete(answeredAt.keys().next().value as string);
			if (newer) {
				stats.answered++;
				// A member behind this creator may have reopened its lineage from storage: it installs only
				// with this creator's statement for the offered epoch, so the statement goes first, in the
				// same answer (no extra round trip).
				let statement: Uint8Array | undefined;
				if (room?.currencyStatement !== undefined && epoch() === latest!.successorEpoch) {
					try {
						statement = encodeCurrency(room.currencyStatement());
					} catch (error) {
						report(error);
					}
				}
				const offerBytes = latest!.bytes;
				void (async (): Promise<void> => {
					if (statement !== undefined && (await send(sender, statement))) stats.currencyAnswered++;
					await send(sender, offerBytes);
				})();
			} else {
				stats.currencyAnswered++;
				void send(sender, currency!);
			}
			return;
		}
		if (frame.kind === "currency") {
			const selected = room;
			if (role !== "member" || sender !== creatorPeer || selected?.confirmCurrent === undefined) return;
			if (selected.localIssueCurrency?.() === "current") return;
			if (frame.statement.epoch > epoch()) {
				// For the install of that epoch; an offer that waited only for it installs now.
				if (aheadStatement === undefined || frame.statement.epoch >= aheadStatement.epoch) aheadStatement = frame.statement;
				const waiting = awaitingStatement;
				if (waiting !== undefined && waiting.successorEpoch === frame.statement.epoch) {
					awaitingStatement = undefined;
					const entry = backoffOf(waiting.bytes);
					if (entry !== undefined) entry.retryAt = 0;
					if (candidate === undefined || waiting.successorEpoch >= candidate.successorEpoch) candidate = waiting;
					install();
				}
				return;
			}
			if (frame.statement.epoch !== epoch()) return;
			void selected.confirmCurrent(frame.statement).then(
				(result) => {
					if (result === "current") stats.currencyConfirmed++;
				},
				(error: unknown) => report(error)
			);
			return;
		}
		if (role !== "member") return;
		stats.received++;
		stats.largestOfferBytes = Math.max(stats.largestOfferBytes, bytes.byteLength);
		// Untrusted hint: keep the newest; anything not newer than the room's epoch is skipped.
		if (frame.successorEpoch <= epoch()) {
			stats.ignored++;
			return;
		}
		if (candidate === undefined || frame.successorEpoch >= candidate.successorEpoch) candidate = frame;
		install();
	};

	return Object.freeze({
		role,
		bind(selected: DeliveryRoom): void {
			if (room !== undefined) throw new TypeError("v3 room successor delivery is already bound");
			if (closed) return;
			room = selected;
			unsubscribe.push(channel.listen(receive));
			if (role === "member") {
				unsubscribe.push(
					channel.onPeerConnected((peerId) => {
						if (peerId === creatorPeer) {
							requestedAt = 0;
							request();
						}
					})
				);
				request();
				poll();
			}
		},
		async publish(offer: V3RoomSuccessorOffer, successorEpoch: number): Promise<void> {
			if (closed || role !== "creator") return;
			const bytes = encodeOffer(offer, successorEpoch);
			if (bytes.byteLength > V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES) {
				stats.oversize++;
				throw new RangeError(
					`v3 room successor offer is ${bytes.byteLength} bytes, above ${V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES}`
				);
			}
			stats.largestOfferBytes = Math.max(stats.largestOfferBytes, bytes.byteLength);
			latest = Object.freeze({ successorEpoch, bytes });
			for (const peerId of room?.connectedPeers() ?? []) remember(peerId);
			const connected = new Set(channel.peers());
			const targets = [...known].filter((peerId) => connected.has(peerId));
			stats.announced += targets.length;
			await Promise.all(targets.map((peerId) => send(peerId, bytes)));
		},
		request,
		idle: async (): Promise<void> => {
			while (installing !== undefined) await installing;
		},
		stats: (): V3RoomSuccessorDeliveryStats => Object.freeze({ ...stats }),
		close(): void {
			if (closed) return;
			closed = true;
			lifetime.abort(new TypeError("v3 room successor delivery is closed"));
			if (pollTimer !== undefined) clearTimeout(pollTimer);
			for (const stop of unsubscribe.splice(0)) stop();
			channel.close();
		},
	});
}

/**
 * The page's delivery on its own node: `createV3RoomSuccessorDelivery` over
 * `createV3RoomSuccessorChannel(node, objectId)`.
 * @param node - The page's started node.
 * @param objectId - The room.
 * @param role - "creator" when this page seals the room, "member" otherwise (observers included).
 * @param hooks - Status and error reporting.
 * @returns The delivery; bind it once the room is open, close it with the room.
 */
export function openV3RoomSuccessorDelivery(
	node: V3RoomSuccessorNode,
	objectId: string,
	role: "creator" | "member",
	hooks?: V3RoomSuccessorDeliveryHooks
): V3RoomSuccessorDelivery {
	return createV3RoomSuccessorDelivery({
		role,
		objectId,
		channel: createV3RoomSuccessorChannel(node, objectId),
		...(hooks === undefined ? {} : { hooks }),
	});
}
