import { resolve } from "node:path";

/**
 * In-process custody of a SQLite file's writer reservation.
 *
 * node:sqlite is synchronous: a connection that meets a held writer reservation
 * runs SQLite's busy handler, which sleeps the only JS thread. When the holder is
 * another connection in this same thread (an issue job's private signing
 * connection, a native sign admission, a native read reservation: each holds
 * BEGIN IMMEDIATE across awaits) it can never release while the waiter sleeps, so
 * the wait always ends in SQLITE_BUSY after busy_timeout, having frozen the event
 * loop for that long. In-process holders register here so a writer can wait for
 * them asynchronously instead. Holders in other processes still meet busy_timeout,
 * which works for them because they progress independently.
 */
interface Gate {
	holders: number;
	free?: Readonly<{ promise: Promise<void>; resolve(): void }>;
}

const gates = new Map<string, Gate>();

/**
 * Registers an in-process holder of a file's writer reservation.
 * @param filename - The SQLite file (any spelling that resolves to the same path).
 * @returns Idempotent release; call it once the holder's transaction ended.
 */
export function holdNativeWriter(filename: string): () => void {
	const key = resolve(filename);
	let gate = gates.get(key);
	if (gate === undefined) {
		gate = { holders: 0 };
		gates.set(key, gate);
	}
	const held = gate;
	held.holders++;
	let released = false;
	return (): void => {
		if (released) return;
		released = true;
		held.holders--;
		if (held.holders > 0) return;
		if (gates.get(key) === held) gates.delete(key);
		held.free?.resolve();
	};
}

/**
 * Whether an in-process connection holds the file's writer reservation now.
 * @param filename - The SQLite file.
 * @returns True while any registered holder has not released.
 */
export function nativeWriterHeld(filename: string): boolean {
	return gates.has(resolve(filename));
}

/**
 * Waits, without blocking the event loop, until no in-process connection holds the
 * file's writer reservation, for at most `boundMs`. A caller that sees `true` must
 * begin its write synchronously, before any await, so no holder can enter between.
 * @param filename - The SQLite file.
 * @param boundMs - The longest wait (the writer's busy budget).
 * @returns True when free, false when the bound expired with a holder still present.
 */
export async function awaitNativeWriterFree(filename: string, boundMs: number): Promise<boolean> {
	const key = resolve(filename);
	const deadline = performance.now() + boundMs;
	for (let gate = gates.get(key); gate !== undefined; gate = gates.get(key)) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) return false;
		let resolveFree!: () => void;
		const free = (gate.free ??= Object.freeze({
			promise: new Promise<void>((settle) => {
				resolveFree = settle;
			}),
			resolve: () => resolveFree(),
		}));
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			free.promise,
			new Promise<void>((settle) => {
				timer = setTimeout(settle, remaining);
			}),
		]);
		clearTimeout(timer);
	}
	return true;
}

/**
 * The refusal a private writer gives when its bounded wait expires: the same
 * shape node:sqlite throws for SQLITE_BUSY, without having slept the thread.
 * @returns A busy error equivalent to the BEGIN IMMEDIATE it replaces.
 */
export function nativeWriterBusyError(): Error {
	return Object.assign(new Error("database is locked"), {
		code: "ERR_SQLITE_ERROR",
		errcode: 5,
		errstr: "database is locked",
	});
}
