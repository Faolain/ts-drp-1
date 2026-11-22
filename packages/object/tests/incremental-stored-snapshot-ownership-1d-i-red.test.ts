import "./helpers/trusted-vertex-ingest.js";

/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow required snapshots and vertices */
import {
	DRPState,
	DRPStateEntry,
	DRPStateOtherTheWire,
	DrpType,
	type IDRP,
	Operation,
	SemanticsType,
} from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";
import { type DRPObjectStateManager } from "../src/state.js";

class OwnershipFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	ballast = { marker: "owned", bytes: "x".repeat(32 * 1024) };
	mutable = { nested: { values: [1, 2] }, map: new Map([["a", { value: 1 }]]) };
	changed = "before";

	replaceChanged(value: string): void {
		this.changed = value;
	}

	mutateThenThrow(value: string): void {
		this.changed = value;
		throw new Error("controlled quarantine");
	}
}

function state(entries: Record<string, unknown>): DRPState {
	return DRPState.create({
		state: Object.entries(entries).map(([key, value]) => DRPStateEntry.create({ key, value })),
	});
}

function encoded(value: DRPState | undefined): Uint8Array | undefined {
	return value === undefined ? undefined : DRPStateOtherTheWire.encode(serializeDRPState(value)).finish();
}

function internalStates(object: DRPObject<OwnershipFixture>): DRPObjectStateManager<OwnershipFixture> {
	return object["_states"];
}

function entry(
	manager: DRPObjectStateManager<OwnershipFixture>,
	side: "acl" | "drp",
	hash: string,
	key: string
): DRPState["state"][number] | undefined {
	const snapshot = side === "acl" ? manager.getACLState(hash) : manager.getDRPState(hash);
	return snapshot?.state.find((candidate) => candidate.key === key);
}

describe("Phase 1d(i) public stored-snapshot ownership", () => {
	it("detaches public setter inputs and every public getStates result", () => {
		const object = new DRPObject({
			peerId: "owner",
			acl: createACL({ admins: ["owner"] }),
			drp: new OwnershipFixture(),
		});
		const hash = "manual-owned-cut";
		const aclInput = state({ permissions: { writers: ["owner"] }, lookup: new Map([["owner", true]]) });
		const drpInput = state({ payload: { nested: [1, 2] }, dates: new Set([new Date(1_700_000_000_000)]) });

		object.setACLState(hash, aclInput);
		object.setDRPState(hash, drpInput);
		const beforeACL = encoded(object.getStates(hash)[0]);
		const beforeDRP = encoded(object.getStates(hash)[1]);

		((aclInput.state[0].value as { writers: string[] }).writers as string[]).push("attacker");
		(aclInput.state[1].value as Map<string, boolean>).set("attacker", true);
		((drpInput.state[0].value as { nested: number[] }).nested as number[]).push(3);
		(drpInput.state[1].value as Set<Date>).add(new Date(1_800_000_000_000));

		const firstRead = object.getStates(hash);
		expect.soft(firstRead[0]).not.toBe(internalStates(object).getACLState(hash));
		expect.soft(firstRead[1]).not.toBe(internalStates(object).getDRPState(hash));
		((firstRead[0]?.state[0].value as { writers: string[] }).writers as string[]).push("getter-attacker");
		((firstRead[1]?.state[0].value as { nested: number[] }).nested as number[]).push(4);

		expect(encoded(object.getStates(hash)[0]), "setter/getter aliases must not rewrite stored ACL bytes").toEqual(
			beforeACL
		);
		expect(encoded(object.getStates(hash)[1]), "setter/getter aliases must not rewrite stored DRP bytes").toEqual(
			beforeDRP
		);
	});

	it("shares unchanged entries only inside owned snapshots and preserves the reconstruction barrier", () => {
		const object = new DRPObject({
			peerId: "owner",
			acl: createACL({ admins: ["owner"] }),
			drp: new OwnershipFixture(),
		});
		const manager = internalStates(object);
		const rootDRPBytes = encoded(manager.getDRPState(HashGraph.rootHash));
		const rootACLBytes = encoded(manager.getACLState(HashGraph.rootHash));

		object.drp?.replaceChanged("after");
		const vertex = object.vertices.find((candidate) => candidate.operation?.opType === "replaceChanged");
		expect(vertex, "positive control: the local operation must publish a vertex").toBeDefined();
		const hash = vertex?.hash as string;

		expect.soft(entry(manager, "drp", hash, "ballast")).toBe(entry(manager, "drp", HashGraph.rootHash, "ballast"));
		expect.soft(entry(manager, "drp", hash, "mutable")).toBe(entry(manager, "drp", HashGraph.rootHash, "mutable"));
		for (const rootEntry of manager.getACLState(HashGraph.rootHash)?.state ?? []) {
			expect
				.soft(entry(manager, "acl", hash, rootEntry.key), `unchanged ACL key ${rootEntry.key} must be shared`)
				.toBe(rootEntry);
		}

		const reconstructed = manager.fromHash(hash)[0] as OwnershipFixture;
		reconstructed.ballast.marker = "reconstructed attacker";
		reconstructed.mutable.nested.values.push(99);
		reconstructed.mutable.map.get("a")!.value = 99;
		object.drp!.ballast.marker = "live attacker";
		object.drp!.mutable.nested.values.push(100);

		expect(encoded(manager.getDRPState(HashGraph.rootHash))).toEqual(rootDRPBytes);
		expect(encoded(manager.getACLState(HashGraph.rootHash))).toEqual(rootACLBytes);
		expect((entry(manager, "drp", hash, "ballast")?.value as { marker: string }).marker).toBe("owned");
		expect((entry(manager, "drp", hash, "mutable")?.value as OwnershipFixture["mutable"]).nested.values).toEqual([
			1, 2,
		]);
	});

	it("keeps shared journal identities intact and rolls back a torn pair publication", () => {
		const object = new DRPObject({
			peerId: "owner",
			acl: createACL({ admins: ["owner"] }),
			drp: new OwnershipFixture(),
		});
		const manager = internalStates(object);
		object.drp?.replaceChanged("first");
		const first = object.vertices.find((candidate) => candidate.operation?.opType === "replaceChanged");
		expect(first).toBeDefined();
		expect
			.soft(entry(manager, "drp", first!.hash, "ballast"))
			.toBe(entry(manager, "drp", HashGraph.rootHash, "ballast"));

		const stateMaps = manager as unknown as {
			aclStates: Map<string, DRPState>;
			drpStates: Map<string, DRPState>;
			setDRPState(hash: string, state: DRPState): void;
		};
		const beforeACL = new Map(stateMaps.aclStates);
		const beforeDRP = new Map(stateMaps.drpStates);
		const originalSetDRPState = stateMaps.setDRPState.bind(manager);
		let armed = true;
		stateMaps.setDRPState = (hash, snapshot): void => {
			if (armed) throw new Error(`controlled torn-pair failure at ${hash}`);
			originalSetDRPState(hash, snapshot);
		};
		try {
			expect(() => object.drp?.replaceChanged("must-roll-back")).toThrow(/controlled torn-pair failure/);
		} finally {
			armed = false;
			stateMaps.setDRPState = originalSetDRPState;
		}

		expect([...stateMaps.aclStates.keys()]).toEqual([...beforeACL.keys()]);
		expect([...stateMaps.drpStates.keys()]).toEqual([...beforeDRP.keys()]);
		for (const [hash, snapshot] of beforeACL) expect(stateMaps.aclStates.get(hash)).toBe(snapshot);
		for (const [hash, snapshot] of beforeDRP) expect(stateMaps.drpStates.get(hash)).toBe(snapshot);
		expect(object.drp?.changed).toBe("first");
	});

	it("keeps an exact single-head checkpoint owned and isolated from every mutable surface", () => {
		const previousSuffix = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "1";
		try {
			const object = new DRPObject({
				peerId: "owner",
				acl: createACL({ admins: ["owner"] }),
				drp: new OwnershipFixture(),
			});
			const manager = internalStates(object);
			object.drp?.replaceChanged("checkpoint");
			const vertex = object.vertices.find((candidate) => candidate.operation?.opType === "replaceChanged");
			expect(vertex).toBeDefined();
			const checkpoints = (
				object["_applier"] as unknown as {
					checkpoints: { frontier: string[]; state: { aclState: DRPState; drpState: DRPState } }[];
				}
			).checkpoints;
			const checkpoint = checkpoints.at(-1)!;
			expect(checkpoint.frontier).toEqual([vertex!.hash]);
			const checkpointACLBytes = encoded(checkpoint.state.aclState);
			const checkpointDRPBytes = encoded(checkpoint.state.drpState);

			const publicRead = object.getStates(vertex!.hash);
			(publicRead[1]!.state.find(({ key }) => key === "ballast")!.value as OwnershipFixture["ballast"]).marker =
				"public getter attacker";
			const reconstructed = manager.fromHash(vertex!.hash)[0]!;
			reconstructed.mutable.nested.values.push(8);
			object.drp!.ballast.marker = "live attacker";

			expect(encoded(checkpoint.state.aclState)).toEqual(checkpointACLBytes);
			expect(encoded(checkpoint.state.drpState)).toEqual(checkpointDRPBytes);
		} finally {
			if (previousSuffix === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffix;
		}
	});

	it("quarantines failed work without mutating shared history or publishing a fragment", async () => {
		const object = new DRPObject({
			peerId: "owner",
			acl: createACL({ admins: ["owner"] }),
			drp: new OwnershipFixture(),
		});
		const manager = internalStates(object);
		object.drp?.replaceChanged("committed");
		const committed = object.vertices.find((candidate) => candidate.operation?.opType === "replaceChanged")!;
		expect
			.soft(entry(manager, "drp", committed.hash, "ballast"))
			.toBe(entry(manager, "drp", HashGraph.rootHash, "ballast"));
		const priorACL = manager.getACLState(committed.hash);
		const priorDRP = manager.getDRPState(committed.hash);
		const operation = Operation.create({
			drpType: DrpType.DRP,
			opType: "mutateThenThrow",
			value: ["quarantined"],
		});
		const timestamp = Date.now() + 1;
		const rejected = {
			hash: computeHash("owner", operation, [committed.hash], timestamp),
			peerId: "owner",
			dependencies: [committed.hash],
			operation,
			timestamp,
			signature: new Uint8Array(),
		};

		await expect(object.applyVertices([rejected])).resolves.toEqual({
			applied: false,
			missing: [],
			invalid: [],
			quarantined: [rejected.hash],
		});
		expect(object.vertices.some(({ hash }) => hash === rejected.hash)).toBe(false);
		expect(object.getStates(rejected.hash)).toEqual([undefined, undefined]);
		expect(manager.getACLState(committed.hash)).toBe(priorACL);
		expect(manager.getDRPState(committed.hash)).toBe(priorDRP);
		expect(object.drp?.changed).toBe("committed");
	});
});
