import type { V3RoomAcceptedVertex, V3RoomSession } from "@ts-drp/node/v3-room";

/** The adopted successor's offer (the four exact canonical byte strings a member installs). */
export type V3RoomSuccessorOffer = Awaited<ReturnType<V3RoomSession["exportCreatorSuccessor"]>>;

/**
 * When a room's creator rolls the epoch over. Each application chooses its own values (in its own
 * `rollover.ts`) under the ceiling it measured; only the scheduling is shared.
 *
 * A move counts against the epoch it was admitted in, per author: the native ceilings are per
 * author (the creator's own issuance image; each Writer's own rows), and so is Chat's allowance.
 */
export interface V3RoomRolloverBudget {
	/** The creator seals once one author has this many admitted moves in the current epoch. */
	readonly movesPerAuthor: number;
	/**
	 * Optional application weight of one admitted move (Chat: its canonical message bytes), and the
	 * per-author total in one epoch at which the creator seals.
	 */
	readonly weight?: Readonly<{ perAuthor: number; of(vertex: V3RoomAcceptedVertex): number }>;
	/** The creator seals after this long without an admission, once the epoch holds a move. */
	readonly idleMs: number;
}

/** What the policy did, for the page's status line and for measurement. Observation only. */
export type V3RoomRolloverEvent = Readonly<{
	epoch: number;
	successorEpoch: number;
	trigger: "budget" | "idle" | "refusal";
	/** The most moves (and weight) any one author had admitted in the closed epoch. */
	moves: number;
	weight: number;
	ms: number;
}>;

export interface V3RoomRolloverHooks {
	/**
	 * Creator: hands the adopted successor's offer to the room's other members, who install it with
	 * `installCreatorSuccessor`. Members cannot follow the room without it. A failure is reported
	 * through `onError`; the creator keeps the offer and the next rollover publishes its own.
	 */
	publishSuccessor?(offer: V3RoomSuccessorOffer, successorEpoch: number): void | Promise<void>;
	onRollover?(event: V3RoomRolloverEvent): void;
	onError?(error: unknown): void;
	/**
	 * Member: a move waits for the room's next epoch (refused at a capacity only a rollover
	 * clears). The page's successor delivery asks the creator for its latest offer.
	 */
	requestSuccessor?(): void;
	/** Every change of `status()`, for the page's status line. */
	onStatus?(status: V3RoomRolloverStatus): void;
	/**
	 * An application refusal that a rollover clears (Chat: its allowance is per checkpoint).
	 * Native capacity refusals are recognised without it.
	 */
	clearedByRollover?(error: unknown): boolean;
}

/**
 * The policy's state for the page. "waiting": a member's move waits for the next epoch.
 * "successor-unavailable": no successor arrived within the member's bound; the kept moves are
 * offered again, in order, once the room installs a later epoch.
 */
export type V3RoomRolloverStatus = Readonly<{
	state: "ready" | "waiting" | "successor-unavailable";
	epoch: number;
	kept: readonly Readonly<Record<string, unknown>>[];
}>;

/**
 * A member's move refused at a capacity only a rollover clears, when no later epoch arrived within
 * the member's bound. The move is not lost: the policy keeps it and offers it again once the room
 * installs a later epoch (`status().kept`).
 */
export class V3RoomSuccessorUnavailable extends Error {
	/**
	 * @param operation - The move kept for the next installed epoch.
	 * @param epoch - The epoch the member waited in.
	 * @param waitedMs - How long it waited.
	 * @param options - The refusal that only a rollover clears, as the cause.
	 */
	constructor(
		readonly operation: Readonly<Record<string, unknown>>,
		readonly epoch: number,
		readonly waitedMs: number,
		options?: ErrorOptions
	) {
		super(`no successor epoch arrived within ${Math.round(waitedMs)} ms; the move is kept`, options);
		this.name = "V3RoomSuccessorUnavailable";
	}
}

/**
 * How long a member waits for the room's next epoch after a capacity refusal before it tells the
 * page and keeps the move. A rollover (seal, adopt, export) measured 1-3 s natively; delivery and
 * install add a few seconds more. Thirty seconds is ten times that and still short for a person.
 */
export const V3_ROOM_MEMBER_SUCCESSOR_WAIT_MS = 30_000;
/** How often a member with kept moves looks for a later epoch. */
const KEPT_POLL_MS = 1_000;

type RolloverRoom = Pick<
	V3RoomSession,
	"adoptCreatorSuccessor" | "authority" | "exportCreatorSuccessor" | "issue" | "sealEpoch"
>;

export interface V3RoomRolloverPolicy {
	/** "creator" seals; a "member" (Writer) never seals and only re-offers refused moves. */
	readonly role: "creator" | "member";
	/** Binds the opened room. Moves observed before it count from then on. */
	bind(room: RolloverRoom): void;
	/** Every accepted vertex, own and remote (the session's `onAcceptedVertex`). */
	observe(vertex: Pick<V3RoomAcceptedVertex, "author" | "epoch"> & Partial<V3RoomAcceptedVertex>): void;
	/**
	 * Issues one move. A move refused at a capacity that a rollover clears is never dropped: the
	 * creator rolls over at once and offers the same move again; a member offers it again once
	 * its room has installed a later epoch. A move refused because the epoch is closing (sealed
	 * and not yet adopted or installed) is offered again once the room is past it. After
	 * `MAX_OFFERS` capacity refusals, or a closing longer than CLOSING_LIMIT_MS, the last refusal is
	 * thrown, so the page can show it and keep the move.
	 */
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	/** Moves waiting to be offered again, for the page's status line. */
	waiting(): number;
	/** The state the page shows, with the moves a member kept (see V3RoomSuccessorUnavailable). */
	status(): V3RoomRolloverStatus;
	/** Joins an in-flight rollover (tests and orderly shutdown). */
	settled(): Promise<void>;
	stats(): Readonly<{ epoch: number; rollovers: number; moves: number; weight: number }>;
	close(): void;
}

/** Native refusals that end with the epoch: the creator's issuance image and proof capacities. */
const ROLLOVER_REFUSAL = /MAINTENANCE_[A-Z_]+|maintenance prefix sizing is unavailable|proof capacity refused/u;
/** Refusals that clear once admitted work joins, without a rollover. */
const TRANSIENT_REFUSAL = /retry after admitted work joins/u;
/**
 * The local plane stopped accepting new operations because its epoch is closing (the creator
 * sealed it and has not adopted the successor yet, or a member received the close and has not
 * installed the successor yet, or its live plane is being replaced by that install). The move is
 * offered again once the room is in a later epoch.
 */
const CLOSING_REFUSAL = /: not-active\b|live plane is unavailable/u;
const SESSION_CLOSED = /v3 room session is closed/u;
/**
 * Capacity refusals of one move before the last is thrown. The creator's issuance image spans the
 * current epoch and up to three before it (measured: a full epoch makes the next two refuse their
 * first move too), so a move may need a rollover per spanned epoch before one admits it.
 */
const MAX_OFFERS = 6;
const TRANSIENT_RETRY_MS = 50;
const MEMBER_EPOCH_POLL_MS = 250;
/**
 * A move refused while the epoch closes is offered again when the room reaches a later epoch or
 * after this pause, whichever is first (the refusal can come from an install that already
 * reports the new epoch), until the closing has lasted CLOSING_LIMIT_MS.
 */
const CLOSING_RETRY_MS = 250;
const CLOSING_LIMIT_MS = 120_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

function message(error: unknown): string {
	if (error instanceof Error) return `${error.message} ${message(error.cause)}`;
	return error === undefined ? "" : String(error);
}

/**
 * Runs `work` in a later host task, at idle priority where the host has one: the rollover is
 * background work and never runs inside the turn that admitted a move. The room's seal already
 * yields between its native phases and defers to registered foreground issues.
 * @param work - The rollover.
 */
function later(work: () => void): void {
	const idle = Reflect.get(globalThis, "requestIdleCallback") as
		| ((callback: () => void, options: Readonly<{ timeout: number }>) => unknown)
		| undefined;
	if (typeof idle === "function") idle(work, { timeout: 1_000 });
	else setTimeout(work, 0);
}

/**
 * The shared scheduling of every application's rollover policy. The creator counts each author's
 * admitted moves in the current epoch and seals, adopts and exports the successor once one author
 * reaches the application's budget, after an idle period, or at once when its own move is refused
 * at a capacity a rollover clears. One rollover runs at a time; a failed one is reported and
 * retried after a backoff. Members never seal.
 * @param input - The local role, the application's budget and hooks.
 * @returns The policy; bind it to the room once the room is open.
 */
export function createV3RoomRolloverPolicy(
	input: Readonly<{
		role: "creator" | "member";
		budget: V3RoomRolloverBudget;
		hooks?: V3RoomRolloverHooks;
		/** A member's bound on waiting for the next epoch (default V3_ROOM_MEMBER_SUCCESSOR_WAIT_MS). */
		memberWaitMs?: number;
	}>
): V3RoomRolloverPolicy {
	const { role, budget } = input;
	const hooks = input.hooks ?? {};
	const memberWaitMs = input.memberWaitMs ?? V3_ROOM_MEMBER_SUCCESSOR_WAIT_MS;
	if (!Number.isFinite(memberWaitMs) || memberWaitMs <= 0) throw new TypeError("v3 room member wait is invalid");
	if (!Number.isSafeInteger(budget.movesPerAuthor) || budget.movesPerAuthor < 1)
		throw new TypeError("v3 room rollover budget is invalid");
	if (!Number.isFinite(budget.idleMs) || budget.idleMs <= 0) throw new TypeError("v3 room rollover idle is invalid");
	let room: RolloverRoom | undefined;
	let closed = false;
	let epoch = 0;
	let rollovers = 0;
	const moves = new Map<string, number>();
	const weights = new Map<string, number>();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let rolling: Promise<void> | undefined;
	let scheduled = false;
	let retryAt = 0;
	let failures = 0;
	let waiting = 0;
	let successorWaits = 0;
	const kept: Readonly<Record<string, unknown>>[] = [];
	let keptEpoch = 0;
	let keptTimer: ReturnType<typeof setTimeout> | undefined;
	let lastStatus = "";
	const epochWaiters = new Set<() => void>();
	function close(): void {
		closed = true;
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		if (keptTimer !== undefined) clearTimeout(keptTimer);
		for (const wake of [...epochWaiters]) wake();
	}
	const status = (): V3RoomRolloverStatus =>
		Object.freeze({
			state: kept.length > 0 ? "successor-unavailable" : successorWaits > 0 ? "waiting" : "ready",
			epoch: currentEpoch(),
			kept: Object.freeze([...kept]),
		});
	const reportStatus = (): void => {
		const next = status();
		const key = `${next.state}:${next.kept.length}`;
		if (key === lastStatus) return;
		lastStatus = key;
		try {
			hooks.onStatus?.(next);
		} catch (error) {
			hooks.onError?.(error);
		}
	};

	const most = (values: ReadonlyMap<string, number>): number => Math.max(0, ...values.values());
	const currentEpoch = (): number => Math.max(epoch, room?.authority()?.epoch ?? 0);
	const advance = (next: number): void => {
		if (next <= epoch) return;
		epoch = next;
		moves.clear();
		weights.clear();
		for (const wake of [...epochWaiters]) wake();
	};
	// The room can advance without this policy (a host's own seal, a member's install); its
	// authority is read before every decision so counts of a closed epoch never trigger one.
	const overBudget = (): boolean => {
		advance(currentEpoch());
		return (
			most(moves) >= budget.movesPerAuthor || (budget.weight !== undefined && most(weights) >= budget.weight.perAuthor)
		);
	};

	const roll = (trigger: V3RoomRolloverEvent["trigger"]): Promise<void> => {
		if (rolling !== undefined) return rolling;
		const selected = room;
		if (selected === undefined || closed || role !== "creator") return Promise.resolve();
		const started = performance.now();
		const closing = { epoch: currentEpoch(), moves: most(moves), weight: most(weights) };
		const task = (async (): Promise<void> => {
			const sealed = await selected.sealEpoch();
			await selected.adoptCreatorSuccessor();
			const offer = await selected.exportCreatorSuccessor();
			rollovers++;
			failures = 0;
			retryAt = 0;
			advance(sealed.successorEpoch);
			hooks.onRollover?.(
				Object.freeze({
					...closing,
					epoch: sealed.epoch,
					successorEpoch: sealed.successorEpoch,
					trigger,
					ms: performance.now() - started,
				})
			);
			try {
				await hooks.publishSuccessor?.(offer, sealed.successorEpoch);
			} catch (error) {
				hooks.onError?.(error);
			}
		})();
		rolling = task
			.then(
				() => undefined,
				(error: unknown) => {
					// A closed session ends its policy; nothing is retried on it.
					if (SESSION_CLOSED.test(message(error))) {
						close();
						return;
					}
					failures++;
					retryAt = Date.now() + (RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length) - 1] ?? 30_000);
					hooks.onError?.(error);
				}
			)
			.finally(() => {
				rolling = undefined;
				// Work admitted while the rollover ran counts in the successor epoch.
				if (overBudget()) schedule("budget");
			});
		return rolling;
	};
	const schedule = (trigger: "budget" | "idle"): void => {
		if (scheduled || rolling !== undefined || closed || role !== "creator") return;
		if (Date.now() < retryAt) {
			// After a failed rollover, try again once the backoff ends.
			scheduled = true;
			setTimeout(() => {
				scheduled = false;
				schedule(trigger);
			}, retryAt - Date.now());
			return;
		}
		scheduled = true;
		later(() => {
			scheduled = false;
			// A rollover that ran meanwhile (a refused move's) may have cleared the trigger.
			const due = trigger === "budget" ? overBudget() : (advance(currentEpoch()), most(moves) > 0);
			if (due) void roll(trigger);
		});
	};
	const armIdle = (): void => {
		if (role !== "creator" || closed) return;
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			advance(currentEpoch());
			if (most(moves) > 0) schedule("idle");
		}, budget.idleMs);
	};
	const clearedByRollover = (error: unknown): boolean =>
		ROLLOVER_REFUSAL.test(message(error)) || hooks.clearedByRollover?.(error) === true;
	// A member's room advances when the host installs the successor; it polls its own authority.
	const nextEpoch = (after: number, within = Number.POSITIVE_INFINITY): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const deadline = performance.now() + within;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (): void => {
				epochWaiters.delete(done);
				if (timer !== undefined) clearTimeout(timer);
				if (closed) reject(new TypeError("v3 room rollover policy is closed"));
				else resolve();
			};
			const poll = (): void => {
				if (closed || currentEpoch() > after || performance.now() >= deadline) {
					advance(currentEpoch());
					done();
					return;
				}
				timer = setTimeout(poll, MEMBER_EPOCH_POLL_MS);
			};
			epochWaiters.add(done);
			poll();
		});

	// Kept moves are offered again, in order, once the room is past the epoch that refused them.
	const watchKept = (): void => {
		if (keptTimer !== undefined || closed || kept.length === 0) return;
		keptTimer = setTimeout(() => {
			keptTimer = undefined;
			if (closed || kept.length === 0) return;
			if (currentEpoch() <= keptEpoch) {
				watchKept();
				return;
			}
			advance(currentEpoch());
			const pending = kept.splice(0, kept.length);
			reportStatus();
			void (async (): Promise<void> => {
				for (const operation of pending) {
					try {
						await issue(operation);
					} catch (error) {
						// A move refused again for want of a successor is kept again by issue().
						if (!(error instanceof V3RoomSuccessorUnavailable)) hooks.onError?.(error);
					}
				}
			})();
		}, KEPT_POLL_MS);
	};
	const keep = (operation: Readonly<Record<string, unknown>>, attempted: number): void => {
		kept.push(operation);
		keptEpoch = Math.max(keptEpoch, attempted);
		reportStatus();
		watchKept();
	};

	async function issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
		const selected = room;
		if (selected === undefined) throw new TypeError("v3 room rollover policy is not bound");
		let closingSince: number | undefined;
		for (let offer = 1; ; offer++) {
			// A move never enters the creator's own rollover between its seal and its adoption.
			if (rolling !== undefined) await rolling;
			const attempted = currentEpoch();
			try {
				await selected.issue(operation);
				return;
			} catch (error) {
				if (closed) throw error;
				if (CLOSING_REFUSAL.test(message(error))) {
					// Not an offer of the move: the room was between epochs. Bounded by the closing's length.
					closingSince ??= performance.now();
					if (performance.now() - closingSince >= CLOSING_LIMIT_MS) throw error;
					offer--;
					waiting++;
					try {
						await (rolling ?? Promise.resolve());
						await nextEpoch(attempted, CLOSING_RETRY_MS);
					} finally {
						waiting--;
					}
					continue;
				}
				closingSince = undefined;
				if (offer >= MAX_OFFERS) throw error;
				if (TRANSIENT_REFUSAL.test(message(error))) {
					await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_MS * offer));
					continue;
				}
				if (!clearedByRollover(error)) throw error;
				// The refused move was not admitted (its issue transaction or admission refused it);
				// the same move is offered again in a later epoch.
				waiting++;
				try {
					if (role === "creator") {
						if (currentEpoch() === attempted) await roll("refusal");
						if (currentEpoch() === attempted) throw error;
					} else {
						// A member's successor comes from the creator through the page's delivery. Ask for it,
						// and wait a bounded time: with no successor, the page is told and the move kept.
						successorWaits++;
						reportStatus();
						const started = performance.now();
						try {
							hooks.requestSuccessor?.();
						} catch (requestError) {
							hooks.onError?.(requestError);
						}
						try {
							await nextEpoch(attempted, memberWaitMs);
						} finally {
							successorWaits--;
						}
						if (currentEpoch() <= attempted) {
							keep(operation, attempted);
							throw new V3RoomSuccessorUnavailable(operation, attempted, performance.now() - started, {
								cause: error,
							});
						}
						reportStatus();
					}
				} finally {
					waiting--;
				}
			}
		}
	}

	return Object.freeze({
		role,
		bind(selected: RolloverRoom): void {
			if (room !== undefined) throw new TypeError("v3 room rollover policy is already bound");
			// The room's epoch is read at the policy's first decision, not here.
			room = selected;
		},
		observe(vertex: Pick<V3RoomAcceptedVertex, "author" | "epoch"> & Partial<V3RoomAcceptedVertex>): void {
			if (closed) return;
			advance(Math.max(vertex.epoch, currentEpoch()));
			if (vertex.epoch < epoch) return;
			moves.set(vertex.author, (moves.get(vertex.author) ?? 0) + 1);
			if (budget.weight !== undefined)
				weights.set(
					vertex.author,
					(weights.get(vertex.author) ?? 0) + budget.weight.of(vertex as V3RoomAcceptedVertex)
				);
			armIdle();
			if (overBudget()) schedule("budget");
		},
		issue,
		waiting: (): number => waiting,
		status,
		settled: async (): Promise<void> => {
			while (rolling !== undefined || scheduled) {
				await (rolling ?? new Promise((resolve) => setTimeout(resolve, 10)));
			}
		},
		stats: () => Object.freeze({ epoch: currentEpoch(), rollovers, moves: most(moves), weight: most(weights) }),
		close,
	});
}
