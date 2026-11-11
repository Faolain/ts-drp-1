/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";

// Step 2 (perf/lull-cost-and-barrier), design A: the creator's rollover policy keeps a move out of
// its own rollover only between the seal and the adoption (the cut). Export and publish serve the
// adopted successor through the room's lifetime FIFO; a move issued then belongs to the successor
// epoch and need not wait for them. RED at base: issue() awaited the whole roll, export and publish
// included.

const policies = new Set<{ close(): void }>();
afterEach(() => {
	for (const policy of policies) policy.close();
	policies.clear();
});

type Gate = { promise: Promise<void>; open: () => void; entered: boolean };
const gate = (): Gate => {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open, entered: false };
};

function creatorRoom(gates: { seal?: Gate; adopt?: Gate; export?: Gate; publish?: Gate }) {
	let epoch = 3;
	const admitted: { id: unknown; epoch: number }[] = [];
	const room = {
		authority: () =>
			({ epoch }) as unknown as ReturnType<
				NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["authority"]
			>,
		issue: (operation: Readonly<Record<string, unknown>>) => {
			admitted.push({ id: operation.id, epoch });
			return Promise.resolve();
		},
		sealEpoch: async () => {
			if (gates.seal !== undefined) {
				gates.seal.entered = true;
				await gates.seal.promise;
			}
			return { epoch, successorEpoch: epoch + 1 } as unknown as Awaited<
				ReturnType<NonNullable<Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]>["sealEpoch"]>
			>;
		},
		adoptCreatorSuccessor: async () => {
			if (gates.adopt !== undefined) {
				gates.adopt.entered = true;
				await gates.adopt.promise;
			}
			epoch++;
			return undefined as never;
		},
		exportCreatorSuccessor: async () => {
			if (gates.export !== undefined) {
				gates.export.entered = true;
				await gates.export.promise;
			}
			return { epoch } as never;
		},
	};
	return { room, admitted };
}

function create(publish?: Gate) {
	const policy = rollover.createV3RoomRolloverPolicy({
		role: "creator",
		budget: { movesPerAuthor: 1, idleMs: 600_000 },
		...(publish === undefined
			? {}
			: {
					hooks: {
						publishSuccessor: async () => {
							publish.entered = true;
							await publish.promise;
						},
					},
				}),
	});
	policies.add(policy);
	return policy;
}

it("a move issued while the adopted successor is exported is admitted without waiting for the export", async () => {
	const exporting = gate();
	const fixture = creatorRoom({ export: exporting });
	const policy = create();
	policy.bind(fixture.room);
	policy.observe({ author: "creator", epoch: 3 });
	await expect.poll(() => exporting.entered, { timeout: 5_000 }).toBe(true);
	const issued = policy.issue({ action: "paint", id: "during-export" });
	await expect.poll(() => fixture.admitted.length, { timeout: 1_000 }).toBe(1);
	// Admitted in the adopted successor epoch, while the export is still running.
	expect(fixture.admitted).toEqual([{ id: "during-export", epoch: 4 }]);
	expect(exporting.entered).toBe(true);
	exporting.open();
	await expect(issued).resolves.toBeUndefined();
	await policy.settled();
});

it("a move issued while the successor is published is admitted without waiting for the publish", async () => {
	const publishing = gate();
	const fixture = creatorRoom({});
	const policy = create(publishing);
	policy.bind(fixture.room);
	policy.observe({ author: "creator", epoch: 3 });
	await expect.poll(() => publishing.entered, { timeout: 5_000 }).toBe(true);
	const issued = policy.issue({ action: "paint", id: "during-publish" });
	await expect.poll(() => fixture.admitted.length, { timeout: 1_000 }).toBe(1);
	expect(fixture.admitted).toEqual([{ id: "during-publish", epoch: 4 }]);
	publishing.open();
	await expect(issued).resolves.toBeUndefined();
	await policy.settled();
});

it("a move issued during the seal or the adoption still waits for the adoption (the cut stays excluded)", async () => {
	for (const stage of ["seal", "adopt"] as const) {
		const held = gate();
		const fixture = creatorRoom({ [stage]: held });
		const policy = create();
		policy.bind(fixture.room);
		policy.observe({ author: "creator", epoch: 3 });
		await expect.poll(() => held.entered, { timeout: 5_000 }).toBe(true);
		const issued = policy.issue({ action: "paint", id: `during-${stage}` });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fixture.admitted, stage).toEqual([]);
		held.open();
		await expect(issued).resolves.toBeUndefined();
		// Never in the closing epoch.
		expect(fixture.admitted, stage).toEqual([{ id: `during-${stage}`, epoch: 4 }]);
		await policy.settled();
		policy.close();
	}
});
