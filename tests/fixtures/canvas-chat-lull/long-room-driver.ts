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
	/** Recipient rows delivered to the creator while its lull was pending. */
	readonly delivered: number;
	/** The lull had not settled when the rows were handed to the creator's ingress. */
	readonly pendingAtDelivery: boolean;
	/** The creator's local move was issued while the lull was pending. */
	readonly localIssuedDuringLull: boolean;
	/** Every delivered row and the local move were accepted by the creator. */
	readonly allAdmitted: boolean;
	/** The delivered rows were accepted in delivery order. */
	readonly fifo: boolean;
	/** Delivered rows (and the local move) whose acceptance settled after the lull. */
	readonly settledAfterLull: number;
	/** Creator acceptance order of this step: "r<i>" = i-th delivered row, "l" = local move. */
	readonly order: readonly string[];
	readonly remoteAdmitMs: number | null;
	readonly localIssueMs: number;
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
}

/** The creator successor offer (base64 of its four exact canonical byte strings). */
export type WireOffer = Readonly<Record<string, string>>;

export interface ObservedEvent {
	readonly kind: string;
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
	/** Delay between starting the creator's lull and delivering the moves that arrive during it. */
	readonly lullIngressDelayMs?: number;
	/** Closes both roles and reopens them from their persisted stores. */
	reopen?(): Promise<readonly [creator: RoleEndpoint, recipient: RoleEndpoint]>;
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
 * @param hooks - Output, the pre-seal yield, the lull-ingress delay and the reopen.
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
				// moves are issued first and handed to the creator's ingress after the lull
				// started; the creator's own move is issued while it runs.
				const remote = writerRecipient ? options.lullMoves : 0;
				for (let index = 0; index < remote; index++)
					recipientIssue.push(await recipient.issue(epoch, options.moves + index));
				const rows = remote === 0 ? [] : await recipient.published(delivered[1] ?? null);
				const mark = (await creator.accepted(0)).length;
				let lullSettledAt: number | undefined;
				const lull = creator.lull().then((result) => {
					lullSettledAt = now();
					return result;
				});
				await sleep(hooks.lullIngressDelayMs ?? 50);
				const pendingAtDelivery = lullSettledAt === undefined;
				const received = rows.length === 0 ? undefined : creator.receive(rows).then((ms) => ({ ms, settledAt: now() }));
				const localIssuedDuringLull = lullSettledAt === undefined;
				const local = creator.issue(epoch, options.moves + remote).then((ms) => ({ ms, settledAt: now() }));
				const [lullResult, remoteResult, localResult] = await Promise.all([lull, received, local]);
				creatorLull = lullResult;
				const lullEnd = lullSettledAt ?? now();
				const last = rows.at(-1);
				if (last !== undefined) delivered[1] = last.authorSequence;
				const own = await creator.published(delivered[0] ?? null);
				const localDigest = own.at(-1)?.digest;
				const acceptedNow = (await creator.accepted(mark)).slice();
				const position = new Map(acceptedNow.map((digest, index) => [digest, index]));
				const remotePositions = rows.map((row) => position.get(row.digest));
				const order = acceptedNow.flatMap((digest) => {
					const index = rows.findIndex((row) => row.digest === digest);
					if (index >= 0) return [`r${index}`];
					return digest === localDigest ? ["l"] : [];
				});
				lullIngress = {
					delivered: rows.length,
					pendingAtDelivery,
					localIssuedDuringLull,
					allAdmitted:
						remotePositions.every((value) => value !== undefined) &&
						localDigest !== undefined &&
						position.has(localDigest),
					fifo: remotePositions.every(
						(value, index) => value !== undefined && (index === 0 || value > (remotePositions[index - 1] ?? -1))
					),
					settledAfterLull:
						(remoteResult !== undefined && remoteResult.settledAt >= lullEnd ? rows.length : 0) +
						(localResult.settledAt >= lullEnd ? 1 : 0),
					order,
					remoteAdmitMs: remoteResult?.ms ?? null,
					localIssueMs: localResult.ms,
				};
				creatorIssue.push(localResult.ms);
				if (remoteResult !== undefined) creatorAdmitsRemote.push(remoteResult.ms);
			}
			const lullEvents = await creator.drainEvents();
			stage = "recipient-lull";
			const recipientLull = await recipient.lull();
			// The local lull move reaches the recipient before the census and the next epoch.
			if (options.lullMoves !== 0) await flush(0, recipientAdmitsRemote);
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
			};
			epochs.push(record);
			hooks.write?.(record);
			hooks.log?.(
				`CANVAS_CHAT_LULL ${label} epoch=${epoch + 1} lulls=${record.lulls.creator}/${record.lulls.recipient} seal=${seal.toFixed(0)} (retire ${record.windows.seal.retirementSelections}) adopt=${adopt.toFixed(0)} install=${install.toFixed(0)} lull=${creatorLull.ms.toFixed(0)} (retire ${record.windows.lull.retirementSelections})/${recipientLull.ms.toFixed(0)}${lullIngress === undefined ? "" : ` ingress=${lullIngress.order.join(",")} fifo=${String(lullIngress.fifo)}`}${reopened === undefined ? "" : ` reopen=${reopened.ms.toFixed(0)}`}`
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
