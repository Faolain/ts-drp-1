// The observer must patch IndexedDB before any product module evaluates.
import { type ObservedWrite, setWriteListener } from "./idb-observer.js";
import { lockLog } from "./lock-observer.js";

import { decodeCanonical } from "@ts-drp/canonical";
import { resolveCreatorCloseEvidenceStore } from "@ts-drp/seal/internal/creator-close-intent";

import { decodeGenerationRecordV1 } from "../../../../packages/storage/src/index.js";
import {
	RoomRetentionRefusal,
	roomRetentionRowBytes,
	roomRetentionRowDigest,
	roomRetentionSourceDigest,
	type RoomRetentionKey,
	type RoomRetentionSelection,
} from "../../../../packages/storage/src/room-retention.js";
import {
	completedLabels,
	counts,
	deepDecode,
	digestDump,
	jsonable,
	keyFromPath,
	rawDump,
	type RawDump,
	rowDigest,
	stable,
} from "./dump.js";
import {
	check,
	closeFixtures,
	dispatchSuccessorFrames,
	type Envelope,
	localRecipient,
	lullFixture,
	type LullFixture,
	type OpenedRoom,
	type Recipient,
	required,
	heads,
	rooms,
	rollover,
	transition,
} from "./room-fixture.js";
import { call, receive as receiveRpc, serve } from "./rpc.js";
import { applying, trapRetention } from "./trap.js";

// Track M, slice 14f: the dedicated worker that runs the Track M room scenario on native
// IndexedDB (the same product modules as the node fixture, bundled from source) and
// reports through postMessage. Modes:
// - smoke: STEADY rollovers and one more boundary, reporting every retention pass;
// - case2: atomicity of the real retention transaction aborted after its last request;
// - case3: a foreign strict writer (another worker) against step B, then stale writers;
// - mutate / recover: one SIGKILL edge of the retention decision (and its recovery);
// - long: the long-room bounds (14b acceptance 6) in this engine;
// - recipient: the recipient room in its own origin, serving the creator worker (rpc.ts).

type Json = Record<string, unknown>;
type Edge = "inside-a" | "between-a-b" | "inside-b" | "after-b" | "none";
interface Input {
	readonly mode: "smoke" | "case2" | "case3" | "mutate" | "recover" | "long" | "recipient";
	readonly prefix: string;
	readonly seed: string;
	readonly steady: number;
	readonly edge?: Edge;
	readonly continuation?: number;
	/** Track O: the creator's sessions refuse any plan of more than one unit (a one-unit cap). */
	readonly oneUnit?: boolean;
	readonly variant?: string;
	readonly epochs?: number;
	/** Recovery: boundaries to run after the reopen (each compared with the reference). */
	readonly rollovers?: number;
	readonly order?: Int32Array;
}

const started = performance.now();
const post = (data: Json): void => postMessage(data);
const progress = (step: string, extra: Json = {}): void =>
	post({ kind: "progress", step, ms: Math.round(performance.now() - started), ...extra });
const describe = (error: unknown): Json =>
	error instanceof Error
		? {
				name: error.name,
				message: error.message,
				stack: error.stack,
				own: jsonable({ ...error }),
				...(error.cause === undefined ? {} : { cause: describe(error.cause) }),
			}
		: {
				value: String(error),
				constructor: (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? null,
				json: jsonable(error),
			};

// ---------------------------------------------------------------------------------
// Proof events (observation only), tagged with the scenario phase that emitted them.
// ---------------------------------------------------------------------------------
let phase = "setup";
let role: "creator" | "recipient" = "creator";
const events: Json[] = [];
// Measurement only (Track M2): `acquisition` says whether a pass decided from the cold
// acquisition or the plane's ledger; `action`, `source` and `role` describe ledger events.
const SLIM = [
	"kind",
	"epoch",
	"outcome",
	"reason",
	"cause",
	"ms",
	"acquiredMs",
	"decisions",
	"shortfall",
	"acquisition",
	"action",
	"source",
	"role",
];
// The node's refusal and decline diagnostics (`requireLaw`, closed-data acquisition,
// source capture), kept apart from the retention events: a refusal's origin only.
const laws: Json[] = [];
const DIAGNOSTIC = /refused|declined|mismatch|unavailable/;
const DIAGNOSTIC_KEYS = ["kind", "law", "refusal", "reason", "type", "message", "stack", "epoch", "phase"];
Reflect.set(globalThis, "__warmProofEvent", (event: Json) => {
	if (
		event !== null &&
		typeof event === "object" &&
		!String(event.kind ?? "").startsWith("room-retention") &&
		DIAGNOSTIC.test(String(event.kind ?? ""))
	) {
		const law: Json = { at: phase, room: role };
		for (const key of DIAGNOSTIC_KEYS) if (key in event) law[key] = jsonable(event[key]);
		laws.push(law);
		if (String(event.kind).endsWith("-refused")) post({ kind: "law", law });
		return;
	}
	if (event === null || typeof event !== "object" || !String(event.kind ?? "").startsWith("room-retention")) return;
	const slim: Json = { phase, room: role };
	for (const key of SLIM) if (key in event) slim[key] = jsonable(event[key]);
	if (typeof event.acquisitionStarted === "number") slim.acquisitionStarted = event.acquisitionStarted;
	events.push(slim);
	post({ kind: "event", event: slim });
});
const passes = (from: number): Json[] => events.slice(from).filter((event) => event.kind === "room-retention-pass");

// ---------------------------------------------------------------------------------
// The recipient room runs in its own origin (rpc.ts). Every call carries the phase and
// returns the proof events the recipient emitted while serving it.
// ---------------------------------------------------------------------------------
let remoteInitialized = false;
async function remoteCall<Value>(method: string, args: Json = {}): Promise<Value> {
	const reply = await call<{ value: Value; events: Json[] }>(method, { ...args, phase });
	for (const event of reply.events) {
		events.push(event);
		post({ kind: "event", event });
	}
	return reply.value;
}
const remote: Recipient = {
	receive: (envelopes, finalDigest) => remoteCall("receive", { envelopes, finalDigest }),
	state: () => remoteCall("state"),
	install: (offer, peers) => remoteCall("install", { offer, peers }),
	lull: () => remoteCall("lull"),
};
async function remoteRoom(fixture: LullFixture, retention: boolean, reopen = false): Promise<Recipient> {
	if (!remoteInitialized) {
		await remoteCall("init", { retention, invite: fixture.invite });
		remoteInitialized = true;
	}
	await remoteCall("open", { reopen });
	return remote;
}

// ---------------------------------------------------------------------------------
// Edges: post a checkpoint, then freeze this worker (and every IndexedDB transaction it
// holds open) until the parent kills the browser.
// ---------------------------------------------------------------------------------
function freeze(edge: string, extra: Json = {}): never {
	post({ kind: "checkpoint", edge, at: Math.round(performance.now() - started), ...extra });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	throw new Error("TRACK_M_14F_UNREACHABLE");
}

// ---------------------------------------------------------------------------------
// Recording of every write request to the recorded databases (test-only observation).
// ---------------------------------------------------------------------------------
interface Recorded {
	readonly seq: number;
	readonly op: ObservedWrite["op"];
	readonly database: string;
	readonly store: string;
	readonly key: string;
	readonly digest?: string;
	/** Issued on a room retirement session transaction (its scope includes room:layout). */
	readonly session: boolean;
	readonly continuation: number;
	readonly tx: number;
	readonly raw: Readonly<{ key: unknown; value?: unknown }>;
}
const transactionIds = new WeakMap<IDBTransaction, number>();
let nextTransaction = 1;
const txId = (transaction: IDBTransaction): number => {
	let id = transactionIds.get(transaction);
	if (id === undefined) {
		id = nextTransaction++;
		transactionIds.set(transaction, id);
	}
	return id;
};

function recorder(
	databases: ReadonlySet<string>,
	onWrite?: (write: Recorded, observed: ObservedWrite) => void,
	continuationOf: (observed: ObservedWrite) => number = (observed) => applying.get(observed.database) ?? -1
) {
	const writes: Recorded[] = [];
	setWriteListener((observed) => {
		if (!databases.has(observed.database)) return;
		let key: unknown = observed.key;
		if (key === undefined && observed.keyPath !== null && observed.value !== undefined)
			key = keyFromPath(observed.keyPath, observed.value);
		if (key instanceof IDBKeyRange) key = { $range: [key.lower, key.upper, key.lowerOpen, key.upperOpen] };
		const write: Recorded = {
			seq: writes.length,
			op: observed.op,
			database: observed.database,
			store: observed.store,
			key: stable(key),
			...(observed.value === undefined ? {} : { digest: rowDigest(key, observed.value) }),
			session: observed.transaction.objectStoreNames.contains("room:layout"),
			continuation: continuationOf(observed),
			tx: txId(observed.transaction),
			raw: { key, ...(observed.value === undefined ? {} : { value: observed.value }) },
		};
		writes.push(write);
		onWrite?.(write, observed);
	});
	return {
		writes,
		stop: () => setWriteListener(undefined),
		wire: (committed: ReadonlySet<number>) =>
			writes.map(({ raw: _raw, ...write }) => ({ ...write, committed: committed.has(write.tx) })),
	};
}

// ---------------------------------------------------------------------------------
// Database observation helpers.
// ---------------------------------------------------------------------------------
const OWNER_CONTROLS = (objectId: string): Record<string, readonly [string, string]> => ({
	ahe: ["ahe:storageMeta", `ahe-retirement:${objectId}`],
	signing: ["storageMeta", `signing-retirement:${objectId}`],
	snapshot: ["snapshot:retirementControls", objectId],
	journal: ["journal:retirementControls", objectId],
	issuance: ["issuance:retirementControls", objectId],
});

function rowOf(raw: RawDump | null, store: string, key: unknown): unknown {
	const wanted = stable(key);
	return raw?.stores[store]?.rows.find(([candidate]) => stable(candidate) === wanted)?.[1];
}

function ownerControls(raw: RawDump | null, objectId: string): Json {
	const out: Json = {};
	for (const [owner, [store, key]] of Object.entries(OWNER_CONTROLS(objectId))) {
		const value = rowOf(raw, store, key);
		if (value === undefined) {
			out[owner] = null;
			continue;
		}
		const decoded = deepDecode(value);
		out[owner] = {
			labels: jsonable(completedLabels(decoded)),
			digest: rowDigest(key, value),
			// The signing control in full (its completed, drain and summary source).
			...(owner === "signing" ? { decoded: jsonable(decoded) } : {}),
		};
	}
	return out;
}

function floorImage(raw: RawDump | null): Json | null {
	const value = rowOf(raw, "floor", "record");
	if (!(value instanceof Uint8Array)) return null;
	return jsonable(decodeCanonical(value)) as Json;
}

interface Observed {
	readonly raw: RawDump | null;
	readonly wire: Json;
}
async function observe(database: string, objectId: string, floor: boolean): Promise<Observed> {
	const raw = await rawDump(database);
	return {
		raw,
		wire: {
			database,
			exists: raw !== null,
			dump: raw === null ? null : digestDump(raw),
			counts: counts(raw),
			...(floor ? { floor: floorImage(raw) } : { controls: ownerControls(raw, objectId) }),
		},
	};
}

interface Names {
	readonly room: string;
	readonly floor: string;
	readonly observerRoom: string;
	readonly observerFloor: string;
}
const namesOf = (fixture: LullFixture): Names => ({
	room: fixture.host.database("creator"),
	floor: fixture.floorName("creator"),
	observerRoom: fixture.host.database("observer"),
	observerFloor: fixture.floorName("observer"),
});
async function observeAll(fixture: LullFixture): Promise<Record<keyof Names, Observed>> {
	const names = namesOf(fixture);
	const observer = await remoteCall<{ observerRoom: Json; observerFloor: Json }>("observe");
	return {
		room: await observe(names.room, fixture.objectId, false),
		floor: await observe(names.floor, fixture.objectId, true),
		observerRoom: { raw: null, wire: observer.observerRoom },
		observerFloor: { raw: null, wire: observer.observerFloor },
	};
}
const wireAll = (observed: Record<keyof Names, Observed>): Json =>
	Object.fromEntries(Object.entries(observed).map(([name, item]) => [name, item.wire]));

// ---------------------------------------------------------------------------------
// The planned decision, in a wire form (keys stable, digests only), and the exact-byte
// check of every row it names against the last known durable state.
// ---------------------------------------------------------------------------------
const PREFIX: Record<string, string> = {
	ahe: "ahe:",
	journal: "journal:",
	snapshot: "snapshot:",
	issuance: "issuance:",
	signing: "",
};
type Model = Map<string, Map<string, Readonly<{ key: unknown; value: unknown }>>>;
function modelOf(raw: RawDump): Model {
	const model: Model = new Map();
	for (const [store, rows] of Object.entries(raw.stores))
		model.set(store, new Map(rows.rows.map(([key, value]) => [stable(key), { key, value }])));
	return model;
}
function applyToModel(model: Model, writes: readonly Recorded[]): void {
	for (const write of writes) {
		const store = model.get(write.store) ?? new Map();
		model.set(write.store, store);
		if (write.op === "delete" || write.op === "cursor-delete") store.delete(write.key);
		else if (write.op === "clear") store.clear();
		else store.set(write.key, { key: write.raw.key, value: write.raw.value });
	}
}
function namespaced(owner: string, store: string): string {
	return store.includes(":") ? store : `${required(PREFIX[owner] ?? "")}${store}`;
}
function planWire(planned: Json, selection: RoomRetentionSelection, model: Model | undefined): Json {
	const decision = planned.decision as { owners: Record<string, Json> };
	const owners: Json = {};
	let named = 0,
		verified = 0;
	const unverified: string[] = [];
	for (const [owner, section] of Object.entries(decision.owners)) {
		if (section === undefined) continue;
		const deletes = (section.delete as { store: string; key: RoomRetentionKey; digest: string }[]).map((row) => {
			const store = namespaced(owner, row.store);
			const current = model?.get(store)?.get(stable(row.key));
			named++;
			const exact =
				current !== undefined &&
				roomRetentionRowDigest(roomRetentionRowBytes(row.store, row.key, current.value)) === row.digest;
			if (exact) verified++;
			else unverified.push(`${owner} ${store} ${stable(row.key)} ${current === undefined ? "absent" : "differs"}`);
			return { store, key: stable(row.key), digest: row.digest, exact };
		});
		const rewrites = (section.rewrite as { store: string; key: RoomRetentionKey; before: string; after: string }[]).map(
			(row) => ({ store: namespaced(owner, row.store), key: stable(row.key), before: row.before, after: row.after })
		);
		owners[owner] = {
			base: section.base,
			target: section.target,
			through: section.through,
			delete: deletes,
			rewrite: rewrites,
		};
	}
	return {
		decisionDigest: planned.decisionDigest,
		writes: planned.writes,
		charged: planned.charged,
		labels: {
			throughEpoch: selection.throughEpoch,
			decisionDigest: planned.decisionDigest,
			sourceProofDigest: roomRetentionSourceDigest(selection),
		},
		stableEpoch: selection.stableEpoch,
		owners,
		named,
		verified,
		unverified: unverified.slice(0, 32),
	};
}

// ---------------------------------------------------------------------------------
// Scenario steps.
// ---------------------------------------------------------------------------------
async function steadyRoom(input: Input, retention = true) {
	const fixture = await lullFixture({ retention, creatorLull: true, seed: input.seed, prefix: input.prefix });
	phase = "open";
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await remoteRoom(fixture, retention);
	progress("opened");
	for (let epoch = 0; epoch < input.steady; epoch++) {
		phase = `rollover-${epoch}`;
		const lulls = await rollover(fixture, creator, recipient, epoch);
		progress(phase, { lulls: jsonable(lulls) });
	}
	return { fixture, creator, recipient };
}

async function smoke(input: Input): Promise<Json> {
	const { fixture, creator, recipient } = await steadyRoom(input);
	phase = `transition-${input.steady}`;
	await transition(fixture, creator, recipient, input.steady);
	const before = events.length;
	phase = `creator-lull-${input.steady}`;
	const creatorLull = await creator.room.maintainRecoveryPool();
	phase = `recipient-lull-${input.steady}`;
	const recipientLull = await recipient.lull();
	const observed = await observeAll(fixture);
	await remoteCall("stop");
	await fixture.stop(creator);
	return {
		creatorLull: jsonable(creatorLull),
		recipientLull: jsonable(recipientLull),
		passes: passes(before),
		counts: { room: observed.room.wire.counts, observerRoom: observed.observerRoom.wire.counts },
		controls: { room: observed.room.wire.controls, floor: observed.floor.wire.floor },
	};
}

/** Case 2: the creator lull's first retention transaction is aborted after its last request. */
async function case2(input: Input): Promise<Json> {
	const variant = input.variant ?? "refusal";
	const { fixture, creator, recipient } = await steadyRoom(input);
	phase = `transition-${input.steady}`;
	await transition(fixture, creator, recipient, input.steady);
	const names = namesOf(fixture);
	let pre: Observed | undefined, preFloor: Observed | undefined;
	let afterAbort: Observed | undefined, afterAbortFloor: Observed | undefined;
	let fired = false;
	let applied: Json | undefined;
	let sessionTransaction: IDBTransaction | undefined;
	const record = recorder(new Set([names.room]), (write, observed) => {
		if (write.session && write.continuation === 0) sessionTransaction = observed.transaction;
	});
	const trap = trapRetention(fixture, {
		beforeFirstPlan: async ({ database }) => {
			if (database !== names.room || pre !== undefined) return;
			pre = await observe(names.room, fixture.objectId, false);
			preFloor = await observe(names.floor, fixture.objectId, true);
		},
		afterApply: ({ database, index, applied: result }) => {
			if (database !== names.room || index !== 0 || fired) return;
			fired = true;
			applied = { writes: result.writes, charged: result.charged, decisionDigest: result.decisionDigest };
			if (variant === "native-abort") {
				// The engine aborts the retention transaction after its last request answered.
				required(sessionTransaction, "TRACK_M_14F_NO_SESSION_TRANSACTION").abort();
				return;
			}
			throw new RoomRetentionRefusal("RETENTION_STALE", "track-m-14f-injected-abort");
		},
		afterAbort: async ({ database }) => {
			if (database !== names.room || afterAbort !== undefined || !fired) return;
			afterAbort = await observe(names.room, fixture.objectId, false);
			afterAbortFloor = await observe(names.floor, fixture.objectId, true);
		},
	});
	const before = events.length;
	phase = `creator-lull-${input.steady}`;
	let lull: unknown;
	try {
		lull = await creator.room.maintainRecoveryPool();
	} catch (error) {
		lull = { threw: describe(error) };
	} finally {
		trap.release();
		record.stop();
	}
	const lullPasses = passes(before);
	const lullEvents = events.slice(before);
	// The following lull of the same boundary, then the next boundary on the retention
	// path. A refusal retains: the same lull's next pass runs the existing path, then
	// retention again. A failure rethrows and the creator's live plane fails closed; the
	// room then continues from the same databases after a reopen.
	const againStart = events.length;
	phase = `creator-lull-${input.steady}-again`;
	let again: unknown;
	try {
		again = await creator.room.maintainRecoveryPool();
	} catch (error) {
		again = { threw: describe(error) };
	}
	const againPasses = passes(againStart);
	let room = creator;
	let reopened: Json | null = null;
	if (variant === "native-abort") {
		phase = `creator-reopen-${input.steady}`;
		const closing: Json = {};
		try {
			await creator.room.close();
		} catch (error) {
			closing.roomCloseThrew = describe(error);
		}
		rooms.delete(creator.room);
		await creator.floor.close();
		heads.delete(creator.floor);
		room = await fixture.open("creator", fixture.creator, { reopen: true });
		const reopenStart = events.length;
		phase = `creator-lull-${input.steady}-reopened`;
		const lullReopened = await room.room.maintainRecoveryPool();
		reopened = {
			...closing,
			ok: true,
			authority: jsonable(room.room.authority()),
			lull: jsonable(lullReopened),
			passes: passes(reopenStart),
			events: events.slice(reopenStart),
		};
	}
	phase = `recipient-lull-${input.steady}`;
	const recipientLull = await recipient.lull();
	const next = events.length;
	phase = `rollover-${input.steady + 1}`;
	const nextLulls = await rollover(fixture, room, recipient, input.steady + 1);
	const nextPasses = passes(next);
	const sessionWrites = record.writes.filter((write) => write.session && write.continuation === 0);
	await remoteCall("stop");
	await fixture.stop(room);
	return {
		variant,
		fired,
		applied,
		storesInTransaction: sessionTransaction === undefined ? [] : [...sessionTransaction.objectStoreNames],
		durability: sessionTransaction?.durability,
		sessionWrites: sessionWrites.map(({ op, store, key }) => ({ op, store, key })),
		pre: required(pre).wire,
		afterAbort: afterAbort?.wire ?? null,
		preFloor: required(preFloor).wire,
		afterAbortFloor: afterAbortFloor?.wire ?? null,
		lull: jsonable(lull),
		lullPasses,
		lullEvents,
		again: jsonable(again),
		againPasses,
		reopened,
		recipientLull: jsonable(recipientLull),
		nextLulls: jsonable(nextLulls),
		nextPasses,
	};
}

/** Ordinary writes of the rows the boundary's lull retired, by each genuine owner (14b RED 3). */
async function staleWrites(fixture: LullFixture, before: RawDump, after: RawDump): Promise<Json> {
	const gone = (store: string) =>
		(before.stores[store]?.rows ?? []).filter(
			([key]) => !(after.stores[store]?.rows ?? []).some(([other]) => stable(other) === stable(key))
		);
	const out: Json = {};
	const outcome = async (run: () => Promise<unknown>) => {
		try {
			return jsonable(await run());
		} catch (error) {
			return { threw: (error as { code?: unknown }).code ?? (error instanceof Error ? error.message : String(error)) };
		}
	};
	const evidence = gone("sealEvidence")[0];
	if (evidence !== undefined) {
		const store = await fixture.host.storageHost.openSealEvidence("creator");
		try {
			const adapter = required(resolveCreatorCloseEvidenceStore(store.store));
			out.signing = await outcome(() => adapter.put(evidence[1] as Parameters<typeof adapter.put>[0], null));
		} finally {
			await store.close();
		}
	}
	const journal = await fixture.host.storageHost.openJournal("creator");
	try {
		const row = gone("journal:acceptedEntries")[0];
		if (row !== undefined) {
			const value = row[1] as Record<string, unknown>;
			out.journalAppend = await outcome(() =>
				journal.appendAccepted({
					scope: {
						objectId: String(value.objectId),
						epoch: Number(value.epoch),
						anchorDigest: String(value.anchorDigest),
					},
					sourceKind: "local-issued",
					vertexDigest: String(value.vertexDigest),
					author: String(value.localAuthor),
					authorSequence: Number(value.localAuthorSequence),
				} as Parameters<typeof journal.appendAccepted>[0])
			);
		}
		const header = gone("journal:scopes")[0];
		if (header !== undefined) {
			const value = header[1] as Record<string, Uint8Array | string>;
			out.journalAnchor = await outcome(() =>
				journal.installEpochAnchor({
					objectId: String(value.objectId),
					exactCanonicalAnchorPreimageBytes: value.exactCanonicalAnchorPreimageBytes as Uint8Array,
					detachedAnchorSignature: value.detachedAnchorSignature as Uint8Array,
					exactCanonicalParametersCarrierBytes: value.exactCanonicalParametersCarrierBytes as Uint8Array,
				})
			);
		}
	} finally {
		await journal.close();
	}
	const scope = gone("snapshot:scopes")[0];
	if (scope !== undefined) {
		const declaration = fixture.declarations.get(Number((scope[1] as Record<string, unknown>).epoch));
		const snapshots = await fixture.host.storageHost.openSnapshots("creator");
		try {
			if (declaration !== undefined)
				out.snapshot = await snapshots
					.openScope(declaration as Parameters<typeof snapshots.openScope>[0])
					.then(async (opened) => {
						await opened.release();
						return { ok: true };
					})
					.catch((error: unknown) => ({ ok: false, code: (error as { code?: unknown }).code ?? String(error) }));
		} finally {
			await snapshots.close();
		}
	}
	const generation = gone("ahe:generations")[0];
	if (generation !== undefined) {
		const decoded = decodeGenerationRecordV1((generation[1] as Record<string, unknown>).record as Uint8Array);
		if (!decoded.ok) throw new TypeError("TRACK_M_GENERATION");
		const ahe = await fixture.host.storageHost.openAhe("creator--ahe");
		try {
			out.ahe = await outcome(() =>
				ahe.beginGeneration({
					objectId: decoded.value.objectId,
					generationId: decoded.value.generationId,
					baseExpectedHead: decoded.value.baseExpectedHead,
					closure: decoded.value.closure,
				})
			);
		} finally {
			await ahe.close();
		}
	}
	return out;
}

/** Case 3: a foreign strict writer in ANOTHER worker against step B, then stale writers. */
async function case3(input: Input): Promise<Json> {
	const order = required(input.order, "TRACK_M_14F_ORDER");
	const { fixture, creator, recipient } = await steadyRoom(input);
	phase = `transition-${input.steady}`;
	await transition(fixture, creator, recipient, input.steady);
	const names = namesOf(fixture);
	// Read before the lull: a read while step B holds the room would itself wait for it.
	const preRaw = required(await rawDump(names.room));
	const control = rowOf(preRaw, "issuance:retirementControls", fixture.objectId) as Record<string, unknown>;
	const journalControlKey = fixture.objectId;
	const scratch = `${fixture.objectId}:track-m-14f-foreign`;
	const sequence: Json[] = [];
	const mark = (what: string): number => {
		const at = Atomics.add(order, 0, 1);
		sequence.push({ what, at });
		return at;
	};
	let foreign: Promise<Json> | undefined;
	const record = recorder(new Set([names.room]));
	const trap = trapRetention(fixture, {
		afterPlan: async ({ database, index }) => {
			if (database !== names.room || index !== 0 || foreign !== undefined) return;
			// Another worker (its own connection and thread) starts a strict read-write
			// transaction over two stores step B holds; wait until its requests are issued.
			let issued: () => void = () => undefined;
			const requestsIssued = new Promise<void>((resolve) => (issued = resolve));
			foreign = new Promise<Json>((resolve) => {
				const listener = (event: MessageEvent<Json>): void => {
					const data = event.data;
					if (data?.kind === "foreign-issued") issued();
					if (data?.kind === "foreign-done") {
						removeEventListener("message", listener);
						resolve(data);
					}
				};
				addEventListener("message", listener);
			});
			mark("foreign-requested");
			post({
				kind: "foreign-request",
				database,
				stores: ["issuance:retirementControls", "journal:retirementControls"],
				put: { store: "issuance:retirementControls", key: scratch, value: { ...control, objectId: scratch } },
				read: { store: "journal:retirementControls", key: journalControlKey },
			});
			await requestsIssued;
			mark("foreign-issued-seen");
		},
		afterApply: ({ database, index }) => {
			if (database === names.room && index === 0) mark("step-b-applied");
		},
		afterCommit: ({ database, index, kind }) => {
			if (database === names.room) mark(`${kind}-${index}-committed`);
		},
	});
	const before = events.length;
	phase = `creator-lull-${input.steady}`;
	let lull: unknown;
	try {
		lull = await creator.room.maintainRecoveryPool();
	} finally {
		trap.release();
		record.stop();
	}
	const foreignDone = await required(foreign, "TRACK_M_14F_FOREIGN_NOT_STARTED");
	// The journal control the first continuation's step B wrote (its exact row digest).
	const firstControl = record.writes
		.filter(
			(write) =>
				write.session &&
				write.continuation === 0 &&
				write.store === "journal:retirementControls" &&
				write.key === stable(journalControlKey) &&
				write.op === "put"
		)
		.at(-1);
	const sessionStores = [...new Set(record.writes.filter((write) => write.session).map((write) => write.store))];
	const lullPasses = passes(before);
	const afterRaw = required(await rawDump(names.room));
	// The journal control the foreign transaction read, against the pre-lull and final ones.
	const journalBefore = rowOf(preRaw, "journal:retirementControls", journalControlKey);
	const journalAfter = rowOf(afterRaw, "journal:retirementControls", journalControlKey);
	phase = "stale-writers";
	const stale = await staleWrites(fixture, preRaw, afterRaw);
	const afterStale = digestDump(required(await rawDump(names.room)));
	const afterLull = digestDump(afterRaw);
	const changed = [...new Set([...Object.keys(afterLull.stores), ...Object.keys(afterStale.stores)])].filter(
		(store) => stable(afterLull.stores[store]) !== stable(afterStale.stores[store])
	);
	phase = `recipient-lull-${input.steady}`;
	await recipient.lull();
	await remoteCall("stop");
	await fixture.stop(creator);
	return {
		lull: jsonable(lull),
		lullPasses,
		sequence,
		foreign: foreignDone,
		journalControl: {
			before: rowDigest(journalControlKey, journalBefore),
			afterFirstContinuation: firstControl?.digest ?? null,
			after: rowDigest(journalControlKey, journalAfter),
		},
		sessionStores,
		stale,
		storesChangedByStaleWriters: changed,
	};
}

/** The existing path's stale-writer outcomes for the same boundary (the comparison of 14b RED 3). */
async function case3Existing(input: Input): Promise<Json> {
	const { fixture, creator, recipient } = await steadyRoom(input, false);
	phase = `transition-${input.steady}`;
	await transition(fixture, creator, recipient, input.steady);
	const names = namesOf(fixture);
	const preRaw = required(await rawDump(names.room));
	phase = `creator-lull-${input.steady}`;
	const lull = await creator.room.maintainRecoveryPool();
	const afterRaw = required(await rawDump(names.room));
	phase = "stale-writers";
	const stale = await staleWrites(fixture, preRaw, afterRaw);
	await remoteCall("stop");
	await fixture.stop(creator);
	return { lull: jsonable(lull), stale };
}

/**
 * Track O: the units a selection carries (the snapshot turnover, each journal header and
 * prefix, each epoch's signing work, each AHE unit), as the node's planner splits them.
 * @param value - A retention selection.
 * @returns How many units it carries.
 */
function unitCount(value: Readonly<Record<string, unknown>>): number {
	const selection = value as unknown as RoomRetentionSelection;
	const epochs = new Set<unknown>([
		...selection.signing.evidence.map((entry) => entry.key[1]),
		...selection.signing.summaries.map((entry) => entry.key[1]),
	]);
	return (
		(selection.snapshot.retire.length === 0 ? 0 : 1) +
		selection.journal.headers.length +
		selection.journal.prefixes.length +
		epochs.size +
		selection.ahe.units.length
	);
}

/** One SIGKILL edge of the creator lull's retention decision `continuation`. */
async function mutate(input: Input): Promise<Json> {
	const edge = required(input.edge);
	const target = input.continuation ?? 0;
	const { fixture, creator, recipient } = await steadyRoom(input);
	phase = `transition-${input.steady}`;
	await transition(fixture, creator, recipient, input.steady);
	const names = namesOf(fixture);
	let model: Model | undefined;
	const committed = new Set<number>();
	const plans = new Map<number, Json>();
	let pre = false;
	let deletesSeen = 0;
	let insideB: { deletes: number; puts: number } | undefined;
	let fenceArmed = false;
	// A floor write belongs to the continuation whose plan preceded it (its step A).
	let fencing = -1;
	const continuationOf = (observed: ObservedWrite): number =>
		observed.database === names.floor ? fencing : (applying.get(observed.database) ?? -1);
	const record = recorder(
		new Set([names.room, names.floor]),
		(write) => {
			if (fenceArmed && write.database === names.floor && write.store === "floor" && write.op === "put") {
				fenceArmed = false;
				freeze("inside-a", { continuation: target, writes: record.wire(committed) });
			}
			if (insideB !== undefined && write.database === names.room && write.session && write.continuation === target) {
				if (write.op === "delete") deletesSeen++;
				const due = insideB.deletes > 0 ? write.op === "delete" && deletesSeen >= insideB.deletes : write.op === "put";
				if (due) {
					insideB = undefined;
					freeze("inside-b", { continuation: target, deletesIssued: deletesSeen, writes: record.wire(committed) });
				}
			}
		},
		continuationOf
	);
	let fenceTransaction: number | undefined;
	const trap = trapRetention(fixture, {
		beforeFirstPlan: async ({ database }) => {
			if (database !== names.room || pre) return;
			pre = true;
			const observed = await observeAll(fixture);
			model = modelOf(required(observed.room.raw));
			post({ kind: "pre", observed: wireAll(observed) });
		},
		// Track O: a one-unit cap, so the target continuation can be any unit of the boundary.
		...(input.oneUnit === true
			? {
					beforePlan: ({
						database,
						selection,
					}: Readonly<{ database: string; selection: Readonly<Record<string, unknown>> }>) => {
						if (database === names.room && unitCount(selection) > 1)
							throw new RoomRetentionRefusal("RETENTION_CAPACITY", "track-o:one-unit");
					},
				}
			: {}),
		afterPlan: ({ database, index, planned, selection }) => {
			if (database !== names.room) return;
			const wire = planWire(planned, selection as unknown as RoomRetentionSelection, model);
			plans.set(index, wire);
			fencing = index;
			post({ kind: "plan", index, plan: wire, units: unitCount(selection) });
			if (index !== target) return;
			if (edge === "inside-a") fenceArmed = true;
		},
		beforeApply: ({ database, index }) => {
			if (database !== names.room) return;
			// Step A of this continuation returned: its floor transaction committed.
			for (const write of record.writes)
				if (write.database === names.floor && !committed.has(write.tx)) {
					committed.add(write.tx);
					fenceTransaction = write.tx;
				}
			if (index !== target) return;
			if (edge === "between-a-b") freeze("between-a-b", { continuation: target, writes: record.wire(committed) });
			if (edge === "inside-b") {
				const plan = required(plans.get(index)) as { owners: Record<string, { delete: unknown[] }> };
				const total = Object.values(plan.owners).reduce((sum, section) => sum + section.delete.length, 0);
				insideB = { deletes: total === 0 ? 0 : Math.max(1, Math.ceil(total / 2)), puts: 0 };
				deletesSeen = 0;
			}
		},
		afterCommit: ({ database, index, kind }) => {
			if (database !== names.room || kind !== "checkpoint") return;
			const ofContinuation = record.writes.filter(
				(write) => write.database === names.room && write.session && write.continuation === index
			);
			for (const write of ofContinuation) committed.add(write.tx);
			if (model !== undefined) applyToModel(model, ofContinuation);
			if (index === target && edge === "after-b")
				freeze("after-b", { continuation: target, writes: record.wire(committed), fenceTransaction });
		},
	});
	const before = events.length;
	phase = `creator-lull-${input.steady}`;
	let lull: unknown;
	try {
		lull = await creator.room.maintainRecoveryPool();
	} finally {
		trap.release();
		record.stop();
	}
	const lullPasses = passes(before);
	if (edge !== "none") return { kind: "unexpected-result", lull: jsonable(lull), lullPasses, plans: [...plans] };
	// The crash-free reference: the same boundary completes; then a graceful close.
	const observed = await observeAll(fixture);
	await remoteCall("stop");
	await fixture.stop(creator);
	return {
		lull: jsonable(lull),
		lullPasses,
		plans: [...plans],
		writes: record.wire(committed),
		observed: wireAll(observed),
	};
}

/** Recovery from the same profile: observe every database, reopen both rooms and run `rollovers` more boundaries. */
async function recover(input: Input): Promise<Json> {
	const fixture = await lullFixture({ retention: true, creatorLull: true, seed: input.seed, prefix: input.prefix });
	await remoteCall("init", { retention: true, invite: fixture.invite });
	remoteInitialized = true;
	phase = "recovered";
	const recovered = await observeAll(fixture);
	post({ kind: "recovered", observed: wireAll(recovered) });
	phase = "reopen";
	let creator: OpenedRoom, recipient: Recipient;
	try {
		creator = await fixture.open("creator", fixture.creator, { reopen: true });
		recipient = await remoteRoom(fixture, true, true);
	} catch (error) {
		return { reopen: { failed: describe(error) } };
	}
	progress("reopened");
	const before = events.length;
	const countsOf = (observed: Record<keyof Names, Observed>): Json =>
		Object.fromEntries(Object.entries(observed).map(([name, item]) => [name, item.wire.counts]));
	const byRollover: Json[] = [];
	const lulls: unknown[] = [];
	let converged: Record<keyof Names, Observed> | undefined;
	for (let index = 0; index < (input.rollovers ?? 1); index++) {
		const epoch = input.steady + 1 + index;
		const start = events.length;
		const base = `rollover-${epoch}`;
		phase = base;
		try {
			lulls.push(jsonable(await rollover(fixture, creator, recipient, epoch, (name) => (phase = `${base}:${name}`))));
		} catch (error) {
			return {
				reopen: { ok: true },
				rollover: { failed: describe(error), index, phase },
				passes: passes(before),
				byRollover,
				laws: laws.slice(-40),
				failedObserved: wireAll(await observeAll(fixture)),
			};
		}
		converged = await observeAll(fixture);
		byRollover.push({
			epoch,
			counts: countsOf(converged),
			passes: passes(start),
			controls: { room: converged.room.wire.controls, floor: converged.floor.wire.floor },
		});
		progress(`recovered-${base}`);
	}
	await remoteCall("stop");
	await fixture.stop(creator);
	const last = required(converged);
	return {
		reopen: { ok: true },
		rollover: { ok: true, lulls },
		passes: passes(before),
		byRollover,
		counts: countsOf(last),
		controls: { room: last.room.wire.controls, floor: last.floor.wire.floor },
	};
}

/** One room database's census at `epoch`: the journal control's range and every store's count. */
function censusOf(objectId: string, epoch: number, raw: RawDump | null): Json {
	const all = counts(raw);
	const row = rowOf(raw, "journal:retirementControls", objectId) as { record?: unknown } | undefined;
	const control = (row?.record instanceof Uint8Array ? decodeCanonical(row.record) : undefined) as
		| { completed?: { throughEpoch: number; protectedScopes: readonly { epoch: number }[] } | null }
		| undefined;
	return {
		epoch,
		journalThrough: control?.completed?.throughEpoch ?? null,
		journalProtected: control?.completed?.protectedScopes.map((scope) => scope.epoch) ?? null,
		journalEpochs: (raw?.stores["journal:scopes"]?.rows ?? []).map(([key]) => Number((key as unknown[])[1])),
		counts: all,
	};
}

/** The recipient realm: its room, floor and databases, serving the creator worker. */
function recipientServer(input: Input): void {
	role = "recipient";
	let fixture: LullFixture | undefined;
	let opened: OpenedRoom | undefined;
	let local: Recipient | undefined;
	const dispatch = (bytes: Uint8Array): Promise<readonly Uint8Array[]> => call("dispatch", { bytes });
	const handle =
		(handler: (args: Json) => Promise<unknown>) =>
		async (args: unknown): Promise<unknown> => {
			const selected = args as Json;
			phase = String(selected.phase ?? phase);
			const start = events.length;
			const value = await handler(selected);
			return { value: value === undefined ? null : value, events: events.slice(start) };
		};
	serve(
		"init",
		handle(async (args) => {
			fixture = await lullFixture({
				retention: args.retention === true,
				creatorLull: true,
				seed: input.seed,
				prefix: input.prefix,
				invite: args.invite as Parameters<typeof lullFixture>[0]["invite"],
			});
			return { objectId: fixture.objectId };
		})
	);
	serve(
		"open",
		handle(async (args) => {
			const selected = required(fixture);
			opened = await selected.open("observer", selected.observer, {
				receiveOnly: true,
				...(args.reopen === true ? { reopen: true } : {}),
			});
			local = localRecipient(opened, dispatch);
			return { ok: true };
		})
	);
	serve(
		"receive",
		handle((args) => required(local).receive(args.envelopes as Envelope[], String(args.finalDigest)))
	);
	serve(
		"state",
		handle(() => required(local).state())
	);
	serve(
		"install",
		handle((args) => required(local).install(args.offer, args.peers as string[]))
	);
	serve(
		"lull",
		handle(async () => jsonable(await required(local).lull()))
	);
	serve(
		"observe",
		handle(async () => {
			const selected = required(fixture);
			const names = namesOf(selected);
			return {
				observerRoom: (await observe(names.observerRoom, selected.objectId, false)).wire,
				observerFloor: (await observe(names.observerFloor, selected.objectId, true)).wire,
			};
		})
	);
	serve(
		"census",
		handle(async (args) => {
			const selected = required(fixture);
			return censusOf(selected.objectId, Number(args.epoch), await rawDump(namesOf(selected).observerRoom));
		})
	);
	serve(
		"stop",
		handle(async () => {
			await required(fixture).stop(required(opened));
			opened = undefined;
			local = undefined;
		})
	);
	serve(
		"close",
		handle(async () => (await closeFixtures()).map(describe))
	);
	post({ kind: "ready", role });
}

/** Case 11: the long room's census (14b acceptance 6). */
async function long(input: Input): Promise<Json> {
	const epochs = input.epochs ?? 16;
	const retention = input.variant !== "existing";
	const fixture = await lullFixture({ retention, creatorLull: true, seed: input.seed, prefix: input.prefix });
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await remoteRoom(fixture, retention);
	const names = namesOf(fixture);
	const census = (epoch: number, raw: RawDump | null): Json => censusOf(fixture.objectId, epoch, raw);
	const installed: Json[] = [];
	const lulled: Json[] = [];
	const before = events.length;
	for (let epoch = 0; epoch < epochs; epoch++) {
		phase = `transition-${epoch}`;
		await transition(fixture, creator, recipient, epoch);
		installed.push({
			creator: census(epoch + 1, await rawDump(names.room)),
			recipient: await remoteCall<Json>("census", { epoch: epoch + 1 }),
		});
		phase = `lulls-${epoch}`;
		const lulls = [await creator.room.maintainRecoveryPool(), await recipient.lull()];
		lulled.push({
			lulls: lulls.map((lull) => (lull as { kind?: unknown }).kind),
			creator: census(epoch + 1, await rawDump(names.room)),
			recipient: await remoteCall<Json>("census", { epoch: epoch + 1 }),
		});
		progress(`epoch-${epoch + 1}`);
	}
	await remoteCall("stop");
	await fixture.stop(creator);
	return { retention, epochs, installed, lulled, passes: passes(before).map((pass) => pass.outcome) };
}

serve("dispatch", (args) => dispatchSuccessorFrames((args as { bytes: Uint8Array }).bytes));

self.addEventListener("message", (event: MessageEvent<Input & { kind?: string }>): void => {
	const input = event.data;
	if (receiveRpc(input as unknown as Json)) return;
	if (input.kind !== undefined) return; // A relayed message for a waiting step.
	if (input.mode === "recipient") {
		post({ kind: "started", mode: input.mode, userAgent: navigator.userAgent, isolated: crossOriginIsolated });
		recipientServer(input);
		return;
	}
	void (async (): Promise<void> => {
		post({ kind: "started", mode: input.mode, userAgent: navigator.userAgent, isolated: crossOriginIsolated });
		let result: Json;
		if (input.mode === "smoke") result = await smoke(input);
		else if (input.mode === "case2") result = await case2(input);
		else if (input.mode === "case3")
			result = input.variant === "existing" ? await case3Existing(input) : await case3(input);
		else if (input.mode === "mutate") result = await mutate(input);
		else if (input.mode === "recover") result = await recover(input);
		else if (input.mode === "long") result = await long(input);
		else throw new TypeError(`TRACK_M_14F_MODE ${String(input.mode)}`);
		const leaked = await closeFixtures();
		check(leaked.length === 0, `close ${JSON.stringify(leaked.map(describe))}`);
		if (remoteInitialized) {
			const remoteLeaked = await remoteCall<unknown[]>("close");
			check(remoteLeaked.length === 0, `recipient close ${JSON.stringify(remoteLeaked)}`);
		}
		post({ kind: "result", ms: Math.round(performance.now() - started), result });
	})().catch(async (error: unknown) => {
		let held: unknown;
		try {
			held = jsonable(await navigator.locks.query());
		} catch (cause) {
			held = describe(cause);
		}
		post({ kind: "worker-error", phase, error: describe(error), locks: { held, requests: lockLog() } });
	});
});
