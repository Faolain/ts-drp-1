import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueScope } from "@ts-drp/issuance-store";
import { nativeIssuanceSignAdmissionForStore } from "@ts-drp/issuance-store/maintenance";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";

/**
 * Every in-process SQLite writer reservation on the issuance file (an issue job's
 * private signing connection, the room's native sign admission, a native read
 * reservation) is held across awaits. A main-connection write that meets it used to
 * busy-wait synchronously: SQLite's busy handler sleeps the only JS thread, so the
 * holder can never release, and after busy_timeout (1 s) the write failed with a
 * transient ISSUANCE_SUBSTRATE_FAILURE that nothing retried ("settlement plan write
 * failed" out of drainSettlementOutbox → writeMergedSettlementPlan).
 */

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const scope: DurableIssueScope = Object.freeze({ objectId: "contention-room", author: "writer" });

async function openStore(): Promise<DurableIssuanceStore> {
	const directory = await mkdtemp(join(tmpdir(), "issuance-writer-contention-"));
	directories.push(directory);
	const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
	stores.push(store);
	return store;
}

function commitFor(sequence: number): DurableIssueCommit {
	const canonicalPreimageBytes = encodeCanonical({
		author: scope.author,
		authorSequence: sequence,
		epoch: 0,
		kind: "drp-vertex",
		objectId: scope.objectId,
		protocolMajor: 3,
	});
	const envelope = {
		canonicalPreimageBytes,
		digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
		signature: new Uint8Array(64).fill(sequence + 1),
	};
	return {
		authorSequence: sequence,
		envelope,
		issuedRecord: { authorSequence: sequence, envelope, scope },
		outboxEntry: { authorSequence: sequence, envelope, scope },
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

type Holder = "issue-signing-connection" | "room-native-sign-admission" | "native-read-reservation";

/**
 * Starts an in-process holder of the issuance file's SQLite writer reservation and
 * resolves once it holds. `release` lets it finish; `done` joins it.
 */
async function hold(
	store: DurableIssuanceStore,
	holder: Holder
): Promise<{ release: () => void; done: Promise<unknown> }> {
	const signGate = deferred();
	const entered = deferred();
	if (holder === "native-read-reservation") {
		const acquire = Reflect.get(store, "acquireNativeReadReservation") as (input: {
			objectId: string;
		}) => Promise<{ release(): Promise<void> }>;
		const reservation = await acquire.call(store, { objectId: scope.objectId });
		return { release: signGate.resolve, done: signGate.promise.then(() => reservation.release()) };
	}
	const done = store.transactIssue(scope, async (sequence, ownAdmission) => {
		const commit = commitFor(sequence);
		const admit = holder === "room-native-sign-admission" ? nativeIssuanceSignAdmissionForStore(store, scope) : ownAdmission;
		if (admit === undefined) throw new Error(`${holder} is unavailable`);
		await admit(commit.envelope.canonicalPreimageBytes, async () => {
			entered.resolve();
			await signGate.promise;
			return commit.envelope.signature;
		});
		return commit;
	});
	void done.catch(() => undefined);
	await entered.promise;
	return { release: signGate.resolve, done };
}

async function seed(store: DurableIssuanceStore): Promise<DurableIssueCommit> {
	const commit = await store.transactIssue(scope, (sequence) => Promise.resolve(commitFor(sequence)));
	return commit;
}

function planFor(commit: DurableIssueCommit, revision: number) {
	const contextBytes = encodeCanonical({ historicalSource: "in-process-writer-contention" });
	const context = {
		digest: hashDomain("ts-drp/settlement-source-context/v1", contextBytes),
		exactCanonicalContextBytes: contextBytes,
	};
	return {
		scope,
		revision,
		fenceSequence: commit.authorSequence,
		sourceContexts: [context],
		entries: [
			{
				sourceContextDigest: context.digest,
				sourceSequence: commit.authorSequence,
				sourceDigest: commit.envelope.digest,
				disposition: "rebase" as const,
				replacementSequence: commit.authorSequence + 1,
			},
		],
	};
}

describe.each([
	"issue-signing-connection",
	"room-native-sign-admission",
	"native-read-reservation",
] as const)("a main-connection write meeting the store's own %s", (holder) => {
	it("waits for the holder instead of failing a transient busy that nothing retries", async () => {
		const store = await openStore();
		const seeded = await seed(store);
		const held = await hold(store, holder);
		// The holder releases from a timer: it can only fire if the write yields the event loop.
		const releaseTimer = setTimeout(held.release, 20);
		const started = performance.now();
		const written = store.transactWriteSettlementPlan({ scope, expectedRevision: null, plan: planFor(seeded, 0) });
		const outcome = await written.then(
			(plan) => ({ ok: true as const, plan }),
			(error: unknown) => ({
				ok: false as const,
				error: `${(error as Error).message} code=${String(Reflect.get(error as object, "code"))} retryClass=${String(
					Reflect.get(error as object, "retryClass")
				)}`,
			})
		);
		const elapsedMs = Math.round(performance.now() - started);
		clearTimeout(releaseTimer);
		held.release();
		await held.done.catch(() => undefined);
		console.log(`[${holder}] settlement plan write ${outcome.ok ? "committed" : `failed: ${outcome.error}`} after ${elapsedMs} ms`);
		expect(outcome.ok ? "committed" : outcome.error).toBe("committed");
		expect(outcome.ok ? outcome.plan : undefined).toEqual(planFor(seeded, 0));
		expect(await store.readSettlementPlan(scope)).toEqual(planFor(seeded, 0));
	});

	it("marks an outbox row published while the holder is held", async () => {
		const store = await openStore();
		const seeded = await seed(store);
		const held = await hold(store, holder);
		const releaseTimer = setTimeout(held.release, 20);
		const outcome = await store
			.compareAndMarkOutboxPublished({ scope, authorSequence: seeded.authorSequence, digest: seeded.envelope.digest })
			.then(
				() => "published",
				(error: unknown) => `failed: ${(error as Error).message}`
			);
		clearTimeout(releaseTimer);
		held.release();
		await held.done.catch(() => undefined);
		expect(outcome).toBe("published");
		expect((await store.readOutboxPage({ scope, limit: 1 }))[0]?.publishState).toBe("published");
	});
});
