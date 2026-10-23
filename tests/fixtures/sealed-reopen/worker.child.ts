import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeFixtures } from "../track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "../track-x/readiness-hold-room.js";

it("native sealed successor process-death worker", async () => {
	const directory = process.env.TS_DRP_SEALED_CRASH_DIRECTORY;
	if (directory === undefined) throw new Error("missing parent-owned crash directory");
	const epoch = Number(process.env.TS_DRP_SEALED_CRASH_EPOCH);
	const reopen = process.env.TS_DRP_SEALED_CRASH_MODE === "reopen";
	const fixture = await readinessHoldRoom({ directory });
	const creator = await fixture.open(0, { reopen });
	if (!reopen) {
		for (let current = 0; current <= epoch; current++) {
			await creator.room.issue({ action: "placeBlock", id: `durable-${current}`, kind: "gold", x: 1, y: current });
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
			if (current < epoch) await creator.room.adoptCreatorSuccessor();
		}
		await writeFile(join(directory, "sealed-ready.json"), JSON.stringify({ pid: process.pid, epoch }));
		// Parent sends SIGKILL to this worker while every native owner is still open.
		await new Promise<void>(() => {});
	} else {
		try {
			expect(creator.room.authority()?.epoch).toBe(epoch + 1);
			const ids = () =>
				(creator.room.projection() as unknown as { blocks: { id: string }[] }).blocks.map((row) => row.id);
			for (let current = 0; current <= epoch; current++) expect(ids()).toContain(`durable-${current}`);
			await creator.room.issue({ action: "placeBlock", id: "after-kill", kind: "stone", x: 2, y: epoch + 1 });
			expect(ids()).toContain("after-kill");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
			await creator.room.adoptCreatorSuccessor();
			expect(creator.room.authority()?.epoch).toBe(epoch + 2);
		} finally {
			expect(await closeFixtures()).toEqual([]);
		}
	}
}, 120000);
