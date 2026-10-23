import { MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, it } from "vitest";

import { creatorDeliveryRoom, envelopeVertex, type Profile } from "./fixtures/track-aa/creator-delivery-room.js";
import { admitted, openAll, place, placedRows } from "./fixtures/track-aa/scenario.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
});

const PROFILES: readonly Profile[] = ["shipped", "settlement"];
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");

describe.each(PROFILES)("Track AA lost repair answer, %s", (profile) => {
	for (const direction of ["writer-to-creator", "creator-to-writer"] as const)
		it(`recovers a silently lost first and final copy ${direction} without a refusal or later move`, async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const peers = await openAll(fixture);
			const sender = required(peers[direction === "writer-to-creator" ? 1 : 0]);
			const receiver = required(peers[direction === "writer-to-creator" ? 0 : 1]);
			await fixture.network.idle();
			let lost = 0;
			let requests = 0;
			fixture.network.observe(({ from, to, message }) => {
				if (
					from === receiver.peerId &&
					to === sender.peerId &&
					message.type === MessageType.MESSAGE_TYPE_CUSTOM &&
					message.data.length === HISTORY_REQUEST.length &&
					message.data.every((byte, index) => byte === HISTORY_REQUEST[index])
				)
					requests++;
			});
			fixture.network.lose(({ kind, from, to, message }) => {
				const operation = envelopeVertex(message)?.operation as { id?: string } | undefined;
				if (kind !== "gossip" || from !== sender.peerId || to !== receiver.peerId || operation?.id !== "silent-final-0")
					return false;
				lost++;
				return true;
			});
			const started = performance.now();
			const ids = await place(sender, "silent-final", 1);
			await fixture.network.idle();
			const rows = placedRows(fixture, sender, ids);
			const result = await admitted(
				receiver,
				rows.map(({ digest }) => digest),
				12_000
			);
			expect(lost).toBeGreaterThan(0);
			expect(requests, "periodic repair needs no observed gap").toBeGreaterThan(0);
			expect(result).toMatchObject({ complete: true });
			console.info(
				`TRACK_AA_SILENT ${JSON.stringify({ profile, direction, ms: Math.round(performance.now() - started), requests })}`
			);
		}, 90_000);

	for (const gap of ["refused", "missing"] as const)
		it(`retries a lost final answer for a ${gap} row without later traffic`, async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const [creatorValue, writerValue] = await openAll(fixture);
			const creator = required(creatorValue);
			const writer = required(writerValue);
			let requests = 0;
			let lostAnswers = 0;
			fixture.network.observe(({ from, to, message }) => {
				if (
					from === creator.peerId &&
					to === writer.peerId &&
					message.type === MessageType.MESSAGE_TYPE_CUSTOM &&
					message.data.length === HISTORY_REQUEST.length &&
					message.data.every((byte, index) => byte === HISTORY_REQUEST[index])
				)
					requests++;
			});
			// The request send succeeds, but every row in its first answer is lost. Only
			// a subsequent repair request permits the answer through; no new move wakes it.
			fixture.network.lose(({ kind, from, to, message }) => {
				if (
					kind !== "direct" ||
					from !== writer.peerId ||
					to !== creator.peerId ||
					message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE ||
					requests !== 1
				)
					return false;
				lostAnswers++;
				return true;
			});
			let ids: string[];
			if (gap === "refused") {
				fixture.creatorGate.hold();
				ids = await place(writer, "lost-answer", 40);
				await fixture.network.idle();
				fixture.creatorGate.release();
			} else {
				const allowParent = fixture.network.lose(({ kind, from, to, message }) => {
					const operation = envelopeVertex(message)?.operation as { id?: string } | undefined;
					return (
						kind === "gossip" && from === writer.peerId && to === creator.peerId && operation?.id === "lost-parent-0"
					);
				});
				ids = await place(writer, "lost-parent", 1);
				await fixture.network.idle();
				allowParent();
				ids.push(...(await place(writer, "held-dependent", 1, 1)));
			}
			await fixture.network.idle();
			const rows = placedRows(fixture, writer, ids);
			const result = await admitted(
				creator,
				rows.map(({ digest }) => digest),
				12_000
			);
			expect(lostAnswers, "the first repair answer was lost after send success").toBeGreaterThan(0);
			expect(requests, "a later request repairs the quiet connection").toBeGreaterThan(1);
			expect(result).toMatchObject({ complete: true });
		}, 90_000);
});
