import { afterEach, expect, it } from "vitest";

import { closeFixtures } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { linkSuccessorProtocol } from "./fixtures/track-x/successor-link.js";

// Track X probe (not a test of record): what reopening the readiness-hold creator does after a
// seal, at each step before and after the adoption. Astra's restart probe saw
// "v3 room trust installation failed: trust-rejected" on the reopen.
// Observed (2026-10-22, logs <evidence>/track-x/logs/e-reopen-probe*.log): every reopen after the
// seal and before the adoption fails "trust-rejected" (its cause, with a temporary debug edit:
// "trust-state-inconsistent"), with or without an export or a Writer install; after the adoption,
// and without a seal, the reopen succeeds. The room's startup trust install reads the epoch-0
// store, whose head holds the sealed successor's trust record, which the generic opener refuses
// by design. A creator that restarts between its seal and its adoption cannot reopen (open item).

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const describeError = (error: unknown): string => {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as { cause?: unknown }).cause;
	return `${error.message}${cause === undefined ? "" : ` [cause: ${JSON.stringify(cause)}]`}`;
};

for (const variant of ["seal", "seal-export", "seal-export-install", "seal-adopt", "none"] as const) {
	it(`reopen after ${variant}`, async () => {
		const fixture = await readinessHoldRoom();
		const creator = await fixture.open(0);
		const writer = await fixture.open(1);
		const link = linkSuccessorProtocol(creator, writer);
		await creator.room.issue({ action: "placeBlock", id: "base", kind: "stone", x: 1, y: 1 });
		await writer.receive(await fixture.publishedAfter(0, null), 0);
		await sleep(300);
		let install: Promise<string> | undefined;
		if (variant !== "none") {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			if (variant === "seal-adopt") await creator.room.adoptCreatorSuccessor();
			if (variant === "seal-export" || variant === "seal-export-install") {
				const offer = await creator.room.exportCreatorSuccessor();
				if (variant === "seal-export-install") {
					install = writer.room.installCreatorSuccessor({ offer, peers: [creator.networkNode.peerId] }).then(
						() => "ok",
						(error: unknown) => `failed: ${describeError(error)}`
					);
					const deadline = performance.now() + 30_000;
					while (link.requests.length === 0 && performance.now() < deadline) await sleep(10);
				}
			}
		}
		await fixture.stop(creator);
		let reopened = "ok";
		let epoch: number | undefined;
		try {
			const peer = await fixture.open(0, { reopen: true });
			epoch = peer.room.authority()?.epoch;
		} catch (error) {
			reopened = `failed: ${describeError(error)}`;
		}
		// A Writer install retries until its own session closes (option E); end it here.
		if (install !== undefined) await fixture.stop(writer);
		console.log(
			`TRACK_X_REOPEN_PROBE ${JSON.stringify({ variant, reopened, epoch, install: install === undefined ? null : await install })}`
		);
	}, 240_000);
}
