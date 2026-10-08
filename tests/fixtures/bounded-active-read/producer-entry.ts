import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
} from "@ts-drp/storage";

import { database, done, environment, request } from "./browser-owner.js";
import { assertNativeSelectedRead, check, LIMITS } from "./contract.js";
import { bootstrap, message, openRoom } from "../startup-discovery/room.js";

async function census(identity: string, objectId: string): Promise<Record<string, unknown>> {
	const db = await database(identity + "--ahe");
	try {
		const tx = db.transaction(["objects", "generations"], "readonly"),
			terminal = done(tx);
		const [headRow, rows] = await Promise.all([
			request(tx.objectStore("objects").get(objectId)),
			request(tx.objectStore("generations").getAll()),
		]);
		await terminal;
		const head = decodeHeadRecordV1(headRow.record);
		check(head.ok && head.value.kind === "present", "genuine head native row");
		const records = rows
			.filter((r: { objectId: string }) => r.objectId === objectId)
			.map((r: { record: Uint8Array }) => {
				const result = decodeGenerationRecordV1(r.record);
				check(result.ok, "genuine native metadata canonical");
				return result.value;
			});
		check(records.filter((r) => r.state === "Adopted").length === 1, "genuine exactly one adopted");
		return { count: records.length, head: head.value, records };
	} finally {
		db.close();
	}
}
Object.assign(globalThis, {
	boundedAheProducer: async (identity: string, settlement: boolean): Promise<unknown> => {
		const b = await bootstrap(identity, settlement ? "creator-trusted-settlement-v1" : "creator-trusted-v1"),
			room = await openRoom(b, "create");
		const checkpoints: Record<string, unknown>[] = [];
		try {
			// The shipped bootstrap room has no successor authority yet. This is the actual
			// producer checkpoint zero, not a claim that a non-null authority authenticates genesis.
			checkpoints.push({ epoch: 0, ...(await census(identity, b.objectId)) });
			await room.issue(message("producer-zero"));
			for (let epoch = 1; epoch <= 3; epoch++) {
				await room.sealEpoch();
				await room.adoptCreatorSuccessor();
				const authority = room.authority();
				check(authority, "genuine successor authority present");
				checkpoints.push({ epoch: authority.epoch, ...(await census(identity, b.objectId)) });
				check(authority.epoch === epoch, "genuine room accepted successor epoch");
				await room.issue(message("producer-" + epoch));
			}
		} finally {
			await room.close();
		}
		const counts = checkpoints.map((c) => c.count);
		const last = checkpoints[3],
			epochTwo = checkpoints[2],
			initial = checkpoints[0];
		check(last && epochTwo && initial, "four genuine checkpoints observed");
		const records = last.records as {
			generationId: string;
			baseExpectedHead: { kind: string; generationId?: string };
			state: string;
		}[];
		const active = records.find((r) => r.state === "Adopted");
		check(active, "genuine selected active L metadata");
		const parent = records.find((r) => r.generationId === active.baseExpectedHead.generationId);
		check(parent, "genuine selected parent Q metadata");
		const older = records.find((r) => r.generationId === parent.baseExpectedHead.generationId);
		check(older, "genuine selected older L metadata");
		if (settlement) {
			check(
				older.baseExpectedHead.kind === "none" && records.length === 3,
				"genuine reclamation normalized oldest L, erased earlier prefix"
			);
			check(
				older.generationId === (epochTwo.head as { generationId: string }).generationId,
				"oldest is genuinely accepted epoch-two L, not genesis"
			);
			check(
				!(initial.records as { generationId: string }[]).some((initial) =>
					records.some((retained) => retained.generationId === initial.generationId)
				),
				"genuine older genesis prefix actually reclaimed"
			);
		}
		return {
			dataObservationOnly: true,
			identity,
			objectId: b.objectId,
			settlement,
			counts,
			checkpoints,
			selectedIds: [active.generationId, parent.generationId, older.generationId],
			normalizedOldest: older.baseExpectedHead.kind === "none",
		};
	},
	boundedAheGenuineRead: async (
		identity: string,
		objectId: string,
		selectedIds: string[],
		settlement: boolean
	): Promise<unknown> => {
		const before = await census(identity, objectId);
		const { createBrowserAheDurableStore } = await import("../../../packages/storage-browser/dist/src/index.js");
		const store = await createBrowserAheDurableStore({ databaseName: identity + "--ahe" });
		try {
			const method: unknown = Reflect.get(store, "acquireBoundedActiveRead");
			if (typeof method !== "function")
				return {
					passed: false,
					failure: "WIRING_RED:acquireBoundedActiveRead absent; genuine producer assertions masked",
					before,
				};
			const observed = await environment(identity + "--ahe").observe(
				() =>
					Reflect.apply(method, store, [{ objectId, ancestorCount: 2, limits: LIMITS }]) as Promise<{
						ok: boolean;
						reason?: string;
						value: {
							reader: {
								head: PresentHead;
								generations: GenerationRecord[];
								blobs: { ref: GenerationRef; bytes: Uint8Array }[];
								release(): Promise<void>;
							};
						};
					}>
			);
			check(
				observed.evidence.writes === 0 &&
					observed.evidence.modes.length === 1 &&
					observed.evidence.modes[0] === "readonly" &&
					observed.evidence.terminals === 1,
				"genuine single readonly terminal native snapshot"
			);
			const result = observed.value;
			if (!settlement) {
				check(!result.ok && result.reason === "READ_BUDGET_EXCEEDED", "fixed G7 whole valid shipped eight-row refusal");
				check(
					!observed.evidence.reads.some((r) => r.table === "generations" && r.operation === "get"),
					"genuine G+1 keys before generation values"
				);
				check((await store.readHead(objectId as never)).ok, "genuine valid G+1 nonpoisoning");
			} else {
				check(result.ok, "genuine successful native selection");
				const expectedRecords = selectedIds.map((generationId) => {
					const record = (before.records as GenerationRecord[]).find((r) => r.generationId === generationId);
					check(record, "genuine exact selected native metadata record present");
					return record;
				});
				assertNativeSelectedRead(
					result.value.reader,
					before.head as PresentHead,
					expectedRecords,
					await environment(identity + "--ahe").image(),
					observed.evidence
				);
				const oldest = expectedRecords[2];
				check(
					oldest && oldest.baseExpectedHead.kind === "none",
					"genuine normalized oldest requires no erased prefix walk"
				);
				await result.value.reader.release();
			}
			check(
				JSON.stringify(await census(identity, objectId)) === JSON.stringify(before),
				"genuine object unchanged by read/refusal"
			);
			return {
				passed: true,
				before,
				observation: observed.evidence,
				budgetRefusalNotRollbackAvailability: !settlement,
			};
		} finally {
			await store.close();
		}
	},
});
