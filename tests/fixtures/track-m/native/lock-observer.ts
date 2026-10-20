// Track M, slice 14f: test-only observation of Web Locks requests in this realm. Every
// request still goes to the native LockManager unchanged; the observer only records the
// name, options, whether it was granted, and the requesting stack (diagnostics).

export interface ObservedLock {
	readonly seq: number;
	readonly name: string;
	readonly mode: string;
	readonly ifAvailable: boolean;
	granted?: boolean;
	released?: boolean;
	readonly stack: string;
}

const log: ObservedLock[] = [];

const manager = (globalThis as unknown as { LockManager?: { prototype: Record<string, unknown> } }).LockManager;
const original = manager?.prototype.request as ((...args: unknown[]) => Promise<unknown>) | undefined;
if (manager !== undefined && typeof original === "function") {
	manager.prototype.request = function request(this: unknown, ...args: unknown[]): Promise<unknown> {
		const name = String(args[0]);
		const options = (args.length > 2 && typeof args[1] === "object" && args[1] !== null ? args[1] : {}) as {
			mode?: string;
			ifAvailable?: boolean;
		};
		const callback = args.at(-1) as (lock: unknown) => unknown;
		const entry: ObservedLock = {
			seq: log.length,
			name,
			mode: options.mode ?? "exclusive",
			ifAvailable: options.ifAvailable === true,
			stack: (new Error().stack ?? "").split("\n").slice(1, 9).join("\n"),
		};
		log.push(entry);
		const wrapped = async (lock: unknown): Promise<unknown> => {
			entry.granted = lock !== null;
			try {
				return await callback(lock);
			} finally {
				entry.released = true;
			}
		};
		return Reflect.apply(original, this, [...args.slice(0, -1), wrapped]) as Promise<unknown>;
	};
}

/** @returns Every observed request so far. */
export function lockLog(): readonly ObservedLock[] {
	return log;
}
