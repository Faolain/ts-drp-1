import { type IDRP, SemanticsType, type Vertex } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { ObjectACL } from "../src/acl/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";

const ADMINS = ["sender", "receiver", "author-a", "author-b"];

class VersionedACL extends ObjectACL {
	currentACLVersion = "acl-v1";
	legacyACLVersion?: string = "legacy-acl-v1";

	constructor() {
		super({ admins: ADMINS });
	}

	upgradeACL(nextVersion: string): void {
		delete this.legacyACLVersion;
		this.currentACLVersion = nextVersion;
	}
}

class VersionedMapDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	currentVersion = "drp-v1";
	legacyVersion?: string = "legacy-drp-v1";
	entries = new Map<string, string>();
	events: string[] = [];

	upgradeDRP(nextVersion: string): void {
		delete this.legacyVersion;
		this.currentVersion = nextVersion;
	}

	setMap(key: string, value: string): void {
		this.entries.set(key, value);
	}

	deleteMap(key: string): void {
		this.entries.delete(key);
	}

	append(event: string): void {
		this.events.push(event);
	}

	query_entries(): [string, string][] {
		return [...this.entries];
	}
}

function makeReplica(peerId: string): DRPObject<VersionedMapDRP> {
	return new DRPObject({
		peerId,
		acl: new VersionedACL(),
		drp: new VersionedMapDRP(),
	});
}

function operationVertex(object: DRPObject<VersionedMapDRP>, opType: string, value: unknown[]): Vertex {
	const vertex = object.vertices.find(
		(candidate) =>
			candidate.operation?.opType === opType &&
			candidate.operation.value.every((item: unknown, index: number) => item === value[index])
	);
	if (!vertex) throw new Error(`Missing ${opType}(${value.join(",")}) vertex`);
	return vertex;
}

describe("Phase 0c2 replacement adoption", () => {
	it("does not resurrect a real Map key deleted on replica A when its operation is adopted by B", async () => {
		const replicaA = makeReplica("sender");
		const replicaB = makeReplica("receiver");

		replicaA.drp?.setMap("retired-key", "replicated-value");
		const setVertex = operationVertex(replicaA, "setMap", ["retired-key", "replicated-value"]);
		await expect(replicaB.applyVertices([setVertex])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});
		expect(replicaB.drp?.query_entries(), "positive control: B must first hold A's real Map entry").toEqual([
			["retired-key", "replicated-value"],
		]);

		replicaA.drp?.deleteMap("retired-key");
		const deleteVertex = operationVertex(replicaA, "deleteMap", ["retired-key"]);
		await expect(replicaB.applyVertices([deleteVertex])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect(replicaB.drp?.query_entries(), "the deleted Map key must not resurrect on B's live instance").toEqual([]);
	});

	it("replaces old-version enumerable state on both journal-less local proxy adoption paths", () => {
		const replica = makeReplica("receiver");

		replica.drp?.upgradeDRP("drp-v2");
		(replica.acl as VersionedACL).upgradeACL("acl-v2");

		expect(
			{
				acl: {
					current: (replica.acl as VersionedACL).currentACLVersion,
					hasLegacy: Object.hasOwn(replica.acl, "legacyACLVersion"),
				},
				drp: {
					current: replica.drp?.currentVersion,
					hasLegacy: Object.hasOwn(replica.drp ?? {}, "legacyVersion"),
				},
				operations: replica.vertices
					.filter(({ hash }) => hash !== HashGraph.rootHash)
					.map(({ operation }) => operation?.opType),
			},
			"local proxy publication must replace, not Object.assign, both live owners"
		).toEqual({
			acl: { current: "acl-v2", hasLegacy: false },
			drp: { current: "drp-v2", hasLegacy: false },
			operations: ["upgradeDRP", "upgradeACL"],
		});
	});

	it("removes old-version fields and retains current canonical fields on both journaled linear adoption paths", async () => {
		const author = makeReplica("sender");
		const receiver = makeReplica("receiver");

		author.drp?.upgradeDRP("drp-v2");
		(author.acl as VersionedACL).upgradeACL("acl-v2");
		const drpUpgrade = operationVertex(author, "upgradeDRP", ["drp-v2"]);
		const aclUpgrade = operationVertex(author, "upgradeACL", ["acl-v2"]);

		await expect(receiver.applyVertices([drpUpgrade, aclUpgrade])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect(
			{
				acl: {
					current: (receiver.acl as VersionedACL).currentACLVersion,
					hasLegacy: Object.hasOwn(receiver.acl, "legacyACLVersion"),
				},
				drp: {
					current: receiver.drp?.currentVersion,
					hasLegacy: Object.hasOwn(receiver.drp ?? {}, "legacyVersion"),
				},
			},
			"cross-version replay must remove stale live fields while retaining literal current fields"
		).toEqual({
			acl: { current: "acl-v2", hasLegacy: false },
			drp: { current: "drp-v2", hasLegacy: false },
		});
	});

	it("replaces both live owners during deferred reconciliation after the first merge injects stale state", async () => {
		const authorA = makeReplica("author-a");
		const authorB = makeReplica("author-b");
		const receiver = makeReplica("receiver");
		authorA.drp?.append("event-a");
		authorB.drp?.append("event-b");
		const eventA = operationVertex(authorA, "append", ["event-a"]);
		const eventB = operationVertex(authorB, "append", ["event-b"]);
		let staleStateInjections = 0;

		receiver.subscribe((live, origin) => {
			if (origin !== "merge" || staleStateInjections !== 0) return;
			staleStateInjections++;
			(live.acl as VersionedACL & { reconcileOnlyACL?: string }).reconcileOnlyACL = "stale-acl";
			(live.drp as VersionedMapDRP & { reconcileOnlyDRP?: string }).reconcileOnlyDRP = "stale-drp";
		});

		await expect(receiver.applyVertices([eventA, eventB])).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});

		expect(
			{
				aclHasStale: Object.hasOwn(receiver.acl, "reconcileOnlyACL"),
				drpHasStale: Object.hasOwn(receiver.drp ?? {}, "reconcileOnlyDRP"),
				events: [...(receiver.drp?.events ?? [])].sort(),
				staleStateInjections,
			},
			"the deferred full replay must publish both canonical owners by replacement"
		).toEqual({
			aclHasStale: false,
			drpHasStale: false,
			events: ["event-a", "event-b"],
			staleStateInjections: 1,
		});
	});

	it("rolls back both journaled replacements when a later publication step is forced to fail", async () => {
		const author = makeReplica("sender");
		const receiver = makeReplica("receiver");
		receiver.drp?.append("receiver-branch");
		author.drp?.append("remote-branch");
		const receiverBranch = operationVertex(receiver, "append", ["receiver-branch"]);
		const remoteBranch = operationVertex(author, "append", ["remote-branch"]);
		(receiver.acl as VersionedACL & { rollbackOnlyACL?: string }).rollbackOnlyACL = "restore-acl";
		(receiver.drp as VersionedMapDRP & { rollbackOnlyDRP?: string }).rollbackOnlyDRP = "restore-drp";

		const applier = receiver["_applier"] as unknown as {
			advanceCheckpointIfNeeded(...args: unknown[]): void;
		};
		const originalAdvanceCheckpoint = applier.advanceCheckpointIfNeeded;
		let stateObservedAfterReplacement:
			| {
					aclHasRollbackOnly: boolean;
					drpHasRollbackOnly: boolean;
					events: string[];
			  }
			| undefined;
		applier.advanceCheckpointIfNeeded = (): void => {
			stateObservedAfterReplacement = {
				aclHasRollbackOnly: Object.hasOwn(receiver.acl, "rollbackOnlyACL"),
				drpHasRollbackOnly: Object.hasOwn(receiver.drp ?? {}, "rollbackOnlyDRP"),
				events: [...(receiver.drp?.events ?? [])].sort(),
			};
			throw new Error("forced failure after journaled replacement");
		};

		try {
			await expect(receiver.applyVertices([remoteBranch])).resolves.toEqual({
				applied: false,
				missing: [],
				invalid: [],
				quarantined: [remoteBranch.hash],
			});
		} finally {
			applier.advanceCheckpointIfNeeded = originalAdvanceCheckpoint;
		}

		expect(
			{
				afterReplacement: stateObservedAfterReplacement,
				afterRollback: {
					aclRollbackOnly: (receiver.acl as VersionedACL & { rollbackOnlyACL?: string }).rollbackOnlyACL,
					drpRollbackOnly: (receiver.drp as VersionedMapDRP & { rollbackOnlyDRP?: string }).rollbackOnlyDRP,
					events: receiver.drp?.events,
				},
				remoteSurfaces: {
					finality: receiver.finalityStore.states.has(remoteBranch.hash),
					graph: receiver.vertices.some(({ hash }) => hash === remoteBranch.hash),
					states: receiver.getStates(remoteBranch.hash),
				},
				receiverBranchStillCommitted: receiver.vertices.some(({ hash }) => hash === receiverBranch.hash),
			},
			"a forced post-replacement failure must restore exact pre-commit live state and every atomic surface"
		).toEqual({
			afterReplacement: {
				aclHasRollbackOnly: false,
				drpHasRollbackOnly: false,
				events: ["receiver-branch", "remote-branch"],
			},
			afterRollback: {
				aclRollbackOnly: "restore-acl",
				drpRollbackOnly: "restore-drp",
				events: ["receiver-branch"],
			},
			remoteSurfaces: {
				finality: false,
				graph: false,
				states: [undefined, undefined],
			},
			receiverBranchStillCommitted: true,
		});

		expect(
			(receiver.acl as VersionedACL).query_isAdmin("receiver"),
			"rollback must preserve the receiver's canonical ACL contents"
		).toBe(true);
		expect(
			(receiver.acl as VersionedACL).query_isWriter("sender"),
			"rollback must preserve the sender's canonical writer permission"
		).toBe(true);
	});
});
