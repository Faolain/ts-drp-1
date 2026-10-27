// Track M measurement (Canvas and Chat): the long-room coordinator, free of product imports
// so the Playwright process can run it against two browser pages. Each role is a
// `RoleEndpoint` (tests/fixtures/track-m-apps/long-room-core.ts `openRole`): in-process under
// vitest, or one page per role (its own origin, so its own IndexedDB and Web Locks) in a
// browser. Everything crossing an endpoint is plain data (bytes as base64), and every
// latency is measured inside the role that does the work.

export type HostKind = "node" | "browser" | "room" | "room-retention";
export type AppKind = "canvas" | "chat" | "grid";
export type RecipientMode = "receive-only" | "writer";
/**
 * Chat only. Track W: "window" = the rolling-window format (v4), "lifetime" = version 3. Track W2:
 * "shares" = the membership-aware format (v5) the shipped Chat signs into new rooms.
 */
export type ChatFormat = "window" | "lifetime" | "shares";

export interface LongRoomOptions {
	readonly app: AppKind;
	readonly host: HostKind;
	readonly recipient: RecipientMode;
	/** Supply a measurement-only ordinary resource bound reader so the creator's explicit lull runs. */
	readonly creatorLull: boolean;
	readonly epochs: number;
	/** Ordinary moves per Writer per epoch. */
	readonly moves: number;
	/** Chat only: the format the creator signs into genesis (default "window", what Chat ships). */
	readonly chatFormat?: ChatFormat;
	/**
	 * The trust profile the creator signs into genesis. Default (absent, or "settlement-v1"): the
	 * app's own exported profile (examples/<app>/src/profile.ts, via genesis-profile.ts), so the long
	 * room signs what the shipped page signs. "trusted-v1" (Grid and Chat only) is the explicit
	 * opt-in override: the legacy trusted profile with a version-1 latched ACL, which never prunes
	 * issued records.
	 */
	readonly profile?: GenesisProfileChoice;
	/**
	 * Who rolls the room over. Default (absent) "harness": the driver seals, adopts and exports
	 * itself. "app": each role runs its application's own rollover policy (the creator seals at the
	 * app's budget or after an idle period; a Writer only re-offers refused moves). Successor offers
	 * travel by the pages' own delivery; the harness only carries its frames (`successorWire`), and
	 * harness offer passing (`install`) is refused.
	 */
	readonly rollover?: RolloverChoice;
	/**
	 * App mode, tests only: replaces the application's trigger values (its weight included) with
	 * these, keeping its refusal classification, so a test can reach the native or application
	 * ceiling and exercise the refusal path.
	 */
	readonly rolloverBudget?: Readonly<{ movesPerAuthor: number; idleMs: number }>;
}

export type RolloverChoice = "harness" | "app";

/** One role's application rollover policy (app mode), observation only. */
export interface RolloverObservation {
	readonly epoch: number;
	readonly rollovers: number;
	/** Moves of this role waiting to be offered again after a capacity refusal. */
	readonly waiting: number;
	/** Rollover and offer-publication failures the policy reported (it retries rollovers). */
	readonly errors: readonly string[];
	readonly events: readonly Readonly<{
		epoch: number;
		successorEpoch: number;
		trigger: string;
		moves: number;
		weight: number;
		ms: number;
		/** When the rollover finished (epoch milliseconds); it began `ms` earlier. */
		endedAt: number;
	}>[];
}

/** One role's successor delivery (app mode), observation only. */
export interface SuccessorDeliveryObservation {
	readonly epoch: number;
	readonly installed: number;
	readonly refused: number;
	readonly announced: number;
	readonly answered: number;
	readonly requested: number;
	readonly largestOfferBytes: number;
	readonly refusals: readonly string[];
	readonly lastError?: string;
}

/** See `successorWire`. */
export interface SuccessorWire {
	carried(): number;
	pause(): Promise<void>;
	resume(): void;
	caughtUp(epoch: number, timeoutMs?: number): Promise<SuccessorDeliveryObservation>;
	stop(): Promise<void>;
}

/**
 * App mode: the scripted wire for the pages' successor delivery. It runs in the background, as a
 * network would, carrying every frame each role's delivery sends to the other role every `everyMs`.
 * It carries bytes only: what is announced, requested, authenticated and installed is the
 * delivery's own decision. `caughtUp` waits until the member's room has installed `epoch`.
 * @param peers - The creator and the member, read on every carry (a reopen replaces them).
 * @param everyMs - Carry interval.
 * @returns The wire.
 */
export function successorWire(peers: () => readonly [RoleEndpoint, RoleEndpoint], everyMs = 20): SuccessorWire {
	let stopped = false;
	let failure: unknown;
	let carried = 0;
	const carry = async (): Promise<number> => {
		const [creator, member] = peers();
		const down = (await creator.successorFrames?.()) ?? [];
		const up = (await member.successorFrames?.()) ?? [];
		if (down.length) await member.deliverSuccessorFrames?.(down);
		if (up.length) await creator.deliverSuccessorFrames?.(up);
		carried += down.length + up.length;
		return down.length + up.length;
	};
	let paused: Promise<void> | undefined;
	let resume: (() => void) | undefined;
	const loop = (async (): Promise<void> => {
		while (!stopped) {
			if (paused !== undefined) await paused;
			if (stopped) return;
			try {
				await carry();
			} catch (error) {
				failure ??= error;
			}
			await new Promise((resolve) => setTimeout(resolve, everyMs));
		}
	})();
	return {
		/**
		 * Frames carried so far.
		 * @returns The count.
		 */
		carried: () => carried,
		/** Holds the wire while the roles are closed and reopened. */
		pause: async (): Promise<void> => {
			paused ??= new Promise<void>((resolve) => (resume = resolve));
			// Let a carry in flight finish.
			await new Promise((resolve) => setTimeout(resolve, everyMs * 2));
		},
		resume: (): void => {
			resume?.();
			paused = undefined;
			resume = undefined;
		},
		/**
		 * Waits until the member's room has installed `epoch` (its delivery idle), or throws after
		 * `timeoutMs` with both roles' delivery counters.
		 * @param epoch - The epoch the member must reach.
		 * @param timeoutMs - How long it may take.
		 * @returns The member's delivery observation.
		 */
		caughtUp: async (epoch: number, timeoutMs = 60_000): Promise<SuccessorDeliveryObservation> => {
			const deadline = performance.now() + timeoutMs;
			for (;;) {
				if (failure !== undefined) throw failure;
				const [creator, member] = peers();
				await carry();
				const observed = await member.successorDelivery?.();
				if (observed === undefined) throw new TypeError("TRACK_M_APPS_SUCCESSOR_DELIVERY_ABSENT");
				if (observed.epoch >= epoch) return observed;
				if (performance.now() > deadline)
					throw new TypeError(
						`TRACK_M_APPS_SUCCESSOR_DELIVERY_STALLED epoch=${epoch} member=${JSON.stringify(observed)} creator=${JSON.stringify(await creator.successorDelivery?.())}`
					);
				await new Promise((resolve) => setTimeout(resolve, everyMs));
			}
		},
		stop: async (): Promise<void> => {
			stopped = true;
			resume?.();
			await loop;
			if (failure !== undefined) throw failure;
		},
	};
}

export type GenesisProfileChoice = "settlement-v1" | "trusted-v1";

export type StoreCensus = Readonly<Record<string, readonly [rows: number, bytes: number]>>;

export interface EpochRecord {
	readonly epoch: number;
	/** Bytes of the canonical application state both roles hold after the install. */
	readonly stateBytes?: number;
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
	/** Chat window format with a device archive (Track W): each role's archive after the epoch. */
	readonly archive?: Readonly<{ creator: ArchiveObservation | null; recipient: ArchiveObservation | null }>;
	/**
	 * Track W: each role's origin storage usage (`navigator.storage.estimate()`) after the epoch,
	 * for every app and format, where the platform has it. Observation only.
	 */
	readonly originUsage?: Readonly<{ creator: number | null; recipient: number | null }>;
}

/**
 * Track W: one role's Chat device archive (application data in its own database, outside the
 * room's stores and census). Counters are cumulative since the role opened. Observation only.
 */
export interface ArchiveObservation {
	readonly messages: number;
	readonly bytes: number;
	readonly appended: number;
	readonly evicted: number;
	/** Store transactions and the wall time spent in them (the append cost). */
	readonly transactions: number;
	readonly transactionMs: number;
	/** Calls of `observe()` on the projection callback and the wall time spent in them. */
	readonly observes: number;
	readonly observeMs: number;
	readonly failures: number;
	/** The archive database's own rows and payload bytes. */
	readonly database: StoreCensus;
	/** `navigator.storage.estimate()` usage of this role's origin, where the platform has it. */
	readonly originUsage?: number;
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
	/** The same move straight to the room, past an application rollover policy. */
	issueRoom?(epoch: number, ordinal: number): Promise<number>;
	/** Every published own row above `after` (an author sequence), in issue order. */
	published(after: number | null): Promise<WireRow[]>;
	/** Delivers the other role's rows; returns the wall time until the last one is accepted. */
	receive(rows: readonly WireRow[]): Promise<number>;
	/** Delivers without joining application acceptance (old-epoch and control rows). */
	inject(rows: readonly WireRow[]): Promise<void>;
	/** Observation of the actual published projection input, never a candidate preview. */
	projectionAudit(): Promise<
		Readonly<{
			base: Readonly<{ epoch: number; state: string }> | null;
			operations: readonly Readonly<{ author: string; operation: Readonly<Record<string, unknown>> }>[];
			acceptedCount: number;
			lastAcceptedAt: number | null;
			remoteAcceptedCount: number;
			lastRemoteAcceptedAt: number | null;
		}>
	>;
	acceptance(digests: readonly string[]): Promise<readonly boolean[]>;
	/** Every live plan reference is still backed by its paired original issuance row. */
	settlementAudit(): Promise<
		Readonly<{
			entries: number;
			missing: readonly number[];
			dispositions: Readonly<Record<string, number>>;
			replacements: readonly Readonly<{
				sourceDigest: string;
				sourceSequence: number;
				disposition: string;
				replacementDigests: readonly string[];
			}>[];
		}>
	>;
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
	/** Track W: the Chat device archive after its pending write, or null without one. */
	archive(): Promise<ArchiveObservation | null>;
	/** Track W: the origin's storage usage, or null where the platform has none (Node). */
	storageUsage?(): Promise<number | null>;
	/** Observer events since the previous drain. */
	drainEvents(): Promise<ObservedEvent[]>;
	/**
	 * App mode: the frames this role's successor delivery (examples/v3-room successor-delivery) sent
	 * since the last call (base64), for the scripted wire to carry to the other role.
	 */
	successorFrames?(): Promise<string[]>;
	/** App mode: hands frames the other role's delivery sent to this role's delivery. */
	deliverSuccessorFrames?(frames: readonly string[]): Promise<void>;
	/** App mode: joins this role's running install, then reports its epoch and delivery counters. */
	successorDelivery?(): Promise<SuccessorDeliveryObservation>;
	/**
	 * App mode: the last projection this role made in `epoch` (its input and canonical state), or
	 * null once it is older than the few epochs kept. For an epoch the creator closed, the closed cut.
	 */
	closedProjection?(epoch: number): Promise<Readonly<{
		base: Readonly<{ epoch: number; state: string }> | null;
		operations: readonly Readonly<{ author: string; operation: Readonly<Record<string, unknown>> }>[];
		state: string;
	}> | null>;
	/** App mode: joins this role's in-flight rollover, then reports its policy. */
	rollover?(): Promise<RolloverObservation>;
	/** Every accepted vertex (own and remote): digest, author, epoch, sequence, operation JSON. */
	acceptedVertices?(): Promise<
		readonly Readonly<{ digest: string; author: string; epoch: number; authorSequence: number; operation: string }>[]
	>;
	/** The room's own settlement observation (V3RoomSession.settlementStatus), or null. */
	settlementStatus?(): Promise<unknown>;
	/** App mode: the application policy's status (examples/v3-room rollover status()), or null. */
	rolloverStatus?(): Promise<unknown>;
	/** App mode: takes the other peer off (false) or back onto (true) this role's successor channel. */
	setPeerConnected?(connected: boolean): Promise<void>;
	close(): Promise<void>;
}

export interface DriveHooks {
	/** Optional macrotask yield before each seal (see the room-database note in `driveLongRoom`). */
	readonly settleMs?: number;
	write?(record: EpochRecord): void;
	log?(line: string): void;
}

/**
 *
 * @param bytes
 */
export function toBase64(bytes: Uint8Array): string {
	let text = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(text);
}

/**
 *
 * @param text
 */
export function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

/**
 *
 * @param options
 */
export function labelOf(options: LongRoomOptions): string {
	const format =
		options.app === "chat" && options.chatFormat !== undefined && options.chatFormat !== "window"
			? `-${options.chatFormat}`
			: "";
	return `${options.app}-${options.recipient}-${options.creatorLull ? "reader" : "product"}-${options.host}${format}`;
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
	const sameState = async (): Promise<number> => {
		const [left, right] = await Promise.all([creator.state(), recipient.state()]);
		if (left !== right) throw new TypeError(`TRACK_M_APPS_PROJECTIONS_DIFFER ${label}`);
		return left.length / 2;
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
			const stateBytes = await sameState();
			stage = "census";
			const installed = await census();
			stage = "creator-lull";
			const creatorLull = await creator.lull();
			stage = "recipient-lull";
			const recipientLull = await recipient.lull();
			stage = "census";
			const lulled = await census();
			stage = "archive";
			const archive = { creator: await creator.archive(), recipient: await recipient.archive() };
			const originUsage = {
				creator: (await creator.storageUsage?.()) ?? null,
				recipient: (await recipient.storageUsage?.()) ?? null,
			};
			const window = [...(await creator.drainEvents()), ...(await recipient.drainEvents())];
			const eventKinds: Record<string, number> = {};
			for (const event of window) eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1;
			const record: EpochRecord = {
				epoch: epoch + 1,
				stateBytes,
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
				...(archive.creator === null && archive.recipient === null ? {} : { archive }),
				...(originUsage.creator === null && originUsage.recipient === null ? {} : { originUsage }),
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
