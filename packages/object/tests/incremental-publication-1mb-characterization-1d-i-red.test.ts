/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow required characterization vertices */
import { DrpType, type Hash, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { DRPObjectStateManager } from "../src/state.js";

const VERTEX_COUNT = 1_000;
const ONE_MIB = 1024 * 1024;

interface CopyMetadata {
	publicationId: string;
	side: "acl" | "drp";
	key: string;
	image: "pre" | "post";
}

interface PublicationRecord {
	publicationId: string;
	kind: "vertex" | "checkpoint";
	mode: "incremental" | "fallback";
	targetHash?: Hash;
	frontier: readonly Hash[];
	changed: Readonly<Record<"acl" | "drp", readonly string[]>>;
}

class CharacterizationProbe {
	readonly copies: (CopyMetadata & { bytes: number })[] = [];
	readonly publications: PublicationRecord[] = [];

	clonePayload(value: unknown, metadata: CopyMetadata): unknown {
		this.copies.push({ ...metadata, bytes: serializeValue(value).byteLength });
		return cloneDeep(value);
	}

	onPublication(record: PublicationRecord): void {
		this.publications.push(record);
	}
}

class OneMiBState implements IDRP {
	semanticsType = SemanticsType.pair;
	ballast = "z".repeat(ONE_MIB);
	counter = 0;

	setCounter(value: number): void {
		this.counter = value;
	}
}

function vertex(value: number, dependency: Hash): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType: "setCounter", value: [value] });
	const timestamp = value;
	return {
		hash: computeHash("remote", operation, [dependency], timestamp),
		peerId: "remote",
		dependencies: [dependency],
		operation,
		timestamp,
		signature: new Uint8Array(),
	};
}

describe("Phase 1d(i) 1k-vertex / 1 MiB characterization", () => {
	it("keeps every exact linear cut and the aggregate under the deterministic publication bound", async () => {
		const drp = new OneMiBState();
		expect(serializeValue(drp.ballast).byteLength).toBeGreaterThanOrEqual(ONE_MIB);
		const acl = createACL({ admins: ["remote"] });
		const hashGraph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, drp.semanticsType);
		const states = new DRPObjectStateManager(acl, drp);
		const probe = new CharacterizationProbe();
		const options = {
			drp,
			acl,
			hashGraph,
			states,
			finalityStore: new FinalityStore(),
			notify: (): void => {},
			publicationInstrumentation: probe,
		};
		const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<OneMiBState>;
		const applier = new Applier(options);
		const vertices: Vertex[] = [];
		let dependency = HashGraph.rootHash;
		let mutatedBytes = 0;
		for (let value = 1; value <= VERTEX_COUNT; value++) {
			const candidate = vertex(value, dependency);
			vertices.push(candidate);
			dependency = candidate.hash;
			mutatedBytes += Math.max(serializeValue(value - 1).byteLength, serializeValue(value).byteLength);
		}

		await expect(applier.applyVertices(vertices)).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		const vertexPublications = probe.publications.filter(({ kind }) => kind === "vertex");
		expect(vertexPublications).toHaveLength(VERTEX_COUNT);
		for (const publication of vertexPublications) {
			expect(publication.mode).toBe("incremental");
			expect(publication.changed.acl).toEqual([]);
			expect(publication.changed.drp).toEqual(["counter"]);
			const clonedBytes = probe.copies
				.filter(({ publicationId }) => publicationId === publication.publicationId)
				.reduce((total, copy) => total + copy.bytes, 0);
			const target = vertices.find(({ hash }) => hash === publication.targetHash);
			expect(target).toBeDefined();
			const value = target?.operation?.value[0] as number;
			const perVertexMutated = Math.max(serializeValue(value - 1).byteLength, serializeValue(value).byteLength);
			expect(clonedBytes).toBeLessThan(20 * perVertexMutated);
		}
		for (const checkpoint of probe.publications.filter(({ kind }) => kind === "checkpoint")) {
			expect(checkpoint.frontier).toHaveLength(1);
			expect(checkpoint.mode).toBe("incremental");
		}
		const clonedBytes = probe.copies.reduce((total, copy) => total + copy.bytes, 0);
		expect(clonedBytes).toBeLessThan(20 * mutatedBytes);
		expect(probe.copies.some(({ key, bytes }) => key === "ballast" && bytes >= ONE_MIB)).toBe(false);
		expect(
			states.getACLState(vertices[0].hash),
			"positive control: old per-vertex snapshots are pruned"
		).toBeUndefined();
		expect(
			states.getDRPState(vertices[0].hash),
			"positive control: old per-vertex snapshots are pruned"
		).toBeUndefined();
		expect(states.getACLState(vertices.at(-1)!.hash)).toBeDefined();
		expect(states.getDRPState(vertices.at(-1)!.hash)).toBeDefined();
	});
});
