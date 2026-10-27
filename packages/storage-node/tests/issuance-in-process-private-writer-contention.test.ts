import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueScope } from "@ts-drp/issuance-store";
import { nativeIssuanceSignAdmissionForStore } from "@ts-drp/issuance-store/maintenance";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeDurableIssuanceStore } from "../src/issuance.js";

/**
 * The store's private writer connections (an issue job's signing connection, the
 * room's native sign admission, a native read reservation) each hold SQLite's
 * writer reservation across awaits. When a second private holder starts while the
 * first is held, its BEGIN IMMEDIATE used to busy-wait synchronously: the busy
 * handler sleeps the only JS thread, so the first holder could never release, and
 * the second failed after busy_timeout (1 s) with the event loop frozen throughout.
 */

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const holderScope: DurableIssueScope = Object.freeze({ objectId: "contention-room", author: "holder" });
const waiterScope: DurableIssueScope = Object.freeze({ objectId: "contention-room", author: "waiter" });

async function openStore(): Promise<DurableIssuanceStore> {
	const directory = await mkdtemp(join(tmpdir(), "issuance-private-writer-contention-"));
	directories.push(directory);
	const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
	stores.push(store);
	return store;
}

function commitFor(scope: DurableIssueScope, sequence: number): DurableIssueCommit {
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

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

type Holder = "issue-signing-connection" | "room-native-sign-admission" | "native-read-reservation";
const HOLDERS = ["issue-signing-connection", "room-native-sign-admission", "native-read-reservation"] as const;

/**
 * Runs one private writer for `scope`. Its sign continuation (or, for a read
 * reservation, its held period) waits on `gate`; `entered` resolves once it holds.
 * @param store - Shared issuance store.
 * @param holder - Which private writer connection to use.
 * @param scope - Issue scope (the read reservation uses its object).
 * @param gate - Released when the holder may finish.
 * @returns Resolves once held, with `done` joining the whole operation.
 */
function run(
	store: DurableIssuanceStore,
	holder: Holder,
	scope: DurableIssueScope,
	gate: Promise<void>
): { entered: Promise<void>; done: Promise<unknown> } {
	const entered = deferred();
	if (holder === "native-read-reservation") {
		const acquire = Reflect.get(store, "acquireNativeReadReservation") as (input: {
			objectId: string;
		}) => Promise<{ release(): Promise<void> }>;
		const done = Promise.resolve()
			.then(() => acquire.call(store, { objectId: scope.objectId }))
			.then(async (reservation) => {
				entered.resolve();
				await gate;
				await reservation.release();
				return "reserved";
			});
		return { entered: entered.promise, done };
	}
	const done = store.transactIssue(scope, async (sequence, ownAdmission) => {
		const commit = commitFor(scope, sequence);
		const admit =
			holder === "room-native-sign-admission" ? nativeIssuanceSignAdmissionForStore(store, scope) : ownAdmission;
		if (admit === undefined) throw new Error(`${holder} is unavailable`);
		await admit(commit.envelope.canonicalPreimageBytes, async () => {
			entered.resolve();
			await gate;
			return commit.envelope.signature;
		});
		return commit;
	});
	return { entered: entered.promise, done };
}

function describeError(error: unknown): string {
	return `${(error as Error).message} code=${String(Reflect.get(error as object, "code"))} retryClass=${String(
		Reflect.get(error as object, "retryClass")
	)}`;
}

describe.each(HOLDERS)("while the store's own %s is held", (holder) => {
	it.each(HOLDERS.filter((waiter) => !(holder === "native-read-reservation" && waiter === holder)))(
		"a %s waits for it instead of freezing the event loop into a busy failure",
		async (waiter) => {
			const store = await openStore();
			const holderGate = deferred();
			const held = run(store, holder, holderScope, holderGate.promise);
			void held.done.catch(() => undefined);
			await held.entered;
			let ticks = 0;
			const ticker = setInterval(() => {
				ticks++;
			}, 5);
			// The holder releases from a timer: it can only fire if the waiter yields the event loop.
			const releaseTimer = setTimeout(holderGate.resolve, 20);
			const started = performance.now();
			const second = run(store, waiter, waiterScope, Promise.resolve());
			const outcome = await second.done.then(
				() => "completed",
				(error: unknown) => `failed: ${describeError(error)}`
			);
			const elapsedMs = Math.round(performance.now() - started);
			clearInterval(ticker);
			clearTimeout(releaseTimer);
			holderGate.resolve();
			const holderOutcome = await held.done.then(
				() => "completed",
				(error: unknown) => `failed: ${describeError(error)}`
			);
			console.log(
				`[${holder} held] ${waiter}: ${outcome} after ${elapsedMs} ms with ${ticks} event-loop ticks; holder ${holderOutcome}`
			);
			expect(outcome).toBe("completed");
			expect(holderOutcome).toBe("completed");
			expect(ticks).toBeGreaterThan(0);
		}
	);
});

it("a private waiter whose holder outlives the busy budget fails transient without freezing the event loop", async () => {
	const store = await openStore();
	const holderGate = deferred();
	const held = run(store, "room-native-sign-admission", holderScope, holderGate.promise);
	void held.done.catch(() => undefined);
	await held.entered;
	let ticks = 0;
	const ticker = setInterval(() => {
		ticks++;
	}, 10);
	const started = performance.now();
	const outcome = await run(store, "issue-signing-connection", waiterScope, Promise.resolve()).done.then(
		() => "completed",
		(error: unknown) => describeError(error)
	);
	const elapsedMs = Math.round(performance.now() - started);
	clearInterval(ticker);
	holderGate.resolve();
	console.log(`[outlived budget] ${outcome} after ${elapsedMs} ms with ${ticks} event-loop ticks`);
	expect(outcome).toMatch(/code=ISSUANCE_SUBSTRATE_FAILURE retryClass=transient$/u);
	// The wait is the busy budget (1 s); a frozen loop would tick zero times.
	expect(ticks).toBeGreaterThanOrEqual(20);
	// The holder was never disturbed: its issue still commits after the refusal.
	await held.done;
	expect((await store.readLineage(holderScope)).next).toBe(1);
	expect((await store.readLineage(waiterScope)).next).toBe(0);
});
