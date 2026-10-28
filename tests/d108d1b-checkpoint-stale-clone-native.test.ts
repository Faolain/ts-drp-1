import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, describe, expect, it } from "vitest";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";

// D.108d1b as amended (owner decision, extended by the coordinator to every issuance):
// the selected author never signs at a sequence at or below its authenticated
// admittedAuthorSequence, on any path. Reproduction: a second device restored from
// Bob's backup taken before he issued (same key, stale lineage) after the room admitted
// Bob's work and closed twice.
// RED today: (a) the checkpoint install's settlement author fence (v3-room) issues at
// the stale lineage.next; (b) an ordinary issue on the restored device does the same.
// Either is a second signed vertex for an admitted slot. The frontier is checked only
// on cold reopen (creator-adoption), which then already sees next above the frontier.
afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Device A issues and is admitted through two closes; device B is Bob's pre-issue backup, reopened. */
async function restoredDevice() {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	const before = new Set(readdirSync(f.directory));
	let member = await f.open(1);
	await f.stop(member);
	// Bob's whole device state (every owner database and the floor) before he issues.
	const bobFiles = readdirSync(f.directory).filter((file) => !before.has(file));
	expect(bobFiles.length).toBeGreaterThan(0);
	const backup = join(f.directory, "bob-backup");
	mkdirSync(backup);
	for (const file of bobFiles) copyFileSync(join(f.directory, file), join(backup, file));

	member = await f.open(1, { reopen: true, promote: true });
	const staleRows = (await f.issuedAfter(1, null)).length;
	await member.room.issue(message("bob-on-device-a"));
	const issued = await f.issuedAfter(1, null);
	expect(issued.length).toBe(staleRows + 1);
	expect(await creator.receive(issued, 1)).toBe(true);
	await f.stop(member);
	for (let step = 0; step < 2; step++) {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	}

	for (const file of readdirSync(f.directory).filter((name) => !before.has(name) && name !== "bob-backup"))
		rmSync(join(f.directory, file));
	for (const file of bobFiles) copyFileSync(join(backup, file), join(f.directory, file));
	member = await f.open(1, { reopen: true, promote: true });
	expect((await f.issuedAfter(1, null)).map((row) => row.commit.authorSequence)).toEqual(
		issued.slice(0, staleRows).map((row) => row.commit.authorSequence)
	);
	const admitted = new Map(issued.map((row) => [row.commit.authorSequence, hex(row.commit.envelope.digest)]));
	/** Every (Bob, seq) row device B issued or published whose digest differs from the admitted one. */
	const conflicting = async () =>
		(await f.issuedAfter(1, null))
			.filter((row: DurableIssuanceOutboxRecord) => {
				const original = admitted.get(row.commit.authorSequence);
				return original !== undefined && original !== hex(row.commit.envelope.digest);
			})
			.map((row) => ({ authorSequence: row.commit.authorSequence, publishState: row.publishState }));
	return { f, member, staleRows, conflicting };
}

describe("D.108d1b: a restored same-author device never re-signs an admitted slot", () => {
	it("through the checkpoint install (settlement author fence) and the cold reopen after it", async () => {
		const { f, member, conflicting } = await restoredDevice();
		const installed = await f.install(member).then(
			() => true,
			(error: unknown) => {
				// Fail closed, surfaced: the settlement fence refuses before signing.
				expect(String((error as Error).message)).toContain("V3_LOCAL_LINEAGE_BEHIND_FRONTIER");
				return false;
			}
		);
		expect(await conflicting()).toEqual([]);
		// The installed plane (epoch 2, authenticated frontier) refuses ordinary work too.
		expect(member.room.authority()?.epoch).toBe(2);
		await expect(member.room.issue(message("bob-after-install"))).rejects.toThrow(/V3_LOCAL_LINEAGE_BEHIND_FRONTIER/u);
		expect(await conflicting()).toEqual([]);
		if (installed) {
			// Had the install proceeded without re-signing, the cold reopen (checkpoint
			// path, authenticated frontier above the stale lineage) must still refuse.
			await f.stop(member);
			await expect(f.open(1, { reopen: true, promote: true })).rejects.toThrow(
				/creator checkpoint issuance lineage is invalid/u
			);
		}
		expect(await conflicting()).toEqual([]);
	}, 240_000);

	// KNOWN GAP (pinned with it.fails; owner decision): before it installs anything, the
	// restored device is at its backup's epoch 0 and holds no authenticated closed
	// frontier, so no local check can know slot 2 was admitted. Its second vertex is an
	// epoch-0 vertex: the room closed epoch 0 and every current peer refuses it, but it is
	// still signed and published. Closing it needs authenticated currency before local
	// issue (e.g. refuse while a newer authenticated offer or floor is known).
	it.fails("through an ordinary issue on the restored device before it learns any later close", async () => {
		const { member, conflicting } = await restoredDevice();
		expect(member.room.authority()?.epoch).toBe(0);
		await member.room.issue(message("bob-on-device-b")).then(
			() => undefined,
			() => undefined
		);
		expect(await conflicting()).toEqual([]);
	}, 240_000);
});
