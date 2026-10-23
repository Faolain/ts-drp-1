/* eslint-disable @typescript-eslint/explicit-function-return-type -- Controlled endpoints preserve the measured driver's capability types. */
/* eslint-disable @typescript-eslint/require-await -- Promise-shaped endpoints model immediate native success or failure; held calls await explicit gates. */
import { expect, it } from "vitest";

import { driveActiveAppEndurance } from "./fixtures/active-endurance/driver.js";
import type { RoleEndpoint } from "./fixtures/track-m-apps/long-room-driver.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function endpoint(overrides: Partial<RoleEndpoint> = {}): RoleEndpoint {
	return {
		issue: async () => 0,
		published: async () => [],
		receive: async () => 0,
		inject: async () => {},
		projectionAudit: async () => ({
			base: null,
			operations: [],
			acceptedCount: 0,
			lastAcceptedAt: null,
			remoteAcceptedCount: 0,
			lastRemoteAcceptedAt: null,
		}),
		acceptance: async () => [],
		settlementAudit: async () => ({ entries: 0, missing: [], dispositions: {}, replacements: [] }),
		state: async () => "",
		seal: async () => {
			await turn();
			return 0;
		},
		adopt: async () => 0,
		exportOffer: async () => ({ offer: {}, ms: 0 }),
		dispatch: async () => [],
		install: async () => 0,
		authorityEpoch: async () => 0,
		lull: async () => ({ kind: "complete", ms: 0 }),
		census: async () => ({}),
		archive: async () => null,
		drainEvents: async () => [],
		close: async () => {},
		...overrides,
	};
}

function run(creator: RoleEndpoint, recipient: RoleEndpoint) {
	const records: Readonly<Record<string, unknown>>[] = [];
	let settled = false;
	const outcome = driveActiveAppEndurance({
		app: "grid",
		epochs: 1,
		moves: 1,
		streamLimit: 1,
		peers: [creator, recipient],
		write: (record) => records.push(record),
	}).then(
		() => {
			settled = true;
			return null;
		},
		(error: unknown) => {
			settled = true;
			return error;
		}
	);
	return { outcome, records, settled: () => settled };
}

it("observes a failed stream immediately and joins the held rollover before reporting failure", async () => {
	const heldSeal = gate();
	const streamFailed = gate();
	const failure = new Error("stream outbox failed");
	const unhandled: unknown[] = [];
	const observe = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", observe);
	let reads = 0;
	const fixture = run(
		endpoint({ seal: async () => (await heldSeal.promise, 0) }),
		endpoint({
			published: async () => {
				if (++reads === 2) {
					streamFailed.release();
					throw failure;
				}
				return [];
			},
		})
	);
	try {
		await streamFailed.promise;
		await turn();
		expect(unhandled).toEqual([]);
		expect(fixture.settled()).toBe(false);
		expect(fixture.records).toEqual([]);
		heldSeal.release();
		expect(await fixture.outcome).toBe(failure);
		expect(fixture.records).toEqual([
			expect.objectContaining({ kind: "failure", completed: 0, error: String(failure) }),
		]);
	} finally {
		heldSeal.release();
		await fixture.outcome;
		process.off("unhandledRejection", observe);
	}
});

it("joins a held stream before reporting a rollover failure to the peer cleanup owner", async () => {
	const heldRead = gate();
	const readStarted = gate();
	const failure = new Error("creator seal failed");
	let reads = 0;
	const fixture = run(
		endpoint({
			seal: async () => {
				throw failure;
			},
		}),
		endpoint({
			published: async () => {
				if (++reads === 2) {
					readStarted.release();
					await heldRead.promise;
				}
				return [];
			},
		})
	);
	try {
		await readStarted.promise;
		await turn();
		expect(fixture.settled()).toBe(false);
		expect(fixture.records).toEqual([]);
		heldRead.release();
		expect(await fixture.outcome).toBe(failure);
		expect(fixture.records).toEqual([
			expect.objectContaining({ kind: "failure", completed: 0, error: String(failure) }),
		]);
	} finally {
		heldRead.release();
		await fixture.outcome;
	}
});

it("joins the other native lull and in-flight writer before reporting maintenance failure", async () => {
	const heldLull = gate();
	const heldWrite = gate();
	const lullStarted = gate();
	const writeStarted = gate();
	const failure = new Error("creator maintenance failed");
	const fixture = run(
		endpoint({
			lull: async () => {
				throw failure;
			},
			issue: async (_epoch, ordinal) => {
				if (ordinal === 2) {
					writeStarted.release();
					await heldWrite.promise;
				}
				return 0;
			},
		}),
		endpoint({
			lull: async () => {
				lullStarted.release();
				await heldLull.promise;
				return { kind: "complete", ms: 0 };
			},
		})
	);
	try {
		await Promise.all([lullStarted.promise, writeStarted.promise]);
		await turn();
		expect(fixture.settled()).toBe(false);
		heldLull.release();
		await turn();
		expect(fixture.settled()).toBe(false);
		expect(fixture.records).toEqual([]);
		heldWrite.release();
		expect(await fixture.outcome).toBe(failure);
		expect(fixture.records).toEqual([
			expect.objectContaining({ kind: "failure", completed: 0, error: String(failure) }),
		]);
	} finally {
		heldLull.release();
		heldWrite.release();
		await fixture.outcome;
	}
});
