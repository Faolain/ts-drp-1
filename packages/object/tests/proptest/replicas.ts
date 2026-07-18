import {
	type BoxGame,
	BoxGame2D,
	BoxGame3D,
	makeReplicas as makePropertyReplicas,
	type Replica,
	type ReplicaFactory,
	runSim as runPropertySim,
	type SimConfig,
} from "@ts-drp/test-utils";

import { createACL } from "../../src/acl/index.js";
import { type HashGraph } from "../../src/hashgraph/index.js";
import { DRPObject } from "../../src/index.js";

const createReplica: ReplicaFactory = (peerId, peerIds, replicaDims, id) => {
	const obj = new DRPObject<BoxGame>({
		peerId,
		id,
		acl: createACL({ admins: peerIds }),
		drp: replicaDims === 2 ? new BoxGame2D() : new BoxGame3D(),
	});
	return {
		peerId,
		obj,
		hashGraph: obj["hashGraph"] as unknown as HashGraph,
	};
};

export function makeReplicas(n: number, dims: 2 | 3, objectId = "proptest-object"): Replica[] {
	return makePropertyReplicas(n, dims, createReplica, objectId);
}

export function runSim(cfg: SimConfig, replicas?: Replica[]): ReturnType<typeof runPropertySim> {
	return runPropertySim({ ...cfg, createReplica }, replicas);
}
