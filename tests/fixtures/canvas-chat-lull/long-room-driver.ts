// Track Q (Canvas and Chat creator lull): the long-room coordinator. It has no product
// imports, so the Playwright process can drive two browser pages with it as well as
// in-process endpoints under vitest. Adapted from Track M's measurement harness
// (tests/fixtures/track-m-apps/ on Track M's branch, commit da3704ac), without its retention
// host. Each role is a `RoleEndpoint` (long-room-core.ts `openRole`). Everything crossing
// an endpoint is plain data (bytes as base64). Every latency is measured inside the role
// that does the work.
//
// Per epoch: ordinary moves, seal, adoption, export, install, the creator's lull (optionally
// with moves arriving while it runs), the recipient's lull, a census, and optionally a
// persisted reopen of both roles. The creator's "closed-retirement-selection" proof events
// are counted per window (seal, adoption, lull), so a test can tell where retirement ran.
// Observation only: nothing here is a bound or a grant.

export type HostKind = "node" | "browser" | "room";
export type AppKind = "canvas" | "chat";
export type RecipientMode = "receive-only" | "writer";
/** "shipped": the application exactly as composed by the product. "absent": the same
 * application with `readOrdinaryApplicationResourceBound` removed (the pre-Track-Q shape). */
export type BoundMode = "shipped" | "absent";

export interface LongRoomOptions {
	readonly app: AppKind;
	readonly host: HostKind;
	readonly recipient: RecipientMode;
	readonly bound: BoundMode;
	readonly epochs: number;
	/** Ordinary moves per Writer per epoch, each delivered to the other role before the next. */
	readonly moves: number;
	/** Moves that arrive while the creator's lull runs: the Writer recipient's (delivered to
	 * the creator during the lull) plus one local creator move. 0 runs the lull alone. */
	readonly lullMoves: number;
	/** Close and reopen both roles from their persisted stores after this epoch (1-based). */
	readonly reopenAfter?: number;
}

export type StoreCensus = Readonly<Record<string, readonly [rows: number, bytes: number]>>;

/** The creator's proof events in one window, by kind (only the kinds the tests read). */
export interface WindowEvents {
	readonly retirementSelections: number;
	readonly boundaryReadiness: number;
	readonly total: number;
}

export interface LullIngress {
	/** Recipient rows delivered to the creator during its lull. */
	readonly delivered: number;
	/** The operation action of each delivered row, in delivery order. */
	readonly deliveredActions: readonly string[];
	/** The lull's own retirement selection was observed before the delivery (its boundary had entered). */
	readonly entered: boolean;
	/** The lull had not settled when the rows were handed to the creator's ingress. */
	readonly pendingAtDelivery: boolean;
	/** Milliseconds from the lull's start to the delivery. */
	readonly deliveredAfterMs: number;
	/** The creator's local move was issued while the lull was pending. */
	readonly localIssuedDuringLull: boolean;
	/** Delivered rows the creator reported through `onAcceptedVertex`. */
	readonly reported: number;
	/** Delivered protocol controls (not reported through `onAcceptedVertex`) that a reported
	 * delivered row depends on, directly or through other delivered rows: admitted before it. */
	readonly controlsCovered: number;
	/** Every delivered row was admitted (reported, or a protocol control a reported row depends
	 * on) and so was the creator's local move. Nothing was dropped. */
	readonly allAdmitted: boolean;
	/** The reported delivered rows were accepted in delivery order. */
	readonly fifo: boolean;
	/** The last delivered row's acceptance, and the local move's, settled after the lull. */
	readonly remoteSettledAfterLull: boolean | null;
	readonly localSettledAfterLull: boolean;
	/** Creator acceptance order of this step: "r<i>" = i-th delivered row, "l" = local move. */
	readonly order: readonly string[];
	/** The Writer recipient's issue time of each delivered row (before the lull started). */
	readonly remoteIssueMs: readonly number[];
	/** The creator's wall time to accept the last delivered row (from delivery). */
	readonly remoteAdmitMs: number | null;
	/** The creator's wall time of its own move issued during the lull. */
	readonly localIssueMs: number;
	/** The recipient's wall time to accept the creator's lull move, after both lulls. */
	readonly localDeliveryMs: number | null;
}

export interface EpochRecord {
	readonly epoch: number;
	readonly lulled: Readonly<{ creator: StoreCensus; recipient: StoreCensus }>;
	readonly latency: Readonly<{
		creatorIssue: readonly number[];
		recipientIssue: readonly number[];
		creatorAdmitsRemote: readonly number[];
		recipientAdmitsRemote: readonly number[];
		seal: number;
		adopt: number;
		exportOffer: number;
		install: number;
		creatorLull: number;
		recipientLull: number;
	}>;
	readonly lulls: Readonly<{ creator: string; recipient: string }>;
	/** The creator's proof events per window. */
	readonly windows: Readonly<{ seal: WindowEvents; adopt: WindowEvents; lull: WindowEvents; other: WindowEvents }>;
	readonly lullIngress?: LullIngress;
	/** Both roles were closed and reopened from their persisted stores after this epoch. */
	readonly reopened?: Readonly<{ ms: number; state: boolean; authority: number | null }>;
	/** Whatever the platform's `sample` hook returned after this epoch (e.g. long tasks). */
	readonly sample?: Readonly<Record<string, unknown>>;
}

export interface LongRoomRun {
	readonly label: string;
	readonly epochs: readonly EpochRecord[];
}

/** One authenticated published row (base64 envelope parts). */
export interface WireRow {
	readonly preimage: string;
	readonly signature: string;
	readonly digest: string;
	readonly authorSequence: number;
	/** The operation action of the signed preimage (observation only). */
	readonly action?: string;
	/** Hex digests of the vertex's declared dependencies (observation only). */
	readonly dependencies?: readonly string[];
}

/** The creator successor offer (base64 of its four exact canonical byte strings). */
export type WireOffer = Readonly<Record<string, string>>;

export interface ObservedEvent {
	readonly kind: string;
}

export interface LullWithIngressResult {
	readonly ms: number;
	readonly kind: string;
	/** The lull's retirement selection was observed before the delivery. */
	readonly selected: boolean;
	readonly pendingAtDelivery: boolean;
	readonly deliveredAfterMs: number;
	readonly localIssuedDuringLull: boolean;
	readonly remote: Readonly<{ ms: number; settledAfterLull: boolean }> | null;
	readonly local: Readonly<{ ms: number; settledAfterLull: boolean }>;
	/** Hex digests this role accepted during the step, in acceptance order. */
	readonly accepted: readonly string[];
}

export interface RoleEndpoint {
	/** Issues one ordinary move; returns its wall time. */
	issue(epoch: number, ordinal: number): Promise<number>;
	/** Every published own row above `after` (an author sequence), in issue order. */
	published(after: number | null): Promise<WireRow[]>;
	/** Delivers the other role's rows; returns the wall time until the last one is accepted. */
	receive(rows: readonly WireRow[]): Promise<number>;
	/** Hex of the canonical application state of the current projection. */
	state(): Promise<string>;
	/** Creator: seals `epoch` (throws on refusal); returns its wall time. */
	seal(epoch: number): Promise<number>;
	/** Creator: adopts the sealed successor; returns its wall time. */
	adopt(): Promise<number>;
	/** Creator: exports the adopted successor through its own material host. */
	exportOffer(): Promise<Readonly<{ offer: WireOffer; ms: number }>>;
	/** Creator: one material request of the recipient (base64) to the response frames. */
	dispatch(request: string): Promise<string[]>;
	/** Recipient: installs the offered successor (material through the environment relay). */
	install(offer: WireOffer): Promise<number>;
	authorityEpoch(): Promise<number | null>;
	/** `maintainRecoveryPool()`: wall time and result kind. */
	lull(): Promise<Readonly<{ ms: number; kind: string }>>;
	/** Creator: `maintainRecoveryPool()` with `rows` delivered and one local move (`ordinal`)
	 * issued while it runs, both joined; see long-room-core.ts. */
	lullWithIngress(rows: readonly WireRow[], epoch: number, ordinal: number): Promise<LullWithIngressResult>;
	/** Hex digests of every vertex this role accepted, in acceptance order, from index `from`. */
	accepted(from: number): Promise<string[]>;
	census(): Promise<StoreCensus>;
	/** This role's observer events since the previous drain. */
	drainEvents(): Promise<ObservedEvent[]>;
	close(): Promise<void>;
}

export interface DriveHooks {
	/** Macrotask yield before each seal (Track M finding 5: NATIVE_READ_RESERVATION_BUSY). */
	readonly settleMs?: number;
	/** Closes both roles and reopens them from their persisted stores. */
	reopen?(): Promise<readonly [creator: RoleEndpoint, recipient: RoleEndpoint]>;
	/** Platform observations after each epoch's census (e.g. long tasks per page). */
	sample?(): Promise<Readonly<Record<string, unknown>>>;
	write?(record: EpochRecord): void;
	log?(line: string): void;
	now?(): number;
}

export function toBase64(bytes: Uint8Array): string {
	let text = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export function labelOf(options: LongRoomOptions): string {
	return `${options.app}-${options.recipient}-${options.bound}-${options.host}`;
}

export const RETIREMENT_SELECTION = "closed-retirement-selection";

function windowEvents(events: readonly ObservedEvent[]): WindowEvents {
	return {
		retirementSelections: events.filter((event) => event.kind === RETIREMENT_SELECTION).length,
		boundaryReadiness: events.filter((event) => event.kind === "ordinary-boundary-readiness").length,
		total: events.length,
	};
}

const sleep = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives one long room.
 * @param options - The room.
 * @param initial - The creator and the recipient.
 * @param hooks - Output, the pre-seal yield, the per-epoch sample and the reopen.
 * @returns Every epoch's record.
 */
export async function driveLongRoom(
	options: LongRoomOptions,
	initial: readonly [creator: RoleEndpoint, recipient: RoleEndpoint],
	hooks: DriveHooks = {}
): Promise<LongRoomRun> {
	const label = labelOf(options);
	const now = hooks.now ?? ((): number => performance.now());
	let [creator, recipient] = initial;
	const role = (index: 0 | 1): RoleEndpoint => (index === 0 ? creator : recipient);
	const writerRecipient = options.recipient === "writer";
	const delivered: (number | null)[] = [null, null];
	const flush = async (from: 0 | 1, admits: number[]): Promise<void> => {
		const rows = await role(from).published(delivered[from] ?? null);
		const last = rows.at(-1);
		if (last === undefined) return;
		admits.push(await role(from === 0 ? 1 : 0).receive(rows));
		delivered[from] = last.authorSequence;
	};
	const sameState = async (): Promise<string> => {
		const [left, right] = await Promise.all([creator.state(), recipient.state()]);
		if (left !== right) throw new TypeError(`CANVAS_CHAT_LULL_PROJECTIONS_DIFFER ${label}`);
		return left;
	};
	const epochs: EpochRecord[] = [];
	let stage = "moves";
	let current = 0;
	try {
		for (let epoch = 0; epoch < options.epochs; epoch++) {
			current = epoch + 1;
			stage = "moves";
			const creatorIssue: number[] = [];
			const recipientIssue: number[] = [];
			const creatorAdmitsRemote: number[] = [];
			const recipientAdmitsRemote: number[] = [];
			for (let ordinal = 0; ordinal < options.moves; ordinal++) {
				creatorIssue.push(await creator.issue(epoch, ordinal));
				await flush(0, recipientAdmitsRemote);
				if (!writerRecipient) continue;
				recipientIssue.push(await recipient.issue(epoch, ordinal));
				await flush(1, creatorAdmitsRemote);
			}
			await sameState();
			if (hooks.settleMs !== undefined) await sleep(hooks.settleMs);
			const other = [...(await creator.drainEvents())];
			stage = "seal";
			const seal = await creator.seal(epoch);
			const sealEvents = await creator.drainEvents();
			stage = "adopt";
			const adopt = await creator.adopt();
			const adoptEvents = await creator.drainEvents();
			stage = "export";
			const exported = await creator.exportOffer();
			stage = "install";
			const install = await recipient.install(exported.offer);
			const authority = await recipient.authorityEpoch();
			if (authority !== epoch + 1) throw new TypeError(`CANVAS_CHAT_LULL_INSTALL_EPOCH ${String(authority)}`);
			await sameState();
			other.push(...(await creator.drainEvents()));

			stage = "creator-lull";
			let creatorLull: Readonly<{ ms: number; kind: string }>;
			let lullIngress: LullIngress | undefined;
			if (options.lullMoves === 0) creatorLull = await creator.lull();
			else {
				// Moves that arrive while the creator's lull runs (G23): the Writer recipient's
				// moves are issued first, then handed to the creator's ingress once its lull has
				// entered its boundary, together with one local creator move.
				const remote = writerRecipient ? options.lullMoves : 0;
				const remoteIssueMs: number[] = [];
				for (let index = 0; index < remote; index++)
					remoteIssueMs.push(await recipient.issue(epoch, options.moves + index));
				const rows = remote === 0 ? [] : await recipient.published(delivered[1] ?? null);
				const step = await creator.lullWithIngress(rows, epoch, options.moves + remote);
				creatorLull = { ms: step.ms, kind: step.kind };
				const last = rows.at(-1);
				if (last !== undefined) delivered[1] = last.authorSequence;
				const own = await creator.published(delivered[0] ?? null);
				const localDigest = own.at(-1)?.digest;
				const position = new Map(step.accepted.map((digest, index) => [digest, index]));
				const remotePositions = rows.map((row) => position.get(row.digest));
				// A protocol control (for example the settlement author fence) is admitted without an
				// application notification. It counts as admitted when a reported delivered row
				// depends on it, directly or through other delivered rows (no vertex is admitted
				// before its dependencies).
				const covered = new Set(rows.filter((row) => position.has(row.digest)).map((row) => row.digest));
				for (let changed = true; changed; ) {
					changed = false;
					for (const row of rows)
						if (covered.has(row.digest))
							for (const dependency of row.dependencies ?? [])
								if (!covered.has(dependency) && rows.some((other) => other.digest === dependency)) {
									covered.add(dependency);
									changed = true;
								}
				}
				const reportedRows = remotePositions.filter((value): value is number => value !== undefined);
				lullIngress = {
					delivered: rows.length,
					deliveredActions: rows.map((row) => row.action ?? "unknown"),
					entered: step.selected,
					pendingAtDelivery: step.pendingAtDelivery,
					deliveredAfterMs: step.deliveredAfterMs,
					localIssuedDuringLull: step.localIssuedDuringLull,
					reported: reportedRows.length,
					controlsCovered: rows.filter((row) => !position.has(row.digest) && covered.has(row.digest)).length,
					allAdmitted:
						rows.every(
							(row) => position.has(row.digest) || (row.action?.startsWith("$drp.") === true && covered.has(row.digest))
						) &&
						localDigest !== undefined &&
						position.has(localDigest),
					fifo: reportedRows.every((value, index) => index === 0 || value > (reportedRows[index - 1] ?? -1)),
					remoteSettledAfterLull: step.remote?.settledAfterLull ?? null,
					localSettledAfterLull: step.local.settledAfterLull,
					order: step.accepted.flatMap((digest) => {
						const index = rows.findIndex((row) => row.digest === digest);
						if (index >= 0) return [`r${index}`];
						return digest === localDigest ? ["l"] : [];
					}),
					remoteIssueMs,
					remoteAdmitMs: step.remote?.ms ?? null,
					localIssueMs: step.local.ms,
					localDeliveryMs: null,
				};
			}
			const lullEvents = await creator.drainEvents();
			stage = "recipient-lull";
			const recipientLull = await recipient.lull();
			// The local lull move reaches the recipient before the census and the next epoch.
			if (lullIngress !== undefined) {
				const deliveries: number[] = [];
				await flush(0, deliveries);
				lullIngress = { ...lullIngress, localDeliveryMs: deliveries[0] ?? null };
			}
			const state = await sameState();
			other.push(...(await creator.drainEvents()));
			stage = "census";
			const lulled = { creator: await creator.census(), recipient: await recipient.census() };
			let reopened: EpochRecord["reopened"];
			if (options.reopenAfter === epoch + 1) {
				stage = "reopen";
				if (hooks.reopen === undefined) throw new TypeError("CANVAS_CHAT_LULL_REOPEN_UNSUPPORTED");
				const started = now();
				[creator, recipient] = await hooks.reopen();
				const ms = now() - started;
				const [left, right] = await Promise.all([creator.state(), recipient.state()]);
				const authorityAfter = await recipient.authorityEpoch();
				if (left !== state || right !== state || authorityAfter !== epoch + 1)
					throw new TypeError(`CANVAS_CHAT_LULL_REOPEN_STATE ${label} authority=${String(authorityAfter)}`);
				reopened = { ms, state: true, authority: authorityAfter };
				await creator.drainEvents();
			}
			const sample = hooks.sample === undefined ? undefined : await hooks.sample();
			const record: EpochRecord = {
				epoch: epoch + 1,
				lulled,
				latency: {
					creatorIssue,
					recipientIssue,
					creatorAdmitsRemote,
					recipientAdmitsRemote,
					seal,
					adopt,
					exportOffer: exported.ms,
					install,
					creatorLull: creatorLull.ms,
					recipientLull: recipientLull.ms,
				},
				lulls: { creator: creatorLull.kind, recipient: recipientLull.kind },
				windows: {
					seal: windowEvents(sealEvents),
					adopt: windowEvents(adoptEvents),
					lull: windowEvents(lullEvents),
					other: windowEvents(other),
				},
				...(lullIngress === undefined ? {} : { lullIngress }),
				...(reopened === undefined ? {} : { reopened }),
				...(sample === undefined ? {} : { sample }),
			};
			epochs.push(record);
			hooks.write?.(record);
			hooks.log?.(
				`CANVAS_CHAT_LULL ${label} epoch=${epoch + 1} lulls=${record.lulls.creator}/${record.lulls.recipient} seal=${seal.toFixed(0)} (retire ${record.windows.seal.retirementSelections}) adopt=${adopt.toFixed(0)} install=${install.toFixed(0)} lull=${creatorLull.ms.toFixed(0)} (retire ${record.windows.lull.retirementSelections})/${recipientLull.ms.toFixed(0)}${lullIngress === undefined ? "" : ` ingress=${lullIngress.order.join(",")} actions=${lullIngress.deliveredActions.join(",")} entered=${String(lullIngress.entered)} pending=${String(lullIngress.pendingAtDelivery)} afterLull=${String(lullIngress.remoteSettledAfterLull)}/${String(lullIngress.localSettledAfterLull)} fifo=${String(lullIngress.fifo)} admitted=${String(lullIngress.allAdmitted)}`}${reopened === undefined ? "" : ` reopen=${reopened.ms.toFixed(0)}`}`
			);
		}
	} catch (error) {
		throw new TypeError(
			`CANVAS_CHAT_LULL_STAGE ${stage} epoch=${current}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	await recipient.close();
	await creator.close();
	return { label, epochs };
}
