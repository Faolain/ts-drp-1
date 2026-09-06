/**
 * Phase 1n-d aggregate RED: compose the accepted heads, recovery, negotiated
 * transport, and retry owners through one real partition/rejoin episode.
 *
 * The relational oracle deliberately changes only retained shared history.
 * Every measured unit is an outer Message handed to the real negotiated
 * sender; authenticated ingress corroborates the protocol selected by the
 * stream. The fallback fixture's single private action is the plan-authorized
 * removal of the additive handler from one real receiver.
 */
import { type Libp2p } from "@libp2p/interface";
import {
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	isDirectSyncIngress,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
	SYNC_FALLBACK_HASH_CAP,
	SYNC_HEADS_FIELD_HASH_CAP,
	SYNC_HEADS_TOTAL_HASH_CAP,
	SYNC_OUTSTANDING_EXACT_CAP,
	SYNC_REQUEST_BYTE_CAP,
	SYNC_RESPONSE_BYTE_CAP,
	SYNC_RESPONSE_CHUNK_CAP,
	SYNC_RESPONSE_VERTEX_CAP,
	SyncTransportError,
} from "@ts-drp/network";
import { createACL, DRPObject, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	Sync,
	SyncAccept,
	Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test } from "vitest";

import { signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

const ANTI_ENTROPY_INTERVAL_MS = 60_000;
const QUIESCENCE_MS = 250;
const SHORT_PREFIX = 16;
const LONG_PREFIX = 80;

type Role = "a" | "b" | "c";

interface Emission {
	readonly bytes: number;
	readonly from: Role;
	readonly message: Message;
	readonly ordinal: number;
	selection?: SelectedSyncProtocol;
	status: "failed" | "pending" | "succeeded";
	readonly to: string;
}

interface IngressObservation {
	readonly bytes: number;
	readonly message: Message;
	readonly mode: SelectedSyncProtocol["mode"];
	readonly peerId: string;
	readonly protocol: SelectedSyncProtocol["protocol"];
	readonly to: Role;
}

interface EpisodeSnapshot {
	readonly byDirection: Readonly<Record<"a->b" | "b->a", DirectionSnapshot>>;
	readonly rejectedCooldownEntries: number;
	readonly suppressed: number;
	readonly total: DirectionSnapshot;
}

interface DirectionSnapshot {
	readonly bytes: number;
	readonly recoveryProbes: number;
	readonly recoveryRounds: number;
	readonly requests: number;
	readonly responses: number;
}

interface CorpusResult {
	readonly missingEncodedLengths: number[];
	readonly missingOperations: string[];
	readonly missingParentShape: number[][];
	readonly missingPeerIds: string[];
	readonly prefixCount: number;
	readonly snapshot: EpisodeSnapshot;
}

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(_label: string): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

class WireTelemetry {
	readonly emissions: Emission[] = [];
	readonly ingresses: IngressObservation[] = [];
	readonly failures: unknown[] = [];
	readonly rejectedByRole = new Map<Role, number>();
	private active = false;
	private inflight = 0;
	private ordinal = 0;
	private peerIds = new Map<Role, string>();
	private suppressed = 0;

	register(role: Role, node: DRPNode): void {
		this.peerIds.set(role, node.networkNode.peerId);
		node.addEventListener(NodeEventName.DRP_SYNC_REJECTED, () => {
			if (!this.active) return;
			this.rejectedByRole.set(role, (this.rejectedByRole.get(role) ?? 0) + 1);
		});
		node.networkNode.subscribeToMessageQueue((candidate) => {
			if (!this.active || !isDirectSyncIngress(candidate)) return;
			if (!this.isMeasuredPair(candidate.peerId, node.networkNode.peerId)) return;
			this.ingresses.push({
				bytes: Message.encode(candidate.message).finish().byteLength,
				message: candidate.message,
				mode: candidate.mode,
				peerId: candidate.peerId,
				protocol: candidate.protocol,
				to: role,
			});
		});
	}

	start(): void {
		this.active = true;
	}

	stop(): void {
		this.active = false;
	}

	async settled(): Promise<void> {
		await expect.poll(() => this.inflight, { interval: 10, timeout: 10_000 }).toBe(0);
		await expect
			.poll(() => this.ingresses.length, { interval: 10, timeout: 10_000 })
			.toBeGreaterThanOrEqual(this.emissions.filter(({ status }) => status === "succeeded").length);
	}

	async quiescent(): Promise<void> {
		await this.settled();
		const emissionCount = this.emissions.length;
		const ingressCount = this.ingresses.length;
		await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_MS));
		expect(this.inflight, "sync-family traffic remained in flight at the quiescence deadline").toBe(0);
		expect(this.emissions, "a sync-family message appeared during the fixed settle budget").toHaveLength(emissionCount);
		expect(this.ingresses, "a sync-family ingress appeared during the fixed settle budget").toHaveLength(ingressCount);
	}

	sender(role: Role, node: () => DRPNode): NegotiatedSyncSender {
		return {
			sendSyncMessage: async (peerId, payloadFactory, options): Promise<void> => {
				this.inflight++;
				let emission: Emission | undefined;
				try {
					await (node().networkNode as unknown as NegotiatedSyncSender).sendSyncMessage(
						peerId,
						async (selection) => {
							const message = await payloadFactory(selection);
							emission = this.begin(role, peerId, message, selection);
							return message;
						},
						options
					);
					if (emission !== undefined) emission.status = "succeeded";
				} catch (error) {
					if (emission !== undefined) emission.status = "failed";
					if (this.active && this.isMeasuredPair(this.peerIds.get(role) ?? "", peerId)) {
						if (error instanceof SyncTransportError && error.code === "SYNC_SEND_SUPPRESSED") this.suppressed++;
						else this.failures.push(error);
					}
					throw error;
				} finally {
					this.inflight--;
				}
			},
			sendSyncResponseMessage: async (peerId, message, options): Promise<void> => {
				this.inflight++;
				const emission = this.begin(role, peerId, message);
				try {
					await (node().networkNode as unknown as NegotiatedSyncSender).sendSyncResponseMessage(
						peerId,
						message,
						options
					);
					if (emission !== undefined) emission.status = "succeeded";
				} catch (error) {
					if (emission !== undefined) emission.status = "failed";
					if (this.active && this.isMeasuredPair(this.peerIds.get(role) ?? "", peerId)) this.failures.push(error);
					throw error;
				} finally {
					this.inflight--;
				}
			},
		};
	}

	snapshot(): EpisodeSnapshot {
		const succeeded = this.emissions.filter(({ status }) => status === "succeeded");
		const direction = (from: Role, to: Role): DirectionSnapshot =>
			summarize(succeeded.filter((emission) => emission.from === from && emission.to === this.peerIds.get(to)));
		return {
			byDirection: { "a->b": direction("a", "b"), "b->a": direction("b", "a") },
			rejectedCooldownEntries: [...this.rejectedByRole.values()].reduce((sum, count) => sum + count, 0),
			suppressed: this.suppressed,
			total: summarize(succeeded),
		};
	}

	private begin(from: Role, to: string, message: Message, selection?: SelectedSyncProtocol): Emission | undefined {
		if (!this.active || !this.isMeasuredPair(this.peerIds.get(from) ?? "", to)) return undefined;
		const emission: Emission = {
			bytes: Message.encode(message).finish().byteLength,
			from,
			message,
			ordinal: this.ordinal++,
			selection,
			status: "pending",
			to,
		};
		this.emissions.push(emission);
		return emission;
	}

	private isMeasuredPair(left: string, right: string): boolean {
		const a = this.peerIds.get("a");
		const b = this.peerIds.get("b");
		return (left === a && right === b) || (left === b && right === a);
	}
}

function summarize(emissions: readonly Emission[]): DirectionSnapshot {
	const requests = emissions.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC);
	const requestedMultisets = requests
		.map(({ message }) => [...Sync.decode(message.data).requestedHashes].sort())
		.filter((hashes) => hashes.length !== 0);
	let recoveryRounds = 0;
	let previous: string[] | undefined;
	for (const current of requestedMultisets) {
		const prior = previous;
		if (
			prior === undefined ||
			current.length !== prior.length ||
			current.some((hash, index) => hash !== prior[index])
		) {
			recoveryRounds++;
		}
		previous = current;
	}
	return {
		bytes: emissions.reduce((sum, { bytes }) => sum + bytes, 0),
		recoveryProbes: requestedMultisets.length,
		recoveryRounds,
		requests: requests.length,
		responses: emissions.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT).length,
	};
}

const running: DRPNode[] = [];

function makeNode(role: Role, seed: string, telemetry: WireTelemetry): DRPNode {
	const owner: { node?: DRPNode } = {};
	const node: DRPNode = new DRPNode(
		{
			interval_sync_options: { interval: ANTI_ENTROPY_INTERVAL_MS },
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
		},
		{
			syncSender: telemetry.sender(role, (): DRPNode => {
				if (owner.node === undefined) throw new Error("Node transport used during construction");
				return owner.node;
			}),
		}
	);
	owner.node = node;
	return node;
}

function aclFor(nodes: readonly DRPNode[]): ReturnType<typeof createACL> {
	const acl = createACL({ admins: nodes.map(({ networkNode }) => networkNode.peerId) });
	for (const node of nodes) {
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

async function replicas(nodes: readonly DRPNode[]): Promise<{ id: string; objects: IDRPObject<CounterDRP>[] }> {
	const creator = await nodes[0].createObject({ acl: aclFor(nodes), drp: new CounterDRP() });
	const objects: IDRPObject<CounterDRP>[] = [creator];
	for (const node of nodes.slice(1)) {
		objects.push(await node.createObject({ acl: aclFor(nodes), drp: new CounterDRP(), id: creator.id }));
	}
	return { id: creator.id, objects };
}

function nonRoot(vertices: readonly Vertex[]): Vertex[] {
	return vertices.filter(({ hash }) => hash !== HashGraph.rootHash);
}

function sameHeads(left: IDRPObject<IDRP>, right: IDRPObject<IDRP>): boolean {
	const a = [...left.getHistoryHeads()].sort();
	const b = [...right.getHistoryHeads()].sort();
	return a.length === b.length && a.every((hash, index) => hash === b[index]);
}

function samePublicState(left: IDRPObject<CounterDRP>, right: IDRPObject<CounterDRP>): boolean {
	return left.drp?.value === right.drp?.value;
}

async function waitForConnection(left: DRPNode, right: DRPNode, connected: boolean): Promise<void> {
	await expect
		.poll(
			() =>
				left.networkNode.getAllPeers().includes(right.networkNode.peerId) === connected &&
				right.networkNode.getAllPeers().includes(left.networkNode.peerId) === connected,
			{ interval: 10, timeout: 10_000 }
		)
		.toBe(true);
}

async function waitForBidirectionalGroupReadiness(left: DRPNode, right: DRPNode, id: string): Promise<void> {
	await expect
		.poll(
			() =>
				left.networkNode.getGroupPeers(id).includes(right.networkNode.peerId) &&
				right.networkNode.getGroupPeers(id).includes(left.networkNode.peerId),
			{ interval: 10, timeout: 10_000 }
		)
		.toBe(true);
}

function addresses(node: DRPNode): string[] {
	const values = node.networkNode.getMultiaddrs();
	if (values === undefined || values.length === 0) throw new Error("Expected public listen addresses");
	return values;
}

async function mergeExactly(target: IDRPObject<CounterDRP>, vertices: readonly Vertex[]): Promise<void> {
	await expect(target.merge([...vertices])).resolves.toEqual([true, [], []]);
}

function assertFrameCeilings(emissions: readonly Emission[]): void {
	let responsesSinceRequest = 0;
	const exactHashes = new Set<string>();
	for (const { bytes, message, selection } of [...emissions].sort((left, right) => left.ordinal - right.ordinal)) {
		if (message.type === MessageType.MESSAGE_TYPE_SYNC) {
			responsesSinceRequest = 0;
			const payload = Sync.decode(message.data);
			expect(selection).toEqual({ mode: "heads-chunk", protocol: DRP_HEADS_CHUNK_PROTOCOL });
			expect(payload.vertexHashes, "current/current traffic must not emit fallback inventory").toEqual([]);
			expect(payload.heads.length).toBeLessThanOrEqual(SYNC_HEADS_FIELD_HASH_CAP);
			expect(payload.sharedHeads.length).toBeLessThanOrEqual(SYNC_HEADS_FIELD_HASH_CAP);
			expect(payload.requestedHashes.length).toBeLessThanOrEqual(SYNC_HEADS_FIELD_HASH_CAP);
			for (const hash of payload.requestedHashes) exactHashes.add(hash);
			expect(payload.heads.length + payload.sharedHeads.length + payload.requestedHashes.length).toBeLessThanOrEqual(
				SYNC_HEADS_TOTAL_HASH_CAP
			);
			expect(bytes).toBeLessThanOrEqual(SYNC_REQUEST_BYTE_CAP);
			continue;
		}
		if (message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT) {
			responsesSinceRequest++;
			const payload = SyncAccept.decode(message.data);
			expect(payload.requested.length).toBeLessThanOrEqual(SYNC_RESPONSE_VERTEX_CAP);
			expect(bytes).toBeLessThanOrEqual(SYNC_RESPONSE_BYTE_CAP);
			expect(responsesSinceRequest).toBeLessThanOrEqual(SYNC_RESPONSE_CHUNK_CAP);
		}
	}
	expect(exactHashes.size).toBeLessThanOrEqual(SYNC_OUTSTANDING_EXACT_CAP);
}

function assertIngressCorroborates(telemetry: WireTelemetry): void {
	const emissions = telemetry.emissions.filter(({ status }) => status === "succeeded");
	expect(telemetry.ingresses).toHaveLength(emissions.length);
	for (const ingress of telemetry.ingresses) {
		expect(ingress.protocol).toBe(DRP_HEADS_CHUNK_PROTOCOL);
		expect(ingress.mode).toBe("heads-chunk");
	}
	const emissionMultiset = emissions.map(({ bytes, message }) => `${message.type}:${bytes}`).sort();
	const ingressMultiset = telemetry.ingresses.map(({ bytes, message }) => `${message.type}:${bytes}`).sort();
	// Authenticated ingress is corroboration only; exact outer bytes and counts
	// above remain sourced from successful real-sender emissions.
	expect(ingressMultiset).toEqual(emissionMultiset);
}

function missingContract(
	vertices: readonly Vertex[],
	shared: ReadonlySet<string>
): Omit<CorpusResult, "prefixCount" | "snapshot"> {
	const localIndex = new Map(vertices.map((vertex, index) => [vertex.hash, index]));
	return {
		missingEncodedLengths: vertices.map((vertex) => Vertex.encode(vertex).finish().byteLength).sort((a, b) => a - b),
		missingOperations: vertices.map((vertex) =>
			Buffer.from(Operation.encode(vertex.operation ?? Operation.create()).finish()).toString("hex")
		),
		missingParentShape: vertices.map((vertex) =>
			vertex.dependencies.flatMap((hash) => {
				const index = localIndex.get(hash);
				if (index !== undefined) return [index];
				if (shared.has(hash)) return [-1];
				throw new Error(`Missing DAG dependency ${hash} is neither local nor shared`);
			})
		),
		missingPeerIds: [...new Set(vertices.map(({ peerId }) => peerId))].sort(),
	};
}

async function runCorpus(prefixCount: number): Promise<CorpusResult> {
	const telemetry = new WireTelemetry();
	const nodes = [
		makeNode("a", "phase-1n-d-aggregate-a", telemetry),
		makeNode("b", "phase-1n-d-aggregate-b", telemetry),
		makeNode("c", "phase-1n-d-aggregate-c", telemetry),
	] as const;
	running.push(...nodes);
	await Promise.all(nodes.map((node) => node.start()));
	for (const [index, node] of nodes.entries()) telemetry.register((["a", "b", "c"] as const)[index], node);

	// Establish and sever the real A/B link before the object workload. The
	// retained prefix and both partition branches are then materialized without
	// sync-family traffic.
	await nodes[0].networkNode.connect(addresses(nodes[1]));
	await waitForConnection(nodes[0], nodes[1], true);
	await nodes[0].networkNode.disconnect(nodes[1].networkNode.peerId);
	await waitForConnection(nodes[0], nodes[1], false);

	const { id, objects } = await replicas(nodes);
	for (let index = 0; index < prefixCount; index++) objects[0].drp?.increment(`prefix-${index}`);
	await signGeneratedVertices(nodes[0], objects[0].vertices);
	const prefix = nonRoot(objects[0].vertices);
	await mergeExactly(objects[1], prefix);
	await mergeExactly(objects[2], prefix);

	objects[1].drp?.increment("shared-b-constant");
	await signGeneratedVertices(nodes[1], objects[1].vertices);
	const bShared = nonRoot(objects[1].vertices).filter(
		({ hash, peerId }) => peerId === nodes[1].networkNode.peerId && objects[0].getVertex(hash) === undefined
	);
	expect(bShared).toHaveLength(1);
	await mergeExactly(objects[0], bShared);
	await mergeExactly(objects[2], bShared);
	const sharedVertices = nonRoot(objects[0].vertices);
	expect(sharedVertices).toHaveLength(prefixCount + 1);
	const sharedHashes = new Set(objects[0].vertices.map(({ hash }) => hash));
	expect(sharedVertices.some(({ peerId }) => peerId === nodes[1].networkNode.peerId)).toBe(true);
	expect(nonRoot(objects[1].vertices).some(({ peerId }) => peerId === nodes[0].networkNode.peerId)).toBe(true);

	// Author the partition branches on unsubscribed public objects and merge the
	// signed vertices into the live replicas. This is non-sync conditioning and
	// prevents queued pubsub UPDATEs from racing the measured reconnect owner.
	const authors = nodes.map(
		(node) =>
			new DRPObject<CounterDRP>({
				acl: aclFor(nodes),
				drp: new CounterDRP(),
				id,
				peerId: node.networkNode.peerId,
			})
	);
	await Promise.all(authors.map((author) => mergeExactly(author, sharedVertices)));
	for (const label of ["a-0", "a-1", "a-2"]) authors[0].drp?.increment(label);
	for (const label of ["b-0", "b-1"]) authors[1].drp?.increment(label);
	for (const label of ["old-0", "old-1"]) authors[2].drp?.increment(label);
	await Promise.all(nodes.map((node, index) => signGeneratedVertices(node, authors[index].vertices)));
	const authoredBranches = authors.map((author) =>
		nonRoot(author.vertices).filter(({ hash }) => !sharedHashes.has(hash))
	);
	for (const [index, branch] of authoredBranches.entries()) {
		await mergeExactly(objects[index], branch);
	}
	for (const [index, object] of objects.entries()) {
		expect(authoredBranches[index].every(({ hash }) => object.getVertex(hash) !== undefined)).toBe(true);
		expect(
			authoredBranches
				.filter((_, branchIndex) => branchIndex !== index)
				.flat()
				.every(({ hash }) => object.getVertex(hash) === undefined),
			"pre-window pubsub/message-queue delivery must not transfer a missing branch"
		).toBe(true);
	}
	const missing = objects.flatMap((object) => nonRoot(object.vertices).filter(({ hash }) => !sharedHashes.has(hash)));
	const contract = missingContract(missing, sharedHashes);

	expect(missing).toHaveLength(7);
	expect(new Set(missing.map(({ hash }) => hash)).size).toBe(7);
	expect(telemetry.emissions, "prefix construction must not use sync-family transport").toEqual([]);
	expect(telemetry.ingresses, "prefix construction must not receive sync-family transport").toEqual([]);
	await telemetry.quiescent();

	telemetry.start();
	await nodes[0].networkNode.connect(addresses(nodes[1]));
	await waitForConnection(nodes[0], nodes[1], true);
	await waitForBidirectionalGroupReadiness(nodes[0], nodes[1], id);
	// Both sides already retain remote-authored history, so public group
	// readiness cannot start the reconnect-owned initial probe. Keep telemetry
	// active and prove no hidden sync-family owner crosses the fixed quiet
	// barrier before the deterministic explicit driver begins.
	await telemetry.quiescent();

	for (
		let attempt = 0;
		attempt < 12 && (!sameHeads(objects[0], objects[1]) || !samePublicState(objects[0], objects[1]));
		attempt++
	) {
		await nodes[attempt % 2].syncObject(id, nodes[(attempt + 1) % 2].networkNode.peerId);
		await telemetry.quiescent();
	}
	expect(sameHeads(objects[0], objects[1]), "partition branches did not converge").toBe(true);
	expect(samePublicState(objects[0], objects[1]), "partition DRP states did not converge").toBe(true);

	// Delayed old-branch injection happens only after A/B advanced their shared
	// frontier. Public merge supplies the signed branch; network recovery remains
	// wholly on the measured real A/B path.
	const oldBranch = nonRoot(objects[2].vertices).filter(({ hash }) => !sharedHashes.has(hash));
	await mergeExactly(objects[1], oldBranch);
	expect(sameHeads(objects[0], objects[1]), "old branch must reopen divergence").toBe(false);
	for (
		let attempt = 0;
		attempt < 8 && (!sameHeads(objects[0], objects[1]) || !samePublicState(objects[0], objects[1]));
		attempt++
	) {
		await nodes[attempt % 2].syncObject(id, nodes[(attempt + 1) % 2].networkNode.peerId);
		await telemetry.quiescent();
	}
	expect(sameHeads(objects[0], objects[1]), "delayed old branch was not recovered").toBe(true);
	expect(samePublicState(objects[0], objects[1]), "state diverged after old-branch recovery").toBe(true);

	// Exactly one public confirmation in each direction, including all causal
	// fan-out, closes the measured episode.
	await nodes[0].syncObject(id, nodes[1].networkNode.peerId);
	await nodes[1].syncObject(id, nodes[0].networkNode.peerId);
	await telemetry.quiescent();
	expect(sameHeads(objects[0], objects[1])).toBe(true);
	expect(samePublicState(objects[0], objects[1])).toBe(true);
	telemetry.stop();

	expect(telemetry.failures, "every non-suppression send failure is fatal").toEqual([]);
	expect(telemetry.emissions.some(({ message }) => Sync.decode(message.data).requestedHashes.length > 0)).toBe(true);
	expect(telemetry.emissions.some(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT)).toBe(true);
	assertFrameCeilings(telemetry.emissions.filter(({ status }) => status === "succeeded"));
	assertIngressCorroborates(telemetry);
	const snapshot = telemetry.snapshot();
	expect(snapshot.suppressed).toBe(0);
	expect(snapshot.rejectedCooldownEntries).toBe(0);
	expect(telemetry.emissions.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC_REJECT)).toEqual(
		[]
	);
	expect(snapshot.total.recoveryProbes).toBeGreaterThan(0);
	expect(snapshot.total.recoveryRounds).toBeGreaterThan(0);
	expect(snapshot.total.requests).toBeGreaterThan(2);
	expect(snapshot.total.responses).toBeGreaterThan(0);

	return { ...contract, prefixCount: sharedVertices.length, snapshot };
}

function fallbackHost(node: DRPNode): Libp2p {
	const host = (node.networkNode as unknown as { readonly _node?: Libp2p })._node;
	if (host === undefined) throw new Error("Expected a started real libp2p host");
	return host;
}

describe("Phase 1n-d aggregate convergence and delta cost", () => {
	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test("keeps recursive partition/rejoin work exactly independent of retained shared history", async () => {
		const short = await runCorpus(SHORT_PREFIX);
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
		const long = await runCorpus(LONG_PREFIX);

		expect(long.prefixCount).toBeGreaterThanOrEqual(short.prefixCount * 4);
		expect(long.prefixCount - short.prefixCount).toBeGreaterThanOrEqual(64);
		expect(long.missingParentShape).toEqual(short.missingParentShape);
		expect(long.missingOperations).toEqual(short.missingOperations);
		expect(long.missingPeerIds).toEqual(short.missingPeerIds);
		expect(long.missingEncodedLengths).toEqual(short.missingEncodedLengths);
		expect
			.soft(long.snapshot, "C9 aggregate work must be exactly retained-history independent")
			.toEqual(short.snapshot);
	}, 60_000);

	test("uses one bounded field-1 request only against an authentically fallback-only receiver", async () => {
		const telemetry = new WireTelemetry();
		const current = makeNode("a", "phase-1n-d-fallback-current", telemetry);
		const fallback = makeNode("b", "phase-1n-d-fallback-receiver", telemetry);
		const author = makeNode("c", "phase-1n-d-fallback-author", telemetry);
		running.push(current, fallback, author);
		await Promise.all(running.map((node) => node.start()));
		telemetry.register("a", current);
		telemetry.register("b", fallback);
		telemetry.register("c", author);

		const { id, objects } = await replicas([current, fallback, author]);
		for (const label of ["shared-0", "shared-1"]) objects[0].drp?.increment(label);
		await signGeneratedVertices(current, objects[0].vertices);
		await mergeExactly(objects[1], nonRoot(objects[0].vertices));
		await mergeExactly(objects[2], nonRoot(objects[0].vertices));

		// The only private capability action authorized for this fixture.
		await fallbackHost(fallback).unhandle(DRP_HEADS_CHUNK_PROTOCOL);
		await current.networkNode.connect(addresses(fallback));
		await waitForConnection(current, fallback, true);
		await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_MS));

		// Inject a signed branch through public merge after connection setup so
		// pubsub cannot preempt the explicit fallback exchange.
		for (const label of ["fallback-0", "fallback-1"]) objects[2].drp?.increment(label);
		await signGeneratedVertices(author, objects[2].vertices);
		await mergeExactly(
			objects[1],
			nonRoot(objects[2].vertices).filter(({ hash }) => objects[1].getVertex(hash) === undefined)
		);
		const advertisedInventory = [...objects[0].historyInventory.knownHashes];
		telemetry.start();
		await current.syncObject(id, fallback.networkNode.peerId);
		await telemetry.quiescent();
		telemetry.stop();

		const sent = telemetry.emissions.filter(({ status }) => status === "succeeded");
		const requests = sent.filter(({ from, message }) => from === "a" && message.type === MessageType.MESSAGE_TYPE_SYNC);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		const fallbackPayload = Sync.decode(request.message.data);
		expect(request.selection).toEqual({ mode: "fallback", protocol: DRP_MESSAGE_PROTOCOL });
		expect(fallbackPayload).toMatchObject({ heads: [], requestedHashes: [], sharedHeads: [] });
		expect(fallbackPayload.vertexHashes).toEqual(advertisedInventory);
		expect(fallbackPayload.vertexHashes.length).toBeLessThanOrEqual(SYNC_FALLBACK_HASH_CAP);
		expect(request.bytes).toBeLessThanOrEqual(SYNC_REQUEST_BYTE_CAP);
		const requestIngress = telemetry.ingresses.find(
			({ message, peerId, to }) =>
				to === "b" && peerId === current.networkNode.peerId && message.type === MessageType.MESSAGE_TYPE_SYNC
		);
		expect(requestIngress).toMatchObject({ mode: "fallback", protocol: DRP_MESSAGE_PROTOCOL });

		const responseIngress = telemetry.ingresses.find(
			({ message, peerId, to }) =>
				to === "a" && peerId === fallback.networkNode.peerId && message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT
		);
		expect(responseIngress).toMatchObject({ mode: "heads-chunk", protocol: DRP_HEADS_CHUNK_PROTOCOL });
		const responses = sent.filter(
			({ from, message }) => from === "b" && message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT
		);
		expect(responses).toHaveLength(1);
		expect(SyncAccept.decode(responses[0].message.data).requested.length).toBeLessThanOrEqual(SYNC_RESPONSE_VERTEX_CAP);
		expect(responses[0].bytes).toBeLessThanOrEqual(SYNC_RESPONSE_BYTE_CAP);
		expect(sameHeads(objects[0], objects[1])).toBe(true);
		expect(samePublicState(objects[0], objects[1])).toBe(true);
		expect(telemetry.failures).toEqual([]);
		expect(telemetry.snapshot().rejectedCooldownEntries).toBe(0);
	}, 30_000);
});
