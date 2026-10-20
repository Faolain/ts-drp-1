// Track M measurement (Canvas and Chat): the long-room coordinator, free of product imports
// so the Playwright process can run it against two browser pages. Each role is a
// `RoleEndpoint` (tests/fixtures/track-m-apps/long-room-core.ts `openRole`): in-process under
// vitest, or one page per role (its own origin, so its own IndexedDB and Web Locks) in a
// browser. Everything crossing an endpoint is plain data (bytes as base64), and every
// latency is measured inside the role that does the work.

export type HostKind = "node" | "browser" | "room" | "room-retention";
export type AppKind = "canvas" | "chat";
export type RecipientMode = "receive-only" | "writer";

export interface LongRoomOptions {
	readonly app: AppKind;
	readonly host: HostKind;
	readonly recipient: RecipientMode;
	/** Supply a measurement-only ordinary resource bound reader so the creator's explicit lull runs. */
	readonly creatorLull: boolean;
	readonly epochs: number;
	/** Ordinary moves per Writer per epoch. */
	readonly moves: number;
}

export type StoreCensus = Readonly<Record<string, readonly [rows: number, bytes: number]>>;

export interface EpochRecord {
	readonly epoch: number;
	readonly installed: Readonly<{ creator: StoreCensus; recipient: StoreCensus }>;
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
	/** `room-retention-pass` outcomes (with the reason of a retained pass) of this epoch. */
	readonly retentionOutcomes: readonly string[];
	/** Reasons of this epoch's `room-retention-declined` events (the existing passes ran instead). */
	readonly retentionDeclines: readonly string[];
	readonly eventKinds: Readonly<Record<string, number>>;
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
	readonly outcome?: string;
	readonly reason?: string;
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
	census(): Promise<StoreCensus>;
	/** Observer events since the previous drain. */
	drainEvents(): Promise<ObservedEvent[]>;
	close(): Promise<void>;
}

export interface DriveHooks {
	/** Optional macrotask yield before each seal (see the room-database note in `driveLongRoom`). */
	readonly settleMs?: number;
	write?(record: EpochRecord): void;
	log?(line: string): void;
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
	return `${options.app}-${options.recipient}-${options.creatorLull ? "reader" : "product"}-${options.host}`;
}

/**
 * Drives one long room: per epoch, `moves` ordinary moves per Writer (each delivered to the
 * other role before the next), seal, adoption, export, install, both roles' lulls, and a
 * census of each role after the install and after the lulls.
 * @param options - The room.
 * @param endpoints - The creator and the recipient.
 * @param hooks - Output and the optional pre-seal yield.
 * @returns Every epoch's record.
 */
export async function driveLongRoom(
	options: LongRoomOptions,
	endpoints: readonly [creator: RoleEndpoint, recipient: RoleEndpoint],
	hooks: DriveHooks = {}
): Promise<LongRoomRun> {
	const label = labelOf(options);
	const [creator, recipient] = endpoints;
	const writerRecipient = options.recipient === "writer";
	const delivered: (number | null)[] = [null, null];
	const flush = async (from: 0 | 1, admits: number[]): Promise<void> => {
		const rows = await endpoints[from].published(delivered[from] ?? null);
		const last = rows.at(-1);
		if (last === undefined) return;
		admits.push(await (from === 0 ? recipient : creator).receive(rows));
		delivered[from] = last.authorSequence;
	};
	const sameState = async (): Promise<void> => {
		const [left, right] = await Promise.all([creator.state(), recipient.state()]);
		if (left !== right) throw new TypeError(`TRACK_M_APPS_PROJECTIONS_DIFFER ${label}`);
	};
	const census = async (): Promise<{ creator: StoreCensus; recipient: StoreCensus }> => ({
		creator: await creator.census(),
		recipient: await recipient.census(),
	});
	const epochs: EpochRecord[] = [];
	// Which transition of which epoch refused, for the failure record.
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
			// Optional macrotask yield before the seal: on the room database a seal issued in the
			// same task chain as a remote admission can meet the creator's live-journal native
			// read reservation still held (NATIVE_READ_RESERVATION_BUSY, surfaced as "creator
			// recovery role transfer source failed: internal-invariant").
			if (hooks.settleMs !== undefined) await new Promise((resolve) => setTimeout(resolve, hooks.settleMs));
			stage = "seal";
			const seal = await creator.seal(epoch);
			stage = "adopt";
			const adopt = await creator.adopt();
			stage = "export";
			const exported = await creator.exportOffer();
			stage = "install";
			const install = await recipient.install(exported.offer);
			const authority = await recipient.authorityEpoch();
			if (authority !== epoch + 1) throw new TypeError(`TRACK_M_APPS_INSTALL_EPOCH ${String(authority)}`);
			await sameState();
			stage = "census";
			const installed = await census();
			stage = "creator-lull";
			const creatorLull = await creator.lull();
			stage = "recipient-lull";
			const recipientLull = await recipient.lull();
			stage = "census";
			const lulled = await census();
			const window = [...(await creator.drainEvents()), ...(await recipient.drainEvents())];
			const eventKinds: Record<string, number> = {};
			for (const event of window) eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1;
			const record: EpochRecord = {
				epoch: epoch + 1,
				installed,
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
				retentionOutcomes: window
					.filter((event) => event.kind === "room-retention-pass")
					.map((event) => (event.reason === undefined ? String(event.outcome) : `${event.outcome}:${event.reason}`)),
				retentionDeclines: window
					.filter((event) => event.kind === "room-retention-declined")
					.map((event) => String(event.reason)),
				eventKinds,
			};
			epochs.push(record);
			hooks.write?.(record);
			hooks.log?.(
				`TRACK_M_APPS ${label} epoch=${epoch + 1} lulls=${record.lulls.creator}/${record.lulls.recipient} seal=${seal.toFixed(0)} adopt=${adopt.toFixed(0)} install=${install.toFixed(0)} lull=${creatorLull.ms.toFixed(0)}/${recipientLull.ms.toFixed(0)}`
			);
		}
	} catch (error) {
		throw new TypeError(
			`TRACK_M_APPS_STAGE ${stage} epoch=${current}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	await recipient.close();
	await creator.close();
	return { label, epochs };
}
