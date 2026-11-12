import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { createOutcomeCommitAdmissionPolicy } from "@ts-drp/outcome-commit";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// Measurement (room state limit, finding B): the admission-time state bound's cost per move and how
// often it falls back to refolding the epoch, on each admission path (creator issue, creator ingress,
// Writer local issue, Writer ingress), at application states of about 8, 16 and 32 KiB.
//
// Two delivery modes per state size. "sequenced": every move is delivered before the next one is
// issued, so each move depends on every tip (the running fold plus one apply). "concurrent": the
// creator and the Writer each issue a move before exchanging them, so each received move is
// concurrent with the receiver's own and does not sort last (the refold fallback).

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const ID_BYTES = Number(process.env.STATE_BOUND_ID_BYTES ?? 200);
const ROUNDS = Number(process.env.STATE_BOUND_ROUNDS ?? 8);
const MEASURE_EPOCHS = Number(process.env.STATE_BOUND_MEASURE_EPOCHS ?? 6);
const TARGETS = [8192, 16_384, 32_768 - 2 * (ID_BYTES + 64)];

type BoundEvent = {
	path: "local" | "received";
	refolded: boolean;
	admitted: boolean;
	sortsLast: boolean;
	durationUs: number;
	stateBytes?: number;
};
type Sample = BoundEvent & { site: string; phase: string };

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((left, right) => left - right);
	return required(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]);
}

it("the state bound's per-move cost and refold rate, per admission path and state size", async () => {
	const fixture = await readinessHoldRoom({
		writers: 1,
		createOperationAdmissionPolicy: ((context: Record<string, unknown>) =>
			createOutcomeCommitAdmissionPolicy({
				aclDigest: context.aclDigest as string,
				anchorDigest: context.anchorDigest as string,
				epoch: context.epoch as number,
				objectId: context.objectId as string,
				maxEntries: 8192,
				...(context.maxApplicationStateBytes === undefined
					? {}
					: { maxApplicationStateBytes: context.maxApplicationStateBytes as number }),
				...(context.authenticatedApplicationStateBytes === undefined
					? {}
					: { authenticatedApplicationStateBytes: context.authenticatedApplicationStateBytes as Uint8Array }),
			})) as never,
	});
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	const samples: Sample[] = [];
	let site = "none";
	let phase = "grow";
	let stateBytes = 0;
	const previous = Reflect.get(globalThis, "__warmProofEvent");
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event.kind === "application-state-bound") {
			const bound = event as unknown as BoundEvent;
			samples.push({ ...bound, site, phase });
			if (bound.admitted && bound.stateBytes !== undefined && site === "creator-issue") stateBytes = bound.stateBytes;
		}
		if (typeof previous === "function") previous(event);
	});
	const delivered: (number | null)[] = [null, null];
	const deliver = async (from: number, to: typeof creator, label: string): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(from, delivered[from] ?? null);
		site = label;
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await to.receive(chunk.slice(0, last + 1), from);
			to.inject(chunk.slice(last + 1), from);
		}
		if (rows.length !== 0) delivered[from] = required(rows.at(-1)).commit.authorSequence;
		site = "none";
	};
	const ordinals = [0, 0];
	let refusal: string | undefined;
	const move = (index: number, grow: boolean, epoch: number) => {
		const ordinal = required(ordinals[index]);
		const id = grow
			? `${index}-${String(ordinal).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`
			: `${index}-${String(epoch % 4).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`;
		// A re-placed block keeps its cell and toggles its kind, so the state never grows.
		return { action: "placeBlock", id, kind: grow || epoch % 2 === 0 ? "stone" : "gold", x: grow ? ordinal % 16 : epoch % 4, y: 0 };
	};
	const issue = async (index: number, room: typeof creator, grow: boolean, epoch: number): Promise<void> => {
		site = index === 0 ? "creator-issue" : "writer-issue";
		try {
			await room.room.issue(move(index, grow, epoch));
			if (grow) ordinals[index] = required(ordinals[index]) + 1;
		} catch (error) {
			refusal ??= explain(error);
		} finally {
			site = "none";
		}
	};
	let epoch = 0;
	const rollover = async (): Promise<void> => {
		await deliver(1, creator, "creator-ingress");
		await deliver(0, writer, "writer-ingress");
		site = "seal";
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		site = "none";
		epoch++;
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const runEpoch = async (grow: boolean, concurrent: boolean): Promise<void> => {
		for (let round = 0; round < ROUNDS; round++) {
			if (grow && refusal !== undefined) break;
			if (concurrent) {
				await issue(0, creator, grow, epoch);
				await issue(1, writer, grow, epoch);
				await deliver(0, writer, "writer-ingress");
				await deliver(1, creator, "creator-ingress");
			} else {
				await issue(0, creator, grow, epoch);
				await deliver(0, writer, "writer-ingress");
				await issue(1, writer, grow, epoch);
				await deliver(1, creator, "creator-ingress");
			}
		}
		await rollover();
	};
	for (const target of TARGETS) {
		phase = "grow";
		while (stateBytes < target && refusal === undefined) await runEpoch(true, false);
		const at = stateBytes;
		for (const mode of ["sequenced", "concurrent"] as const) {
			phase = `${mode}@${at}`;
			for (let count = 0; count < MEASURE_EPOCHS; count++) await runEpoch(false, mode === "concurrent");
		}
	}
	const summary: Record<string, unknown>[] = [];
	const groups = new Map<string, Sample[]>();
	for (const sample of samples) {
		if (sample.phase === "grow" || sample.site === "none" || sample.site === "seal") continue;
		const key = `${sample.phase} ${sample.site}`;
		groups.set(key, [...(groups.get(key) ?? []), sample]);
	}
	for (const [key, group] of groups) {
		const fast = group.filter((sample) => !sample.refolded).map((sample) => sample.durationUs);
		const all = group.map((sample) => sample.durationUs);
		summary.push({
			key,
			count: group.length,
			refolds: group.filter((sample) => sample.refolded).length,
			sortsLast: group.filter((sample) => sample.sortsLast).length,
			p50Us: percentile(all, 0.5),
			p95Us: percentile(all, 0.95),
			maxUs: Math.max(...all),
			fastP50Us: percentile(fast, 0.5),
			fastP95Us: percentile(fast, 0.95),
			stateBytes: Math.max(...group.map((sample) => sample.stateBytes ?? 0)),
		});
	}
	const growth = samples.filter((sample) => sample.phase === "grow" && sample.site !== "none");
	console.log(
		`STATE_BOUND_COST ${JSON.stringify({
			idBytes: ID_BYTES,
			rounds: ROUNDS,
			epochs: epoch,
			refusal,
			growth: {
				count: growth.length,
				refolds: growth.filter((sample) => sample.refolded).length,
				bySite: Object.fromEntries(
					["creator-issue", "creator-ingress", "writer-issue", "writer-ingress"].map((name) => {
						const rows = growth.filter((sample) => sample.site === name);
						return [name, { count: rows.length, refolds: rows.filter((sample) => sample.refolded).length }];
					})
				),
			},
			summary,
		})}`
	);
	expect(refusal, "growth stops at the room's limit with the typed refusal").toMatch(/application state limit/u);
	expect(summary.length).toBeGreaterThan(0);
}, 3_600_000);
