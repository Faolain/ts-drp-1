import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { DeliveredEphemeralFrame, EphemeralPublishInput } from "@ts-drp/ephemeral";

// Memory-only speculative presentation over the authoritative durable projection.
// The overlay holds no plane, store, signer or transport capability: it is built
// from a pure projection function and read-only durable snapshots, and its only
// outputs are display values and callbacks. Nothing here can create, sign, admit
// or persist a vertex, and nothing here feeds the durable projection or authority.

/** Durable row shape shared with the room; speculative rows reuse it for the pure projection. */
export interface PresentationRow {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

export type V3RoomPresentationSource = "local" | "remote-signed" | "remote-intent";

export type V3RoomPresentationRollbackReason =
	/** The local durable issue failed (authorization, admission, capacity, close, terminal failure). */
	| "refused"
	/** Durable admission accepted no projection row for it (the application refused it). */
	| "projection-refused"
	/** A remote vertex of an epoch that sealed without admitting it here. */
	| "epoch-changed"
	/** A remote entry that durable admission did not confirm within the timeout. */
	| "unconfirmed"
	/** The remote author withdrew its intent because its own issue was refused. */
	| "withdrawn"
	| "closed";

export interface V3RoomPendingOperation {
	readonly id: string;
	readonly source: V3RoomPresentationSource;
	readonly author: string;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	/** Present once the operation is signed (remote-signed) or durable (local). */
	readonly vertexDigest?: string;
	/** False while the pure projection refuses it on the current speculative base. */
	readonly visible: boolean;
	readonly since: number;
}

export type V3RoomPresentationEvent =
	| Readonly<{ kind: "pending"; at: number; entry: V3RoomPendingOperation }>
	| Readonly<{ kind: "visible"; at: number; entry: V3RoomPendingOperation }>
	| Readonly<{
			kind: "confirmed";
			at: number;
			entry: V3RoomPendingOperation;
			/** Absent only when the issue completed through a migration redirect. */
			vertexDigest?: string;
			/** "signed": a remote intent superseded by its authenticated signed vertex. */
			stage: "durable" | "signed";
	  }>
	| Readonly<{
			kind: "rolled-back";
			at: number;
			entry: V3RoomPendingOperation;
			reason: V3RoomPresentationRollbackReason;
			error?: unknown;
	  }>;

export interface V3RoomPresentationOptions<Projection> {
	/** Pending local plus remote entries retained; extra work stays durable-only. Default 256. */
	readonly maxPendingEntries?: number;
	/** Remote signed or intent entries unconfirmed this long roll back as "unconfirmed". Default 15 000. */
	readonly remotePendingTimeoutMilliseconds?: number;
	/** Which operations may be shown before durable admission. Default: the application's batchable actions. */
	speculate?(operation: Readonly<Record<string, unknown>>): boolean;
	/** Synchronous speculative view after every overlay or durable change while entries are pending. */
	onSpeculativeProjection?(projection: Projection): void;
	onPresentationEvent?(event: V3RoomPresentationEvent): void;
}

export interface LocalPresentationHooks {
	visible?(entry: V3RoomPendingOperation): void;
	durable?(confirmed: Readonly<{ vertexDigest: string; authorSequence: number }>): void;
	rolledBack?(reason: V3RoomPresentationRollbackReason, error: unknown): void;
}

export interface RemoteSignedVertex {
	readonly author: string;
	readonly epoch: number;
	readonly logicalTime: number;
	readonly vertexDigest: string;
	readonly rows: readonly PresentationRow[];
}

export interface DurablePresentationSnapshot<Projection> {
	readonly projection: Projection;
	readonly epoch: number;
	/** Ordered authoritative current-epoch rows; read lazily only while entries are pending. */
	rows(): readonly PresentationRow[];
}

interface Entry {
	readonly id: string;
	readonly seq: number;
	readonly source: V3RoomPresentationSource;
	readonly author: string;
	logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationKey: string;
	rows: readonly PresentationRow[];
	readonly since: number;
	readonly deadline: number | undefined;
	readonly epoch: number | undefined;
	readonly vertexDigest: string | undefined;
	readonly intentId: string | undefined;
	/** Local logical time chosen by the issue path; the durable row carries it exactly. */
	bound: number | undefined;
	visible: boolean;
	shown: boolean;
	readonly hooks: LocalPresentationHooks | undefined;
}

export interface PresentationOverlay<Projection> {
	addLocal(
		operation: Readonly<Record<string, unknown>>,
		roomLogicalTime: number,
		hooks?: LocalPresentationHooks
	): string | undefined;
	bindLocal(id: string, logicalTime: number): void;
	settleLocal(
		id: string,
		outcome: Readonly<{ ok: true }> | Readonly<{ ok: false; reason: "refused" | "projection-refused"; error: unknown }>
	): void;
	addRemoteVertex(vertex: RemoteSignedVertex): boolean;
	addIntent(
		input: Readonly<{
			author: string;
			intentId: string;
			logicalTime: number;
			operation: Readonly<Record<string, unknown>>;
		}>
	): boolean;
	withdrawIntent(author: string, intentId: string): void;
	durableCommitted(additions: readonly Readonly<{ identity: string; rows: readonly PresentationRow[] }>[]): void;
	durableChanged(): void;
	/** Durable admission kept these vertices but projected no row for them. */
	durableRefused(identities: readonly string[]): void;
	epochChanged(epoch: number): void;
	expire(): void;
	close(): void;
	pending(): readonly V3RoomPendingOperation[];
	projection(): Projection;
	subscribe(listener: (event: V3RoomPresentationEvent) => void): () => void;
	hasRemoteSigned(vertexDigest: string): boolean;
}

const DEFAULT_MAX_PENDING_ENTRIES = 256;
const DEFAULT_REMOTE_TIMEOUT_MILLISECONDS = 15_000;
const INTENT_MEMORY_LIMIT = 1_024;
const PENDING_OPERATION_LIMITS = { maxBytes: 16_384, maxDepth: 16, maxItems: 1_024 } as const;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function operationKey(operation: Readonly<Record<string, unknown>>): string {
	const bytes = encodeCanonical(operation, PENDING_OPERATION_LIMITS);
	let result = "";
	for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
	return result;
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

// A canonical round trip detaches caller-owned objects (getters, prototypes,
// later mutation) from what the overlay shows and later compares.
function detached(operation: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return deepFreeze(
		decodeCanonical(encodeCanonical(operation, PENDING_OPERATION_LIMITS), PENDING_OPERATION_LIMITS) as Record<
			string,
			unknown
		>
	);
}

function validPositive(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`v3 room presentation ${name} is invalid`);
	return value;
}

export function createPresentationOverlay<Projection>(input: {
	readonly localAuthor: string;
	readonly options: V3RoomPresentationOptions<Projection>;
	readonly batchableOperationActions: readonly string[];
	readonly durable: () => DurablePresentationSnapshot<Projection>;
	/** Pure application fold of durable rows followed by speculative rows. */
	readonly project: (rows: readonly PresentationRow[]) => Projection;
	readonly now: () => number;
	readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
}): PresentationOverlay<Projection> {
	const { localAuthor, options } = input;
	const maxEntries = validPositive(options.maxPendingEntries, DEFAULT_MAX_PENDING_ENTRIES, "maxPendingEntries");
	const remoteTimeout = validPositive(
		options.remotePendingTimeoutMilliseconds,
		DEFAULT_REMOTE_TIMEOUT_MILLISECONDS,
		"remotePendingTimeoutMilliseconds"
	);
	const speculate =
		options.speculate ??
		((operation: Readonly<Record<string, unknown>>): boolean => {
			const action = Reflect.get(operation, "action");
			return typeof action === "string" && input.batchableOperationActions.includes(action);
		});
	const entries = new Map<string, Entry>();
	const listeners = new Set<(event: V3RoomPresentationEvent) => void>();
	// Intents travel apart from signed vertices and in no order, so an intent can
	// arrive after its move is already signed or durable here, or after its own
	// withdrawal. Bounded memories of both keep such late intents from showing.
	const settledIntentMoves = new Map<string, true>();
	const withdrawnIntents = new Map<string, true>();
	const remember = (memory: Map<string, true>, key: string): void => {
		memory.delete(key);
		memory.set(key, true);
		if (memory.size > INTENT_MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
	};
	let seq = 0;
	let provisional = -Infinity;
	let closed = false;
	let cached: Projection | undefined;
	let timer: unknown;
	let timerDeadline: number | undefined;

	const view = (entry: Entry): V3RoomPendingOperation =>
		Object.freeze({
			id: entry.id,
			source: entry.source,
			author: entry.author,
			logicalTime: entry.logicalTime,
			operation: entry.operation,
			...(entry.vertexDigest === undefined ? {} : { vertexDigest: entry.vertexDigest }),
			visible: entry.visible,
			since: entry.since,
		});
	// Observers are isolated: a throwing display callback never reaches the
	// durable caller that triggered the change.
	const emit = (event: V3RoomPresentationEvent): void => {
		try {
			options.onPresentationEvent?.(event);
		} catch {
			// Display-only observer failure.
		}
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// Display-only observer failure.
			}
		}
	};
	const callHook = (action: () => void): void => {
		try {
			action();
		} catch {
			// Receipt continuation failure stays with the caller's own promise.
		}
	};
	const ordered = (): Entry[] =>
		[...entries.values()].sort(
			(left, right) =>
				left.logicalTime - right.logicalTime || compareText(left.author, right.author) || left.seq - right.seq
		);
	const compute = (): Projection => {
		const durable = input.durable();
		if (entries.size === 0) return durable.projection;
		const base = durable.rows();
		const selected = ordered();
		const accepted: PresentationRow[] = [...base];
		let result: Projection | undefined;
		try {
			for (const entry of selected) accepted.push(...entry.rows);
			result = input.project(Object.freeze(accepted.slice()));
			for (const entry of selected) entry.visible = true;
		} catch {
			// Mirror the durable contained fold: keep each entry the pure fold accepts.
			accepted.length = base.length;
			result = undefined;
			for (const entry of selected) {
				const attempt = [...accepted, ...entry.rows];
				try {
					result = input.project(Object.freeze(attempt));
					accepted.push(...entry.rows);
					entry.visible = true;
				} catch {
					entry.visible = false;
				}
			}
			result ??= input.project(Object.freeze(accepted.slice()));
		}
		return result;
	};
	const notify = (): void => {
		cached = undefined;
		if (closed) return;
		// Without an observer the view stays lazy; projection() computes it on demand.
		if (
			options.onSpeculativeProjection === undefined &&
			options.onPresentationEvent === undefined &&
			listeners.size === 0 &&
			![...entries.values()].some((entry) => !entry.shown && entry.hooks?.visible !== undefined)
		)
			return;
		let projection: Projection;
		try {
			projection = compute();
		} catch {
			// A durable snapshot that cannot be read leaves the last view in place.
			return;
		}
		cached = projection;
		const at = input.now();
		for (const entry of entries.values()) {
			if (!entry.visible || entry.shown) continue;
			entry.shown = true;
			const shown = view(entry);
			emit(Object.freeze({ kind: "visible", at, entry: shown }));
			const hook = entry.hooks?.visible;
			if (hook !== undefined) callHook(() => hook(shown));
		}
		try {
			options.onSpeculativeProjection?.(projection);
		} catch {
			// Display-only observer failure.
		}
	};
	const schedule = (): void => {
		let next: number | undefined;
		for (const entry of entries.values())
			if (entry.deadline !== undefined && (next === undefined || entry.deadline < next)) next = entry.deadline;
		if (next === timerDeadline) return;
		if (timer !== undefined) input.clearTimer(timer);
		timer = undefined;
		timerDeadline = next;
		if (next === undefined || closed) return;
		timer = input.setTimer(
			() => {
				timer = undefined;
				timerDeadline = undefined;
				overlay.expire();
			},
			Math.max(0, next - input.now())
		);
	};
	const remove = (entry: Entry): void => {
		entries.delete(entry.id);
	};
	const rollBack = (entry: Entry, reason: V3RoomPresentationRollbackReason, error?: unknown): void => {
		remove(entry);
		const removed = view(entry);
		emit(
			Object.freeze({
				kind: "rolled-back",
				at: input.now(),
				entry: removed,
				reason,
				...(error === undefined ? {} : { error }),
			})
		);
		const hook = entry.hooks?.rolledBack;
		if (hook !== undefined) callHook(() => hook(reason, error));
	};
	const confirm = (
		entry: Entry,
		vertexDigest: string | undefined,
		stage: "durable" | "signed",
		authorSequence?: number
	): void => {
		remove(entry);
		emit(
			Object.freeze({
				kind: "confirmed",
				at: input.now(),
				entry: view(entry),
				...(vertexDigest === undefined ? {} : { vertexDigest }),
				stage,
			})
		);
		const hook = entry.hooks?.durable;
		if (hook !== undefined && vertexDigest !== undefined && authorSequence !== undefined)
			callHook(() => hook(Object.freeze({ vertexDigest, authorSequence })));
	};
	const supersedeIntents = (rows: readonly PresentationRow[], stage: "durable" | "signed"): boolean => {
		let changed = false;
		for (const row of rows) {
			if (row.author === localAuthor) continue;
			let key: string | undefined;
			try {
				key = operationKey(row.operation);
			} catch {
				continue;
			}
			remember(settledIntentMoves, `${row.author}\u0000${key}`);
			const match = ordered().find(
				(entry) => entry.source === "remote-intent" && entry.author === row.author && entry.operationKey === key
			);
			if (match === undefined) continue;
			confirm(match, row.vertexDigest, stage);
			changed = true;
		}
		return changed;
	};
	const add = (entry: Entry): void => {
		entries.set(entry.id, entry);
		emit(Object.freeze({ kind: "pending", at: entry.since, entry: view(entry) }));
	};
	const pendingRow = (
		entry: Readonly<{ id: string; author: string; logicalTime: number; operation: Readonly<Record<string, unknown>> }>
	): PresentationRow =>
		Object.freeze({
			author: entry.author,
			// Unsigned rows have no sequence or digest yet; these markers cannot collide
			// with a durable row (sequences are >= 0, digests are 64 lowercase hex).
			authorSequence: -1,
			logicalTime: entry.logicalTime,
			operation: entry.operation,
			operationCount: 1,
			operationIndex: 0,
			vertexDigest: `pending:${entry.id}`,
		});

	const overlay: PresentationOverlay<Projection> = {
		addLocal(operation, roomLogicalTime, hooks) {
			if (closed || entries.size >= maxEntries) return undefined;
			let copy: Readonly<Record<string, unknown>>;
			let key: string;
			try {
				if (!speculate(operation)) return undefined;
				copy = detached(operation);
				key = operationKey(copy);
			} catch {
				return undefined;
			}
			provisional = Math.max(roomLogicalTime, provisional + 2);
			const id = `local:${++seq}`;
			const base = { id, author: localAuthor, logicalTime: provisional, operation: copy };
			add({
				...base,
				seq,
				source: "local",
				operationKey: key,
				rows: Object.freeze([pendingRow(base)]),
				since: input.now(),
				deadline: undefined,
				epoch: undefined,
				vertexDigest: undefined,
				intentId: undefined,
				bound: undefined,
				visible: false,
				shown: false,
				hooks,
			});
			notify();
			return id;
		},
		bindLocal(id, logicalTime) {
			const entry = entries.get(id);
			if (entry === undefined || entry.source !== "local") return;
			entry.bound = logicalTime;
			if (entry.logicalTime === logicalTime) return;
			entry.logicalTime = logicalTime;
			entry.rows = Object.freeze([pendingRow(entry)]);
			provisional = Math.max(provisional, logicalTime);
			notify();
		},
		settleLocal(id, outcome) {
			const entry = entries.get(id);
			// The durable commit normally confirmed it already, atomically with the
			// durable projection that now contains it.
			if (entry === undefined) return;
			if (outcome.ok) confirm(entry, undefined, "durable");
			else rollBack(entry, outcome.reason, outcome.error);
			notify();
		},
		addRemoteVertex(vertex) {
			if (closed || entries.has(`vertex:${vertex.vertexDigest}`) || vertex.author === localAuthor) return false;
			if (vertex.rows.length === 0 || !vertex.rows.every((row) => speculate(row.operation))) return false;
			const superseded = supersedeIntents(vertex.rows, "signed");
			if (entries.size >= maxEntries) {
				if (superseded) notify();
				return false;
			}
			const since = input.now();
			add({
				id: `vertex:${vertex.vertexDigest}`,
				seq: ++seq,
				source: "remote-signed",
				author: vertex.author,
				logicalTime: vertex.logicalTime,
				operation: vertex.rows[0]!.operation,
				operationKey: "",
				rows: vertex.rows,
				since,
				deadline: since + remoteTimeout,
				epoch: vertex.epoch,
				vertexDigest: vertex.vertexDigest,
				intentId: undefined,
				bound: undefined,
				visible: false,
				shown: false,
				hooks: undefined,
			});
			schedule();
			notify();
			return true;
		},
		addIntent({ author, intentId, logicalTime, operation }) {
			if (closed || author === localAuthor || entries.size >= maxEntries) return false;
			const id = `intent:${author}:${intentId}`;
			if (entries.has(id) || withdrawnIntents.has(id) || !Number.isSafeInteger(logicalTime) || logicalTime < 0)
				return false;
			let copy: Readonly<Record<string, unknown>>;
			let key: string;
			try {
				if (!speculate(operation)) return false;
				copy = detached(operation);
				key = operationKey(copy);
			} catch {
				return false;
			}
			// A repeat of an identical recent move by the same author therefore shows
			// only once signed or durable: late is never shown, at worst it is slower.
			if (settledIntentMoves.has(`${author}\u0000${key}`)) return false;
			const since = input.now();
			const base = { id, author, logicalTime, operation: copy };
			add({
				...base,
				seq: ++seq,
				source: "remote-intent",
				operationKey: key,
				rows: Object.freeze([pendingRow(base)]),
				since,
				deadline: since + remoteTimeout,
				epoch: undefined,
				vertexDigest: undefined,
				intentId,
				bound: undefined,
				visible: false,
				shown: false,
				hooks: undefined,
			});
			schedule();
			notify();
			return true;
		},
		withdrawIntent(author, intentId) {
			const id = `intent:${author}:${intentId}`;
			remember(withdrawnIntents, id);
			const entry = entries.get(id);
			if (entry === undefined) return;
			rollBack(entry, "withdrawn");
			schedule();
			notify();
		},
		durableCommitted(additions) {
			if (closed) return;
			for (const { identity, rows } of additions) {
				const signed = entries.get(`vertex:${identity}`);
				if (signed !== undefined) confirm(signed, identity, "durable");
				for (const row of rows) {
					if (row.author !== localAuthor) continue;
					// The issue path chose this exact logical time; the operation bytes
					// exclude an unrelated join or settlement row at the same time.
					const local = [...entries.values()].find(
						(entry) => entry.source === "local" && entry.bound === row.logicalTime
					);
					if (local === undefined) continue;
					let key: string | undefined;
					try {
						key = operationKey(row.operation);
					} catch {
						continue;
					}
					if (key === local.operationKey) confirm(local, identity, "durable", row.authorSequence);
				}
				supersedeIntents(rows, "durable");
			}
			schedule();
			notify();
		},
		durableRefused(identities) {
			let changed = false;
			for (const identity of identities) {
				const signed = entries.get(`vertex:${identity}`);
				if (signed === undefined) continue;
				rollBack(signed, "projection-refused");
				changed = true;
			}
			if (!changed) return;
			schedule();
			notify();
		},
		durableChanged() {
			if (entries.size === 0 && options.onSpeculativeProjection === undefined) {
				cached = undefined;
				return;
			}
			notify();
		},
		epochChanged(epoch) {
			for (const entry of [...entries.values()])
				if (entry.source === "remote-signed" && entry.epoch !== undefined && entry.epoch < epoch)
					rollBack(entry, "epoch-changed");
			schedule();
			notify();
		},
		expire() {
			const now = input.now();
			let changed = false;
			for (const entry of [...entries.values()]) {
				if (entry.deadline === undefined || entry.deadline > now) continue;
				rollBack(entry, "unconfirmed");
				changed = true;
			}
			schedule();
			if (changed) notify();
		},
		close() {
			if (closed) return;
			for (const entry of [...entries.values()]) rollBack(entry, "closed");
			closed = true;
			if (timer !== undefined) input.clearTimer(timer);
			timer = undefined;
			timerDeadline = undefined;
			cached = undefined;
			listeners.clear();
		},
		pending() {
			return Object.freeze(ordered().map(view));
		},
		projection() {
			if (entries.size === 0) return input.durable().projection;
			cached ??= compute();
			return cached;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		hasRemoteSigned(vertexDigest) {
			return entries.has(`vertex:${vertexDigest}`);
		},
	};
	return overlay;
}

// ---------------------------------------------------------------------------
// Display-only intents over the room's authenticated ephemeral channel.
// The channel already binds each frame to a transport-authenticated peer and
// drops senders that are not current writers; intents never carry a signature,
// so they are never accepted as vertices and never reach durable admission.

const INTENT_FRAME_VERSION = 1;

export interface PresentationIntentChannel {
	publish(input: EphemeralPublishInput): Promise<boolean>;
	subscribe(listener: (frame: DeliveredEphemeralFrame) => void): () => void;
}

export function attachPresentationIntents<Projection>(input: {
	readonly overlay: PresentationOverlay<Projection>;
	readonly channel: PresentationIntentChannel;
	readonly key: string;
	readonly localAuthor: string;
	authorForPeer(peerId: string): string | undefined;
}): () => void {
	const { overlay, channel, key } = input;
	let detachedChannel = false;
	const send = (payload: Readonly<Record<string, unknown>>): void => {
		if (detachedChannel) return;
		let bytes: Uint8Array;
		try {
			bytes = encodeCanonical(payload, PENDING_OPERATION_LIMITS);
		} catch {
			return;
		}
		// Unordered ephemeral classes carry no key; the namespace travels in the payload.
		void channel.publish(Object.freeze({ class: "reliable-unordered", key: null, payload: bytes })).catch(() => false);
	};
	// A per-attachment nonce keeps a reopened session's ids distinct from stale ones.
	const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	const intentId = (entry: V3RoomPendingOperation): number | undefined => {
		const value = Number(entry.id.slice("local:".length));
		return entry.id.startsWith("local:") && Number.isSafeInteger(value) ? value : undefined;
	};
	const unsubscribeOverlay = overlay.subscribe((event) => {
		if (event.entry.source !== "local") return;
		const id = intentId(event.entry);
		if (id === undefined) return;
		if (event.kind === "pending")
			send({
				channel: key,
				version: INTENT_FRAME_VERSION,
				session: nonce,
				kind: "intent",
				id,
				logicalTime: event.entry.logicalTime,
				operation: event.entry.operation,
			});
		else if (event.kind === "rolled-back" && event.reason !== "closed")
			send({ channel: key, version: INTENT_FRAME_VERSION, session: nonce, kind: "withdraw", id });
	});
	const unsubscribeChannel = channel.subscribe((frame) => {
		if (detachedChannel || frame.key !== null) return;
		const author = input.authorForPeer(frame.sender);
		if (author === undefined || author === input.localAuthor) return;
		let value: unknown;
		try {
			value = decodeCanonical(frame.payload, PENDING_OPERATION_LIMITS);
		} catch {
			return;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const record = value as Record<string, unknown>;
		if (
			record.channel !== key ||
			record.version !== INTENT_FRAME_VERSION ||
			typeof record.session !== "string" ||
			!/^[0-9a-f]{16}$/u.test(record.session) ||
			!Number.isSafeInteger(record.id)
		)
			return;
		const intentId = `${record.session}:${record.id as number}`;
		if (record.kind === "withdraw") {
			overlay.withdrawIntent(author, intentId);
			return;
		}
		const operation = record.operation;
		if (
			record.kind !== "intent" ||
			typeof operation !== "object" ||
			operation === null ||
			Array.isArray(operation) ||
			typeof record.logicalTime !== "number"
		)
			return;
		overlay.addIntent({
			author,
			intentId,
			logicalTime: record.logicalTime,
			operation: operation as Record<string, unknown>,
		});
	});
	return () => {
		detachedChannel = true;
		unsubscribeOverlay();
		unsubscribeChannel();
	};
}
