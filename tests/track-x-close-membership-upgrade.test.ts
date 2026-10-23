import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { journalClosedMembershipCanExtend } from "@ts-drp/live-journal";
import { afterEach, expect, it } from "vitest";

import { openReceivedCloseMembership } from "../packages/node/src/internal/creator-received-close-membership.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { install, play, seal, type OutsideRowsRoom } from "./fixtures/track-x/outside-rows-room.js";

afterEach(async () => { expect(await closeFixtures()).toEqual([]); });

it("only extends exact unwrapped evidence and never overwrites an existing envelope", () => {
	// Mechanical encoding only: these are not authenticated membership or checkpoint records.
	const original = encodeCanonical({ kind: "creator-close-membership-1", marker: 1 });
	const fields = { kind: "creator-received-close-membership-1", exactCanonicalMembershipBytes: original,
		exactCanonicalCutValueBytes: Uint8Array.of(1), exactCanonicalCommitQcBytes: Uint8Array.of(2),
		exactCanonicalSuccessorTrustStateRecordBytes: Uint8Array.of(3) };
	const extended = encodeCanonical(fields);
	expect(journalClosedMembershipCanExtend(original, extended)).toBe(true);
	for (const changed of [
		{ ...fields, exactCanonicalMembershipBytes: encodeCanonical({ kind: "creator-close-membership-1", marker: 2 }) },
		{ ...fields, kind: "other-envelope" }, { ...fields, extra: true },
		{ ...fields, exactCanonicalCommitQcBytes: new Uint8Array() },
	]) expect(journalClosedMembershipCanExtend(original, encodeCanonical(changed))).toBe(false);
	expect(journalClosedMembershipCanExtend(original, original)).toBe(false);
	expect(journalClosedMembershipCanExtend(extended, encodeCanonical({ ...fields,
		exactCanonicalMembershipBytes: extended }))).toBe(false);
});

it("retries after an old build persisted membership and crashed before successor installation", async () => {
	const fixture = await readinessHoldRoom();
	let first = true, original: Uint8Array | undefined;
	const room: OutsideRowsRoom = { fixture, peers: [await fixture.open(0), await fixture.open(1, {
		host: host => ({ ...host, openJournal: async (...args) => {
			const journal = await host.openJournal(...args);
			return { ...journal, recordClosedMembership: async input => {
				if (!first) return required(journal.recordClosedMembership)(input);
				first = false;
				original = required(openReceivedCloseMembership(input.exactCanonicalMembershipBytes)).exactCanonicalMembershipBytes;
				expect(await required(journal.recordClosedMembership)({ ...input,
					exactCanonicalMembershipBytes: original })).toMatchObject({ ok: true });
				return { ok: false, kind: "substrate-failure" } as const;
			} };
		} }),
	})], delivered: [null, null] };
	await play(room, "legacy");
	await seal(room, 0);
	await required(room.peers[0]).room.adoptCreatorSuccessor();
	expect(await install(room, 1)).toBe("failed: creator received close membership persistence refused");
	await fixture.stop(required(room.peers[1]));
	room.peers[1] = await fixture.open(1, { reopen: true });
	expect(await install(room, 1)).toBe("ok");
	const journal = await fixture.host.storageHost.openJournal("peer-1");
	try {
		const image = await required(journal.readRetirementImage)({ objectId: fixture.objectId });
		if (!image.ok) throw new TypeError(image.kind);
		const header = image.value.canonicalRows.map(bytes => decodeCanonical(bytes) as [string, unknown[], Record<string, unknown>])
			.find(frame => frame[0] === "scopes" && frame[1][1] === 0);
		const upgraded = required(openReceivedCloseMembership(required(header)[2].closed_membership_bytes as Uint8Array));
		expect(upgraded.exactCanonicalMembershipBytes).toEqual(original);
	} finally { await journal.close(); }
}, 120_000);
