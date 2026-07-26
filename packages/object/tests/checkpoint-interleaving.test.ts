import { DRPStateOtherTheWire, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { expectGraphWellFormedAfterFailure } from "./merge-failure-invariants.js";
import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

interface ParkingControl {
	entered: Deferred;
	release: Deferred;
}

const parkingControls = new Map<string, ParkingControl>();

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function parkingControl(id: string): ParkingControl {
	const control = { entered: deferred(), release: deferred() };
	parkingControls.set(id, control);
	return control;
}

class CheckpointLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	async appendAfterRelease(controlId: string, value: number): Promise<void> {
		const control = parkingControls.get(controlId);
		if (!control) throw new Error(`Missing parking control ${controlId}`);
		control.entered.resolve();
		await control.release.promise;
		this.values.push(value);
	}
}

function makeReceiver(peerId: string): DRPObject<CheckpointLogDRP> {
	return new DRPObject({
		peerId,
		// Both replicas MUST share one consensus ACL: the test compares ACL snapshot bytes at
		// shared heads, and adding each replica's own peerId as an admin makes `_authorizedPeers`
		// differ by construction, so the comparison could never hold. Only "sender" and
		// "local-author" ever author a vertex here; the serial replica just replays.
		acl: createACL({ admins: ["sender", "local-author"] }),
		drp: new CheckpointLogDRP(),
	});
}

function makeVertex(opType: string, value: unknown[], dependencies: string[], timestamp: number): Vertex {
	return createVertex("sender", Operation.create({ drpType: DrpType.DRP, opType, value }), dependencies, timestamp);
}

function encodedStates(receiver: DRPObject<CheckpointLogDRP>, hash: string): (number[] | undefined)[] {
	return receiver
		.getStates(hash)
		.map((state) =>
			state === undefined ? undefined : Array.from(DRPStateOtherTheWire.encode(serializeDRPState(state)).finish())
		);
}

describe("checkpoint writer merge interleaving", () => {
	it("keeps live state and retained snapshot bytes replica-equivalent at the default 256 suffix", async () => {
		const previousSuffixSize = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "256";
		try {
			const control = parkingControl("checkpoint-256");
			const interleaved = makeReceiver("local-author");
			const bulk: Vertex[] = [];
			let dependency = HashGraph.rootHash;
			for (let value = 1; value <= 256; value++) {
				const vertex = makeVertex("append", [value], [dependency], value);
				bulk.push(vertex);
				dependency = vertex.hash;
			}
			const parking = makeVertex("appendAfterRelease", ["checkpoint-256", 257], [dependency], 257);
			const localNotifications: Vertex[] = [];
			interleaved.subscribe((_object, origin, vertices) => {
				if (origin === "callFn") localNotifications.push(...vertices);
			});

			const merge = interleaved.applyVertices([...bulk, parking]);
			await control.entered.promise;
			interleaved.drp?.append(258);
			const localVertex = localNotifications.at(-1);
			expect(
				localVertex,
				"positive control: the interleaved local checkpoint writer must commit and notify"
			).toBeDefined();
			expect(localVertex?.dependencies).toEqual([bulk.at(-1)?.hash]);

			control.release.resolve();
			const mergeResult = await merge;
			expect(
				mergeResult,
				"positive control: the merge must report every submitted vertex as successfully applied"
			).toEqual({ applied: true, missing: [], invalid: [] });

			const serial = makeReceiver("serial-replica");
			const serialResult = await serial.applyVertices([...bulk, localVertex as Vertex, parking]);
			expect(serialResult, "positive control: the same DAG must apply normally without the interleaving").toEqual({
				applied: true,
				missing: [],
				invalid: [],
			});

			const interleavedHashes = interleaved.vertices.map(({ hash }) => hash).sort();
			const serialHashes = serial.vertices.map(({ hash }) => hash).sort();
			const retainedHashes = [localVertex?.hash, parking.hash].filter((hash): hash is string => hash !== undefined);
			const sameStoredStateBytes = retainedHashes.every(
				(hash) => JSON.stringify(encodedStates(interleaved, hash)) === JSON.stringify(encodedStates(serial, hash))
			);
			const sameLiveState = JSON.stringify(interleaved.drp?.values) === JSON.stringify(serial.drp?.values);
			const mergeReportTruthful =
				!mergeResult.applied ||
				(interleavedHashes.join() === serialHashes.join() && sameLiveState && sameStoredStateBytes);

			expect(
				{
					graphHashesEqual: interleavedHashes.join() === serialHashes.join(),
					interleavedLiveLength: interleaved.drp?.values.length,
					mergeReportTruthful,
					sameLiveState,
					sameStoredStateBytes,
					serialLiveLength: serial.drp?.values.length,
				},
				"an applied merge and an interleaved checkpoint must reproduce the serial replica's live state and snapshot bytes"
			).toEqual({
				graphHashesEqual: true,
				interleavedLiveLength: 258,
				mergeReportTruthful: true,
				sameLiveState: true,
				sameStoredStateBytes: true,
				serialLiveLength: 258,
			});

			await expectGraphWellFormedAfterFailure(
				interleaved,
				1005,
				"the checkpoint interleaving must leave the graph reachable and the applier usable"
			);
		} finally {
			if (previousSuffixSize === undefined) {
				delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			} else {
				process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffixSize;
			}
		}
	});
});
