import { type InternalSealVoteStore, type PendingVoteRow, type StoredSealCarrier } from "./seal-vote-store.js";

export interface VoteDispatchResult {
	readonly inFlightPeak: number;
	readonly overflowReason: "DISPATCH_QUEUE_FULL_RETRY_LATER" | undefined;
	readonly sentKeys: readonly string[];
}

interface VoteDispatcherInput {
	readonly databaseName: string;
	publish(input: Readonly<{ carrier: StoredSealCarrier; key: string }>): Promise<void>;
	readonly store: InternalSealVoteStore;
}

const DISPATCH_CONCURRENCY = 4;
const LOCK_TIMEOUT_MILLISECONDS = 250;

function encodedKey(row: PendingVoteRow): string {
	return JSON.stringify([row.objectId, row.epoch, row.round, row.phase, row.signerId]);
}

function lockName(databaseName: string): string {
	return `ts-drp:seal-vote:v2:${new TextEncoder().encode(databaseName).length}:${databaseName}`;
}

/**
 * Creates the package-internal bounded primary dispatcher for durable vote rows.
 * @param input - Database identity, durable store, and injected publication port.
 * @returns Cooperative dispatcher lifecycle.
 */
export function createInternalVoteDispatcher(input: VoteDispatcherInput): Readonly<{
	close(): Promise<void>;
	drain(): Promise<VoteDispatchResult>;
}> {
	let closed = false;
	let inFlight = 0;
	let inFlightPeak = 0;
	const activeKeys = new Set<string>();
	const sentKeys: string[] = [];
	let tail = Promise.resolve();

	const publishRows = async (): Promise<VoteDispatchResult> => {
		if (closed)
			return Object.freeze({ inFlightPeak, overflowReason: undefined, sentKeys: Object.freeze([...sentKeys]) });
		const pending = await input.store.readPending(DISPATCH_CONCURRENCY + 1);
		const overflow = pending.length > DISPATCH_CONCURRENCY;
		const batch = pending.slice(0, DISPATCH_CONCURRENCY);
		await Promise.all(
			batch.map(async (row) => {
				const key = encodedKey(row);
				if (closed || activeKeys.has(key)) return;
				activeKeys.add(key);
				inFlight += 1;
				inFlightPeak = Math.max(inFlightPeak, inFlight);
				try {
					await input.publish({ carrier: row.carrier, key });
					if (closed) return;
					await input.store.markDispatched([row.objectId, 0, row.round, row.phase, row.signerId]);
					sentKeys.push(key);
				} finally {
					inFlight -= 1;
					activeKeys.delete(key);
				}
			})
		);
		return Object.freeze({
			inFlightPeak,
			overflowReason: overflow ? ("DISPATCH_QUEUE_FULL_RETRY_LATER" as const) : undefined,
			sentKeys: Object.freeze([...sentKeys]),
		});
	};

	const drain = (): Promise<VoteDispatchResult> => {
		let resolveResult!: (value: VoteDispatchResult) => void;
		let rejectResult!: (reason: unknown) => void;
		const result = new Promise<VoteDispatchResult>((resolvePromise, reject) => {
			resolveResult = resolvePromise;
			rejectResult = reject;
		});
		tail = tail
			.catch(() => undefined)
			.then(async () => {
				const locks = Reflect.get(navigator, "locks") as unknown;
				const request =
					locks !== null && typeof locks === "object" ? (Reflect.get(locks, "request") as unknown) : undefined;
				const runPublish = async (): Promise<void> => {
					try {
						resolveResult(await publishRows());
					} catch (error) {
						rejectResult(error);
					}
				};
				if (typeof request !== "function") {
					await runPublish();
					return;
				}
				let settled = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const fallback = async (): Promise<void> => {
					if (settled) return;
					settled = true;
					await runPublish();
				};
				try {
					timer = setTimeout(() => void fallback().catch(rejectResult), LOCK_TIMEOUT_MILLISECONDS);
					const requested = Reflect.apply(request, locks, [
						lockName(input.databaseName),
						{ ifAvailable: true, mode: "exclusive" },
						async (lock: unknown): Promise<void> => {
							if (settled) return;
							if (lock === null || lock === undefined) {
								await fallback();
								return;
							}
							settled = true;
							clearTimeout(timer);
							await runPublish();
						},
					]);
					void Promise.resolve(requested).catch(async () => fallback());
				} catch {
					await fallback();
				}
				await result;
				clearTimeout(timer);
			});
		return result;
	};

	return Object.freeze({
		close: async () => {
			closed = true;
			await tail;
		},
		drain,
	});
}
