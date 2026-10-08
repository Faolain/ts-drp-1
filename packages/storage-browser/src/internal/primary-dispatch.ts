export type InternalPrimaryDispatchIdentity = "ahe-reclamation:v1" | "seal-vote:v2";

interface InternalPrimaryDispatchInput<T> {
	readonly databaseName: string;
	readonly identity: InternalPrimaryDispatchIdentity;
	task(): Promise<T>;
}

const LOCK_TIMEOUT_MILLISECONDS = 250;

function lockName(identity: InternalPrimaryDispatchIdentity, databaseName: string): string {
	return `ts-drp:${identity}:${new TextEncoder().encode(databaseName).length}:${databaseName}`;
}

/**
 * Runs one internal task under a best-effort browser primary election.
 * @param input - Closed internal identity, database identity, and owner-local task.
 * @returns The task's unmodified result or failure.
 */
export function runInternalPrimaryDispatch<T>(input: InternalPrimaryDispatchInput<T>): Promise<T> {
	const locks = Reflect.get(navigator, "locks") as unknown;
	const request = locks !== null && typeof locks === "object" ? (Reflect.get(locks, "request") as unknown) : undefined;
	if (typeof request !== "function") return input.task();

	return new Promise<T>((resolve, reject) => {
		let task: Promise<T> | undefined;
		const runTask = (): Promise<T> => {
			if (task !== undefined) return task;
			clearTimeout(timer);
			task = Promise.resolve().then(input.task);
			task.then(resolve, reject);
			return task;
		};

		const timer = setTimeout(() => void runTask(), LOCK_TIMEOUT_MILLISECONDS);
		try {
			const requested = Reflect.apply(request, locks, [
				lockName(input.identity, input.databaseName),
				{ ifAvailable: true, mode: "exclusive" },
				async (lock: unknown): Promise<void> => {
					if (task !== undefined) return;
					if (lock === null || lock === undefined) {
						await runTask();
						return;
					}
					await runTask();
				},
			]);
			void Promise.resolve(requested).catch(() => {
				if (task === undefined) void runTask();
			});
		} catch {
			void runTask();
		}
	});
}
