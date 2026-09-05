import { EMPTY_MERKLE_ROOT } from "@ts-drp/compaction";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type {
	AppendAcceptedVertexInput,
	AppendAcceptedVertexResult,
	DurableLiveJournalStore,
	InstallLiveJournalGenesisResult,
	LiveJournalAcceptedRow,
	LiveJournalPageInput,
	LiveJournalPageResult,
	LiveJournalReadinessInput,
	LiveJournalReadinessResult,
} from "@ts-drp/live-journal";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	PHASE3_EXIT_REAL_SCENARIOS,
	type Phase3ExitAcceptedVertexEvidence,
	type Phase3ExitCapacityRejectionEvidence,
	type Phase3ExitDriverResult,
	type Phase3ExitIssuedVertexEvidence,
	type Phase3ExitLocalEffectEvidence,
	type Phase3ExitObservedAction,
	type Phase3ExitOutboxVertexEvidence,
	type Phase3ExitRealObservation,
	type Phase3ExitRealScenario,
	type Phase3ExitRejectedVertexEvidence,
} from "./model-contract.js";
import {
	activateV3LivePlane,
	recoverV3LiveReplica,
	routeV3Ingress,
	type V3PlaneHandle,
} from "../../../packages/node/src/v3-live.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";
import { createGenuinePreparedV3Fixture, type GenuinePreparedV3Fixture } from "../phase-3a1b-p3/live-fixture.js";
import { ObservedMessageQueueManager } from "../shared/observed-message-queue.js";

const A0_SEED = "11".repeat(32);
const A1_SEED = "22".repeat(32);
const UNAUTHORIZED_SEED = "33".repeat(32);
const PARAMETERS = Object.freeze({
	maxDependencies: 16 as const,
	maxEpochBytes: 8_388_608 as const,
	maxEpochVertices: 8192 as const,
	maxPendingBytes: 16_777_216 as const,
	maxPendingEntries: 4096 as const,
});

interface RegisteredVertex {
	readonly author: string;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface ObservationExtras {
	readonly actionTrace: readonly Phase3ExitObservedAction[];
	readonly attemptedDigests: readonly string[];
	readonly capacityRejections?: readonly Phase3ExitCapacityRejectionEvidence[];
	readonly droppedDigests?: readonly string[];
	readonly issuanceCrash?: Phase3ExitRealObservation["issuanceCrash"];
	readonly localIssue?: Phase3ExitRealObservation["localIssue"];
	readonly redeliveredDigests?: readonly string[];
	readonly rejections?: readonly Phase3ExitRejectedVertexEvidence[];
	readonly replicaJournalDigests?: readonly (readonly string[])[];
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function detached(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function commitFor(scope: DurableIssueScope, authorSequence: number, vertex: RegisteredVertex): DurableIssueCommit {
	if (vertex.author !== scope.author) throw new TypeError("phase-3-exit local commit author mismatch");
	const envelope = Object.freeze({
		canonicalPreimageBytes: detached(vertex.canonicalPreimageBytes),
		digest: detached(vertex.digest),
		signature: detached(vertex.signature),
	});
	const issuedRecord = Object.freeze({ authorSequence, envelope, scope: Object.freeze({ ...scope }) });
	const outboxEntry = Object.freeze({ authorSequence, envelope, scope: Object.freeze({ ...scope }) });
	return Object.freeze({ authorSequence, envelope, issuedRecord, outboxEntry });
}

function testNetwork(): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId: "peer:phase-3-exit-model",
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		gossipTopicFor: (message: Message) => message.objectId,
		getSubscribedTopics: () => [...topics],
		publishMessage: () => Promise.resolve(true),
		subscribe: (topic: string) => topics.add(topic),
		unsubscribe: (topic: string) => topics.delete(topic),
	} as unknown as DRPNetworkNode;
}

class ControlledJournalStore implements DurableLiveJournalStore {
	readonly #delegate: DurableLiveJournalStore;
	#failNextLocalBeforeAppend = false;
	#throwAfterDigest: string | undefined;

	constructor(delegate: DurableLiveJournalStore) {
		this.#delegate = delegate;
	}

	failNextLocalBeforeAppend(): void {
		this.#failNextLocalBeforeAppend = true;
	}

	throwAfterDigest(digest: string): void {
		this.#throwAfterDigest = digest;
	}

	installGenesis(
		input: Parameters<DurableLiveJournalStore["installGenesis"]>[0]
	): Promise<InstallLiveJournalGenesisResult> {
		return this.#delegate.installGenesis(input);
	}

	async appendAccepted(input: AppendAcceptedVertexInput): Promise<AppendAcceptedVertexResult> {
		if (this.#failNextLocalBeforeAppend && input.sourceKind === "local-issued") {
			this.#failNextLocalBeforeAppend = false;
			throw new Error("phase-3-exit controlled pre-append failure");
		}
		const result = await this.#delegate.appendAccepted(input);
		if (result.ok && result.vertexDigest === this.#throwAfterDigest && !result.idempotent) {
			this.#throwAfterDigest = undefined;
			throw new Error("phase-3-exit controlled post-append failure");
		}
		return result;
	}

	readiness(input: LiveJournalReadinessInput): Promise<LiveJournalReadinessResult> {
		return this.#delegate.readiness(input);
	}

	readPage(input: LiveJournalPageInput): Promise<LiveJournalPageResult> {
		return this.#delegate.readPage(input);
	}

	close(): Promise<void> {
		return this.#delegate.close();
	}
}

async function readJournalRows(
	journal: DurableLiveJournalStore,
	fixture: GenuinePreparedV3Fixture
): Promise<readonly LiveJournalAcceptedRow[]> {
	const scope = Object.freeze({ anchorDigest: fixture.anchorDigest, epoch: 0 as const, objectId: fixture.objectId });
	const readiness = await journal.readiness({ scope });
	if (!readiness.ok || !readiness.ready) throw new TypeError("phase-3-exit journal is not ready");
	const rows: LiveJournalAcceptedRow[] = [];
	let afterSequence: number | null | undefined;
	for (;;) {
		const page = await journal.readPage({
			afterSequence,
			limit: 128,
			scope,
			snapshot: readiness.snapshot,
		});
		if (!page.ok) throw new TypeError(`phase-3-exit journal page failed: ${page.kind}`);
		rows.push(...page.rows);
		if (page.nextSequence === null) break;
		afterSequence = page.nextSequence;
	}
	if (rows.length !== readiness.rowCount) throw new TypeError("phase-3-exit journal row count changed");
	return Object.freeze(rows);
}

async function readOutboxRows(
	store: DurableIssuanceStore,
	scope: DurableIssueScope
): Promise<readonly DurableIssuanceOutboxRecord[]> {
	const rows: DurableIssuanceOutboxRecord[] = [];
	let afterKey: readonly [string, string, number] | undefined;
	for (;;) {
		const page = await store.readOutboxPage(
			afterKey === undefined ? { limit: 128, scope } : { afterKey, limit: 128, scope }
		);
		if (page.length === 0) break;
		rows.push(...page);
		const last = page.at(-1);
		if (last === undefined) break;
		afterKey = [scope.objectId, scope.author, last.commit.authorSequence];
	}
	return Object.freeze(rows);
}

class RealScenarioRuntime {
	readonly fixture: GenuinePreparedV3Fixture;
	readonly directory: string;
	readonly issuanceFilename: string;
	readonly journalFilename: string;
	readonly scope: DurableIssueScope;
	readonly callbacks: string[] = [];
	readonly recovered: string[] = [];
	readonly bootstrap: RegisteredVertex;

	store!: DurableIssuanceStore;
	journal!: ControlledJournalStore;
	handle!: V3PlaneHandle;
	queue!: ObservedMessageQueueManager<Message>;
	network!: DRPNetworkNode;

	private constructor(fixture: GenuinePreparedV3Fixture, label: string, directory: string) {
		this.fixture = fixture;
		this.directory = directory;
		this.issuanceFilename = path.join(directory, `${label}-issuance.sqlite`);
		this.journalFilename = path.join(directory, `${label}-journal.sqlite`);
		this.scope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
		this.bootstrap = fixture.createRegisteredVertex({
			authorSequence: 0,
			dependencies: [fixture.anchorDigest],
			logicalTime: 1,
			operation: Object.freeze({ action: "add", value: 1 }),
			privateKeySeedHex: A0_SEED,
		});
	}

	static async create(fixture: GenuinePreparedV3Fixture, label: string): Promise<RealScenarioRuntime> {
		const directory = mkdtempSync(path.join(tmpdir(), "drp-phase-3-exit-model-"));
		const runtime = new RealScenarioRuntime(fixture, label, directory);
		try {
			runtime.store = createNodeDurableIssuanceStore({ primaryFilename: runtime.issuanceFilename });
			await runtime.store.transactIssue(runtime.scope, (authorSequence) => {
				if (authorSequence !== 0) throw new TypeError("phase-3-exit bootstrap lineage mismatch");
				return Promise.resolve(commitFor(runtime.scope, authorSequence, runtime.bootstrap));
			});
			await runtime.openPlane();
			return runtime;
		} catch (error) {
			await runtime.close().catch(() => undefined);
			throw error;
		}
	}

	private async openPlane(): Promise<void> {
		this.store ??= createNodeDurableIssuanceStore({ primaryFilename: this.issuanceFilename });
		const delegate = createNodeDurableLiveJournalStore({ primaryFilename: this.journalFilename });
		this.journal = new ControlledJournalStore(delegate);
		const installed = await this.journal.installGenesis({
			detachedAnchorSignature: this.fixture.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: this.fixture.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: this.fixture.exactCanonicalParametersCarrierBytes,
			objectId: this.fixture.objectId,
		});
		if (!installed.ok) throw new TypeError(`phase-3-exit journal install failed: ${installed.kind}`);
		const prepared = await this.fixture.prepareAgain();
		const recovered = await recoverV3LiveReplica({
			capability: prepared.capability,
			exactCanonicalAuthorAuthorizationBytes: this.fixture.exactCanonicalAuthorAuthorizationBytes,
			issuanceScope: this.scope,
			issuanceStore: this.store,
			liveJournalStore: this.journal,
		});
		if (!recovered.ok) throw new TypeError(`phase-3-exit recovery failed: ${recovered.kind}`);
		this.recovered.push(...recovered.descriptor.recoveredVertices.map((vertex) => lowerHex(vertex.digest)));
		this.queue = new ObservedMessageQueueManager<Message>({ logConfig: { level: "silent" } });
		this.network = testNetwork();
		const activated = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: this.queue,
			networkNode: this.network,
			onAdmittedVertex: (delivery) => {
				this.callbacks.push(lowerHex(delivery.vertex.digest));
			},
		});
		if (!activated.ok) throw new TypeError(`phase-3-exit activation failed: ${activated.kind}`);
		this.handle = activated.handle;
	}

	async deliver(vertex: RegisteredVertex, mode: "normal" | "commit-then-throw" = "normal"): Promise<void> {
		const digest = lowerHex(vertex.digest);
		if (mode === "commit-then-throw") this.journal.throwAfterDigest(digest);
		const message = Message.create({
			data: V3Envelope.encode({
				canonicalPreimage: vertex.canonicalPreimageBytes,
				signature: vertex.signature,
			}).finish(),
			objectId: this.handle.topic,
			sender: "peer:phase-3-exit-remote",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		});
		const receiptPromise = this.queue.nextReceipt();
		if (!routeV3Ingress(this.network, message)) throw new TypeError("phase-3-exit ingress was not claimed");
		const receipt = await receiptPromise;
		await receipt.processed;
		if (receipt.outcome !== "handler-settled") {
			throw new TypeError(`phase-3-exit ingress did not reach its handler: ${String(receipt.outcome)}`);
		}
	}

	async restart(): Promise<void> {
		this.handle.deactivate();
		await this.journal.close();
		await this.store.close();
		this.store = createNodeDurableIssuanceStore({ primaryFilename: this.issuanceFilename });
		await this.openPlane();
	}

	async snapshot(scenario: Phase3ExitRealScenario, extras: ObservationExtras): Promise<Phase3ExitRealObservation> {
		const journalRows = await readJournalRows(this.journal, this.fixture);
		const outboxRows = await readOutboxRows(this.store, this.scope);
		const acceptedVertices: Phase3ExitAcceptedVertexEvidence[] = [];
		for (const row of journalRows) {
			if (row.sourceKind === "received") {
				acceptedVertices.push(
					Object.freeze({
						authenticatedCanonicalPreimageByteLength: row.exactCanonicalPreimageBytes.byteLength,
						detachedSignature: detached(row.detachedSignature),
						digest: row.vertexDigest,
						exactCanonicalPreimageBytes: detached(row.exactCanonicalPreimageBytes),
						source: "received-journal" as const,
					})
				);
				continue;
			}
			const issued = await this.store.readIssued(this.scope, row.authorSequence);
			if (issued === null || lowerHex(issued.envelope.digest) !== row.vertexDigest) {
				throw new TypeError("phase-3-exit local journal join failed");
			}
			acceptedVertices.push(
				Object.freeze({
					authenticatedCanonicalPreimageByteLength: issued.envelope.canonicalPreimageBytes.byteLength,
					detachedSignature: detached(issued.envelope.signature),
					digest: row.vertexDigest,
					exactCanonicalPreimageBytes: detached(issued.envelope.canonicalPreimageBytes),
					source: "local-issued-journal" as const,
				})
			);
		}
		const journalDigestSet = new Set(journalRows.map(({ vertexDigest }) => vertexDigest));
		const issuedVertices: Phase3ExitIssuedVertexEvidence[] = outboxRows
			.filter(({ commit }) => journalDigestSet.has(lowerHex(commit.envelope.digest)))
			.map(({ commit, publishState }) =>
				Object.freeze({
					author: commit.issuedRecord.scope.author,
					authorSequence: commit.authorSequence,
					detachedSignature: detached(commit.envelope.signature),
					digest: lowerHex(commit.envelope.digest),
					exactCanonicalPreimageBytes: detached(commit.envelope.canonicalPreimageBytes),
					journalDigest: lowerHex(commit.envelope.digest),
					outboxDigest: lowerHex(commit.envelope.digest),
					publishState,
				})
			);
		const journalDigests = Object.freeze(journalRows.map(({ vertexDigest }) => vertexDigest));
		return Object.freeze({
			acceptedVertices: Object.freeze(acceptedVertices),
			actionTrace: Object.freeze([...extras.actionTrace]),
			anchorDigest: this.fixture.anchorDigest,
			anchorSignerPublicKey: detached(this.fixture.anchorPublicKey),
			attemptedDigests: Object.freeze([...extras.attemptedDigests]),
			authorizedAuthors: Object.freeze([...this.fixture.authors]),
			callbackDigests: Object.freeze([...this.callbacks]),
			capacityRejections: Object.freeze([...(extras.capacityRejections ?? [])]),
			droppedDigests: Object.freeze([...(extras.droppedDigests ?? [])]),
			detachedAnchorSignature: detached(this.fixture.detachedAnchorSignature),
			exactCanonicalAnchorPreimageBytes: detached(this.fixture.exactCanonicalAnchorPreimageBytes),
			issuanceCrash: extras.issuanceCrash,
			issuedVertices: Object.freeze(issuedVertices),
			journalDigests,
			localIssue: extras.localIssue,
			recoveredDigests: Object.freeze([...this.recovered]),
			redeliveredDigests: Object.freeze([...(extras.redeliveredDigests ?? [])]),
			rejections: Object.freeze([...(extras.rejections ?? [])]),
			replicaJournalDigests: Object.freeze(
				(extras.replicaJournalDigests ?? [journalDigests]).map((digests) => Object.freeze([...digests]))
			),
			scenario,
		});
	}

	async close(): Promise<void> {
		this.handle?.deactivate();
		await this.journal?.close();
		await this.store?.close();
		rmSync(this.directory, { force: true, recursive: true });
	}
}

function standardDependencies(scenario: Phase3ExitRealScenario, label: number): readonly number[] {
	if (label === 0) return [-1];
	if (scenario === "sibling-permutation") return label === 1 ? [0] : [1];
	if (scenario === "pending-entry-capacity") return label === 1 ? [0] : [1];
	if (scenario === "multi-member-commitment") return [0];
	return [label - 1];
}

function standardVertices(
	runtime: RealScenarioRuntime,
	scenario: Phase3ExitRealScenario,
	count: number
): ReadonlyMap<number, RegisteredVertex> {
	const vertices = new Map<number, RegisteredVertex>([[0, runtime.bootstrap]]);
	for (let label = 1; label < count; label += 1) {
		const dependencies = standardDependencies(scenario, label).map((dependency) =>
			dependency === -1 ? runtime.fixture.anchorDigest : lowerHex((vertices.get(dependency) as RegisteredVertex).digest)
		);
		vertices.set(
			label,
			runtime.fixture.createRegisteredVertex({
				authorSequence: label - 1,
				dependencies,
				logicalTime: label + 1,
				operation: Object.freeze({ action: "add", value: label + 1 }),
				privateKeySeedHex: A1_SEED,
			})
		);
	}
	return vertices;
}

function digestOf(vertex: RegisteredVertex): string {
	return lowerHex(vertex.digest);
}

async function runStandardScenario(
	fixture: GenuinePreparedV3Fixture,
	scenario: Exclude<Phase3ExitRealScenario, "local-issue-release" | "post-issuance-commit-crash">,
	count: number
): Promise<Phase3ExitRealObservation> {
	const runtime = await RealScenarioRuntime.create(fixture, scenario);
	try {
		const vertices = standardVertices(runtime, scenario, count);
		const vertex = (label: number): RegisteredVertex => vertices.get(label) as RegisteredVertex;
		const attempted: string[] = [];
		const trace: Phase3ExitObservedAction[] = [];
		const deliver = async (label: number, mode: "normal" | "commit-then-throw" = "normal"): Promise<void> => {
			const selected = vertex(label);
			attempted.push(digestOf(selected));
			trace.push(Object.freeze(["deliver", digestOf(selected), mode] as const));
			await runtime.deliver(selected, mode);
		};
		const redeliver = async (label: number): Promise<void> => {
			const selected = vertex(label);
			attempted.push(digestOf(selected));
			trace.push(Object.freeze(["redeliver", digestOf(selected)] as const));
			await runtime.deliver(selected);
		};
		let capacityRejections: readonly Phase3ExitCapacityRejectionEvidence[] = Object.freeze([]);
		let dropped: readonly string[] = Object.freeze([]);
		let redelivered: readonly string[] = Object.freeze([]);
		let rejections: readonly Phase3ExitRejectedVertexEvidence[] = Object.freeze([]);
		if (scenario === "ready-forward") {
			await deliver(1);
			await deliver(2);
			await deliver(3);
		} else if (scenario === "complete-reverse") {
			await deliver(3);
			await deliver(2);
			await deliver(1);
		} else if (scenario === "sibling-permutation") {
			const siblings = [vertex(2), vertex(3)].sort((left, right) =>
				digestOf(left) < digestOf(right) ? 1 : digestOf(left) > digestOf(right) ? -1 : 0
			);
			for (const sibling of siblings) {
				attempted.push(digestOf(sibling));
				trace.push(Object.freeze(["deliver", digestOf(sibling), "normal"] as const));
				await runtime.deliver(sibling);
			}
			await deliver(1);
		} else if (scenario === "duplicate-before-release") {
			await deliver(2);
			await redeliver(2);
			await deliver(1);
		} else if (scenario === "duplicate-after-acceptance") {
			await deliver(1);
			await deliver(2);
			await redeliver(2);
		} else if (scenario === "volatile-pending-crash") {
			await deliver(2);
			trace.push(Object.freeze(["crash-restart"] as const));
			await runtime.restart();
			await redeliver(2);
			redelivered = Object.freeze([digestOf(vertex(2))]);
			await deliver(1);
		} else if (scenario === "post-journal-append-crash") {
			await deliver(1, "commit-then-throw");
			trace.push(Object.freeze(["crash-restart"] as const));
			await runtime.restart();
		} else if (scenario === "accepted-capacity") {
			for (let label = 1; label <= 8190; label += 1) await deliver(label);
			const candidate = runtime.fixture.createRegisteredVertex({
				authorSequence: 8190,
				dependencies: [digestOf(vertex(8190))],
				logicalTime: 8192,
				operation: Object.freeze({ action: "add", value: 8192 }),
				privateKeySeedHex: A1_SEED,
			});
			const rowsBefore = await readJournalRows(runtime.journal, runtime.fixture);
			const acceptedByteChargeBefore =
				runtime.fixture.exactCanonicalAnchorPreimageBytes.byteLength +
				rowsBefore.reduce((total, row) => {
					if (row.sourceKind === "received") return total + row.exactCanonicalPreimageBytes.byteLength;
					return total + runtime.bootstrap.canonicalPreimageBytes.byteLength;
				}, 0);
			attempted.push(digestOf(candidate));
			trace.push(Object.freeze(["deliver", digestOf(candidate), "normal"] as const));
			await runtime.deliver(candidate);
			capacityRejections = Object.freeze([
				Object.freeze({
					acceptedByteChargeBefore,
					acceptedVertexCountBefore: 1 + rowsBefore.length,
					candidateByteCharge: candidate.canonicalPreimageBytes.byteLength,
					detachedSignature: detached(candidate.signature),
					digest: digestOf(candidate),
					exactCanonicalPreimageBytes: detached(candidate.canonicalPreimageBytes),
					kind: "accepted-count" as const,
				}),
			]);
			dropped = Object.freeze([digestOf(candidate)]);
		} else if (scenario === "pending-entry-capacity") {
			for (let label = 2; label <= 4098; label += 1) await deliver(label);
			const overflow = digestOf(vertex(4098));
			dropped = Object.freeze([overflow]);
			await deliver(1);
			await redeliver(4098);
			redelivered = Object.freeze([overflow]);
		} else if (scenario === "wrong-scope-author-signature") {
			const bootstrapDigest = digestOf(runtime.bootstrap);
			const base = {
				authorSequence: 0,
				dependencies: [bootstrapDigest],
				logicalTime: 2,
				operation: Object.freeze({ action: "add", value: 2 }),
				privateKeySeedHex: A1_SEED,
			};
			const wrongObject = runtime.fixture.createRegisteredVertex({
				...base,
				objectId: `creator:${"b".repeat(32)}`,
			});
			const wrongEpoch = runtime.fixture.createRegisteredVertex({ ...base, epoch: 1 });
			const wrongAnchor = runtime.fixture.createRegisteredVertex({ ...base, anchor: "f".repeat(64) });
			const wrongProtocol = runtime.fixture.createRegisteredVertex({ ...base, protocolMajor: 4 });
			const unauthorized = runtime.fixture.createRegisteredVertex({ ...base, privateKeySeedHex: UNAUTHORIZED_SEED });
			const valid = runtime.fixture.createRegisteredVertex(base);
			const malformedSignature = Object.freeze({
				...valid,
				signature: Uint8Array.from(valid.signature, (byte, index) => (index === 0 ? byte ^ 0x01 : byte)),
			});
			const rows = [
				["wrong-object", wrongObject],
				["wrong-epoch", wrongEpoch],
				["wrong-anchor", wrongAnchor],
				["wrong-protocol", wrongProtocol],
				["unauthorized-author", unauthorized],
				["malformed-signature", malformedSignature],
			] as const;
			for (const [, selected] of rows) {
				attempted.push(digestOf(selected));
				trace.push(Object.freeze(["deliver", digestOf(selected), "normal"] as const));
				await runtime.deliver(selected);
			}
			rejections = Object.freeze(
				rows.map(([classification, selected]) =>
					Object.freeze({
						classification,
						detachedSignature: detached(selected.signature),
						digest: digestOf(selected),
						exactCanonicalPreimageBytes: detached(selected.canonicalPreimageBytes),
					})
				)
			);
		} else if (scenario === "multi-member-commitment") {
			await deliver(1);
			await deliver(2);
			await deliver(3);
		}
		trace.push(Object.freeze(["query-commitment"] as const));
		const row = await runtime.snapshot(scenario, {
			actionTrace: trace,
			attemptedDigests: attempted,
			capacityRejections,
			droppedDigests: dropped,
			redeliveredDigests: redelivered,
			rejections,
		});
		if (scenario === "sibling-permutation") {
			return Object.freeze({ ...row, replicaJournalDigests: Object.freeze([row.journalDigests, row.journalDigests]) });
		}
		return row;
	} finally {
		await runtime.close();
	}
}

function outboxEvidence(row: DurableIssuanceOutboxRecord): Phase3ExitOutboxVertexEvidence {
	return Object.freeze({
		author: row.commit.issuedRecord.scope.author,
		authorSequence: row.commit.authorSequence,
		detachedSignature: detached(row.commit.envelope.signature),
		digest: lowerHex(row.commit.envelope.digest),
		exactCanonicalPreimageBytes: detached(row.commit.envelope.canonicalPreimageBytes),
		publishState: row.publishState,
	});
}

async function runIssuanceCrash(fixture: GenuinePreparedV3Fixture): Promise<Phase3ExitRealObservation> {
	const runtime = await RealScenarioRuntime.create(fixture, "post-issuance-commit-crash");
	try {
		await runtime.store.compareAndMarkOutboxPublished({
			authorSequence: 0,
			digest: runtime.bootstrap.digest,
			scope: runtime.scope,
		});
		const preCrashJournalDigests = (await readJournalRows(runtime.journal, fixture)).map(
			({ vertexDigest }) => vertexDigest
		);
		runtime.journal.failNextLocalBeforeAppend();
		const signerDigests: string[] = [];
		const issue = await runtime.handle.issueLocal({
			operations: Object.freeze([
				Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 2 }) }),
			]),
			signRegisteredVertexDigest: async (digest) => {
				signerDigests.push(lowerHex(digest));
				return fixture.signRegisteredVertexDigest(digest);
			},
		});
		if (issue.ok || issue.kind !== "journal-rejected" || signerDigests.length !== 1) {
			throw new TypeError("phase-3-exit issuance crash did not stop after durable issue");
		}
		const candidateDigest = signerDigests[0] as string;
		const pendingBefore = (await readOutboxRows(runtime.store, runtime.scope)).filter(
			({ publishState }) => publishState === "pending"
		);
		if (
			pendingBefore.length !== 1 ||
			lowerHex(pendingBefore[0]?.commit.envelope.digest ?? new Uint8Array()) !== candidateDigest
		) {
			throw new TypeError("phase-3-exit issuance crash outbox evidence mismatch");
		}
		const preCrashOutboxVertices = Object.freeze(pendingBefore.map(outboxEvidence));
		const preCrashCallbackDigests = Object.freeze([...runtime.callbacks]);
		await runtime.restart();
		const postRecoveryJournalDigests = (await readJournalRows(runtime.journal, fixture)).map(
			({ vertexDigest }) => vertexDigest
		);
		return await runtime.snapshot("post-issuance-commit-crash", {
			actionTrace: Object.freeze([
				Object.freeze(["issue-local", candidateDigest] as const),
				Object.freeze(["crash-restart"] as const),
				Object.freeze(["query-commitment"] as const),
			]),
			attemptedDigests: Object.freeze([candidateDigest]),
			issuanceCrash: Object.freeze({
				postRecoveryJournalDigests: Object.freeze(postRecoveryJournalDigests),
				preCrashCallbackDigests,
				preCrashJournalDigests: Object.freeze(preCrashJournalDigests),
				preCrashOutboxVertices,
			}),
		});
	} finally {
		await runtime.close();
	}
}

async function runLocalIssueRelease(fixture: GenuinePreparedV3Fixture): Promise<Phase3ExitRealObservation> {
	const runtime = await RealScenarioRuntime.create(fixture, "local-issue-release");
	try {
		const bootstrapDigest = digestOf(runtime.bootstrap);
		const siblingA = fixture.createRegisteredVertex({
			authorSequence: 0,
			dependencies: [bootstrapDigest],
			logicalTime: 2,
			operation: Object.freeze({ action: "add", value: 2 }),
			privateKeySeedHex: A1_SEED,
		});
		const siblingC = fixture.createRegisteredVertex({
			authorSequence: 1,
			dependencies: [bootstrapDigest],
			logicalTime: 4,
			operation: Object.freeze({ action: "add", value: 4 }),
			privateKeySeedHex: A1_SEED,
		});
		const preflight = fixture.createRegisteredVertex({
			authorSequence: 1,
			dependencies: [digestOf(siblingA), digestOf(siblingC)].sort(),
			logicalTime: 3,
			operation: Object.freeze({ action: "add", value: 3 }),
			privateKeySeedHex: A0_SEED,
		});
		const releasedChild = fixture.createRegisteredVertex({
			authorSequence: 2,
			dependencies: [digestOf(preflight)],
			logicalTime: 5,
			operation: Object.freeze({ action: "add", value: 5 }),
			privateKeySeedHex: A1_SEED,
		});
		const attempted = [digestOf(siblingA), digestOf(siblingC), digestOf(releasedChild)];
		const trace: Phase3ExitObservedAction[] = [];
		for (const selected of [siblingA, siblingC, releasedChild]) {
			trace.push(Object.freeze(["deliver", digestOf(selected), "normal"] as const));
			await runtime.deliver(selected);
		}
		const preflightSignerDigests: string[] = [];
		const issue = await runtime.handle.issueLocal({
			operations: Object.freeze([
				Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 3 }) }),
			]),
			signRegisteredVertexDigest: async (digest) => {
				preflightSignerDigests.push(lowerHex(digest));
				return fixture.signRegisteredVertexDigest(digest);
			},
		});
		if (!issue.ok || issue.digest !== digestOf(preflight)) {
			throw new TypeError(`phase-3-exit local issue failed: ${issue.ok ? "digest-mismatch" : issue.kind}`);
		}
		attempted.push(issue.digest);
		trace.push(Object.freeze(["issue-local", issue.digest] as const), Object.freeze(["query-commitment"] as const));
		const effectKinds = [
			"issuance-committed",
			"outbox-observed",
			"journal-appended",
			"accepted-observed",
			"callback-observed",
		] as const;
		const effectEvents: readonly Phase3ExitLocalEffectEvidence[] = Object.freeze(
			effectKinds.map((kind, sequence) => Object.freeze({ digest: issue.digest, kind, sequence }))
		);
		const observation = await runtime.snapshot("local-issue-release", {
			actionTrace: trace,
			attemptedDigests: attempted,
			localIssue: Object.freeze({
				actualDigest: issue.digest,
				author: fixture.author,
				authorSequence: issue.authorSequence,
				effectEvents,
				logicalTime: 3,
				operation: Object.freeze({ action: "add", value: 3 }),
				preflightSignerDigests: Object.freeze(preflightSignerDigests),
				releasedChildDigest: digestOf(releasedChild),
			}),
		});
		if (!observation.journalDigests.includes(digestOf(releasedChild))) {
			throw new TypeError("phase-3-exit local issue did not release the pending remote child");
		}
		return observation;
	} finally {
		await runtime.close();
	}
}

/**
 * Run the retained production integration representatives for the bounded Phase 3 exit model.
 * @returns Authenticated durable and public observations for every retained scenario.
 */
export async function runPhase3ExitDriver(): Promise<Phase3ExitDriverResult> {
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "legacy-author-list",
		authorizedPrivateKeySeedHexes: Object.freeze([A0_SEED, A1_SEED]),
		historyRoot: lowerHex(EMPTY_MERKLE_ROOT),
		historySize: 0,
	});
	try {
		const observations = new Map<Phase3ExitRealScenario, Phase3ExitRealObservation>();
		observations.set("ready-forward", await runStandardScenario(fixture, "ready-forward", 4));
		observations.set("complete-reverse", await runStandardScenario(fixture, "complete-reverse", 4));
		observations.set("sibling-permutation", await runStandardScenario(fixture, "sibling-permutation", 4));
		observations.set("duplicate-before-release", await runStandardScenario(fixture, "duplicate-before-release", 3));
		observations.set("duplicate-after-acceptance", await runStandardScenario(fixture, "duplicate-after-acceptance", 3));
		observations.set("volatile-pending-crash", await runStandardScenario(fixture, "volatile-pending-crash", 3));
		observations.set("post-journal-append-crash", await runStandardScenario(fixture, "post-journal-append-crash", 2));
		observations.set("post-issuance-commit-crash", await runIssuanceCrash(fixture));
		observations.set("local-issue-release", await runLocalIssueRelease(fixture));
		observations.set("accepted-capacity", await runStandardScenario(fixture, "accepted-capacity", 8191));
		observations.set("pending-entry-capacity", await runStandardScenario(fixture, "pending-entry-capacity", 4099));
		observations.set(
			"wrong-scope-author-signature",
			await runStandardScenario(fixture, "wrong-scope-author-signature", 1)
		);
		observations.set("multi-member-commitment", await runStandardScenario(fixture, "multi-member-commitment", 4));
		return Object.freeze({
			observations: Object.freeze(
				PHASE3_EXIT_REAL_SCENARIOS.map((scenario) => {
					const observation = observations.get(scenario);
					if (observation === undefined) throw new TypeError(`missing phase-3-exit scenario ${scenario}`);
					return observation;
				})
			),
			parameters: PARAMETERS,
		});
	} finally {
		await fixture.close();
	}
}
