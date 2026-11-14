/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";

// Fault injection at the creator close's role-transfer source (failed-close follow-ons): while
// armed, the sealed source acquisitions after `skip` more return the given primary refusal, as
// browser Grid's close did ("creator recovery role transfer source failed: ...SUBSTRATE_FAILURE" or
// "...internal-invariant"). Unarmed, it is the real acquisition.
// `onFail` runs as the refusal is returned (after `delayMs`), so a test can put concurrent work
// across the failed close.
type RoleSourceFault = {
	skip: number;
	fail: number;
	refusal: Readonly<Record<string, unknown>>;
	injected: number[];
	delayMs?: number;
	onFail?: () => void;
};
const roleSourceFault: { armed?: RoleSourceFault } = {};
vi.mock("../packages/node/src/internal/creator-closed-rollback-data.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../packages/node/src/internal/creator-closed-rollback-data.js")>();
	return {
		...original,
		acquireCreatorForwardPromotionSource: (async (...args: Parameters<typeof original.acquireCreatorForwardPromotionSource>) => {
			const fault = roleSourceFault.armed;
			if (fault !== undefined && args[2]?.sealed === true && fault.fail > 0) {
				if (fault.skip > 0) fault.skip--;
				else {
					fault.fail--;
					fault.injected.push(args[1]);
					fault.onFail?.();
					if (fault.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
					return Object.freeze({ ...fault.refusal });
				}
			}
			return original.acquireCreatorForwardPromotionSource(...args);
		}) as typeof original.acquireCreatorForwardPromotionSource,
	};
});
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import {
	type AppKind,
	fromBase64,
	type RecipientMode,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// App rollover policy: each shipped application rolls its own room over. Measured on native
// SQLite (app-rollover-ceiling-native.test.ts), one epoch admits at most 40 of the creator's own
// moves in Canvas and Grid (the creator's issuance image), and 14 of one author's short messages
// in Chat (its per-checkpoint allowance). Each case plays well past that ceiling per role with no
// harness seal: the creator's application policy must roll the room over by itself, every move
// must be accepted (none strands at the ceiling, none is lost), and both roles must converge on
// state that contains every accepted move. Successor offers travel by the pages' own delivery
// (examples/v3-room successor-delivery); the harness only carries rows and the delivery's frames.
const MOVES: Readonly<Record<AppKind, number>> = { canvas: 100, grid: 100, chat: 35 };
// Creator-only play has a receive-only recipient, except in Grid: its members are enrolled
// Writers (a receive-only recipient is not authorised to fetch Grid's successor material), so its
// creator-only case has a Writer that issues nothing.
type Recipient = RecipientMode | "silent-writer";
const cases: readonly (readonly [AppKind, Recipient])[] = [
	["canvas", "receive-only"],
	["canvas", "writer"],
	["chat", "receive-only"],
	["chat", "writer"],
	["grid", "silent-writer"],
	["grid", "writer"],
];

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const rowValue = (row: WireRow) =>
	decodeCanonical(fromBase64(row.preimage)) as { epoch: number; operation: { action: string } };

async function openApp(
	app: AppKind,
	recipient: RecipientMode,
	rolloverBudget?: Readonly<{ movesPerAuthor: number; idleMs: number }>
) {
	const directory = mkdtempSync(join(tmpdir(), `app-rollover-${app}-`));
	directories.push(directory);
	const options = {
		app,
		host: "node" as const,
		recipient,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
		...(rolloverBudget === undefined ? {} : { rolloverBudget }),
	};
	const env = {
		host: nodeHostFor("node", directory),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: "create" as const },
			}),
	};
	const creator = await openRole(options, 0, env);
	const other = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
	return [creator, other] as const satisfies readonly [RoleEndpoint, RoleEndpoint];
}

/**
 * Plays `moves` per role (alternating, the creator first) with no harness seal. The creator's
 * delivery announces each adopted offer and the member's delivery installs it; the harness wire
 * carries their frames in the background, concurrent with play (a Writer's move refused at
 * capacity waits for that install), and the harness carries every published row in the receiver's
 * epoch. It then checks that every move was accepted, both roles
 * converged, and the state holds every accepted move.
 * @param app - The application.
 * @param recipient - The other role.
 * @param moves - Moves per role.
 * @param rolloverBudget - Test-only trigger values replacing the application's.
 * @param creatorMoves - Which ordinals the creator moves at (default every one); a sparser creator makes a
 * Writer the hot author. Its rows carry admission evidence of the Writer's moves (their causal past).
 * @returns The creator's policy observation.
 */
async function playPastCeiling(
	app: AppKind,
	recipient: Recipient,
	moves: number,
	rolloverBudget?: Readonly<{ movesPerAuthor: number; idleMs: number }>,
	creatorMoves: (ordinal: number) => boolean = () => true,
	toleratedErrors?: RegExp,
	// A burst of creator moves outside the sequential loop (as a page's placements and moves keep
	// coming), started when `arm`'s callback runs: `count` moves, one every `everyMs`, not awaited
	// one by one. Every one must be accepted.
	burst?: Readonly<{
		count: number;
		everyMs: number;
		// `room` issues one creator move straight to the room (past the policy, as its own re-offer
		// does) and `track` counts a move like a burst move: accepted, or a recorded error.
		arm: (
			start: () => void,
			room: Readonly<{ issue: (ordinal: number) => Promise<unknown>; track: (ordinal: number, move: Promise<unknown>) => void }>
		) => void;
	}>
) {
	const peers = await openApp(app, recipient === "receive-only" ? "receive-only" : "writer", rolloverBudget);
	const [creator, other] = peers;
	const burstMoves: Promise<void>[] = [];
	const burstErrors: string[] = [];
	const track = (ordinal: number, move: Promise<unknown>): void => {
		burstMoves.push(
			move.then(
				() => void accepted.push({ role: 0, ordinal }),
				(error: unknown) => void burstErrors.push(`${ordinal}: ${error instanceof Error ? error.message : String(error)}`)
			)
		);
	};
	burst?.arm(
		() => {
			for (let index = 0; index < burst.count; index++) {
				const ordinal = 100_000 + index;
				track(ordinal, new Promise((resolve) => setTimeout(resolve, index * burst.everyMs)).then(() => creator.issue(0, ordinal)));
			}
		},
		{ issue: (ordinal) => creator.issueRoom(0, ordinal), track }
	);
	const writer = recipient === "writer";
	const delivered: (number | null)[] = [null, null];
	const wire = successorWire(() => peers);
	// Every new row of `from` in the receiver's current epoch, then a bounded wait for the last
	// one's acceptance. Rows of an earlier epoch are not delivered, and a row the receiver does not
	// accept is not retried here: a Writer's row the creator closed its epoch without is replaced
	// by the Writer's settlement once it installs the successor. The final state check is what
	// proves no accepted move was lost.
	const deliver = async (from: 0 | 1): Promise<void> => {
		const published = await peers[from].published(delivered[from]);
		const receiver = peers[from === 0 ? 1 : 0];
		const current = (await receiver.authorityEpoch()) ?? 0;
		// A row of an epoch the receiver has not installed yet waits for that install.
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		const last = rows.at(-1);
		if (last === undefined) return;
		const live = rows.filter((row) => rowValue(row).epoch === current);
		delivered[from] = last.authorSequence;
		if (live.length === 0) return;
		await receiver.inject(live);
		// Control rows ($drp.*) are not application acceptance; join the last ordinary move.
		const final = live.findLast((row) => !rowValue(row).operation.action.startsWith("$drp."));
		if (final === undefined) return;
		for (const deadline = performance.now() + 5_000; performance.now() < deadline; ) {
			if ((await receiver.acceptance([final.digest]))[0] === true) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	// Like a room's sync after a reconnect: rows of the receiver's current epoch that it has not
	// accepted (a row injected while its install was replacing the live plane is dropped) are
	// offered again.
	const redeliver = async (from: 0 | 1): Promise<void> => {
		const receiver = peers[from === 0 ? 1 : 0];
		const current = (await receiver.authorityEpoch()) ?? 0;
		const rows = (await peers[from].published(null)).filter((row) => rowValue(row).epoch === current);
		if (rows.length === 0) return;
		const known = await receiver.acceptance(rows.map((row) => row.digest));
		const missing = rows.filter(
			(row, index) => known[index] !== true && !rowValue(row).operation.action.startsWith("$drp.")
		);
		const final = missing.at(-1);
		if (final === undefined) return;
		await receiver.inject(rows);
		for (const deadline = performance.now() + 5_000; performance.now() < deadline; ) {
			if ((await receiver.acceptance([final.digest]))[0] === true) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const accepted: { role: number; ordinal: number }[] = [];
	// A stalled run says where it stands (which role's move, and each policy's view).
	let step = "open";
	const watchdog = setInterval(() => {
		void Promise.all([creator.rollover?.(), other.rollover?.(), other.authorityEpoch()]).then(([own, member, epoch]) =>
			process.stdout.write(
				`ROLLOVER_PROGRESS ${app}/${recipient} step=${step} creator=${JSON.stringify({ epoch: own?.epoch, rollovers: own?.rollovers, waiting: own?.waiting, errors: own?.errors })} member=${JSON.stringify({ epoch, waiting: member?.waiting })}\n`
			)
		);
	}, 30_000);
	try {
		for (let ordinal = 0; ordinal < moves; ordinal++) {
			if (creatorMoves(ordinal)) {
				step = `creator#${ordinal}`;
				await creator.issue(0, ordinal);
				accepted.push({ role: 0, ordinal });
				await deliver(0);
			}
			// The member's own rows go to the creator even when it makes no move: each install
			// publishes the member's settlement of the epoch it leaves.
			await deliver(1);
			if (!writer) continue;
			step = `writer#${ordinal}`;
			await other.issue(0, ordinal);
			accepted.push({ role: 1, ordinal });
			await deliver(1);
		}
		step = "burst";
		await Promise.all(burstMoves);
		// Quiesce: the last rollover joins, its offer is installed, and every row is delivered.
		step = "quiesce";
		for (let round = 0; round < 4; round++) {
			await wire.caughtUp((await creator.rollover?.())?.epoch ?? 0);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await deliver(0);
			await deliver(1);
			await redeliver(0);
			await redeliver(1);
		}
	} finally {
		clearInterval(watchdog);
		await wire.stop();
	}
	const policy = await creator.rollover?.();
	const member = await other.rollover?.();
	process.stdout.write(
		`ROLLOVER_EVENTS ${app}/${recipient} moves=${moves} ${JSON.stringify(policy?.events.map((event) => [event.epoch, event.trigger, event.moves, Math.round(event.ms)]))}\n`
	);
	const delivery = await other.successorDelivery?.();
	process.stdout.write(`ROLLOVER_DELIVERY ${app}/${recipient} ${JSON.stringify(delivery)}\n`);
	if (burst !== undefined) process.stdout.write(`ROLLOVER_BURST ${app}/${recipient} ${JSON.stringify({ moves: burstMoves.length, errors: burstErrors })}\n`);
	expect(burstErrors, "every concurrent creator move is accepted").toEqual([]);
	expect(delivery?.installed ?? 0, "the member's own delivery installed the successors").toBeGreaterThan(0);
	expect((policy?.errors ?? ["no creator policy"]).filter((error) => toleratedErrors?.test(error) !== true)).toEqual([]);
	expect(member?.waiting ?? 0).toBe(0);
	expect(await other.authorityEpoch()).toBe(policy?.epoch);
	const [left, right] = [await creator.state(), await other.state()];
	expect(left).toBe(right);
	const state = decodeCanonical(Uint8Array.from(Buffer.from(left, "hex"))) as {
		counters?: number[][];
		blocks?: { id: string; x: number }[];
		messages?: { clientOperationId: string }[];
	};
	if (app === "canvas")
		expect(state.counters?.reduce((sum, rgb) => sum + (rgb[0] ?? 0), 0)).toBe(
			accepted.reduce((sum, row) => sum + 1 + row.role, 0)
		);
	else if (app === "grid")
		expect(state.blocks?.map((block) => block.id).sort()).toEqual(
			accepted.map((row) => `block-${row.role}-${row.ordinal}`).sort()
		);
	else
		expect(new Set(state.messages?.map((message) => message.clientOperationId))).toEqual(
			new Set(accepted.map((row) => `m-${row.role}-0-${row.ordinal}`))
		);
	for (const audit of [await creator.settlementAudit(), await other.settlementAudit()])
		expect(audit.missing).toEqual([]);
	return policy;
}

it.each(cases)(
	"%s with a %s recipient: the application rolls its own room over past the ceiling and loses no move",
	async (app, recipient) => {
		const restore = await installEnvironment("node", () => undefined);
		try {
			const policy = await playPastCeiling(app, recipient, MOVES[app]);
			expect(policy?.rollovers ?? 0).toBeGreaterThanOrEqual(3);
			// The budget is safely under every epoch's ceiling: no move ever met a capacity refusal.
			expect(policy?.events.filter((event) => event.trigger === "refusal")).toEqual([]);
		} finally {
			restore();
		}
	},
	1_200_000
);

// Failed-close follow-ons (browser Grid sg3/sg5, .logs/realtime-resume-2026-11-10/netreuse): one
// creator close fails at its role-transfer source. The session's own interrupted-close retry must
// then seal and adopt, and the room must continue with nothing lost: every later move of both roles
// is accepted (no "creator issuance maintenance authority is unavailable", no
// MAINTENANCE_POST_ADOPTION_CENSUS_UNAVAILABLE, no "creator recovery dependency hold unavailable"),
// later closes succeed, and both roles converge on every accepted move. The only tolerated policy
// error is the injected close failure itself.
it.each([
	["SUBSTRATE_FAILURE", { ok: false, kind: "ahe-rejected", cause: { owner: "ahe", reason: "SUBSTRATE_FAILURE" } }],
	["internal-invariant", { ok: false, kind: "internal-invariant" }],
] as const)(
	"grid with a writer: a creator close that fails at its role-transfer source (%s) is retried, and play continues with no move lost",
	async (_name, refusal) => {
		const restore = await installEnvironment("node", () => undefined);
		// Two sealed acquisitions pass (the first closes), the next one fails once.
		const fault: RoleSourceFault = { skip: 2, fail: 1, refusal, injected: [] };
		roleSourceFault.armed = fault;
		try {
			const policy = await playPastCeiling(
				"grid",
				"writer",
				Number(process.env.FAILED_CLOSE_MOVES ?? 100),
				undefined,
				undefined,
				/role transfer source failed|promotion source failed/u
			);
			process.stdout.write(`FAILED_CLOSE_FAULT ${JSON.stringify({ injected: fault.injected, errors: policy?.errors })}\n`);
			expect(fault.injected, "the fault fired in a close").toHaveLength(1);
			expect(policy?.rollovers ?? 0).toBeGreaterThanOrEqual(3);
		} finally {
			roleSourceFault.armed = undefined;
			restore();
		}
	},
	1_200_000
);

// The same failed close with creator moves still coming (browser Grid places a block every 400 ms
// and moves every 100 ms through the policy; sg5-pub-4, sg5b-pub-5 and sf1-base-2 each stopped play
// on a placement refused with "creator issuance maintenance authority is unavailable" about a second
// after such a close). A burst of creator moves spans the failure, the session's retry (250 ms
// later) and its adoption; every move must be accepted.
it.each([
	["SUBSTRATE_FAILURE", { ok: false, kind: "ahe-rejected", cause: { owner: "ahe", reason: "SUBSTRATE_FAILURE" } }, 25],
	["internal-invariant", { ok: false, kind: "internal-invariant" }, 10],
] as const)(
	"grid with a writer: creator moves that overlap a failed close (%s) and its retry are all accepted",
	async (_name, refusal, everyMs) => {
		const restore = await installEnvironment("node", () => undefined);
		const fault: RoleSourceFault = { skip: 2, fail: 1, refusal, injected: [], delayMs: 30 };
		roleSourceFault.armed = fault;
		try {
			const policy = await playPastCeiling(
				"grid",
				"writer",
				Number(process.env.FAILED_CLOSE_MOVES ?? 60),
				undefined,
				undefined,
				/role transfer source failed|promotion source failed/u,
				{ count: Number(process.env.FAILED_CLOSE_BURST ?? 60), everyMs, arm: (start) => (fault.onFail = start) }
			);
			process.stdout.write(`FAILED_CLOSE_FAULT ${JSON.stringify({ injected: fault.injected, errors: policy?.errors })}\n`);
			expect(fault.injected, "the fault fired in a close").toHaveLength(1);
		} finally {
			roleSourceFault.armed = undefined;
			restore();
		}
	},
	1_200_000
);

// The play-stopping follow-on, pinned (browser diag dd250ea4, fcd1 4/4: "creator issuance
// maintenance authority is unavailable [jobs=1,pending=false,kind=local-issuance]" in the epoch the
// retry adopted). After a failed close the session's own retry seals and adopts without the policy,
// whose moves wait only across its own rollover. A creator move made right after the failure is
// refused close-pending and waits for the epoch; it is offered again as soon as the retried
// adoption exposes the successor, while that adoption's ordinary readiness job still holds the
// creator's maintenance consumer (held open here by the test seam for 3 s). It must be accepted.
it("grid with a writer: a creator move refused close-pending and offered again while the retried adoption prepares readiness is accepted", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const fault: RoleSourceFault = {
		skip: 2,
		fail: 1,
		refusal: { ok: false, kind: "ahe-rejected", cause: { owner: "ahe", reason: "SUBSTRATE_FAILURE" } },
		injected: [],
	};
	roleSourceFault.armed = fault;
	const seam = globalThis as { __creatorOrdinaryReadinessHold?: (epoch: number) => Promise<void> };
	const heldEpochs: number[] = [];
	let firstOffer = "not made";
	try {
		const policy = await playPastCeiling(
			"grid",
			"writer",
			Number(process.env.FAILED_CLOSE_MOVES ?? 60),
			undefined,
			undefined,
			/role transfer source failed|promotion source failed/u,
			{
				count: 0,
				everyMs: 0,
				// The policy's own re-offer, made straight to the room: natively the policy's next
				// rollover joins the slower retry and its cut would hold the move, which the browser's
				// faster retry does not.
				arm: (_start, room) => {
					const ordinal = 200_000;
					fault.onFail = () => {
						// Once the failed close set its close-pending gate: the first offer is refused.
						setTimeout(() => {
							room.issue(ordinal).then(
								() => (firstOffer = "accepted"),
								(error: unknown) => (firstOffer = error instanceof Error ? error.message : String(error))
							);
						}, 50);
						// Only the first readiness after the failure: the retried close's adoption. The
						// move is offered again inside it, with the successor exposed.
						seam.__creatorOrdinaryReadinessHold = (epoch) => {
							delete seam.__creatorOrdinaryReadinessHold;
							heldEpochs.push(epoch);
							room.track(ordinal, room.issue(ordinal));
							return new Promise((resolve) => setTimeout(resolve, 3_000));
						};
					};
				},
			}
		);
		process.stdout.write(`FAILED_CLOSE_FAULT ${JSON.stringify({ injected: fault.injected, heldEpochs, firstOffer, errors: policy?.errors })}\n`);
		expect(fault.injected, "the fault fired in a close").toHaveLength(1);
		expect(firstOffer, "the first offer met the close-pending gate").toMatch(/close-pending/u);
		expect(heldEpochs, "the retried adoption's readiness was held").toHaveLength(1);
	} finally {
		roleSourceFault.armed = undefined;
		delete seam.__creatorOrdinaryReadinessHold;
		restore();
	}
}, 1_200_000);

// Failed-close follow-on (census): browser Grid with the readiness fix, after a forced role-transfer
// failure, failed the retried adoption terminally ("v3 room settlement issue failed: ... creator
// issuance maintenance prefix sizing is unavailable: MAINTENANCE_POST_ADOPTION_CENSUS_UNAVAILABLE",
// diag 75cebd40: the census resolver's settlement preview was stale). The session's retry adopts
// without the policy's cut, so the app keeps issuing; each creator move allocates the room's next
// logical time as it passes the barriers, even when the adoption then holds it. The adoption's epoch
// fence sizes its post-adoption census with the room's settlement preview, which carries that clock,
// and re-checks it after host turns. A creator move made inside that window (held open here by the
// test seam at the first fence quote after the failure) must not fail the adoption.
it("grid with a writer: a creator move made while the retried adoption sizes its epoch fence leaves the adoption and the move accepted", async () => {
	// The successor fence clock each census preview saw, and the clock each fence was issued with.
	const previews: { key: string; at: number }[] = [];
	const fences = new Map<string, number>();
	const restore = await installEnvironment("node", (event) => {
		if (event.kind === "successor-settlement-preview")
			previews.push({ key: `${String(event.author)}@${String(event.successorEpoch)}`, at: event.fenceLogicalTime as number });
		if (event.kind === "author-fence-issued")
			fences.set(`${String(event.author)}@${String(event.epoch)}`, event.logicalTime as number);
	});
	const fault: RoleSourceFault = {
		skip: 2,
		fail: 1,
		refusal: { ok: false, kind: "ahe-rejected", cause: { owner: "ahe", reason: "SUBSTRATE_FAILURE" } },
		injected: [],
	};
	roleSourceFault.armed = fault;
	const seam = globalThis as { __creatorFenceQuoteHold?: (epoch: number) => Promise<void> };
	const heldEpochs: number[] = [];
	try {
		const policy = await playPastCeiling(
			"grid",
			"writer",
			Number(process.env.FAILED_CLOSE_MOVES ?? 60),
			undefined,
			undefined,
			/role transfer source failed|promotion source failed/u,
			{
				count: 0,
				everyMs: 0,
				arm: (_start, room) => {
					fault.onFail = () => {
						// Only the first fence quote after the failure: the retried adoption's epoch fence.
						seam.__creatorFenceQuoteHold = (epoch) => {
							delete seam.__creatorFenceQuoteHold;
							heldEpochs.push(epoch);
							room.track(300_000, room.issue(300_000));
							return new Promise((resolve) => setTimeout(resolve, 500));
						};
					};
				},
			}
		);
		process.stdout.write(`FAILED_CLOSE_FENCE ${JSON.stringify({ injected: fault.injected, heldEpochs, errors: policy?.errors })}\n`);
		expect(fault.injected, "the fault fired in a close").toHaveLength(1);
		expect(heldEpochs, "the retried adoption's fence quote was held").toHaveLength(1);
		// No issued fence takes a clock below one previewed for it: the census charges the clock
		// at full width, and the fence takes the room's current (monotonic) clock.
		const compared = previews.filter((preview) => fences.has(preview.key));
		process.stdout.write(`FAILED_CLOSE_FENCE_CLOCKS ${JSON.stringify({ previews: previews.length, compared: compared.length,
			below: compared.filter((preview) => (fences.get(preview.key) ?? 0) < preview.at) })}\n`);
		expect(compared.length, "previewed fences that were issued").toBeGreaterThan(0);
		for (const preview of compared)
			expect(fences.get(preview.key), `fence clock ${preview.key}`).toBeGreaterThanOrEqual(preview.at);
	} finally {
		roleSourceFault.armed = undefined;
		delete seam.__creatorFenceQuoteHold;
		restore();
	}
}, 1_200_000);

// The refusal path: with trigger values too high to fire, the creator's move at the native
// ceiling (Canvas: the 169th since fix/maintenance-image-capacity; the 41st before, when the next
// two epochs then admitted none) or at Chat's allowance (the 15th short message, for the creator and
// for a Writer, who cannot seal and waits for the next installed epoch) is refused, rolled over
// and offered again, and is accepted.
it.each([
	["canvas", "receive-only", 200],
	["chat", "writer", 25],
] as const)(
	"%s with a %s recipient: a move refused at the ceiling is accepted after the rollover it triggers",
	async (app, recipient, moves) => {
		const restore = await installEnvironment("node", () => undefined);
		try {
			const policy = await playPastCeiling(app, recipient, moves, { movesPerAuthor: 10_000, idleMs: 3_600_000 });
			expect(policy?.events.map((event) => event.trigger)).toContain("refusal");
			expect(policy?.events.every((event) => event.trigger === "refusal")).toBe(true);
		} finally {
			restore();
		}
	},
	1_200_000
);

// The received-move refusal path (liveness (a)/(b)) needs several Writers' combined load: see
// app-rollover-received-refusal-native.test.ts. One hot Writer reaches its own settlement reserve
// first (the next case).

// Writer-side admission and maintenance agree (fix/maintenance-image-capacity): a hot Writer's
// moves the creator closed an epoch without are replaced at the successor's install, under the
// Writer's own issuance row and byte bound. At about 505 moves the Writer admitted moves whose
// replacements its store then refused (row bound) inside the install's drainRebaseOutbox, so it
// never installed. Its admission must reserve one replacement per own move of the epoch and refuse
// (typed, retry after rollover) otherwise; then every admitted move settles. The Writer cannot seal:
// its refused move waits for the creator's next rollover (a received refusal, or the idle timer).
it("grid with a hot writer: no admitted move's settlement is refused by the Writer's own store", async () => {
	const restore = await installEnvironment("node", () => undefined);
	try {
		// 700: past the deadlock (about writer move 505 without the reserve) and under the grid
		// state's canonical bound (each move adds a block; about 900 blocks exceed it).
		const writerMoves = Number(process.env.HOT_WRITER_SETTLEMENT_MOVES ?? 700);
		// The creator moves every 8 Writer moves (admission evidence, as an online room has).
		const creatorEvery = Number(process.env.HOT_WRITER_CREATOR_EVERY ?? 8);
		const policy = await playPastCeiling("grid", "writer", writerMoves, { movesPerAuthor: 100_000, idleMs: 20_000 },
			(ordinal) => ordinal % creatorEvery === 0);
		process.stdout.write(`HOT_WRITER_SETTLEMENT ${JSON.stringify({ writerMoves, creatorEvery, rollovers: policy?.rollovers,
			triggers: policy?.events.map((event) => event.trigger) })}\n`);
	} finally {
		restore();
	}
}, 3_600_000);
