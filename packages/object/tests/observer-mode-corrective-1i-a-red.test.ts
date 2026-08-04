import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Keychain } from "@ts-drp/keychain";
import {
	ACLGroup,
	type DRPState,
	DrpType,
	type IDRP,
	Operation,
	SemanticsType,
	type Vertex,
	Vertex as VertexCodec,
} from "@ts-drp/types";
import { createHash } from "node:crypto";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { DRPObject } from "../src/index.js";
import { installObserverPreDriftControl } from "./helpers/observer-pre-drift-control.js";

type ReplicaMode = "observer" | "writer";
type PublicIngest = "applyVertices" | "merge";
type HistoryFixture = [Vertex, Vertex, Vertex, Vertex, Vertex, Vertex, Vertex, Vertex, Vertex];
type BranchJoinFixture = [Vertex, Vertex, Vertex, Vertex, Vertex, Vertex, Vertex];
type ZeroDeltaBranchFixture = [Vertex, Vertex, Vertex, Vertex, Vertex];
type CausalKeySetFixture = [Vertex, Vertex];
type CausalACLFixture = [Vertex, Vertex, Vertex, Vertex];
type CrossKeyTailFixture = [Vertex, Vertex, Vertex, Vertex];

interface SigningIdentity {
	keychain: Keychain;
	peerId: string;
}

interface StateStoreReflection {
	deleteACLState(hash: string, expected: DRPState): boolean;
	deleteDRPState(hash: string, expected: DRPState): boolean;
	getACLState(hash: string): DRPState | undefined;
	getDRPState(hash: string): DRPState | undefined;
	setACLState(hash: string, state: DRPState): void;
	setDRPState(hash: string, state: DRPState): void;
}

interface ObjectReflection {
	_applier: {
		checkpoints: Array<{ frontier: string[] }>;
	};
	_states: StateStoreReflection;
	hashGraph: { linearizeVertices(): Vertex[] };
}

class ObserverHistoryDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	query_values(): number[] {
		return [...this.values];
	}
}

class ZeroDeltaBranchDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	governed = 0;
	marker = "root";

	setGoverned(value: number): void {
		this.governed = value;
	}

	semanticNoOp(): void {}

	mark(value: string): void {
		this.marker = value;
	}

	query_state(): { governed: number; marker: string } {
		return { governed: this.governed, marker: this.marker };
	}
}

class CausalKeySetDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	marker = "root";
	removable?: string = "present";
	declare added?: string;

	changeSiblingKeySet(): void {
		this.added = "sibling-added";
		delete this.removable;
	}

	mark(value: string): void {
		this.marker = value;
	}

	query_state(): { added?: string; marker: string; removable?: string } {
		return { added: this.added, marker: this.marker, removable: this.removable };
	}
}

class CrossKeyTailDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	x = 0;
	y = 0;
	marker = "root";

	setX(value: number): void {
		this.x = value;
	}

	deriveY(): void {
		this.y = this.x;
	}

	mark(value: string): void {
		this.marker = value;
	}

	query_state(): { marker: string; x: number; y: number } {
		return { marker: this.marker, x: this.x, y: this.y };
	}
}

let author: SigningIdentity;
let guest: SigningIdentity;

async function identity(seed: string): Promise<SigningIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

function replica(mode: ReplicaMode): DRPObject<ObserverHistoryDRP> {
	const config = { log_config: { level: "silent" }, replica_mode: mode } as const;
	return new DRPObject({
		peerId: `${mode}-receiver`,
		acl: createACL({ admins: [author.peerId] }),
		drp: new ObserverHistoryDRP(),
		config,
	});
}

function zeroDeltaReplica(): DRPObject<ZeroDeltaBranchDRP> {
	return new DRPObject({
		peerId: "zero-delta-writer",
		acl: createACL({ admins: [author.peerId] }),
		drp: new ZeroDeltaBranchDRP(),
		config: { log_config: { level: "silent" }, replica_mode: "writer" },
	});
}

function causalKeySetReplica(): DRPObject<CausalKeySetDRP> {
	return new DRPObject({
		peerId: "causal-key-set-writer",
		acl: createACL({ admins: [author.peerId] }),
		drp: new CausalKeySetDRP(),
		config: { log_config: { level: "silent" }, replica_mode: "writer" },
	});
}

function crossKeyTailReplica(): DRPObject<CrossKeyTailDRP> {
	return new DRPObject({
		peerId: "cross-key-tail-writer",
		acl: createACL({ admins: [author.peerId] }),
		drp: new CrossKeyTailDRP(),
		config: { log_config: { level: "silent" }, replica_mode: "writer" },
	});
}

async function signedVertex(
	opType: string,
	value: unknown[],
	dependencies: string[],
	timestamp: number,
	drpType = DrpType.DRP,
	signer = author
): Promise<Vertex> {
	const vertex = createVertex(signer.peerId, Operation.create({ drpType, opType, value }), dependencies, timestamp);
	vertex.signature = await signer.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

async function publicIngest(mode: ReplicaMode, surface: PublicIngest): Promise<void> {
	const receiver = replica(mode);
	const vertex = await signedVertex("append", [1], [HashGraph.rootHash], 1_700_000_000_001);
	if (surface === "applyVertices") {
		await expect(receiver.applyVertices([vertex])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
	} else {
		await expect(receiver.merge([vertex])).resolves.toEqual([true, [], []]);
	}
	expect(receiver.drp?.query_values()).toEqual([1]);
}

async function historyFixture(): Promise<HistoryFixture> {
	const first = await signedVertex("append", [1], [HashGraph.rootHash], 1_700_000_001_001);
	const grantGuest = await signedVertex(
		"grant",
		["guest-writer", ACLGroup.Writer],
		[first.hash],
		1_700_000_001_002,
		DrpType.ACL
	);
	const second = await signedVertex("append", [2], [grantGuest.hash], 1_700_000_001_003);
	const left = await signedVertex("append", [4], [second.hash], 1_700_000_001_004);
	const grantBranch = await signedVertex(
		"grant",
		["branch-writer", ACLGroup.Writer],
		[second.hash],
		1_700_000_001_005,
		DrpType.ACL
	);
	const join = await signedVertex("append", [6], [left.hash, grantBranch.hash], 1_700_000_001_006);
	const revokeBranch = await signedVertex(
		"revoke",
		["branch-writer", ACLGroup.Writer],
		[join.hash],
		1_700_000_001_007,
		DrpType.ACL
	);
	const concurrentTail = await signedVertex("append", [8], [join.hash], 1_700_000_001_008);
	const final = await signedVertex("append", [9], [revokeBranch.hash, concurrentTail.hash], 1_700_000_001_009);
	return [first, grantGuest, second, left, grantBranch, join, revokeBranch, concurrentTail, final];
}

async function branchJoinFixture(): Promise<BranchJoinFixture> {
	const first = await signedVertex("append", [1], [HashGraph.rootHash], 1_700_000_011_001);
	const grant = await signedVertex(
		"grant",
		["branch-join-guest", ACLGroup.Writer],
		[first.hash],
		1_700_000_011_002,
		DrpType.ACL
	);
	const second = await signedVertex("append", [2], [grant.hash], 1_700_000_011_003);
	const left = await signedVertex("append", [4], [second.hash], 1_700_000_011_004);
	const right = await signedVertex("append", [5], [second.hash], 1_700_000_011_005);
	const revoke = await signedVertex(
		"revoke",
		["branch-join-guest", ACLGroup.Writer],
		[left.hash, right.hash],
		1_700_000_011_006,
		DrpType.ACL
	);
	const final = await signedVertex("append", [7], [revoke.hash], 1_700_000_011_007);
	return [first, grant, second, left, right, revoke, final];
}

async function zeroDeltaBranchFixture(): Promise<ZeroDeltaBranchFixture> {
	const dependency = await signedVertex("setGoverned", [1], [HashGraph.rootHash], 1_700_000_021_001);
	const changedSibling = await signedVertex("setGoverned", [99], [dependency.hash], 1_700_000_021_002);
	const zeroDeltaSibling = await signedVertex("semanticNoOp", [], [dependency.hash], 1_700_000_021_003);
	const causalChild = await signedVertex("mark", ["child-of-no-op"], [zeroDeltaSibling.hash], 1_700_000_021_004);
	const join = await signedVertex("semanticNoOp", [], [changedSibling.hash, causalChild.hash], 1_700_000_021_005);
	return [dependency, changedSibling, zeroDeltaSibling, causalChild, join];
}

async function causalKeySetFixture(): Promise<CausalKeySetFixture> {
	const changedSibling = await signedVertex("changeSiblingKeySet", [], [HashGraph.rootHash], 1_700_000_031_001);
	const target = await signedVertex("mark", ["target-B"], [HashGraph.rootHash], 1_700_000_031_002);
	return [changedSibling, target];
}

async function causalACLFixture(): Promise<CausalACLFixture> {
	const grant = await signedVertex(
		"grant",
		[guest.peerId, ACLGroup.Writer],
		[HashGraph.rootHash],
		1_700_000_041_001,
		DrpType.ACL
	);
	const revoke = await signedVertex(
		"revoke",
		[guest.peerId, ACLGroup.Writer],
		[grant.hash],
		1_700_000_041_002,
		DrpType.ACL
	);
	const target = await signedVertex("mark", ["target-B"], [grant.hash], 1_700_000_041_003);
	const child = await signedVertex("mark", ["authorized-child"], [target.hash], 1_700_000_041_004, DrpType.DRP, guest);
	return [grant, revoke, target, child];
}

async function crossKeyTailFixture(): Promise<CrossKeyTailFixture> {
	const dependency = await signedVertex("setX", [1], [HashGraph.rootHash], 1_700_000_051_001);
	// These fixed signed inputs make B's child hash sort before A's; the test
	// independently asserts the resulting canonical D, B, A order.
	const pending = await signedVertex("setX", [2], [dependency.hash], 1_700_000_051_004);
	const tail = await signedVertex("deriveY", [], [dependency.hash], 1_700_000_051_002);
	const join = await signedVertex("mark", ["joined"], [pending.hash, tail.hash], 1_700_000_051_005);
	return [dependency, pending, tail, join];
}

function storedDRPState<T extends IDRP>(object: DRPObject<T>, hash: string): Record<string, unknown> {
	const state = (object as unknown as ObjectReflection)._states.getDRPState(hash);
	expect(state, `stored DRP snapshot for ${hash}`).toBeDefined();
	return Object.fromEntries(state?.state.map(({ key, value }) => [key, value]) ?? []);
}

function convergenceSnapshot(object: DRPObject<ObserverHistoryDRP>): {
	acl: { branch: boolean; guest: boolean };
	digest: string;
	orderedHashes: string[];
	values: number[] | undefined;
} {
	const reflection = object as unknown as ObjectReflection;
	const orderedVertices = reflection.hashGraph.linearizeVertices();
	const orderedHashes = orderedVertices.map(({ hash }) => hash);
	const values = object.drp?.query_values();
	const acl = {
		branch: object.acl.query_isWriter("branch-writer"),
		guest: object.acl.query_isWriter("guest-writer"),
	};
	const digestBuilder = createHash("sha256");
	for (const vertex of orderedVertices) digestBuilder.update(VertexCodec.encode(vertex).finish());
	const digest = digestBuilder.update(JSON.stringify({ acl, orderedHashes, values })).digest("hex");
	return { acl, digest, orderedHashes, values };
}

beforeAll(async () => {
	author = await identity("phase-1i-a-corrective-object-author");
	guest = await identity("phase-1i-a-causal-acl-guest");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Phase 1i-a untouched public authenticated ingest", () => {
	it.each([
		["writer", "applyVertices"],
		["writer", "merge"],
		["observer", "applyVertices"],
		["observer", "merge"],
	] as const)("%s %s invokes the real novelty classifier and accepts a signed vertex", async (mode, surface) => {
		await publicIngest(mode, surface);
	});
});

describe("Phase 1i-a contracts behind the bounded pre-drift causal control", () => {
	let restoreControl: (() => void) | undefined;

	beforeEach(() => {
		restoreControl = installObserverPreDriftControl();
	});

	afterEach(() => {
		restoreControl?.();
		restoreControl = undefined;
	});

	it("keeps public writer and observer ingest green while the control supplies no asserted result", async () => {
		for (const mode of ["writer", "observer"] as const) {
			for (const surface of ["applyVertices", "merge"] as const) await publicIngest(mode, surface);
		}
	});

	it("retains complete signed history and serves it across checkpoints and concurrent branches", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const vertices = await historyFixture();
		const writer = replica("writer");
		const observer = replica("observer");

		await expect(writer.applyVertices(vertices)).resolves.toMatchObject({ applied: true, invalid: [], missing: [] });
		await expect(observer.applyVertices([vertices[2], vertices[0], vertices[1]])).resolves.toMatchObject({
			applied: false,
			invalid: [],
			missing: [vertices[2].hash],
		});
		await expect(observer.applyVertices([vertices[2]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(observer.applyVertices([vertices[4], vertices[3]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(observer.applyVertices([vertices[8], vertices[7], vertices[6], vertices[5]])).resolves.toMatchObject({
			applied: false,
			invalid: [],
			missing: [vertices[8].hash, vertices[7].hash, vertices[6].hash],
		});
		await expect(observer.applyVertices([vertices[7], vertices[6]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(observer.applyVertices([vertices[8]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});

		const checkpoints = (observer as unknown as ObjectReflection)._applier.checkpoints;
		expect(checkpoints.length, "positive control: the fixture crosses multiple checkpoint boundaries").toBeGreaterThan(
			2
		);
		for (const vertex of vertices) {
			const stored = observer.getVertex(vertex.hash);
			expect.soft(stored, `observer must serve ${vertex.hash}`).toEqual(vertex);
			expect.soft(stored).not.toBe(vertex);
			expect
				.soft(stored === undefined ? undefined : VertexCodec.encode(stored).finish())
				.toEqual(VertexCodec.encode(vertex).finish());
		}

		const freshPeer = replica("writer");
		await expect(freshPeer.applyVertices(observer.vertices)).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(observer.vertices).toHaveLength(vertices.length + 1);
		expect(convergenceSnapshot(observer)).toEqual(convergenceSnapshot(writer));
		expect(convergenceSnapshot(freshPeer)).toEqual(convergenceSnapshot(writer));
	});

	it("converges linear, out-of-order and non-frontier replay on ordered history, digest, ACL and DRP state", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "4");
		const vertices = await historyFixture();
		const writer = replica("writer");
		const observerLinear = replica("observer");
		const observerNonFrontier = replica("observer");

		for (const vertex of vertices) {
			await expect(writer.applyVertices([vertex])).resolves.toMatchObject({ applied: true, invalid: [], missing: [] });
			await expect(observerLinear.applyVertices([vertex])).resolves.toMatchObject({
				applied: true,
				invalid: [],
				missing: [],
			});
		}
		await expect(observerNonFrontier.applyVertices([vertices[2], vertices[0], vertices[1]])).resolves.toMatchObject({
			applied: false,
			invalid: [],
			missing: [vertices[2].hash],
		});
		await expect(observerNonFrontier.applyVertices([vertices[2]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		for (const batch of [[vertices[3]], [vertices[4]]]) {
			await expect(observerNonFrontier.applyVertices(batch)).resolves.toMatchObject({
				applied: true,
				invalid: [],
				missing: [],
			});
		}
		await expect(observerNonFrontier.applyVertices([vertices[7], vertices[6], vertices[5]])).resolves.toMatchObject({
			applied: false,
			invalid: [],
			missing: [vertices[7].hash, vertices[6].hash],
		});
		await expect(observerNonFrontier.applyVertices([vertices[7], vertices[6]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(observerNonFrontier.applyVertices([vertices[8]])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});

		const expected = convergenceSnapshot(writer);
		expect(convergenceSnapshot(observerLinear)).toEqual(expected);
		expect(convergenceSnapshot(observerNonFrontier)).toEqual(expected);
	});

	it("keeps both concurrent DRP branches after an ACL join instead of checkpointing one causal branch", async () => {
		// Freeze the production default: the root replay forces its first checkpoint
		// on the two branch heads instead of checkpointing their shared parent early.
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "256");
		const [first, grant, second, left, right, revoke, final] = await branchJoinFixture();
		const common = [first, grant, second];
		const writerLeftRight = replica("writer");
		const writerRightLeft = replica("writer");
		const observer = replica("observer");

		for (const [target, history] of [
			[writerLeftRight, [...common, left, right, revoke, final]],
			[writerRightLeft, [...common, right, left, revoke, final]],
		] as const) {
			await expect(target.applyVertices([...history])).resolves.toMatchObject({
				applied: true,
				invalid: [],
				missing: [],
			});
		}
		await expect(observer.applyVertices([...common, left, right, revoke, final])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});

		const canonicalValues = (observer as unknown as ObjectReflection).hashGraph
			.linearizeVertices()
			.filter(({ operation }) => operation?.drpType === DrpType.DRP && operation.opType === "append")
			.map(({ operation }) => operation?.value[0]);
		expect(observer.drp?.query_values()).toEqual(canonicalValues);
		expect(observer.acl.query_isWriter("branch-join-guest")).toBe(false);
		for (const target of [observer, writerLeftRight, writerRightLeft]) {
			for (const vertex of [first, grant, second, left, right, revoke, final]) {
				const retained = target.getVertex(vertex.hash);
				expect.soft(retained).toBeDefined();
				expect
					.soft(retained === undefined ? undefined : VertexCodec.encode(retained).finish())
					.toEqual(VertexCodec.encode(vertex).finish());
			}
		}

		for (const writer of [writerLeftRight, writerRightLeft]) {
			expect.soft(writer.drp?.query_values()).toEqual(canonicalValues);
			expect.soft(writer.acl.query_isWriter("branch-join-guest")).toBe(false);
		}
	});

	it("keeps a zero-delta concurrent tail on its own causal cut through its child and whole-frontier join", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "256");
		const [dependency, changedSibling, zeroDeltaSibling, causalChild, join] = await zeroDeltaBranchFixture();

		const control = zeroDeltaReplica();
		await expect(control.applyVertices([dependency, zeroDeltaSibling, changedSibling])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(control.drp?.query_state(), "positive control: the whole frontier retains sibling A").toEqual({
			governed: 99,
			marker: "root",
		});
		expect(storedDRPState(control, zeroDeltaSibling.hash)).toMatchObject({ governed: 1, marker: "root" });

		const subject = zeroDeltaReplica();
		await expect(subject.applyVertices([dependency, changedSibling, zeroDeltaSibling])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(subject.drp?.query_state(), "positive control: immediate whole-frontier state is canonical").toEqual({
			governed: 99,
			marker: "root",
		});
		expect
			.soft(
				storedDRPState(subject, zeroDeltaSibling.hash),
				"sibling B is the pure dependency-to-B causal cut and excludes sibling A"
			)
			.toMatchObject({ governed: 1, marker: "root" });

		await expect(subject.applyVertices([causalChild])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect
			.soft(
				storedDRPState(subject, causalChild.hash),
				"B's child inherits B's causal value when it mutates only another key"
			)
			.toMatchObject({ governed: 1, marker: "child-of-no-op" });
		expect(subject.drp?.query_state(), "the concurrent whole frontier still includes sibling A").toEqual({
			governed: 99,
			marker: "child-of-no-op",
		});

		await expect(subject.applyVertices([join])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(subject.drp?.query_state(), "the explicit join deterministically combines both causal branches").toEqual({
			governed: 99,
			marker: "child-of-no-op",
		});
	});

	it("keeps a sibling-only key addition and deletion out of B's stored pair and serialized bytes", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "256");
		const [changedSibling, target] = await causalKeySetFixture();
		const pureCausal = causalKeySetReplica();
		await expect(pureCausal.applyVertices([target])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const expectedPair = pureCausal.getStates(target.hash);
		const expectedBytes = pureCausal.getSerializedStates(target.hash);

		for (const arrivalOrder of [
			[changedSibling, target],
			[target, changedSibling],
		] as const) {
			const subject = causalKeySetReplica();
			for (const vertex of arrivalOrder) {
				await expect(subject.applyVertices([vertex])).resolves.toMatchObject({
					applied: true,
					invalid: [],
					missing: [],
				});
			}

			expect.soft(subject.getStates(target.hash)).toEqual(expectedPair);
			expect.soft(subject.getSerializedStates(target.hash)).toEqual(expectedBytes);
			expect(subject.drp?.query_state(), "live state retains both whole-frontier key-set effects").toEqual({
				added: "sibling-added",
				marker: "target-B",
				removable: undefined,
			});
		}
	});

	it("excludes a concurrent revoke from B's stored ACL and authorizes B's child identically across arrival orders", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "256");
		const [grant, revoke, target, child] = await causalACLFixture();
		const pureCausal = causalKeySetReplica();
		await expect(pureCausal.applyVertices([grant, target])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const expectedACL = pureCausal.getStates(target.hash)[0];
		const expectedACLBytes = pureCausal.getSerializedStates(target.hash)[0];

		for (const arrivalOrder of [
			[revoke, target],
			[target, revoke],
		] as const) {
			const subject = causalKeySetReplica();
			await expect(subject.applyVertices([grant])).resolves.toMatchObject({
				applied: true,
				invalid: [],
				missing: [],
			});
			for (const vertex of arrivalOrder) {
				await expect(subject.applyVertices([vertex])).resolves.toMatchObject({
					applied: true,
					invalid: [],
					missing: [],
				});
			}

			expect(subject.acl.query_isWriter(guest.peerId), "live whole-frontier ACL includes the revoke").toBe(false);
			expect.soft(subject.getStates(target.hash)[0]).toEqual(expectedACL);
			expect.soft(subject.getSerializedStates(target.hash)[0]).toEqual(expectedACLBytes);
			await expect(subject.applyVertices([child])).resolves.toMatchObject({
				applied: true,
				invalid: [],
				missing: [],
			});
			expect(subject.getVertex(child.hash)).toEqual(child);
		}
	});

	it("keeps a causal B snapshot while replaying A's distinct-key derivation into live and joined state", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "1");
		const [dependency, pending, tail, join] = await crossKeyTailFixture();

		const pureCausal = crossKeyTailReplica();
		await expect(pureCausal.applyVertices([dependency, pending])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const expectedPendingPair = pureCausal.getStates(pending.hash);
		const expectedPendingBytes = pureCausal.getSerializedStates(pending.hash);
		expect(storedDRPState(pureCausal, pending.hash)).toMatchObject({ marker: "root", x: 2, y: 0 });

		const canonical = crossKeyTailReplica();
		await expect(canonical.applyVertices([dependency, pending, tail])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const fixtureHashes = new Set([dependency.hash, pending.hash, tail.hash]);
		const canonicalOrder = (canonical as unknown as ObjectReflection).hashGraph
			.linearizeVertices()
			.filter(({ hash }) => fixtureHashes.has(hash))
			.map(({ hash }) => hash);
		expect(canonicalOrder, "positive control: deterministic order is D, B, A").toEqual([
			dependency.hash,
			pending.hash,
			tail.hash,
		]);
		expect(canonical.drp?.query_state(), "positive control: canonical tail A derives y from B's x").toEqual({
			marker: "root",
			x: 2,
			y: 2,
		});
		await expect(canonical.applyVertices([join])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const expectedJoinPair = canonical.getStates(join.hash);
		const expectedJoinBytes = canonical.getSerializedStates(join.hash);
		expect(storedDRPState(canonical, join.hash)).toMatchObject({ marker: "joined", x: 2, y: 2 });

		const subject = crossKeyTailReplica();
		await expect(subject.applyVertices([dependency, tail])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(subject.applyVertices([pending])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect
			.soft(subject.getStates(pending.hash), "B's stored pair is the pure D-to-B causal image")
			.toEqual(expectedPendingPair);
		expect
			.soft(subject.getSerializedStates(pending.hash), "B's stored bytes exclude nondependency A's derived y")
			.toEqual(expectedPendingBytes);
		expect(subject.drp?.query_state(), "immediate live state replays tail A after newly arrived B").toEqual({
			marker: "root",
			x: 2,
			y: 2,
		});
		const checkpointFrontiers = (subject as unknown as ObjectReflection)._applier.checkpoints.map(
			({ frontier }) => frontier
		);
		expect(
			checkpointFrontiers.some(
				(frontier) => frontier.length === 2 && frontier.includes(pending.hash) && frontier.includes(tail.hash)
			),
			"positive control: suffix one checkpoints the B/A frontier before join C"
		).toBe(true);

		await expect(subject.applyVertices([join])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(subject.drp?.query_state(), "the forced checkpoint join preserves the whole-frontier image").toEqual({
			marker: "joined",
			x: 2,
			y: 2,
		});
		expect.soft(subject.getStates(join.hash), "join C stores the canonical union of B and A").toEqual(expectedJoinPair);
		expect
			.soft(subject.getSerializedStates(join.hash), "join C's bytes preserve A's derivation from B")
			.toEqual(expectedJoinBytes);
	});

	it("rolls back both observer snapshot sides when DRP discard rejects after ACL discard", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "256");
		const observer = replica("observer");
		const reflection = observer as unknown as ObjectReflection;
		const store = reflection._states;
		const vertex = await signedVertex("append", [41], [HashGraph.rootHash], 1_700_000_002_001);
		const events: string[] = [];
		const originalDeleteACL = store.deleteACLState.bind(store);
		const originalDeleteDRP = store.deleteDRPState.bind(store);
		const originalSetACL = store.setACLState.bind(store);
		let drpTargetCalls = 0;
		let awaitingACLRestore = false;
		let rollbackDRPJustDeleted = false;

		vi.spyOn(store, "deleteACLState").mockImplementation((hash, expected) => {
			const deleted = originalDeleteACL(hash, expected);
			if (hash === vertex.hash) {
				if (rollbackDRPJustDeleted) {
					events.push(`acl-rollback-delete:${deleted}`);
					rollbackDRPJustDeleted = false;
				} else {
					events.push(`acl-discard-delete:${deleted}`);
					awaitingACLRestore = deleted;
				}
			}
			return deleted;
		});
		vi.spyOn(store, "deleteDRPState").mockImplementation((hash, expected) => {
			if (hash !== vertex.hash) return originalDeleteDRP(hash, expected);
			drpTargetCalls++;
			if (drpTargetCalls % 2 === 1) {
				events.push("drp-delete:rejected");
				return false;
			}
			const deleted = originalDeleteDRP(hash, expected);
			events.push(`drp-rollback-delete:${deleted}`);
			rollbackDRPJustDeleted = deleted;
			return deleted;
		});
		vi.spyOn(store, "setACLState").mockImplementation((hash, state) => {
			if (hash === vertex.hash && awaitingACLRestore) {
				events.push("acl-restore");
				awaitingACLRestore = false;
			}
			originalSetACL(hash, state);
		});

		await expect(observer.applyVertices([vertex])).resolves.toEqual({
			applied: false,
			invalid: [],
			missing: [],
			quarantined: [vertex.hash],
		});
		expect(events.filter((event) => event === "drp-delete:rejected")).toHaveLength(3);
		expect(events.filter((event) => event === "acl-restore")).toHaveLength(3);
		expect(events.filter((event) => event === "drp-rollback-delete:true")).toHaveLength(3);
		expect(events.filter((event) => event === "acl-discard-delete:true")).toHaveLength(3);
		expect(events.filter((event) => event === "acl-rollback-delete:true")).toHaveLength(3);
		expect(store.getACLState(vertex.hash)).toBeUndefined();
		expect(store.getDRPState(vertex.hash)).toBeUndefined();
		expect(observer.getVertex(vertex.hash)).toBeUndefined();
		expect(observer.drp?.query_values()).toEqual([]);
	});
});
