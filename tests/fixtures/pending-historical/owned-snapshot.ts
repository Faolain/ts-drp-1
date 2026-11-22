import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	type GenuineCreatorAdoptionFixture,
	type GenuineCreatorAdoptionFixtureModules,
	type GenuineCreatorAdoptionFixtureOptions,
	prepareGenuineCreatorAdoptionFixture,
	REPOSITORY_ROOT,
} from "../phase-6a-v3/creator-adoption-contract.js";

type SnapshotFactory = GenuineCreatorAdoptionFixtureModules["createBrowserSnapshotQuarantineStore"];
type SnapshotOwner = Awaited<ReturnType<SnapshotFactory>>;
type PendingFixtureOptions = Omit<GenuineCreatorAdoptionFixtureOptions, "createSnapshotStore">;

/**
 * Retain cleanup failures without replacing a primary construction/body error.
 * @param primary - Exact original failure, including frozen or hostile error objects.
 * @param errors - Settled cleanup failures in owner registration order.
 * @throws The primary or an aggregate retaining its exact cause.
 */
function throwWithPendingCleanupErrors(primary: unknown, errors: readonly unknown[]): never {
	if ((typeof primary === "object" && primary !== null) || typeof primary === "function") {
		try {
			Object.defineProperty(primary, "pendingSnapshotCleanupErrors", { value: errors });
		} catch {
			// Frozen/reused errors and hostile traps must not replace the original failure.
			throw new AggregateError(errors, "PENDING_SNAPSHOT_PRIMARY_AND_CLEANUP_FAILED", { cause: primary });
		}
		throw primary;
	}
	throw new AggregateError(errors, "PENDING_SNAPSHOT_PRIMARY_AND_CLEANUP_FAILED", { cause: primary });
}

/**
 * Use the configured factory verbatim; otherwise match the frozen loader's source URL.
 * @param modules - Effective configured genuine module lane, if supplied.
 * @returns The capable factory from that same lane, never a dist receipt owner.
 */
export async function pendingSnapshotFactory(modules?: GenuineCreatorAdoptionFixtureModules): Promise<SnapshotFactory> {
	if (modules !== undefined) return modules.createBrowserSnapshotQuarantineStore;
	const url = pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-browser/src/snapshot-transfer.ts")).href;
	const source = (await import(url)) as Pick<
		GenuineCreatorAdoptionFixtureModules,
		"createBrowserSnapshotQuarantineStore"
	>;
	return source.createBrowserSnapshotQuarantineStore;
}

/**
 * Delete only the helper-owned exact database, rejecting blocked/error outcomes.
 * @param databaseName - Fully suffixed exact identity (not a prefix or glob).
 * @returns Completion of native deletion, not merely acceptance of a request.
 */
export function deleteOwnedPendingSnapshotDatabase(databaseName: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.addEventListener("success", () => resolvePromise(), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("PENDING_SNAPSHOT_DELETE_ERROR")), {
			once: true,
		});
		request.addEventListener("blocked", () => reject(new Error(`PENDING_SNAPSHOT_DELETE_BLOCKED:${databaseName}`)), {
			once: true,
		});
	});
}

/**
 * Own one injected native snapshot and settle it even when parallel preparation fails.
 * The generic lifecycle seam lets focused controls exercise failures without opening
 * untracked frozen-fixture siblings. It does not implement recovery policy.
 * @param input - Genuine capable factory and preparation/finish lifecycle.
 * @param input.factory - Effective configured/source native snapshot factory.
 * @param input.prepare - Producer construction that receives the exact owner factory hook.
 * @param input.finish - Genuine close and finish after retaining the cleanup handle.
 * @returns Finished value, exact producer owner, database custody and cached cleanup.
 */
export async function openOwnedPendingSnapshot<Prepared extends { close(): Promise<void> }, Finished>(input: {
	readonly factory: SnapshotFactory;
	prepare(createSnapshotStore: () => Promise<SnapshotOwner>): Promise<Prepared>;
	finish(prepared: Prepared): Promise<Finished>;
}): Promise<{
	readonly value: Finished;
	readonly snapshotStore: SnapshotOwner;
	readonly snapshotDatabaseName: string;
	close(): Promise<void>;
}> {
	const primaryDatabaseName = `pending-historical-snapshot-${crypto.randomUUID()}`;
	const snapshotDatabaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	let started: Promise<SnapshotOwner> | undefined;
	let prepared: Prepared | undefined;
	let cleanup: Promise<void> | undefined;
	const close = (primary?: unknown): Promise<void> => {
		cleanup ??= (async (): Promise<void> => {
			const errors: unknown[] = [];
			if (prepared !== undefined) {
				try {
					await prepared.close();
				} catch (error) {
					errors.push(error);
				}
			}
			if (started !== undefined) {
				let owner: SnapshotOwner | undefined;
				try {
					owner = await started;
				} catch (error) {
					if (error !== primary) errors.push(error);
				}
				if (owner !== undefined) {
					try {
						// Native owner caches its close; fixture-wide close is attempted once above.
						await owner.close();
					} catch (error) {
						errors.push(error);
					}
				}
			}
			try {
				await deleteOwnedPendingSnapshotDatabase(snapshotDatabaseName);
			} catch (error) {
				errors.push(error);
			}
			if (errors.length !== 0) throw new AggregateError(errors, "PENDING_SNAPSHOT_CLEANUP_FAILED");
		})();
		return cleanup;
	};
	try {
		prepared = await input.prepare(() => {
			if (started !== undefined) throw new Error("PENDING_SNAPSHOT_FACTORY_REENTERED");
			// Capture before any await, including a synchronous factory failure.
			started = Promise.resolve().then(() => input.factory({ primaryDatabaseName }));
			return started;
		});
		const value = await input.finish(prepared);
		if (started === undefined) throw new Error("PENDING_SNAPSHOT_FACTORY_NOT_CALLED");
		return { value, snapshotStore: await started, snapshotDatabaseName, close };
	} catch (primary) {
		try {
			await close(primary);
		} catch (cleanupError) {
			const errors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
			throwWithPendingCleanupErrors(primary, errors);
		}
		throw primary;
	}
}

export interface PendingHistoricalFixture extends GenuineCreatorAdoptionFixture {
	readonly pendingSnapshotStore: SnapshotOwner;
	readonly pendingSnapshotDatabaseName: string;
}

/**
 * Return the exact created owner to the frozen producer, then retain it for pending recovery.
 * The producer's evidence decorator remains narrow and unchanged. Pending calls deliberately
 * bypass its durableReadHook and mutation controls, not authentication or native identity.
 * @param options - Existing fixture options and effective module factory lane.
 * @returns Genuine closed fixture plus its exact capable snapshot and owned cleanup.
 */
export async function openPendingHistoricalFixture(
	options: PendingFixtureOptions = {}
): Promise<PendingHistoricalFixture> {
	const owned = await openOwnedPendingSnapshot({
		factory: await pendingSnapshotFactory(options.modules),
		prepare: (createSnapshotStore) => prepareGenuineCreatorAdoptionFixture({ ...options, createSnapshotStore }),
		finish: async (prepared) => prepared.finish(await prepared.handle.close()),
	});
	return {
		...owned.value,
		pendingSnapshotStore: owned.snapshotStore,
		pendingSnapshotDatabaseName: owned.snapshotDatabaseName,
		close: owned.close,
	};
}

/**
 * Own caller acquisition as soon as each fixture returns, including later construction failures.
 * This scope owns returned fixture handles; the single-fixture helper still owns an
 * in-flight factory and its exact database before a handle can return.
 * @param run - Complete acquisition/assertion body, using the registered acquisition function.
 * @param open - Genuine fixture constructor, with a test-only rejection seam for caller controls.
 * @returns Body result only after every acquired fixture's cleanup has settled once.
 */
export async function withPendingHistoricalFixtures<Result>(
	run: (acquire: typeof openPendingHistoricalFixture) => Promise<Result>,
	open: typeof openPendingHistoricalFixture = openPendingHistoricalFixture
): Promise<Result> {
	const acquired: PendingHistoricalFixture[] = [];
	const acquire = async (options: PendingFixtureOptions = {}): Promise<PendingHistoricalFixture> => {
		const fixture = await open(options);
		acquired.push(fixture);
		return fixture;
	};
	let value!: Result;
	let primary: unknown;
	let failed = false;
	try {
		value = await run(acquire);
	} catch (error) {
		failed = true;
		primary = error;
	}
	const settled = await Promise.allSettled(acquired.map((fixture) => Promise.resolve().then(() => fixture.close())));
	const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
	if (failed) {
		if (errors.length !== 0) throwWithPendingCleanupErrors(primary, errors);
		throw primary;
	}
	if (errors.length !== 0) throw new AggregateError(errors, "PENDING_HISTORICAL_FIXTURES_CLEANUP_FAILED");
	return value;
}
