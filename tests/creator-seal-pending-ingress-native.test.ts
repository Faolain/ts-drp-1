/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
// The hold-unavailable family, creator seal: a creator close whose inline recovery maintenance fires
// (pool full, generation pressure, resume or promotion pool, creator-close bindCreatorLiveClose)
// while the creator holds a pending ingress row.
//
// Observed in the 5-Writer received-refusal room (diag-seal7, generation-pressure trigger at seal 4):
// sealCreatorRecoveryDependencies(required = true) threw
// "creator recovery dependency hold unavailable:live:1:1:1:active:1:631:0:0:1:1:0", meaning one
// pending ingress row (631 B) plus a displaced source. The closing (non-active) observation
// requires an empty pending ingress (v3-live captureCreatorRecoveryRuntime). A row whose parent has
// not arrived cannot be admitted into the closing plane (the stage closed admission), so every
// retry of that close meets the same state. The close never completes and the room stops.
//
// Here Writer 2 makes two moves per epoch and the creator receives only the later one before it
// seals, so the creator holds it as pending ingress at every seal. The room rolls enough epochs
// for the recovery pool to fill and the seal's inline maintenance to run. Rule under test: a
// pending ingress row never stops a creator close ("hot ingress must never stop the room").
// Genuine SQLite, Ed25519, room owners, floor and creator material server.
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const explain = (error: unknown, depth = 0): string => {
	if (!(error instanceof Error) || depth > 3) return String(error).slice(0, 400);
	return error.message.slice(0, 400) + (error.cause === undefined ? "" : ` <- ${explain(error.cause, depth + 1)}`);
};

const EPOCHS = Number(process.env.SEAL_PENDING_EPOCHS ?? 9);

it.each([
	["[RED] a creator seal with a pending ingress row completes at every epoch, including maintenance seals", true],
	["[control] the same rollovers with Writer 2's moves delivered to the creator in order (nothing held)", false],
])(
	"%s",
	async (_name, held) => {
		const events: string[] = [];
		Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
			if (typeof event !== "object" || event === null) return;
			const kind = String(Reflect.get(event, "kind"));
			if (/retirement|maintenance|turnover|pool/u.test(kind))
				events.push(`${kind}:${String(Reflect.get(event, "epoch"))}:${String(Reflect.get(event, "outcome") ?? "")}`);
		});
		const fixture = await readinessHoldRoom({ writers: 2 });
		const creator = await fixture.open(0);
		const member = await fixture.open(1);
		const other = await fixture.open(2);
		const peers: ReadinessHoldPeer[] = [creator, member, other];
		const cursor = new Map<string, number | null>();
		const key = (from: number, to: number): string => `${from}->${to}`;
		const deliver = async (from: number, to: number): Promise<void> => {
			const rows = await fixture.publishedAfter(from, cursor.get(key(from, to)) ?? null);
			const receiver = required(peers[to]);
			for (let start = 0; start < rows.length; start += 16) {
				const chunk = rows.slice(start, start + 16);
				const last = chunk.findLastIndex((row) => !isControl(row));
				if (last >= 0) await receiver.receive(chunk.slice(0, last + 1), from).catch(() => undefined);
				receiver.inject(chunk.slice(last + 1), from);
			}
			if (rows.length !== 0) cursor.set(key(from, to), required(rows.at(-1)).commit.authorSequence);
		};
		const install = async (peer: ReadinessHoldPeer, index: number, epoch: number): Promise<string | undefined> => {
			try {
				const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, index);
				Reflect.set(peer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
				await peer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
				return peer.room.authority()?.epoch === epoch ? undefined : `epoch ${String(peer.room.authority()?.epoch)}`;
			} catch (error) {
				return explain(error);
			}
		};
		const seals: { epoch: number; ok: boolean; ms: number; attempts: number; error?: string }[] = [];
		const installFailures: string[] = [];
		for (let epoch = 0; epoch < EPOCHS; epoch++) {
			await creator.room.issue({ action: "placeBlock", id: `creator-${epoch}`, kind: "stone", x: 1, y: epoch });
			await deliver(0, 1);
			await deliver(0, 2);
			await member.room.issue({ action: "placeBlock", id: `member-${epoch}`, kind: "stone", x: 2, y: epoch });
			await deliver(1, 0);
			await deliver(1, 2);
			await other.room.issue({ action: "placeBlock", id: `other-a-${epoch}`, kind: "gold", x: 3, y: epoch });
			await other.room.issue({ action: "placeBlock", id: `other-b-${epoch}`, kind: "gold", x: 4, y: epoch });
			await deliver(2, 1);
			const otherRows = await fixture.publishedAfter(2, cursor.get(key(2, 0)) ?? null);
			const moves = otherRows.filter((row) => !isControl(row));
			const later = required(moves.at(-1));
			if (held) {
				creator.inject([later], 2);
				await sleep(400);
				expect(
					creator.accepted.has(Buffer.from(later.commit.envelope.digest).toString("hex")),
					"the creator holds the later move as pending ingress"
				).toBe(false);
				if (otherRows.length !== 0) cursor.set(key(2, 0), required(otherRows.at(-1)).commit.authorSequence);
			} else {
				await deliver(2, 0);
				await sleep(400);
			}
			// The creator's own seal; a failed close is retried as the room's rollover retry would.
			const started = performance.now();
			let attempts = 0;
			let error: string | undefined;
			let ok = false;
			while (attempts < 4 && !ok) {
				attempts++;
				try {
					const sealed = await creator.room.sealEpoch();
					ok = (sealed as { ok?: boolean }).ok === true;
					if (!ok) error = JSON.stringify(sealed).slice(0, 400);
				} catch (cause) {
					error = explain(cause);
					await sleep(1_000);
				}
			}
			seals.push({
				epoch,
				ok,
				ms: Math.round(performance.now() - started),
				attempts,
				...(error === undefined ? {} : { error }),
			});
			if (!ok) break;
			await creator.room.adoptCreatorSuccessor();
			for (const [peer, index] of [
				[member, 1],
				[other, 2],
			] as const) {
				const failure = await install(peer, index, epoch + 1);
				if (failure !== undefined) installFailures.push(`${epoch + 1}:${index}: ${failure}`);
			}
		}
		console.log(
			"CREATOR_SEAL_WITH_PENDING",
			JSON.stringify({ held, seals, installFailures, events: events.slice(-60) })
		);
		expect(
			seals.filter((row) => !row.ok).map((row) => `${row.epoch}: ${row.error ?? ""}`),
			"no creator seal is stopped by a pending ingress row"
		).toEqual([]);
		expect(seals.length, "the creator sealed every epoch").toBe(EPOCHS);
		expect(
			seals
				.filter((row) => row.attempts > 1)
				.map((row) => `${row.epoch}: ${row.attempts} attempts: ${row.error ?? ""}`),
			"no seal needed a retry"
		).toEqual([]);
	},
	1_200_000
);
