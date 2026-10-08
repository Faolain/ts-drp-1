/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Product invocation and causal assertions stay independent from setup. */
import { encodeCanonical } from "@ts-drp/canonical";
import { AHE_BOUNDED_READ_LIMITS, parseStorageObjectId } from "@ts-drp/storage";
import {
	authenticateCreatorClosedRollbackData,
	resolveCreatorClosedRollbackDataObservation,
} from "rollback-observer-under-test";

import { arm, events, reset } from "./events.js";
import { mutateProof } from "./proof-faults.js";
import { provePresentBytes, requireThat } from "./proof.js";
import type { Bootstrap, Fault, Floor, NativeOwners, NativePort } from "./types.js";
import { application, unhex } from "../cold-discovery/application.js";
export async function recover(b: Bootstrap, fault: Fault, owners: NativeOwners, port: NativePort) {
	const floor = await port.readFloor();
	requireThat(floor, "real refreshed trusted host floor");
	const parsed = parseStorageObjectId(b.objectId);
	requireThat(parsed.ok, "admitted object");
	const precondition =
		fault === "unpruned-g8"
			? {
					physicalRows: (await port.image()).generations.length,
					actualBoundedResult: await owners.ahe.acquireBoundedActiveRead({
						objectId: parsed.value,
						ancestorCount: 2,
						limits: AHE_BOUNDED_READ_LIMITS,
					}),
				}
			: await provePresentBytes(b, floor, owners);
	const mutation = await mutateProof(b, floor, owners, port, fault);
	if (
		[
			"older-missing-chunk",
			"older-corrupt-chunk",
			"older-missing-manifest",
			"temporary",
			"open",
			"legacy",
			"not-ready",
		].includes(fault)
	)
		await port.snapshotFault(fault, b.objectId, floor.stable.epoch - 2);
	if (fault === "missing-anchor" || fault === "anchor-neighbor" || fault === "anchor-cap")
		await port.journalFault(fault, b.objectId, floor.stable.epoch - 2);
	if (fault === "same-u") {
		const native = await owners.ahe.acquireBoundedActiveRead({
			objectId: parsed.value,
			ancestorCount: 2,
			limits: AHE_BOUNDED_READ_LIMITS,
		});
		requireThat(native.ok && native.value.kind === "present", "actual generic union admitted by bounded native owner");
		const reader = native.value.reader;
		try {
			return {
				classification: "GENERIC_NATIVE_CONTROL",
				precondition,
				mutation,
				nativeControl: {
					kind: "present",
					actualDistinctUnionBytes: reader.blobs.reduce((s, c) => s + c.bytes.length, 0),
					closureCounts: reader.generations.map((g) => g.closure.length),
				},
				result: null,
				summary: null,
				events: [],
			};
		} finally {
			await reader.release();
		}
	}
	reset();
	if (
		typeof authenticateCreatorClosedRollbackData !== "function" ||
		typeof resolveCreatorClosedRollbackDataObservation !== "function"
	)
		return {
			classification: "WIRING_RED",
			missing: "private authenticate/resolver",
			precondition,
			mutation,
			result: null,
			summary: null,
			events: [],
		};
	const authenticate = authenticateCreatorClosedRollbackData,
		resolve = resolveCreatorClosedRollbackDataObservation;
	const controller = new AbortController(),
		admitted: Promise<unknown>[] = [],
		floorReads: unknown[] = [];
	if (fault === "already-aborted") controller.abort();
	let getterReads = 0;
	const replacement =
		fault === "older-replaced" ? await port.prepareReplacement(b.objectId, floor.stable.epoch - 2) : null;
	const staleHead = fault === "head-stale" ? await port.prepareStaleHead(b.objectId) : null;
	let payloads = 0;
	const nativeChunk = () => {
		payloads++;
		if ((fault === "abort-first" && payloads === 1) || (fault === "abort-second" && payloads === 2)) controller.abort();
		if (fault === "close-first" && payloads === 1) admitted.push(owners.snapshot.close());
		if (staleHead && payloads === 1) admitted.push(staleHead.run());
	};
	arm((name, epoch) => {
		if (name === "snapshot-acquire" && epoch === floor.stable.epoch - 2 && replacement)
			admitted.push(replacement.run());
		if (name === "snapshot-release" && fault === "release-failed") throw new Error("explicit fixture release fault");
	});
	const roomHeadAuthority = {
		read: async (input: Readonly<{ scope: Readonly<{ objectId: string; pinnedGenesisAnchorDigest: string }> }>) => {
			requireThat(
				input.scope.objectId === b.objectId && input.scope.pinnedGenesisAnchorDigest === b.pinnedGenesisAnchorDigest,
				"exact actual host scope"
			);
			floorReads.push(input);
			if (floorReads.length === 2 && (fault === "floor-stale" || fault === "floor-pending")) {
				const state: Floor =
					fault === "floor-stale"
						? { stable: { ...floor.stable, currentAnchorDigest: "e".repeat(64) }, pending: null }
						: {
								stable: floor.stable,
								pending: {
									previous: floor.stable,
									next: { ...floor.stable, epoch: floor.stable.epoch + 1, currentAnchorDigest: "e".repeat(64) },
								},
							};
				await port.writeFloor(state);
			}
			return { ok: true, state: await port.readFloor() };
		},
	};
	const before = encodeCanonical(await port.image());
	let result: unknown,
		summary: unknown,
		tokenEmpty = false,
		tokenFrozen = false,
		foreign: unknown;
	const observed = await port.observe(async () => {
		const input = {
			objectId: b.objectId,
			pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes),
			roomHeadAuthority,
			catalog: application().catalog,
			store: owners.ahe,
			snapshotStore: owners.snapshot,
			liveJournalStore: owners.journal,
			signal: controller.signal,
		};
		if (fault === "capture-accessor")
			Object.defineProperty(input, "objectId", {
				enumerable: true,
				get: () => {
					getterReads++;
					throw new Error("capture must not invoke accessor");
				},
			});
		result = await authenticate(input);
		const r = result as { ok: boolean; observation?: object };
		if (r.ok) {
			tokenEmpty = Reflect.ownKeys(r.observation!).length === 0;
			tokenFrozen = Object.isFrozen(r.observation);
			summary = resolve(r.observation);
			foreign = [{}, Object.freeze({}), JSON.parse(JSON.stringify(r.observation)), { ...r.observation }, summary].map(
				(v) => resolve(v) ?? null
			);
		} else summary = null;
		const terminals = await Promise.allSettled(admitted);
		requireThat(
			terminals.every((t) => t.status === "fulfilled"),
			"fixture admitted native terminals settled successfully"
		);
		return result;
	}, nativeChunk);
	arm(undefined);
	await replacement?.close();
	await staleHead?.close();
	const after = encodeCanonical(await port.image());
	return {
		classification: "REACHED",
		precondition,
		mutation,
		result,
		summary,
		tokenEmpty,
		tokenFrozen,
		foreign,
		getterReads,
		floorReads: floorReads.length,
		events: [...events],
		native: observed.evidence,
		unchangedAhe: before.length === after.length && before.every((v, i) => v === after[i]),
	};
}
