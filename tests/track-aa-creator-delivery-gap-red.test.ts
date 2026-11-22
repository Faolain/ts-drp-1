import { afterEach, describe, expect, it, vi } from "vitest";

import {
	creatorDeliveryRoom,
	envelopeVertex,
	historyRequestMessage,
	type Profile,
	sleep,
} from "./fixtures/track-aa/creator-delivery-room.js";
import { admitted, ingressWarnings, openAll, place, placedRows, SETTLE_MS } from "./fixtures/track-aa/scenario.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";

// The plane's ingress warnings (v3-live.ts `ingressFailureLog`) go to the console captured at
// module load. vi.hoisted runs before every import, so the recorder sees them.
const warnings = vi.hoisted(() => {
	const recorded: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]): void => {
		recorded.push(args);
		if (process.env.TRACK_AA_ECHO_WARN === "1") original(...args);
	};
	return recorded;
});

// Track AA RED (decision row 73), the creator's delivery gaps beyond a single refusal:
// - a creator blocked past the Writer's last scheduled retry (room-network.ts
//   RETAINED_REQUEST_DELAYS ends at 15 s): every scheduled republication meets the full
//   creator and nothing asks again;
// - a missing parent followed by dependents: the dependents are authenticated and held for
//   the missing parent, and the creator's missing-dependency request is a no-op
//   (room-network.ts `#requestMissing`; v3-room.ts documents "A no-op on the creator");
// - a repeated full replay of the Writer's retained history against a busy creator: the
//   duplicate prefix fills the 32-job input pool, so the missing tail is refused again in
//   every round and never makes progress.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PROFILES: readonly Profile[] = (process.env.TRACK_AA_PROFILES?.split(",") as Profile[] | undefined) ?? [
	"shipped",
	"settlement",
];
const TEST_TIMEOUT = 240_000;

describe.each(PROFILES)("Track AA RED, %s profile: creator delivery gaps", (profile) => {
	it(
		"a creator blocked past the Writer's last scheduled retry admits every Writer row once released",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const creator = await fixture.open(0);
			await sleep(SETTLE_MS);
			// The Writer opens now: its retained requests run at 0, 0.5, 1.5, 3, 6, 10 and 15 s.
			const writer = await fixture.open(1);
			const opened = Date.now();
			fixture.creatorGate.hold();
			const mark = warnings.length;
			const ids = await place(writer, "blocked", 40);
			await fixture.network.idle();
			// Hold the creator past the last scheduled retry (and let its copy arrive).
			await sleep(Math.max(0, opened + 16_500 - Date.now()));
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["admission-rejected"] ?? 0, "precondition: refusals").toBeGreaterThan(0);
			fixture.creatorGate.release();
			const rows = placedRows(fixture, writer, ids);
			const result = await admitted(
				creator,
				rows.map((row) => row.digest)
			);
			expect(result, `TRACK_AA_RED blocked: creator admitted ${result.count} of ${result.of}`).toMatchObject({
				complete: true,
			});
		},
		TEST_TIMEOUT
	);

	for (const transport of ["gossip", "direct"] as const)
		it(
			`a missing parent followed by ${transport} dependents: the creator asks the dependents' sender`,
			async () => {
				const fixture = await creatorDeliveryRoom({ profile });
				const [creator, writer] = await openAll(fixture);
				const creatorPeer = required(creator).peerId;
				const writerPeer = required(writer).peerId;
				// The parent never reaches the creator (lost, not refused: no capacity signal).
				const loseParent = fixture.network.lose(({ from, to }) => from === writerPeer && to === creatorPeer);
				const parent = await place(required(writer), "parent", 1);
				await fixture.network.idle();
				loseParent();
				if (transport === "direct")
					fixture.network.lose(({ kind, from, to }) => kind === "gossip" && from === writerPeer && to === creatorPeer);
				const mark = warnings.length;
				const dependents = await place(required(writer), "dependent", 3, 1);
				await fixture.network.idle();
				const rows = placedRows(fixture, required(writer), [...parent, ...dependents]);
				if (transport === "direct") {
					const writerNode = required(fixture.nodes.get(writerPeer));
					for (const row of rows.slice(1)) await writerNode.sendMessage(creatorPeer, row.message);
					await fixture.network.idle();
				}
				expect(ingressWarnings(warnings, mark)["graph-rejected"] ?? 0, "precondition: dependents held").toBeGreaterThan(
					0
				);
				const result = await admitted(
					required(creator),
					rows.map((row) => row.digest)
				);
				expect(
					result,
					`TRACK_AA_RED missing-parent-${transport}: creator admitted ${result.count} of ${result.of}`
				).toMatchObject({ complete: true });
			},
			TEST_TIMEOUT
		);

	it(
		"repeated full replay against a busy creator makes progress on the missing tail",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile, writers: 2 });
			const [creator, writer, other] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const writerPeer = required(writer).peerId;
			// The creator admits the Writer's first 35 rows; the last 5 are lost on the way to the
			// creator and to the other Writer (so that Writer's later moves do not depend on them).
			const tail = new Set(Array.from({ length: 5 }, (_, index) => `replay-${35 + index}`));
			const loseTail = fixture.network.lose(({ from, message }) => {
				const operation = envelopeVertex(message)?.operation as Readonly<Record<string, unknown>> | undefined;
				return from === writerPeer && typeof operation?.id === "string" && tail.has(operation.id);
			});
			const ids = await place(required(writer), "replay", 40);
			await fixture.network.idle();
			loseTail();
			const rows = placedRows(fixture, required(writer), ids);
			const digests = rows.map((row) => row.digest);
			const initial = await admitted(required(creator), digests.slice(0, 35));
			expect(initial.complete, "precondition: the prefix is admitted").toBe(true);
			const counts: number[] = [];
			for (let round = 0; round < 3; round++) {
				// The creator is busy: another Writer's move is in its FIFO.
				fixture.creatorGate.hold();
				const entered = fixture.creatorGate.entered;
				await place(required(other), `busy-${round}`, 1, 2 + round);
				await fixture.network.idle();
				await fixture.creatorGate.whenEntered(entered + 1);
				// The Writer's genuine retained republication of its whole journal to the creator,
				// asked for with the transport's existing request.
				await required(fixture.nodes.get(creatorPeer)).sendMessage(
					writerPeer,
					historyRequestMessage(fixture.objectId, creatorPeer)
				);
				await fixture.network.idle();
				await sleep(200);
				await fixture.network.idle();
				fixture.creatorGate.release();
				await admitted(required(creator), digests, 2_000);
				counts.push(digests.filter((digest) => required(creator).accepted.has(digest)).length);
			}
			expect(
				counts,
				`TRACK_AA_RED replay: Writer rows admitted after each replay round ${JSON.stringify(counts)} of ${digests.length}`
			).toEqual([40, 40, 40]);
		},
		TEST_TIMEOUT
	);
});
