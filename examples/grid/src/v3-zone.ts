import { openTrustedBlueprintCatalogBytes } from "@ts-drp/blueprint-catalog/bytes";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import { decodeEntityDeltaBatch, encodeEntityDeltaBatch, type EphemeralChannel } from "@ts-drp/ephemeral";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	openV3RoomSuccessorDelivery,
	createV3RoomSession,
	type V3RoomAcceptedOperation,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHeadAuthority,
	type V3RoomMigrationActivationReceipt,
	type V3RoomMigrationProjection,
	type V3RoomMigrationRehearsalReceipt,
	type V3RoomProjectionInput,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
	type V3RoomSuccessorDelivery,
	type V3RoomSession,
	prepareV3RoomPlayerDatabase,
} from "@ts-drp/example-v3-room";
import type { DRPNode } from "@ts-drp/node";
import {
	createOutcomeCommitAdmissionOperation,
	createOutcomeCommitAdmissionPolicy,
	createOutcomeCommitOperation,
	type OutcomeApproval,
	type OutcomeCommitAdmissionOperation,
	type PreparedOutcomeIntent,
	prepareOutcomeIntent,
	verifyOutcomeCommitAdmissionOperation,
	verifyOutcomeCommitOperation,
} from "@ts-drp/outcome-commit";

import { GRID_GENESIS_PROFILE } from "./profile.js";
import { fabricAgeOfInformation, fabricPercentile } from "./age-of-information.js";
import { GRID_ROLLOVER_BUDGET } from "./rollover.js";
import catalogMaterial from "./zone-catalog-material.json" with { type: "json" };
import predecessorCatalogMaterial from "./zone-catalog-predecessor-material.json" with {type:"json"};
import { createZoneStateKernel, emptyZoneState, type ZonePlacementGrowthMaterial, type ZoneState, type ZoneStateKernel } from "./zone-state.js";
const PARAMETERS = Object.freeze({
	authorShareMultiplier: 4,
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const FABRIC_CAMPAIGN_INTERVAL_MS = 33;
const FABRIC_CAMPAIGN_SAMPLE_COUNT = 600;
const FABRIC_RELIABLE_OBSERVATION_TAIL_MS = 15_000;
const ZONE_EPHEMERAL_OPTIONS = Object.freeze({
	maxMessageBytes: 65_536,
	maxSequencedKeys: 9,
	maxSequencedSenders: 2,
});
const ZONE_INVITE_KEYS = ["kind", "roomInvite", "version", "zoneId"] as const;

export interface ZoneBlock {
	readonly id: string;
	readonly kind: string;
	readonly x: number;
	readonly y: number;
}

/** Presentation-only positions from the already admitted ephemeral channel.
 * This carries no room, signing, migration or cross-epoch authority. */
export interface ZoneTransientSnapshot {
	readonly ready: boolean;
	readonly zoneId: string;
	readonly transientPositions: ZoneSnapshot["transientPositions"];
}

export interface V3ZoneRoomHeadOpenContext {
	readonly author: string;
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
	readonly objectId: string;
	readonly operation: "create" | "join";
}

export type V3ZoneRoomHeadAuthorityForOpen = (
	context: Readonly<V3ZoneRoomHeadOpenContext>
) => V3RoomHeadAuthority | Promise<V3RoomHeadAuthority>;

export type V3ZoneSettlementSourceApproval = NonNullable<
	Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["approveSettlementSourceSelection"]
>;

/**
 * The application host's delivery of each adopted successor offer to the zone's other members,
 * who install it with `installCreatorSuccessor`. Without it the creator still rolls over.
 */
export type V3ZoneSuccessorPublisher = NonNullable<V3RoomRolloverHooks["publishSuccessor"]>;

type EntityDelta = ReturnType<typeof decodeEntityDeltaBatch>[number];

interface FabricRunInput {
	readonly intervalMs: number;
	readonly payloadFormat: "e3-03-ascii-v1";
	readonly payloadBytes: number;
	readonly reliableSentinelBytes: number;
	readonly sampleCount: number;
	readonly trialId: string;
}

interface FabricObservation {
	readonly byteLength: number;
	readonly lane: "raw" | "reliable";
	readonly receivedAtMs: number;
	readonly sentAtMs: number;
	readonly sequence: number;
	readonly sentinel: boolean;
}

interface FabricTrialState {
	attemptedRaw: number;
	attemptedReliable: number;
	deadlineAtMs: number | undefined;
	deadlineEmissionScheduled: boolean;
	readonly durableBaseline: number;
	intervalMs: number;
	readonly observations: FabricObservation[];
	sampleCount: number;
	readonly trialId: string;
}

export interface FabricTrialView {
	readonly durableDelta: number;
	readonly fallbackCount: 0;
	readonly maxGap: number;
	readonly rawAoIP50Ms: number;
	readonly rawAoIP95Ms: number;
	readonly rawDelivered: number;
	readonly reliableAoIP50Ms: number;
	readonly reliableAoIP95Ms: number;
	readonly reliableDelivered: number;
	readonly sampleCount: number;
	readonly trialId: string;
}

export interface ZoneFabricWorkbench {
	reset(trialId: string): Promise<void>;
	runTrial(input: FabricRunInput): Promise<void>;
	snapshot(trialId: string): Readonly<{
		readonly attempted: Readonly<{ readonly raw: number; readonly reliable: number }>;
		readonly observations: readonly Readonly<FabricObservation>[];
		readonly transport: Readonly<{
			readonly fallbackCount: 0;
			readonly raw: readonly Readonly<{
				readonly connectionId: string;
				readonly generation: number;
				readonly iceRestarts: 0;
				readonly maxRetransmits: 0;
				readonly ordered: false;
				readonly peerId: string;
				readonly remoteAddr: string;
				readonly readyState: "open";
			}>[];
		}>;
		readonly trialId: string;
	}>;
}

export interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly aoiBandwidth: Readonly<
		Record<
			string,
			Readonly<{
				readonly durableDelta: number;
				readonly elapsedMs: number;
				readonly inputEntityCount: number;
				readonly projectionBitsPerSecond: number;
				readonly projectionPayloadBytesSent: number;
				readonly publicationCount: number;
				readonly selectedEntityCount: number;
			}>
		>
	>;
	readonly aoiPopulations: Readonly<Record<string, readonly EntityDelta[]>>;
	readonly aoiProjection: Readonly<
		Record<
			string,
			Readonly<{
				readonly baseKeyframeId: number | null;
				readonly baseKeyframeSequence: number | null;
				readonly generation: number | null;
				readonly lastSequence: number | null;
				readonly waitingForKeyframe: boolean;
			}>
		>
	>;
	readonly blocks: readonly ZoneBlock[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly fabricTrials: readonly FabricTrialView[];
	readonly invite: string;
	readonly localAuthor: string;
	readonly localPeerId: string;
	readonly outcomeCount: number;
	readonly outcomeContext: OutcomeContext | null;
	readonly ready: boolean;
	readonly rawTransport: Readonly<{
		readonly authenticatedConnectionLosses: number;
		readonly backpressuredDrops: number;
		readonly fallbackCount: 0;
		readonly handshakeFailures: number;
		readonly lastLinkDrop: string;
		readonly linkDrops: number;
		readonly links: readonly Readonly<{
			readonly label: string;
			readonly maxRetransmits: number;
			readonly ordered: boolean;
			readonly peerId: string;
		}>[];
		readonly overLimit: number;
		readonly received: number;
		readonly routedBytesReceived: number;
		readonly routedBytesSent: number;
		readonly sent: number;
	}>;
	readonly transientPositions: Readonly<Record<string, Readonly<{ readonly x: number; readonly y: number }>>>;
	readonly tradeIntent: TradeIntentView;
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly zoneId: string;
}

interface OutcomeContext {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

interface TradeIntentView extends OutcomeContext {
	readonly approvalCount: number;
	readonly clientOperationId: string;
	readonly counterparties: readonly string[];
	readonly intentDigest: string;
	readonly outcomeKind: string;
	readonly status: "absent" | "accepted" | "approved" | "pending" | "ready" | "recovered";
}

export interface PreparedTradeIntent {
	readonly clientOperationId: string;
	readonly exactCanonicalIntentHex: string;
	readonly exactCanonicalPayloadHex: string;
	readonly intentDigest: string;
	readonly registeredDigestHex: string;
}

export interface TradeApproval {
	readonly signatureHex: string;
	readonly signer: string;
}

interface ZoneProjection {
	readonly creatorAuthor: string;
	readonly creatorPeerId: string;
	readonly acceptedDigests: readonly string[];
	readonly blocks: readonly ZoneBlock[];
	readonly outcomes: readonly OutcomeCommitAdmissionOperation[];
	readonly roster: readonly Readonly<Enrollment & { readonly order: number }>[];
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

interface Enrollment {
	readonly author: string;
	readonly peerId: string;
}

interface AoiProjectionSenderState {
	readonly authorityGeneration: number;
	readonly durableBaseline: number;
	durableDelta: number;
	inputEntityCount: number;
	lastPublishedAtMs: number;
	readonly maxEnvelopeBytes: number;
	nextSequence: number;
	projectionPayloadBytesSent: number;
	publicationCount: number;
	selectedEntityCount: number;
	startedAtMs: number | undefined;
	readonly sender: AoiProjectionSender;
}

interface AoiProjectionReceiverState {
	readonly authorityGeneration: number;
	expiryTimer: ReturnType<typeof setTimeout> | undefined;
	readonly receiver: AoiProjectionReceiver;
}

interface AoiProjectionSender {
	encode(
		input: Readonly<{ readonly entities: readonly EntityDelta[]; readonly sequence: number }>
	): readonly Uint8Array[];
}

interface AoiProjectionReceiver {
	expire(nowMs: number): void;
	ingest(
		input: Readonly<{ readonly authorityGeneration: number; readonly bytes: Uint8Array; readonly receivedAtMs: number }>
	): boolean;
	nextExpiryAtMs(): number | null;
	snapshot(): Readonly<{
		readonly baseKeyframeId: number | null;
		readonly baseKeyframeSequence: number | null;
		readonly entities: readonly EntityDelta[];
		readonly generation: number | null;
		readonly lastSequence: number | null;
		readonly waitingForKeyframe: boolean;
	}>;
}

function projectionView(
	snapshot: ReturnType<AoiProjectionReceiver["snapshot"]>
): ZoneSnapshot["aoiProjection"][string] {
	return Object.freeze({
		baseKeyframeId: snapshot.baseKeyframeId,
		baseKeyframeSequence: snapshot.baseKeyframeSequence,
		generation: snapshot.generation,
		lastSequence: snapshot.lastSequence,
		waitingForKeyframe: snapshot.waitingForKeyframe,
	});
}

interface ZoneInvite {
	readonly roomInvite: string;
	readonly zoneId: string;
}

export interface V3ZoneApi {
	sealEpoch(): ReturnType<V3RoomSession<ZoneProjection>["sealEpoch"]>;
	exportCreatorSuccessor(): ReturnType<V3RoomSession<ZoneProjection>["exportCreatorSuccessor"]>;
	adoptCreatorSuccessor(): ReturnType<V3RoomSession<ZoneProjection>["adoptCreatorSuccessor"]>;
	installCreatorSuccessor(input: Parameters<V3RoomSession<ZoneProjection>["installCreatorSuccessor"]>[0]):
		ReturnType<V3RoomSession<ZoneProjection>["installCreatorSuccessor"]>;
	activateMigration(receipt: V3RoomMigrationRehearsalReceipt): Promise<V3RoomMigrationActivationReceipt>;
	approveTradeIntent(
		input: Readonly<{ readonly exactCanonicalIntentHex: string; readonly exactCanonicalPayloadHex: string }>
	): Promise<TradeApproval>;
	close(): Promise<void>;
	create(memberEnrollments: string | readonly string[]): Promise<void>;
	readonly fabric: ZoneFabricWorkbench;
	join(invite: string): Promise<void>;
	move(dx: number, dy: number): void;
	placeBlock(input: ZoneBlock): Promise<void>;
	prepareTradeIntent(
		input: Readonly<{
			readonly clientOperationId: string;
			readonly counterpartyAuthor: string;
			readonly offeredAsset: string;
			readonly requestedAsset: string;
		}>
	): Promise<PreparedTradeIntent>;
	publishAoiPopulation(
		input: Readonly<{
			readonly entities: readonly EntityDelta[];
			readonly observerPeerId: string;
			readonly observerX: number;
			readonly observerY: number;
			readonly radius: number;
		}>
	): Promise<boolean>;
	rehearseMigration(): Promise<V3RoomMigrationRehearsalReceipt>;
	finalizeTradeIntent(
		input: Readonly<{
			readonly approvals: readonly TradeApproval[];
			readonly exactCanonicalIntentHex: string;
			readonly exactCanonicalPayloadHex: string;
		}>
	): Promise<Readonly<{ readonly action: "commit-outcome-v1"; readonly clientOperationId: string }>>;
	commitTradeIntent(
		input: Readonly<{
			readonly approvals: readonly TradeApproval[];
			readonly exactCanonicalIntentHex: string;
			readonly exactCanonicalPayloadHex: string;
		}>
	): Promise<Readonly<{ readonly kind: "accepted" | "duplicate" }>>;
	snapshot(): ZoneSnapshot;
}

/**
 * Create the grid-specific durable projection over the shared v3 room.
 * @param node Authenticated node that owns the room transport and signer.
 * @param onProjection Observer for deterministic durable and transient projections.
 * @param roomHeadAuthorityForOpen Host-owned authority acquisition; initialization belongs to the host.
 * @param onTransient Optional UI-only position observer; full public snapshots remain fresh.
 * @param publishSuccessor Test override of the creator's successor announcement. By default the
 * zone's successor delivery (examples/v3-room) announces each adopted offer to the zone's members
 * over this node and answers their requests; with this hook, the hook receives the offers instead.
 * @returns The bounded zone application API.
 */
export function createV3ZoneApi(
	node: DRPNode,
	onProjection: (snapshot: ZoneSnapshot) => void,
	roomHeadAuthorityForOpen: V3ZoneRoomHeadAuthorityForOpen,
	approveSettlementSourceSelection?: V3ZoneSettlementSourceApproval,
	onTransient?: (snapshot: ZoneTransientSnapshot) => void,
	publishSuccessor?: V3ZoneSuccessorPublisher
): V3ZoneApi {
	if (typeof roomHeadAuthorityForOpen !== "function") {
		throw new TypeError("v3 zone room-head authority factory is required");
	}
	if (approveSettlementSourceSelection !== undefined && typeof approveSettlementSourceSelection !== "function")
		throw new TypeError("v3 zone settlement approval policy is invalid");
	if (onTransient !== undefined && typeof onTransient !== "function")
		throw new TypeError("v3 zone transient presentation observer is invalid");
	if (publishSuccessor !== undefined && typeof publishSuccessor !== "function")
		throw new TypeError("v3 zone successor publisher is invalid");
	const localAuthor = node.keychain.localAuthorId;
	const localPeerId = node.networkNode.peerId;
	const enrollment = encodeEnrollment({ author: localAuthor, peerId: localPeerId });
	const projectionModule = import("@ts-drp/ephemeral");
	const aoiPopulations = new Map<string, readonly EntityDelta[]>();
	const aoiReceivers = new Map<string, AoiProjectionReceiverState>();
	const aoiSenders = new Map<string, AoiProjectionSenderState>();
	const fabricTrials = new Map<string, FabricTrialState>();
	const transientPositions = new Map<string, Readonly<{ x: number; y: number }>>();
	let room: Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>> | undefined;
	// The creator's rollover policy (examples/grid/src/rollover.ts); a member's only offers a refused
	// block placement again once its room installed the next epoch.
	let rollover: V3RoomRolloverPolicy | undefined;
	// The zone's successor delivery: the creator announces offers, members install them.
	let delivery: V3RoomSuccessorDelivery | undefined;
	let ephemeral: EphemeralChannel | undefined;
	let projection = emptyProjection(localAuthor, localPeerId);
	// Accepted-history identity belongs to the durable projection, not to an
	// input event or a frame. No parsed authority or native observation is cached.
	let acceptedOperationDigest = digest("ts-drp/d9346-zone-accepted-operations/v1", encodeCanonical(projection.acceptedDigests));
	const installProjection = (value: ZoneProjection): void => {
		projection = value;
		acceptedOperationDigest = digest("ts-drp/d9346-zone-accepted-operations/v1", encodeCanonical(value.acceptedDigests));
	};
	let migrationCreatorAuthor = "";
	let migrationMembers: readonly Readonly<Enrollment & { readonly order: number }>[] = Object.freeze([]);
	let invite = "";
	let zoneId = "";
	let localX = 0;
	let localY = 0;
	let localMovementSequence = 0;
	let tradeIntent: TradeIntentView | undefined;
	let recoveredTradeIntent = false;
	let closeRequested = false;
	let closing: Promise<void> | undefined;
	let opening: Promise<void> | undefined;
	const retainedSourceBridges = new Set<Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>>>();
	const clearAoiProjection = (): void => {
		for (const state of aoiReceivers.values()) clearTimeout(state.expiryTimer);
		aoiPopulations.clear();
		aoiReceivers.clear();
		aoiSenders.clear();
	};
	const resetZoneState = (): void => {
		installProjection(emptyProjection(localAuthor, localPeerId));
		migrationCreatorAuthor = "";
		migrationMembers = Object.freeze([]);
		clearAoiProjection();
		transientPositions.clear();
		invite = "";
		zoneId = "";
		localX = 0;
		localY = 0;
		localMovementSequence = 0;
		tradeIntent = undefined;
		recoveredTradeIntent = false;
		fabricTrials.clear();
	};
	const outcomeContextFor = (selected: V3RoomSession<ZoneProjection>): OutcomeContext => {
		const preview = selected.previewLatchedAcl();
		const acl = Reflect.get(preview, "current");
		if (acl === null || typeof acl !== "object" || Array.isArray(acl)) {
			throw new TypeError("v3 zone outcome ACL context is invalid");
		}
		const epoch = Reflect.get(acl, "epoch");
		if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) {
			throw new TypeError("v3 zone outcome context is invalid");
		}
		return Object.freeze({
			aclDigest: digest("ts-drp/latched-acl/v3", encodeCanonical(acl)),
			anchorDigest: selected.roomId,
			epoch: epoch as number,
			objectId: selected.objectId,
		});
	};
	const requireCurrentPrepared = (
		exactCanonicalIntentHex: string,
		exactCanonicalPayloadHex: string
	): Readonly<{ readonly context: OutcomeContext; readonly prepared: PreparedOutcomeIntent }> => {
		const selected = room;
		if (selected === undefined) throw new TypeError("v3 zone is not open");
		const context = outcomeContextFor(selected);
		const prepared = openPreparedTradeIntent(exactCanonicalIntentHex, exactCanonicalPayloadHex);
		if (
			prepared.intent.aclDigest !== context.aclDigest ||
			prepared.intent.anchorDigest !== context.anchorDigest ||
			prepared.intent.epoch !== context.epoch ||
			prepared.intent.objectId !== context.objectId
		) {
			throw new TypeError("v3 zone trade intent context differs");
		}
		return Object.freeze({ context, prepared });
	};

	const snapshot = (): ZoneSnapshot => {
		const aoiEntries = [...aoiPopulations.entries()].sort(([left], [right]) => compareText(left, right));
		const aoiBandwidthEntries = [...aoiSenders.entries()]
			.filter(([, state]) => state.publicationCount > 0)
			.map(([peerId, state]) => {
				const elapsedMs = Math.max(0, state.lastPublishedAtMs - (state.startedAtMs ?? state.lastPublishedAtMs));
				return [
					peerId,
					Object.freeze({
						durableDelta: state.durableDelta,
						elapsedMs,
						inputEntityCount: state.inputEntityCount,
						projectionBitsPerSecond: elapsedMs === 0 ? 0 : (state.projectionPayloadBytesSent * 8_000) / elapsedMs,
						projectionPayloadBytesSent: state.projectionPayloadBytesSent,
						publicationCount: state.publicationCount,
						selectedEntityCount: state.selectedEntityCount,
					}),
				] as const;
			})
			.sort(([left], [right]) => compareText(left, right));
		const aoiProjectionEntries = [...aoiReceivers.entries()]
			.map(([peerId, { receiver }]) => [peerId, projectionView(receiver.snapshot())] as const)
			.sort(([left], [right]) => compareText(left, right));
		const positionEntries = [...transientPositions.entries()].sort(([left], [right]) => compareText(left, right));
		const raw = zoneId.length === 0 ? undefined : node.ephemeralUnreliableWebRtcSnapshot(zoneId);
		const outcomeContext = room === undefined ? null : outcomeContextFor(room);
		const contextualTradeIntent =
			tradeIntent !== undefined && outcomeContext !== null && sameOutcomeContext(tradeIntent, outcomeContext)
				? tradeIntent
				: undefined;
		const committedOutcome =
			contextualTradeIntent === undefined
				? undefined
				: projection.outcomes.find(
						(outcome) => outcome.proof.clientOperationId === contextualTradeIntent.clientOperationId
					);
		const committedPrepared = committedOutcome === undefined ? undefined : preparedOutcomeCarrier(committedOutcome);
		const currentTradeIntent =
			contextualTradeIntent !== undefined
				? committedPrepared === undefined ||
					(contextualTradeIntent.intentDigest === committedPrepared.intentDigest &&
						(contextualTradeIntent.status === "accepted" || contextualTradeIntent.status === "recovered"))
					? contextualTradeIntent
					: tradeIntentView(committedPrepared, "accepted", 2)
				: absentTradeIntent();
		return Object.freeze({
			acceptedOperationDigest,
			aoiBandwidth: Object.freeze(Object.fromEntries(aoiBandwidthEntries)),
			aoiPopulations: Object.freeze(Object.fromEntries(aoiEntries)),
			aoiProjection: Object.freeze(Object.fromEntries(aoiProjectionEntries)),
			blocks: projection.blocks,
			durableVertexCount: projection.acceptedDigests.length,
			enrollment,
			fabricTrials: Object.freeze(
				[...fabricTrials.values()]
					.map((trial) => fabricTrialView(trial, projection.acceptedDigests.length))
					.filter((trial): trial is FabricTrialView => trial !== undefined)
					.sort((left, right) => compareText(left.trialId, right.trialId))
			),
			invite,
			localAuthor,
			localPeerId,
			outcomeCount: projection.outcomes.length,
			outcomeContext,
			ready: room !== undefined,
			rawTransport: Object.freeze({
				authenticatedConnectionLosses: raw?.authenticatedConnectionLosses ?? 0,
				backpressuredDrops: raw?.backpressuredDrops ?? 0,
				fallbackCount: 0,
				handshakeFailures: raw?.handshakeFailures ?? 0,
				lastLinkDrop: raw?.lastLinkDrop ?? "none",
				linkDrops: raw?.linkDrops ?? 0,
				links: Object.freeze(
					(raw?.links ?? []).map(({ label, maxRetransmits, ordered, peerId }) =>
						Object.freeze({ label, maxRetransmits, ordered, peerId })
					)
				),
				overLimit: ephemeral?.stats().overLimit ?? 0,
				received: raw?.received ?? 0,
				routedBytesReceived: raw?.routedBytesReceived ?? 0,
				routedBytesSent: raw?.routedBytesSent ?? 0,
				sent: raw?.sent ?? 0,
			}),
			transientPositions: Object.freeze(Object.fromEntries(positionEntries)),
			tradeIntent: currentTradeIntent,
			transportPeerAuthors: projection.transportPeerAuthors,
			zoneId,
		});
	};
	const emit = (): void => onProjection(snapshot());
	const emitPositions = (): void => {
		if (onTransient === undefined) return emit();
		// Detach the map on every delivery. Positions themselves are frozen at
		// capture; a subscriber cannot mutate the owner's next visual frame.
		onTransient(Object.freeze({ ready: room !== undefined, zoneId,
			transientPositions: Object.freeze(Object.fromEntries(
				[...transientPositions.entries()].sort(([left], [right]) => compareText(left, right)))) }));
	};
	const scheduleAoiExpiry = (channel: EphemeralChannel, sender: string, state: AoiProjectionReceiverState): void => {
		clearTimeout(state.expiryTimer);
		const expiresAt = state.receiver.nextExpiryAtMs();
		if (expiresAt === null) {
			state.expiryTimer = undefined;
			return;
		}
		state.expiryTimer = setTimeout(
			() => {
				state.expiryTimer = undefined;
				if (room === undefined || ephemeral !== channel || aoiReceivers.get(sender) !== state) return;
				state.receiver.expire(Date.now());
				scheduleAoiExpiry(channel, sender, state);
				emit();
			},
			Math.max(0, expiresAt - Date.now()) + 1
		);
	};
	const scheduleFabricDeadlineEmission = (trial: FabricTrialState): void => {
		if (trial.deadlineAtMs === undefined || trial.deadlineEmissionScheduled) return;
		trial.deadlineEmissionScheduled = true;
		setTimeout(
			() => {
				if (fabricTrials.get(trial.trialId) === trial) emit();
			},
			Math.max(0, trial.deadlineAtMs - Date.now()) + 10
		);
	};
	const subscribeEphemeral = (channel: EphemeralChannel): void => {
		channel.subscribe(({ class: deliveryClass, key, payload, sender }) => {
			// A previously admitted callback must not repaint a reopened room.
			// Current channel authority is still checked by the original channel.
			if (room === undefined || ephemeral !== channel) return;
			const fabricObservation = decodeFabricPayload(payload);
			if (fabricObservation !== undefined) {
				const trial = fabricTrials.get(fabricObservation.trialId);
				if (trial === undefined) return;
				const receivedAtMs = Date.now();
				if (trial.deadlineAtMs === undefined && /^e3-03-[0-2]$/u.test(fabricObservation.trialId)) {
					trial.intervalMs = FABRIC_CAMPAIGN_INTERVAL_MS;
					trial.sampleCount = FABRIC_CAMPAIGN_SAMPLE_COUNT;
					const startedAtMs = fabricObservation.sentAtMs - fabricObservation.sequence * FABRIC_CAMPAIGN_INTERVAL_MS;
					trial.deadlineAtMs =
						startedAtMs +
						(FABRIC_CAMPAIGN_SAMPLE_COUNT - 1) * FABRIC_CAMPAIGN_INTERVAL_MS +
						FABRIC_RELIABLE_OBSERVATION_TAIL_MS;
					scheduleFabricDeadlineEmission(trial);
				}
				if (trial.deadlineAtMs !== undefined && receivedAtMs > trial.deadlineAtMs) return;
				trial.observations.push(
					Object.freeze({
						byteLength: payload.byteLength,
						lane: fabricObservation.lane,
						receivedAtMs,
						sentAtMs: fabricObservation.sentAtMs,
						sequence: fabricObservation.sequence,
						sentinel: fabricObservation.sentinel,
					})
				);
				if (fabricObservation.sentinel) emit();
				return;
			}
			if (deliveryClass === "unreliable-unordered" && key === null) {
				const authorityGeneration = channel.authorityGeneration?.();
				if (authorityGeneration === undefined || payload.byteLength < 6) return;
				const packetGeneration = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
					2,
					false
				);
				if (packetGeneration !== authorityGeneration) return;
				void projectionModule.then(({ createAoiProjectionReceiver }) => {
					if (room === undefined || ephemeral !== channel || channel.authorityGeneration?.() !== authorityGeneration) {
						return;
					}
					let state = aoiReceivers.get(sender);
					if (state === undefined || state.authorityGeneration !== authorityGeneration) {
						clearTimeout(state?.expiryTimer);
						state = {
							authorityGeneration,
							expiryTimer: undefined,
							receiver: createAoiProjectionReceiver({ authorityGeneration }),
						};
						aoiReceivers.set(sender, state);
						aoiPopulations.delete(sender);
					}
					const accepted = state.receiver.ingest({ authorityGeneration, bytes: payload, receivedAtMs: Date.now() });
					if (accepted) aoiPopulations.set(sender, state.receiver.snapshot().entities);
					scheduleAoiExpiry(channel, sender, state);
					emit();
				});
				return;
			}
			const position = decodePosition(payload);
			if (position === undefined) return;
			transientPositions.set(sender, position);
			emitPositions();
		});
	};
	const performOpen = async (
		selectedZoneId: string,
		creatorInvite: string | V3RoomCreatorInviteMaterial,
		bootstrapMembers: readonly Readonly<Enrollment & { readonly order: number }>[],
		operation: "create" | "join"
	): Promise<void> => {
		resetZoneState();
		zoneId = selectedZoneId;
		let opened: Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>> | undefined;
		let sourceRoom: Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>> | undefined;
		let redirectedDuringOpen: Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>> | undefined;
		try {
			const separator = selectedZoneId.indexOf(":");
			if (separator <= 0) throw new TypeError("v3 zone creator identity is invalid");
			const creatorPeerId = selectedZoneId.slice(0, separator);
			const creatorAuthor = creatorAuthorFromInvite(creatorInvite);
			const roomHeadAuthority = await roomHeadAuthorityForOpen(
				Object.freeze({ author: localAuthor, creatorInvite, objectId: selectedZoneId, operation })
			);
			validateRoomHeadAuthority(roomHeadAuthority);
			if (closeRequested) throw new Error("v3 zone closed during open");
			// Creator custody comes from the configured Keychain, including creator
			// reopen. An independently enrolled recipient never acquires this authority.
			const creatorFinalitySigner =
				localAuthor === creatorAuthor ? await node.keychain.acquireLocalAuthorFinalitySigner() : undefined;
			if (closeRequested) throw new Error("v3 zone closed during open");
			const application = createV3ZoneApplication(bootstrapMembers, creatorPeerId, creatorAuthor, blueprintDigestFromInvite(creatorInvite));
			// Delivery runs on the room's own object id and installs into its own session, so it
			// follows a migration redirect: the migrated room's members (redirected or joined
			// afterwards) are on the target's queue, and only the target session installs its offers.
			const openDelivery = (objectId: string): V3RoomSuccessorDelivery =>
				openV3RoomSuccessorDelivery(node, objectId, creatorFinalitySigner === undefined ? "member" : "creator", {
					onError: (error) => console.warn("v3 zone successor delivery failed; it is retried", error),
					onRefused: (error) => console.warn("v3 zone successor offer was refused", error),
				});
			delivery = openDelivery(selectedZoneId);
			// Only the creator, which holds the finality signer, seals.
			const policy = createV3RoomRolloverPolicy({
				role: creatorFinalitySigner === undefined ? "member" : "creator",
				budget: GRID_ROLLOVER_BUDGET,
				// A later placement of a block supersedes an earlier one (the zone's displacement identity):
				// a kept or given-back placement never lands after a newer accepted one of the same block.
				identity: (operation) => {
					const action = operation.action;
					return typeof action === "string" && application.displacementPolicies[action] === "rebase"
						? `${action}\u0000${application.displacedOperationIdentity(operation)}`
						: undefined;
				},
				hooks: {
					publishSuccessor:
						publishSuccessor ?? ((offer, epoch): Promise<void> => delivery?.publish(offer, epoch) ?? Promise.resolve()),
					requestSuccessor: () => delivery?.request(),
					// Between zones (no delivery yet) the creator is not judged unreachable.
					creatorReachable: () => delivery?.creatorReachable() ?? true,
					onStatus: (status) => {
						if (status.state === "successor-unavailable")
							console.warn("v3 zone is waiting for the creator's next epoch; kept placements", status.kept);
						if (status.state === "not-reaching-host")
							console.warn(
								`v3 zone: your moves are not reaching the host (${status.unsettledEpochs} epochs); kept placements`,
								status.kept
							);
						if (status.state === "read-only")
							console.warn("v3 zone: the host is unreachable; read-only until it is back; kept placements", status.kept);
					},
					onError: (error) => console.warn("v3 zone rollover failed; it is retried", error),
				},
			});
			rollover = policy;
			// Decision A: this player's own room database; the shared (zoneId-only) one migrates once.
			const { databaseName } = await prepareV3RoomPlayerDatabase({
				application: "zone",
				objectId: zoneId,
				author: localAuthor,
			});
			opened = await createV3RoomSession<ZoneProjection>({
				application,
				author: localAuthor,
				creatorInvite,
				...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
				...(creatorFinalitySigner === undefined ? {} : { creatorFinalitySigner }),
				// Creator restore currency: a reopened creator asks the zone's members before it signs.
				...(delivery?.role === "creator" ? { creatorMemberView: delivery.creatorMemberView } : {}),
				createOperationAdmissionPolicy: (context) =>
					createOutcomeCommitAdmissionPolicy({
						aclDigest: context.aclDigest,
						anchorDigest: context.anchorDigest,
						epoch: context.epoch,
						objectId: context.objectId,
						maxEntries: PARAMETERS.maxEpochVertices,
						...(context.authenticatedApplicationStateBytes === undefined
							? {}
							: { authenticatedApplicationStateBytes: context.authenticatedApplicationStateBytes }),
					}),
				databaseName,
				initialLogicalTime: 3,
				issuanceDatabaseName: databaseName,
				migrationDatabaseNamespace: `${localAuthor}:${zoneId}`,
				objectId: zoneId,
				onAcceptedVertex: (vertex) => policy.observe(vertex),
				// A hot Writer's move refused at the creator's capacity: seal now, it lands in the successor.
				onIngressCapacityRefusal: (reason) => policy.refused(reason),
				onMigrationTarget: (target, targetObjectId): void => {
					redirectedDuringOpen = target;
					if (sourceRoom !== undefined) retainedSourceBridges.add(sourceRoom);
					room = target;
					zoneId = targetObjectId;
					delivery?.close();
					const followed = openDelivery(targetObjectId);
					delivery = followed;
					followed.bind(target);
					tradeIntent = undefined;
					recoveredTradeIntent = false;
					ephemeral?.close();
					clearAoiProjection();
					const redirectedEphemeral = target.openEphemeral(ZONE_EPHEMERAL_OPTIONS);
					subscribeEphemeral(redirectedEphemeral);
					ephemeral = redirectedEphemeral;
				},
				onProjection: (value): void => {
					installProjection(value);
					const latestOutcome = value.outcomes.at(-1);
					if (latestOutcome !== undefined) {
						const preparedOutcome = preparedOutcomeCarrier(latestOutcome);
						if (
							preparedOutcome.intent.counterparties.includes(localAuthor) &&
							tradeIntent?.intentDigest !== preparedOutcome.intentDigest
						) {
							tradeIntent = tradeIntentView(preparedOutcome, "accepted", 2);
							recoveredTradeIntent = room === undefined;
						}
					}
					const selectedRoom = room;
					const selectedEphemeral = ephemeral;
					if (selectedRoom !== undefined && selectedEphemeral !== undefined) {
						queueMicrotask((): void => {
							if (room !== selectedRoom || ephemeral !== selectedEphemeral) return;
							try {
								selectedRoom.openEphemeral(ZONE_EPHEMERAL_OPTIONS);
							} catch {
								// Optional raw reconciliation cannot terminalize an accepted durable projection.
							}
						});
					}
					emit();
				},
				openTransport: (openedObjectId) => node.openRoomNetwork(openedObjectId),
				publicKeyBytes: bytes(localAuthor),
				roomHeadAuthority,
				signRegisteredVertexDigest: (registeredDigest) => node.keychain.signWithLocalAuthor(registeredDigest),
			});
			sourceRoom = opened;
			// A migrated source forwards issue and seal to its target, so the policy stays bound to it.
			// Delivery is bound to the target by the redirect instead.
			policy.bind(opened);
			if (redirectedDuringOpen === undefined) delivery?.bind(opened);
			if (redirectedDuringOpen !== undefined) retainedSourceBridges.add(opened);
			if (closeRequested) throw new Error("v3 zone closed during open");
			if (redirectedDuringOpen === undefined) {
				const openedEphemeral = opened.openEphemeral(ZONE_EPHEMERAL_OPTIONS);
				subscribeEphemeral(openedEphemeral);
				room = opened;
				zoneId = opened.objectId;
				ephemeral = openedEphemeral;
			}
			migrationCreatorAuthor = creatorAuthor;
			migrationMembers = Object.freeze(bootstrapMembers.map((member) => Object.freeze({ ...member })));
			emit();
		} catch (error) {
			rollover?.close();
			rollover = undefined;
			delivery?.close();
			delivery = undefined;
			await Promise.allSettled([opened?.close(), redirectedDuringOpen?.close()]);
			resetZoneState();
			throw error;
		}
	};
	const trackOpen = (operation: () => Promise<void>): Promise<void> => {
		if (room !== undefined || opening !== undefined || closing !== undefined) {
			throw new TypeError("v3 zone is already open or closing");
		}
		closeRequested = false;
		const attempt = operation().finally(() => {
			if (opening === attempt) opening = undefined;
		});
		opening = attempt;
		return attempt;
	};
	let activeFabricTrial: string | undefined;
	const fabric: ZoneFabricWorkbench = Object.freeze({
		async reset(trialId: string): Promise<void> {
			validateFabricTrialId(trialId);
			if (activeFabricTrial === trialId) throw new TypeError("fabric trial is active");
			if (room === undefined || ephemeral === undefined) throw new TypeError("fabric trial is not ready");
			await Promise.all([ephemeral.resetReliable(), ephemeral.restartUnreliable()]);
			fabricTrials.set(trialId, {
				attemptedRaw: 0,
				attemptedReliable: 0,
				deadlineAtMs: undefined,
				deadlineEmissionScheduled: false,
				durableBaseline: projection.acceptedDigests.length,
				intervalMs: 0,
				observations: [],
				sampleCount: 0,
				trialId,
			});
			if (
				!(await ephemeral.publish({
					class: "reliable-unordered",
					key: null,
					payload: new Uint8Array(),
				}))
			) {
				throw new Error("fabric reliable drain is not ready");
			}
			emit();
		},
		async runTrial(input: FabricRunInput): Promise<void> {
			validateFabricRunInput(input);
			const channel = ephemeral;
			const trial = fabricTrials.get(input.trialId);
			if (room === undefined || channel === undefined || trial === undefined) {
				throw new TypeError("fabric trial is not ready");
			}
			if (activeFabricTrial !== undefined) throw new TypeError("fabric trial is active");
			trial.intervalMs = input.intervalMs;
			trial.sampleCount = input.sampleCount;
			trial.deadlineAtMs = /^e3-03-[0-2]$/u.test(input.trialId)
				? Date.now() + (input.sampleCount - 1) * input.intervalMs + FABRIC_RELIABLE_OBSERVATION_TAIL_MS
				: undefined;
			scheduleFabricDeadlineEmission(trial);
			activeFabricTrial = input.trialId;
			try {
				const startedAtMs = Date.now();
				for (let sequence = 0; sequence < input.sampleCount; sequence += 1) {
					if (sequence > 0) {
						const dueAtMs = startedAtMs + sequence * input.intervalMs;
						await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueAtMs - Date.now())));
					}
					const sentAtMs = Date.now();
					trial.attemptedRaw += 1;
					trial.attemptedReliable += 1;
					void channel
						.publish({
							class: "unreliable-sequenced",
							key: localPeerId,
							payload: encodeFabricPayload(input, "raw", sequence, sentAtMs, false, input.payloadBytes),
						})
						.catch(() => false);
					void channel
						.publish({
							class: "reliable-unordered",
							key: null,
							payload: encodeFabricPayload(input, "reliable", sequence, sentAtMs, false, input.payloadBytes),
						})
						.catch(() => false);
				}
				void channel
					.publish({
						class: "reliable-unordered",
						key: null,
						payload: encodeFabricPayload(
							input,
							"reliable",
							input.sampleCount,
							Date.now(),
							true,
							input.reliableSentinelBytes
						),
					})
					.catch(() => false);
			} finally {
				activeFabricTrial = undefined;
				emit();
			}
		},
		snapshot(trialId: string) {
			validateFabricTrialId(trialId);
			const trial = fabricTrials.get(trialId);
			if (trial === undefined) throw new TypeError("fabric trial is absent");
			if (fabricTrialView(trial, projection.acceptedDigests.length) !== undefined) emit();
			const raw = node.ephemeralUnreliableWebRtcSnapshot(zoneId);
			return Object.freeze({
				attempted: Object.freeze({ raw: trial.attemptedRaw, reliable: trial.attemptedReliable }),
				observations: Object.freeze([...trial.observations]),
				transport: Object.freeze({
					fallbackCount: 0 as const,
					raw: Object.freeze(
						(raw?.links ?? []).map(({ connectionId, generation, maxRetransmits, ordered, peerId, remoteAddr }) =>
							Object.freeze({
								connectionId,
								generation,
								iceRestarts: 0 as const,
								maxRetransmits: maxRetransmits as 0,
								ordered: ordered as false,
								peerId,
								remoteAddr,
								readyState: "open" as const,
							})
						)
					),
				}),
				trialId,
			});
		},
	});

	const api: V3ZoneApi = {
		async activateMigration(receipt: V3RoomMigrationRehearsalReceipt): Promise<V3RoomMigrationActivationReceipt> {
			const selected = room;
			if (selected === undefined) throw new TypeError("v3 zone is not open");
			if (migrationCreatorAuthor !== localAuthor) throw new TypeError("v3 zone migration requires the creator");
			const record = decodeCanonical(receipt.exactCanonicalRecordBytes);
			const nonce = record !== null && typeof record === "object" ? Reflect.get(record, "rehearsalNonce") : undefined;
			const targetObjectId =
				record !== null && typeof record === "object" ? Reflect.get(record, "targetObjectId") : undefined;
			if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 32 || typeof targetObjectId !== "string") {
				throw new TypeError("v3 zone migration receipt is invalid");
			}
			const sourceMembers = migrationMembers;
			const targetCreatorInvite = await createCreatorInviteMaterial(node, targetObjectId, sourceMembers);
			const activated = await selected.activateMigration({
				exactCanonicalRecordBytes: new Uint8Array(receipt.exactCanonicalRecordBytes),
				recordVertexDigest: receipt.recordVertexDigest,
				targetCreatorInvite,
			});
			tradeIntent = undefined;
			recoveredTradeIntent = false;
			invite = encodeZoneInvite({ roomInvite: selected.invite, zoneId: targetObjectId });
			emit();
			return activated;
		},
		async approveTradeIntent(input): Promise<TradeApproval> {
			const selected = room;
			if (
				selected === undefined ||
				input === null ||
				typeof input !== "object" ||
				typeof input.exactCanonicalIntentHex !== "string" ||
				typeof input.exactCanonicalPayloadHex !== "string"
			) {
				throw new TypeError("v3 zone trade approval input is invalid");
			}
			const { context, prepared } = requireCurrentPrepared(
				input.exactCanonicalIntentHex,
				input.exactCanonicalPayloadHex
			);
			if (!prepared.intent.counterparties.includes(localAuthor)) {
				throw new TypeError("v3 zone trade intent excludes the local author");
			}
			const signature = await node.keychain.signWithLocalAuthor(prepared.registeredDigest);
			if (room !== selected || !sameOutcomeContext(context, outcomeContextFor(selected))) {
				tradeIntent = undefined;
				recoveredTradeIntent = false;
				throw new TypeError("v3 zone trade context changed while approving");
			}
			tradeIntent = tradeIntentView(prepared, "approved", 1);
			emit();
			return Object.freeze({ signatureHex: hex(signature), signer: localAuthor });
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closeRequested = true;
			const attempt = (async (): Promise<void> => {
				await opening?.catch(() => undefined);
				const selected = room;
				const selectedEphemeral = ephemeral;
				const sources = [...retainedSourceBridges];
				retainedSourceBridges.clear();
				rollover?.close();
				rollover = undefined;
				delivery?.close();
				delivery = undefined;
				room = undefined;
				ephemeral = undefined;
				resetZoneState();
				let failure: unknown;
				try {
					selectedEphemeral?.close();
				} catch (error) {
					failure = error;
				}
				const closed = await Promise.allSettled([selected?.close(), ...sources.map((source) => source.close())]);
				for (const result of closed) {
					if (result.status === "rejected") failure ??= result.reason;
				}
				resetZoneState();
				if (failure !== undefined) throw failure;
			})().finally(() => {
				if (closing === attempt) closing = undefined;
				closeRequested = false;
				emit();
			});
			closing = attempt;
			return attempt;
		},
		// The application delegates to its original current room owner. These
		// methods mint no transition authority and do not bridge the ephemeral
		// authority gap while the original successor lifecycle is joining.
		sealEpoch() {
			const selected = room;
			if (selected === undefined || closeRequested) return Promise.reject(new TypeError("v3 zone is not open"));
			return selected.sealEpoch();
		},
		exportCreatorSuccessor() {
			const selected = room;
			if (selected === undefined || closeRequested) return Promise.reject(new TypeError("v3 zone is not open"));
			return selected.exportCreatorSuccessor();
		},
		adoptCreatorSuccessor() {
			const selected = room;
			if (selected === undefined || closeRequested) return Promise.reject(new TypeError("v3 zone is not open"));
			return selected.adoptCreatorSuccessor();
		},
		installCreatorSuccessor(request) {
			const selected = room;
			if (selected === undefined || closeRequested) return Promise.reject(new TypeError("v3 zone is not open"));
			return selected.installCreatorSuccessor(request);
		},
		async commitTradeIntent(input): Promise<Readonly<{ readonly kind: "accepted" | "duplicate" }>> {
			const selected = room;
			if (
				selected === undefined ||
				input === null ||
				typeof input !== "object" ||
				!Array.isArray(input.approvals) ||
				typeof input.exactCanonicalIntentHex !== "string" ||
				typeof input.exactCanonicalPayloadHex !== "string"
			) {
				throw new TypeError("v3 zone trade commit input is invalid");
			}
			const { context, prepared } = requireCurrentPrepared(
				input.exactCanonicalIntentHex,
				input.exactCanonicalPayloadHex
			);
			const approvals: readonly OutcomeApproval[] = input.approvals.map((approval) =>
				Object.freeze({ signature: bytes(approval.signatureHex), signer: approval.signer })
			);
			const proof = createOutcomeCommitOperation({ approvals, prepared });
			const verified = verifyOutcomeCommitOperation({
				expectedAclDigest: context.aclDigest,
				expectedAnchorDigest: context.anchorDigest,
				expectedEpoch: context.epoch,
				expectedObjectId: context.objectId,
				operation: proof,
			});
			if (!verified.ok) throw new TypeError(`v3 zone trade proof was rejected: ${verified.reason}`);
			const operation = createOutcomeCommitAdmissionOperation(verified.verified.operation);
			try {
				await selected.issue(operation);
			} catch (error) {
				const existing = projection.outcomes.find(
					(candidate) => candidate.proof.clientOperationId === verified.verified.clientOperationId
				);
				if (
					existing !== undefined &&
					preparedOutcomeCarrier(existing).intentDigest === verified.verified.intentDigest
				) {
					if (recoveredTradeIntent) {
						tradeIntent = tradeIntentView(prepared, "recovered", 2);
						recoveredTradeIntent = false;
						emit();
					}
					return Object.freeze({ kind: "duplicate" as const });
				}
				throw error;
			}
			if (room !== selected || !sameOutcomeContext(context, outcomeContextFor(selected))) {
				tradeIntent = undefined;
				recoveredTradeIntent = false;
				throw new TypeError("v3 zone trade context changed while committing");
			}
			const accepted = projection.outcomes.find(
				(candidate) => candidate.proof.clientOperationId === verified.verified.clientOperationId
			);
			if (accepted === undefined || preparedOutcomeCarrier(accepted).intentDigest !== verified.verified.intentDigest) {
				throw new TypeError("v3 zone trade commit was not projected");
			}
			tradeIntent = tradeIntentView(prepared, "accepted", 2);
			emit();
			return Object.freeze({ kind: "accepted" as const });
		},
		async create(memberEnrollments: string | readonly string[]): Promise<void> {
			await trackOpen(async (): Promise<void> => {
				const encodedMembers = typeof memberEnrollments === "string" ? [memberEnrollments] : [...memberEnrollments];
				if (encodedMembers.length < 1 || encodedMembers.length > 8) {
					throw new TypeError("v3 zone member enrollment count differs");
				}
				const decodedMembers = encodedMembers.map((encoded) => decodeEnrollment(encoded));
				const authors = new Set([localAuthor]);
				const peerIds = new Set([localPeerId]);
				for (const member of decodedMembers) {
					if (authors.has(member.author) || peerIds.has(member.peerId)) {
						throw new TypeError("v3 zone member enrollment duplicates a member");
					}
					authors.add(member.author);
					peerIds.add(member.peerId);
				}
				const salt = new Uint8Array(16);
				crypto.getRandomValues(salt);
				const selectedZoneId = `${localPeerId}:${hex(salt)}`;
				const members = Object.freeze([
					Object.freeze({ author: localAuthor, order: 0, peerId: localPeerId }),
					...decodedMembers.map((member, index) => Object.freeze({ ...member, order: index + 1 })),
				]);
				const material = await createCreatorInviteMaterial(node, selectedZoneId, members);
				await performOpen(selectedZoneId, material, members, "create");
				if (room === undefined) throw new Error("v3 zone did not open");
				invite = encodeZoneInvite({ roomInvite: room.invite, zoneId: selectedZoneId });
				emit();
			});
		},
		fabric,
		finalizeTradeIntent(input) {
			if (
				input === null ||
				typeof input !== "object" ||
				!Array.isArray(input.approvals) ||
				typeof input.exactCanonicalIntentHex !== "string" ||
				typeof input.exactCanonicalPayloadHex !== "string"
			) {
				throw new TypeError("v3 zone trade finalization input is invalid");
			}
			const { context, prepared } = requireCurrentPrepared(
				input.exactCanonicalIntentHex,
				input.exactCanonicalPayloadHex
			);
			const approvals: readonly OutcomeApproval[] = input.approvals.map((approval) =>
				Object.freeze({ signature: bytes(approval.signatureHex), signer: approval.signer })
			);
			const operation = createOutcomeCommitOperation({ approvals, prepared });
			const verified = verifyOutcomeCommitOperation({
				expectedAclDigest: context.aclDigest,
				expectedAnchorDigest: context.anchorDigest,
				expectedEpoch: context.epoch,
				expectedObjectId: context.objectId,
				operation,
			});
			if (!verified.ok) throw new TypeError(`v3 zone trade proof was rejected: ${verified.reason}`);
			tradeIntent = tradeIntentView(prepared, "ready", 2);
			emit();
			return Promise.resolve(
				Object.freeze({
					action: "commit-outcome-v1" as const,
					clientOperationId: verified.verified.clientOperationId,
				})
			);
		},
		async join(encodedInvite: string): Promise<void> {
			await trackOpen(async (): Promise<void> => {
				const decoded = decodeZoneInvite(encodedInvite);
				await performOpen(
					decoded.zoneId,
					decoded.roomInvite,
					Object.freeze([Object.freeze({ author: localAuthor, order: 1, peerId: localPeerId })]),
					"join"
				);
				invite = encodedInvite;
				emit();
			});
		},
		move(dx: number, dy: number): void {
			if (room === undefined || ephemeral === undefined) return;
			const nextX = localX + dx;
			const nextY = localY + dy;
			if (
				!Number.isInteger(dx) ||
				!Number.isInteger(dy) ||
				nextX < -2_147_483_648 ||
				nextX > 2_147_483_647 ||
				nextY < -2_147_483_648 ||
				nextY > 2_147_483_647
			) {
				throw new TypeError("v3 zone movement is outside its integer range");
			}
			localX = nextX;
			localY = nextY;
			localMovementSequence = (localMovementSequence + 1) >>> 0;
			transientPositions.set(localPeerId, Object.freeze({ x: localX, y: localY }));
			void ephemeral.publish({
				class: "unreliable-sequenced",
				key: localPeerId,
				payload: encodeEntityDeltaBatch([{ entityId: 0, sequence: localMovementSequence, x: localX, y: localY }]),
			});
			emitPositions();
		},
		async placeBlock(input: ZoneBlock): Promise<void> {
			const selected = room;
			if (selected === undefined) throw new TypeError("v3 zone is not open");
			if (
				typeof input.id !== "string" ||
				input.id.length === 0 ||
				typeof input.kind !== "string" ||
				input.kind.length === 0 ||
				!Number.isSafeInteger(input.x) ||
				!Number.isSafeInteger(input.y)
			) {
				throw new TypeError("v3 zone block is invalid");
			}
			// A placement refused at the epoch's capacity is offered again after the next rollover.
			await (rollover ?? selected).issue(
				Object.freeze({ action: "placeBlock", id: input.id, kind: input.kind, x: input.x, y: input.y })
			);
		},
		prepareTradeIntent(input): Promise<PreparedTradeIntent> {
			const selected = room;
			if (
				selected === undefined ||
				input === null ||
				typeof input !== "object" ||
				typeof input.clientOperationId !== "string" ||
				typeof input.counterpartyAuthor !== "string" ||
				!/^[0-9a-f]{64}$/u.test(input.counterpartyAuthor) ||
				input.counterpartyAuthor === localAuthor ||
				!validTradeAsset(input.offeredAsset) ||
				!validTradeAsset(input.requestedAsset)
			) {
				throw new TypeError("v3 zone trade preparation input is invalid");
			}
			const context = outcomeContextFor(selected);
			const prepared = prepareOutcomeIntent({
				...context,
				clientOperationId: input.clientOperationId,
				counterparties: [localAuthor, input.counterpartyAuthor],
				exactCanonicalPayloadBytes: encodeCanonical({
					counterparty: input.counterpartyAuthor,
					kind: "same-zone-trade-v1",
					offeredAsset: input.offeredAsset,
					proposer: localAuthor,
					requestedAsset: input.requestedAsset,
					version: 1,
				}),
				outcomeKind: "same-zone-trade-v1",
			});
			tradeIntent = tradeIntentView(prepared, "pending", 0);
			emit();
			return Promise.resolve(
				Object.freeze({
					clientOperationId: prepared.intent.clientOperationId,
					exactCanonicalIntentHex: hex(prepared.exactCanonicalIntentBytes),
					exactCanonicalPayloadHex: hex(prepared.exactCanonicalPayloadBytes),
					intentDigest: prepared.intentDigest,
					registeredDigestHex: hex(prepared.registeredDigest),
				})
			);
		},
		async publishAoiPopulation(input): Promise<boolean> {
			if (room === undefined || ephemeral === undefined) return false;
			if (
				input === null ||
				typeof input !== "object" ||
				typeof input.observerPeerId !== "string" ||
				input.observerPeerId.length === 0
			) {
				throw new TypeError("v3 zone AOI publication differs");
			}
			const authorityGeneration = ephemeral.authorityGeneration?.();
			const maxEnvelopeBytes = ephemeral.maxEnvelopeBytes?.("unreliable-unordered");
			if (authorityGeneration === undefined || maxEnvelopeBytes === undefined || maxEnvelopeBytes < 42) return false;
			const { createAoiProjectionSender, selectAoiEntityDeltas } = await projectionModule;
			const inputEntityCount = input.entities.length;
			const selected = selectAoiEntityDeltas({
				entities: input.entities,
				maxEntities: 32,
				observerX: input.observerX,
				observerY: input.observerY,
				radius: input.radius,
			});
			let senderState = aoiSenders.get(input.observerPeerId);
			if (
				senderState === undefined ||
				senderState.authorityGeneration !== authorityGeneration ||
				senderState.maxEnvelopeBytes !== maxEnvelopeBytes
			) {
				const nowMs = Date.now();
				senderState = {
					authorityGeneration,
					durableBaseline: projection.acceptedDigests.length,
					durableDelta: 0,
					inputEntityCount: 0,
					lastPublishedAtMs: nowMs,
					maxEnvelopeBytes,
					nextSequence: 0,
					projectionPayloadBytesSent: 0,
					publicationCount: 0,
					selectedEntityCount: 0,
					startedAtMs: undefined,
					sender: createAoiProjectionSender({ generation: authorityGeneration, maxPayloadBytes: maxEnvelopeBytes }),
				};
				aoiSenders.set(input.observerPeerId, senderState);
			}
			const packets = senderState.sender.encode({ entities: selected, sequence: senderState.nextSequence });
			senderState.nextSequence += 1;
			let projectionPayloadBytesSent = 0;
			for (const payload of packets) {
				if (
					!(await ephemeral.publishTo([input.observerPeerId], {
						class: "unreliable-unordered",
						key: null,
						payload,
					}))
				) {
					return false;
				}
				projectionPayloadBytesSent += payload.byteLength;
			}
			const publishedAtMs = Date.now();
			senderState.durableDelta = projection.acceptedDigests.length - senderState.durableBaseline;
			senderState.inputEntityCount = inputEntityCount;
			senderState.lastPublishedAtMs = publishedAtMs;
			senderState.projectionPayloadBytesSent += projectionPayloadBytesSent;
			senderState.publicationCount += 1;
			senderState.selectedEntityCount = selected.length;
			senderState.startedAtMs ??= publishedAtMs;
			emit();
			return true;
		},
		async rehearseMigration(): Promise<V3RoomMigrationRehearsalReceipt> {
			const selected = room;
			if (selected === undefined) throw new TypeError("v3 zone is not open");
			if (migrationCreatorAuthor !== localAuthor) throw new TypeError("v3 zone migration requires the creator");
			const rehearsalNonce = new Uint8Array(32);
			crypto.getRandomValues(rehearsalNonce);
			const targetObjectId = migrationTargetObjectId(zoneId, rehearsalNonce);
			return selected.rehearseMigration({
				rehearsalNonce,
				targetCreatorInvite: await createCreatorInviteMaterial(node, targetObjectId, migrationMembers),
			});
		},
		snapshot,
	};
	emit();
	return Object.freeze(api);
}

/**
 * Encodes the durable zone projection shared by genesis and migration.
 * @param projection - Product-owned durable zone state.
 * @returns Exact canonical durable zone state bytes.
 */
function canonicalZoneStateBytes(projection: ZoneProjection): Uint8Array {
	return encodeCanonical({
		version: 2,
		creatorAuthor: projection.creatorAuthor,
		creatorPeerId: projection.creatorPeerId,
		blocks: projection.blocks,
		outcomes: projection.outcomes,
		roster: projection.roster,
	});
}

/**
 * Creates the one production zone composition installed by the zone entry path.
 * @param members - Ordered creator-approved bootstrap roster.
 * @param creatorPeerId - Transport identity bound to the creator roster entry.
 * @param creatorAuthor - Durable creator author bound to the signed invite.
 * @returns Exact blueprint, catalog, bootstrap and projection authority.
 */
export function createV3ZoneApplication(
	members: readonly Readonly<Enrollment & { readonly order: number }>[],
	creatorPeerId: string,
	creatorAuthor: string,
	blueprintDigest?: string
): Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["application"] {
	const material = applicationMaterial(blueprintDigest);
	const kernel = createZoneStateKernel(creatorAuthor, creatorPeerId, material.artifactVersion);
	// The projection is a pure fold. Keep this application's last fold so the next projection over
	// the same base and an exact prefix of the same frozen accepted-operation records continues it
	// instead of replaying the whole epoch.
	let lastFold: ZoneFold | undefined;
	const resolved = material.catalog.resolve(material.blueprintDigest);
	// Capture this application's exact resolved entry once. Public catalog/package
	// readouts cannot mutate these private expected carriers between invocations.
	const expectedResourceCatalog = Object.freeze({
		blueprintDigest: resolved.blueprintDigest,
		artifactId: resolved.artifactId,
		artifactDigest: resolved.artifactDigest,
		catalogDigest: resolved.evidence.catalogDigest,
		runtimeProfile: resolved.runtimeProfile,
		exactArtifactBytes: resolved.exactArtifactBytes.slice(),
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice(),
	});
	type ResourceReader = NonNullable<Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["application"]["readOrdinaryApplicationResourceBound"]>;
	type ResourceInput<Material> = Readonly<{catalog: Parameters<ResourceReader>[0]["catalog"]; material: Material}>;
	const captureResourceMaterial = <Material>(input: ResourceInput<Material>): Material | undefined => {
		if (input === null || typeof input !== "object" || Reflect.ownKeys(input).length !== 2) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (descriptors.catalog === undefined || !Object.hasOwn(descriptors.catalog, "value") ||
			descriptors.material === undefined || !Object.hasOwn(descriptors.material, "value")) return undefined;
		const catalog = descriptors.catalog.value;
		if (catalog === null || typeof catalog !== "object" || Reflect.ownKeys(catalog).length !== 7) return undefined;
		const fields = Object.getOwnPropertyDescriptors(catalog);
		const identityKeys = ["blueprintDigest", "artifactId", "artifactDigest", "catalogDigest", "runtimeProfile"] as const;
		if (identityKeys.some(key => fields[key] === undefined || !Object.hasOwn(fields[key]!, "value") ||
			fields[key]!.value !== expectedResourceCatalog[key])) return undefined;
		for (const key of ["exactArtifactBytes", "canonicalBlueprintPackageBytes"] as const) {
			if (fields[key] === undefined || !Object.hasOwn(fields[key]!, "value") ||
				!(fields[key]!.value instanceof Uint8Array) || !sameBytes(expectedResourceCatalog[key], fields[key]!.value)) return undefined;
		}
		return descriptors.material.value as Material | undefined;
	};
	const resourceFootprint = (bound: CanonicalResourceFootprint | undefined): CanonicalResourceFootprint | undefined =>
		bound === undefined ? undefined : Object.freeze({byteLength: bound.byteLength, items: bound.items, maxDepth: bound.maxDepth});
	/** Local numerical policy only. The original source owner authenticates the
	 * exact catalog/material and retains one source-bound projection. Neither
	 * complete nor delta planning grants admission, authority or proof credit. */
	const resourceBoundReader = Object.assign((input: ResourceInput<ZonePlacementGrowthMaterial>): CanonicalResourceFootprint | undefined => {
		try {
			const captured = captureResourceMaterial(input);
			return captured === undefined ? undefined : resourceFootprint(kernel.readPlacementGrowthBound(captured));
		} catch {return undefined;}
	}, {
		createIncrementalProjection: (input: ResourceInput<Omit<ZonePlacementGrowthMaterial, "candidateOperation">>) => {
			try {
				const captured = captureResourceMaterial(input);
				const projection = captured === undefined ? undefined : kernel.createPlacementGrowthProjection(captured);
				return projection === undefined ? undefined : Object.freeze({
					advance: (operations: readonly unknown[]) => projection.advance(operations),
					quote: (candidateOperation: unknown) => resourceFootprint(projection.quote(candidateOperation)),
					quoteWithoutApplicationCandidate: () => resourceFootprint(projection.quoteWithoutApplicationCandidate()),
					quoteWindow: (declaration: Parameters<typeof projection.quoteWindow>[0]) => resourceFootprint(projection.quoteWindow(declaration)),
				});
			} catch {return undefined;}
		},
	});
	return Object.freeze({
		batchableOperationActions: Object.freeze(["placeBlock"]),
		bootstrapOperation: Object.freeze({
			action: "installRoster",
			roster: Object.freeze({ entries: Object.freeze(members.map((entry) => Object.freeze({ ...entry }))) }),
		}),
		canonicalBlueprintPackageBytes: material.canonicalBlueprintPackageBytes,
		catalog: material.catalog,
		readOrdinaryApplicationResourceBound: resourceBoundReader,
		displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>) => {
			const identity = Reflect.get(operation, "id");
			if (typeof identity !== "string" || identity.length === 0) {
				throw new TypeError("v3 zone block identity is invalid");
			}
			return identity;
		},
		displacementPolicies: Object.freeze({ placeBlock: "rebase" as const }),
		migration: Object.freeze({
			...(material.artifactVersion === "current" ? {inheritAuthenticatedState: true as const} : {}),
			containsInheritedOperation: (operation: Readonly<Record<string, unknown>>, exactCanonicalStateBytes: Uint8Array) => {
				if (operation.action !== "commit-outcome-v1") return false;
				const exact = encodeCanonical(verifiedOutcomeCarrier(operation));
				const projection = decodeZoneState(exactCanonicalStateBytes, kernel);
				return projection.outcomes.some((outcome) => sameBytes(exact, encodeCanonical(outcome)));
			},
			canonicalStateBytes: canonicalZoneStateBytes,
			prepare: (operations: readonly V3RoomAcceptedOperation[], exactCanonicalSourceStateBytes?: Uint8Array) => {
				const prepared = prepareZoneMigration(operations,kernel,exactCanonicalSourceStateBytes);
				if (material.artifactVersion === "predecessor" && decodeZoneState(prepared.exactCanonicalApplicationStateBytes,kernel).outcomes.length !== 0)
					throw new TypeError("retained Grid blueprint has no authenticated outcome-transfer reducer");
				return prepared;
			},
		}),
		projectAcceptedOperations: (input: V3RoomProjectionInput) => {
			const baseBytes = input.authenticatedBase?.exactCanonicalApplicationStateBytes;
			const prior = continuableFold(lastFold, baseBytes, input.currentEpochOperations);
			const base =
				prior !== undefined || baseBytes === undefined ? undefined : decodeZoneState(baseBytes, kernel);
			const fold = foldZone(input.currentEpochOperations, kernel, base, prior, baseBytes);
			lastFold = fold;
			return zoneProjection([...fold.acceptedDigests], fold.state);
		},
	});
}

/** One completed fold: its base bytes (a private copy), its exact operation records and its result. */
type ZoneFold = Readonly<{
	baseBytes: Uint8Array | undefined;
	operations: readonly V3RoomAcceptedOperation[];
	acceptedDigests: ReadonlySet<string>;
	state: ZoneState;
	continuable: boolean;
}>;

/**
 * The prior fold, when the new projection only appends to it: equal base bytes, and the prior
 * operations are the new list's prefix by identity of frozen accepted-operation records (whose
 * operation is a frozen detached copy). Otherwise undefined: the caller folds from the base.
 */
function continuableFold(
	prior: ZoneFold | undefined,
	baseBytes: Uint8Array | undefined,
	operations: readonly V3RoomAcceptedOperation[]
): ZoneFold | undefined {
	if (prior === undefined || !prior.continuable || prior.operations.length > operations.length) return undefined;
	const sameBase =
		baseBytes === undefined
			? prior.baseBytes === undefined
			: prior.baseBytes !== undefined && sameBytes(prior.baseBytes, baseBytes);
	if (!sameBase) return undefined;
	for (let index = 0; index < prior.operations.length; index++)
		if (prior.operations[index] !== operations[index]) return undefined;
	return prior;
}

function projectZone(
	operations: readonly V3RoomAcceptedOperation[],
	kernel: ZoneStateKernel,
	base?: ZoneProjection
): ZoneProjection {
	const fold = foldZone(operations, kernel, base);
	return zoneProjection([...fold.acceptedDigests], fold.state);
}

function foldZone(
	operations: readonly V3RoomAcceptedOperation[],
	kernel: ZoneStateKernel,
	base?: ZoneProjection,
	prior?: ZoneFold,
	baseBytes?: Uint8Array
): ZoneFold {
	let state: ZoneState =
		prior !== undefined
			? prior.state
			: base === undefined
				? kernel.emptyState()
				: {
						version: 2,
						creatorAuthor: base.creatorAuthor,
						creatorPeerId: base.creatorPeerId,
						blocks: base.blocks,
						outcomes: base.outcomes,
						roster: base.roster,
					};
	const acceptedDigests = new Set<string>(prior?.acceptedDigests);
	const start = prior?.operations.length ?? 0;
	for (const accepted of operations.slice(start)) {
		acceptedDigests.add(accepted.vertexDigest);
		// Signature and current-room admission remain owned by the authenticated
		// boundary. The exact same pure transition owns live and folded state.
		const operation =
			accepted.operation.action === "commit-outcome-v1"
				? verifiedOutcomeCarrier(accepted.operation)
				: accepted.operation;
		state = kernel.apply(state, operation, accepted.author).state;
	}
	// Continuable only over frozen records and a frozen (captured) state: identity then proves
	// the prefix and its result are unchanged.
	let continuable = Object.isFrozen(state);
	for (let index = start; continuable && index < operations.length; index++) {
		const record = operations[index];
		continuable = Object.isFrozen(record) && Object.isFrozen(record?.operation);
	}
	return Object.freeze({
		baseBytes: prior !== undefined ? prior.baseBytes : baseBytes === undefined ? undefined : baseBytes.slice(),
		operations: Object.freeze([...operations]),
		acceptedDigests,
		state,
		continuable,
	});
}

function zoneProjection(acceptedDigests: readonly string[], state: ZoneState): ZoneProjection {
	return Object.freeze({
		acceptedDigests: Object.freeze([...acceptedDigests]),
		creatorAuthor: state.creatorAuthor,
		creatorPeerId: state.creatorPeerId,
		blocks: state.blocks,
		outcomes: state.outcomes,
		roster: state.roster,
		transportPeerAuthors: Object.freeze(state.roster.map(({ author, peerId }) => Object.freeze({ author, peerId }))),
		writerAuthors: Object.freeze(state.roster.map(({ author }) => author)),
	});
}

function decodeZoneState(stateBytes: Uint8Array, kernel: ZoneStateKernel): ZoneProjection {
	const invalidState = (): never => {
		throw new TypeError("v3 zone authenticated projection state is invalid");
	};
	let value: unknown;
	try {
		value = decodeCanonical(stateBytes, {
			maxBytes: PARAMETERS.maxSnapshotBytes,
			maxDepth: 32,
			maxItems: PARAMETERS.maxSnapshotBytes,
		});
	} catch {
		return invalidState();
	}
	const state = kernel.captureState(value);
	try {
		for (const outcome of state.outcomes) verifiedOutcomeCarrier(outcome);
	} catch {
		return invalidState();
	}
	const projection = zoneProjection([], state);
	if (!sameBytes(canonicalZoneStateBytes(projection), stateBytes)) return invalidState();
	return projection;
}

function preparedOutcomeCarrier(operation: Readonly<Record<string, unknown>>): PreparedOutcomeIntent {
	const proof = Reflect.get(operation, "proof");
	if (proof === null || typeof proof !== "object" || Array.isArray(proof)) {
		throw new TypeError("v3 zone outcome proof is invalid");
	}
	const intentBytes = Reflect.get(proof, "exactCanonicalIntentBytes");
	const payloadBytes = Reflect.get(proof, "exactCanonicalPayloadBytes");
	if (!(intentBytes instanceof Uint8Array) || !(payloadBytes instanceof Uint8Array)) {
		throw new TypeError("v3 zone outcome proof bytes are invalid");
	}
	return openPreparedTradeIntent(hex(intentBytes), hex(payloadBytes));
}

function verifiedOutcomeCarrier(operation: Readonly<Record<string, unknown>>): OutcomeCommitAdmissionOperation {
	const prepared = preparedOutcomeCarrier(operation);
	const verified = verifyOutcomeCommitAdmissionOperation({
		expectedAclDigest: prepared.intent.aclDigest,
		expectedAnchorDigest: prepared.intent.anchorDigest,
		expectedEpoch: prepared.intent.epoch,
		expectedObjectId: prepared.intent.objectId,
		operation,
	});
	if (!verified.ok) throw new TypeError(`v3 zone outcome projection was rejected: ${verified.reason}`);
	return createOutcomeCommitAdmissionOperation(verified.verified.operation);
}

function creatorAuthorFromSignerSet(exactCanonicalSignerSetBytes: Uint8Array): string {
	const decoded = decodeCanonical(exactCanonicalSignerSetBytes, { maxBytes: 4_096, maxDepth: 3, maxItems: 32 });
	if (!Array.isArray(decoded) || decoded.length !== 1) throw new TypeError("v3 zone creator signer is invalid");
	const signer = decoded[0];
	if (typeof signer !== "object" || signer === null) throw new TypeError("v3 zone creator signer is invalid");
	const keys = Reflect.ownKeys(signer);
	const publicKey = Reflect.get(signer, "publicKey");
	if (
		keys.length !== 2 ||
		!keys.includes("publicKey") ||
		!keys.includes("signerId") ||
		Reflect.get(signer, "signerId") !== "creator" ||
		typeof publicKey !== "string" ||
		!/^[0-9a-f]{64}$/u.test(publicKey)
	) {
		throw new TypeError("v3 zone creator signer is invalid");
	}
	return publicKey;
}

function validateRoomHeadAuthority(value: unknown): asserts value is V3RoomHeadAuthority {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!["begin", "commit", "create", "migrate", "read"].every(
			(method) => typeof Reflect.get(value, method) === "function"
		)
	) {
		throw new TypeError("v3 zone room-head authority provider is invalid");
	}
	const initialization: unknown = Reflect.get(value, "initialization");
	if (typeof initialization !== "object" || initialization === null || Array.isArray(initialization)) {
		throw new TypeError("v3 zone room-head authority initialization is invalid");
	}
	const kind: unknown = Reflect.get(initialization, "kind");
	const keys = Object.keys(initialization);
	if ((kind === "create" || kind === "reopen") && keys.length === 1 && keys.includes("kind")) return;
	if (kind === "migrate" && keys.length === 2 && keys.includes("kind") && keys.includes("head")) {
		const head: unknown = Reflect.get(initialization, "head");
		if (typeof head === "object" && head !== null && !Array.isArray(head)) {
			const headKeys = Object.keys(head);
			const currentAnchorDigest: unknown = Reflect.get(head, "currentAnchorDigest");
			const epoch: unknown = Reflect.get(head, "epoch");
			const objectId: unknown = Reflect.get(head, "objectId");
			if (
				headKeys.length === 3 &&
				["currentAnchorDigest", "epoch", "objectId"].every((key) => headKeys.includes(key)) &&
				typeof currentAnchorDigest === "string" &&
				/^[0-9a-f]{64}$/u.test(currentAnchorDigest) &&
				typeof epoch === "number" &&
				Number.isSafeInteger(epoch) &&
				epoch >= 0 &&
				typeof objectId === "string" &&
				objectId.length > 0
			) {
				return;
			}
		}
	}
	throw new TypeError("v3 zone room-head authority initialization is invalid");
}

function creatorAuthorFromInvite(invite: string | V3RoomCreatorInviteMaterial): string {
	if (typeof invite !== "string") return creatorAuthorFromSignerSet(invite.exactCanonicalSignerSetBytes);
	const decoded = decodeCanonical(bytes(invite), { maxBytes: 131_072, maxDepth: 4, maxItems: 128 });
	if (typeof decoded !== "object" || decoded === null) throw new TypeError("v3 zone creator invite is invalid");
	const signerSet = Reflect.get(decoded, "exactCanonicalSignerSetBytes");
	if (!(signerSet instanceof Uint8Array)) throw new TypeError("v3 zone creator invite is invalid");
	return creatorAuthorFromSignerSet(signerSet);
}

function blueprintDigestFromInvite(invite: string | V3RoomCreatorInviteMaterial): string {
	const decoded = typeof invite === "string" ? decodeCanonical(bytes(invite),{maxBytes:131072,maxDepth:4,maxItems:128}) : invite;
	if (decoded === null || typeof decoded !== "object") throw new TypeError("v3 zone creator invite is invalid");
	const exact = Reflect.get(decoded,"exactCanonicalGenesisAnchorPreimageBytes");
	if (!(exact instanceof Uint8Array)) throw new TypeError("v3 zone creator genesis is invalid");
	const genesis = decodeCanonical(exact,{maxBytes:65536,maxDepth:4,maxItems:128});
	const selected = genesis === null || typeof genesis !== "object" ? undefined : Reflect.get(genesis,"blueprintDigest");
	if (typeof selected !== "string" || !/^[0-9a-f]{64}$/u.test(selected)) throw new TypeError("v3 zone creator blueprint is invalid");
	return selected;
}

function emptyProjection(creatorAuthor: string, creatorPeerId: string): ZoneProjection {
	return zoneProjection([], emptyZoneState(creatorAuthor, creatorPeerId));
}

function prepareZoneMigration(
	operations: readonly V3RoomAcceptedOperation[],
	kernel: ZoneStateKernel,
	exactCanonicalSourceStateBytes?: Uint8Array
): V3RoomMigrationProjection {
	const blocks = new Map<string, ZoneBlock>();
	for (const row of operations) {
		const action = Reflect.get(row.operation, "action");
		if (action === "commit-outcome-v1") {
			verifiedOutcomeCarrier(row.operation);
			continue;
		}
		if (action !== "placeBlock") continue;
		const block = kernel.blockForOperation(row.operation);
		if (block === undefined) throw new TypeError("v3 zone migration block is invalid");
		if (blocks.has(block.id)) throw new TypeError("v3 zone migration identity conflicts");
		blocks.set(block.id, block);
	}
	const projection =
		exactCanonicalSourceStateBytes === undefined
			? projectZone(operations, kernel)
			: decodeZoneState(exactCanonicalSourceStateBytes, kernel);
	return Object.freeze({
		exactCanonicalApplicationStateBytes: canonicalZoneStateBytes(projection),
		importOperations: Object.freeze(
			projection.blocks.map((block) => Object.freeze({ action: "placeBlock", ...block }))
		),
	});
}

function validateFabricTrialId(trialId: string): void {
	if (!/^[a-z0-9-]{1,64}$/u.test(trialId)) throw new TypeError("fabric trial identity is invalid");
}

function validateFabricRunInput(input: FabricRunInput): void {
	if (
		Reflect.ownKeys(input).sort().join(",") !==
		"intervalMs,payloadBytes,payloadFormat,reliableSentinelBytes,sampleCount,trialId"
	) {
		throw new TypeError("fabric trial input differs");
	}
	validateFabricTrialId(input.trialId);
	if (
		input.payloadFormat !== "e3-03-ascii-v1" ||
		!Number.isSafeInteger(input.intervalMs) ||
		input.intervalMs < 1 ||
		input.intervalMs > 1_000 ||
		!Number.isSafeInteger(input.payloadBytes) ||
		input.payloadBytes < 128 ||
		input.payloadBytes > 1_024 ||
		!Number.isSafeInteger(input.reliableSentinelBytes) ||
		input.reliableSentinelBytes < input.payloadBytes ||
		input.reliableSentinelBytes > 16_000 ||
		!Number.isSafeInteger(input.sampleCount) ||
		input.sampleCount < 1 ||
		input.sampleCount > 600
	) {
		throw new TypeError("fabric trial input is invalid");
	}
	const fixedCampaign = /^e3-03-[0-2]$/u.test(input.trialId) && input.intervalMs === 33 && input.sampleCount === 600;
	const fixedCalibration =
		input.trialId === "e3-03-total-loss-calibration" && input.intervalMs === 20 && input.sampleCount === 300;
	const fixedDurableReadinessDiagnostic =
		input.trialId === "e3-03-durable-readiness" &&
		input.intervalMs === 1 &&
		input.sampleCount === 1 &&
		input.payloadBytes === 256 &&
		input.reliableSentinelBytes === 12_000;
	if (!fixedCampaign && !fixedCalibration && !fixedDurableReadinessDiagnostic) {
		throw new TypeError("fabric trial profile differs");
	}
}

function encodeFabricPayload(
	input: FabricRunInput,
	lane: FabricObservation["lane"],
	sequence: number,
	sentAtMs: number,
	sentinel: boolean,
	byteLength: number
): Uint8Array {
	const prefix = `E303|${input.trialId}|${lane}|${String(sequence)}|${String(sentAtMs)}|${sentinel ? "1" : "0"}|`;
	const suffix = "|E303END";
	const padding = byteLength - prefix.length - suffix.length;
	if (padding < 0) throw new TypeError("fabric payload size is invalid");
	const encoded = new TextEncoder().encode(prefix + "x".repeat(padding) + suffix);
	if (encoded.byteLength !== byteLength) throw new TypeError("fabric payload bytes differ");
	return encoded;
}

function decodeFabricPayload(payload: Uint8Array):
	| Readonly<{
			readonly lane: FabricObservation["lane"];
			readonly sentAtMs: number;
			readonly sequence: number;
			readonly sentinel: boolean;
			readonly trialId: string;
	  }>
	| undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
	} catch {
		return undefined;
	}
	const match = /^E303\|([a-z0-9-]{1,64})\|(raw|reliable)\|([0-9]+)\|([0-9]+)\|([01])\|x*\|E303END$/u.exec(text);
	if (match === null) return undefined;
	const lane = match[2];
	const sequence = Number(match[3]);
	const sentAtMs = Number(match[4]);
	if (
		(lane !== "raw" && lane !== "reliable") ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0 ||
		!Number.isSafeInteger(sentAtMs) ||
		sentAtMs < 0
	) {
		return undefined;
	}
	return Object.freeze({ lane, sentAtMs, sequence, sentinel: match[5] === "1", trialId: match[1] ?? "" });
}

function fabricTrialView(trial: FabricTrialState, durableVertexCount: number): FabricTrialView | undefined {
	if (
		trial.deadlineAtMs === undefined ||
		Date.now() < trial.deadlineAtMs ||
		trial.intervalMs === 0 ||
		trial.sampleCount === 0
	) {
		return undefined;
	}
	const raw = trial.observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel);
	const reliableBySequence = new Map<number, FabricObservation>();
	for (const observation of trial.observations) {
		if (observation.lane !== "reliable" || observation.sentinel || reliableBySequence.has(observation.sequence)) {
			continue;
		}
		reliableBySequence.set(observation.sequence, observation);
	}
	const reliable = [...reliableBySequence.values()];
	const startedAtMs = Math.min(
		...trial.observations.filter(({ sentinel }) => !sentinel).map(({ sentAtMs }) => sentAtMs)
	);
	const rawAoI = fabricAgeOfInformation(raw, startedAtMs, trial.deadlineAtMs, trial.intervalMs);
	const reliableAoI = fabricAgeOfInformation(reliable, startedAtMs, trial.deadlineAtMs, trial.intervalMs);
	const receivedRaw = [...raw].sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	let maxGap = receivedRaw[0]?.sequence ?? 0;
	for (let index = 1; index < receivedRaw.length; index += 1) {
		maxGap = Math.max(maxGap, (receivedRaw[index]?.sequence ?? 0) - (receivedRaw[index - 1]?.sequence ?? 0));
	}
	return Object.freeze({
		durableDelta: durableVertexCount - trial.durableBaseline,
		fallbackCount: 0,
		maxGap,
		rawAoIP50Ms: fabricPercentile(rawAoI, 0.5),
		rawAoIP95Ms: fabricPercentile(rawAoI, 0.95),
		rawDelivered: raw.length,
		reliableAoIP50Ms: fabricPercentile(reliableAoI, 0.5),
		reliableAoIP95Ms: fabricPercentile(reliableAoI, 0.95),
		reliableDelivered: reliable.length,
		sampleCount: trial.sampleCount,
		trialId: trial.trialId,
	});
}

function decodePosition(payload: Uint8Array): Readonly<{ x: number; y: number }> | undefined {
	try {
		const entities = decodeEntityDeltaBatch(payload);
		const value = entities[0];
		return entities.length === 1 && value?.entityId === 0 ? Object.freeze({ x: value.x, y: value.y }) : undefined;
	} catch {
		return undefined;
	}
}

async function createCreatorInviteMaterial(
	node: DRPNode,
	objectId: string,
	members: readonly Readonly<Enrollment & { readonly order: number }>[]
): Promise<V3RoomCreatorInviteMaterial> {
	const creator = members.find(({ author, order }) => author === node.keychain.localAuthorId && order === 0);
	if (creator === undefined) throw new TypeError("v3 zone creator enrollment is unavailable");
	const application = applicationMaterial();
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: [...members]
			.map(({ author }, index) =>
				Object.freeze({
					author,
					finalityKey: index === 0 ? author : null,
					groups: Object.freeze(index === 0 ? ["admin", "finality", "writer"] : ["writer"]),
				})
			)
			.sort((left, right) => compareText(left.author, right.author)),
		objectId,
		permissionless: false,
		version: GRID_GENESIS_PROFILE.latchedAclVersion,
	});
	const signerSet = Object.freeze([Object.freeze({ publicKey: node.keychain.localAuthorId, signerId: "creator" })]);
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalProfileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: GRID_GENESIS_PROFILE.profileId,
		quorum: 1,
		signers: signerSet,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
	return createV3RoomCreatorInviteMaterial({
		blueprintDigest: application.blueprintDigest,
		exactCanonicalApplicationStateBytes: canonicalZoneStateBytes(
			emptyProjection(node.keychain.localAuthorId, creator.peerId)
		),
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		objectId,
		signGenesisAnchorDigest: (anchorDigest) => node.keychain.signWithLocalAuthor(anchorDigest),
	});
}

const ZONE_CATALOG = openTrustedBlueprintCatalogBytes({
	catalogBytes: bytes(catalogMaterial.catalogBytes),
	assets: Object.fromEntries(
		Object.entries(catalogMaterial.assets).map(([filename, value]) => [filename, bytes(value)])
	),
});
	const PREDECESSOR_ZONE_CATALOG = openTrustedBlueprintCatalogBytes({
		catalogBytes:bytes(predecessorCatalogMaterial.catalogBytes),
		assets:Object.fromEntries(Object.entries(predecessorCatalogMaterial.assets).map(([filename,value])=>[filename,bytes(value)])),
	});

function applicationMaterial(selectedDigest?:string): Readonly<{
	readonly artifactVersion:"current"|"predecessor";
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["application"]["catalog"];
}> {
	const catalog = selectedDigest === undefined || ZONE_CATALOG.blueprintDigests.includes(selectedDigest) ? ZONE_CATALOG : PREDECESSOR_ZONE_CATALOG;
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined || catalog.blueprintDigests.length !== 1 || (selectedDigest !== undefined && selectedDigest !== blueprintDigest))
		throw new TypeError("v3 zone requires its exact single-entry catalog");
	return Object.freeze({
		artifactVersion:catalog === ZONE_CATALOG ? "current" as const : "predecessor" as const,
		blueprintDigest,
		canonicalBlueprintPackageBytes: catalog.resolve(blueprintDigest).canonicalBlueprintPackageBytes,
		catalog,
	});
}

function encodeEnrollment(value: Enrollment): string {
	return hex(encodeCanonical({ ...value, kind: "ts-drp-v3-zone-enrollment", version: 1 }));
}

function decodeEnrollment(value: string): Enrollment {
	const decoded = decodeCanonical(bytes(value), { maxBytes: 4_096, maxDepth: 3, maxItems: 64 });
	if (typeof decoded !== "object" || decoded === null) throw new TypeError("v3 zone enrollment is invalid");
	const author = Reflect.get(decoded, "author");
	const peerId = Reflect.get(decoded, "peerId");
	if (
		Reflect.get(decoded, "kind") !== "ts-drp-v3-zone-enrollment" ||
		Reflect.get(decoded, "version") !== 1 ||
		typeof author !== "string" ||
		!/^[0-9a-f]{64}$/u.test(author) ||
		typeof peerId !== "string" ||
		peerId.length === 0
	) {
		throw new TypeError("v3 zone enrollment is invalid");
	}
	return Object.freeze({ author, peerId });
}

function encodeZoneInvite(value: ZoneInvite): string {
	return hex(encodeCanonical({ ...value, kind: "ts-drp-v3-zone-invite", version: 1 }));
}

function decodeZoneInvite(value: string): ZoneInvite {
	const decoded = decodeCanonical(bytes(value), { maxBytes: 131_072, maxDepth: 4, maxItems: 32 });
	if (typeof decoded !== "object" || decoded === null) throw new TypeError("v3 zone invite is invalid");
	const keys = Reflect.ownKeys(decoded);
	if (
		keys.length !== ZONE_INVITE_KEYS.length ||
		keys.some((key) => typeof key !== "string" || !ZONE_INVITE_KEYS.some((candidate) => candidate === key)) ||
		Reflect.get(decoded, "kind") !== "ts-drp-v3-zone-invite" ||
		Reflect.get(decoded, "version") !== 1
	) {
		throw new TypeError("v3 zone invite is invalid");
	}
	const roomInvite = Reflect.get(decoded, "roomInvite");
	const zoneId = Reflect.get(decoded, "zoneId");
	if (
		typeof roomInvite !== "string" ||
		!/^[0-9a-f]+$/u.test(roomInvite) ||
		typeof zoneId !== "string" ||
		zoneId.length === 0
	) {
		throw new TypeError("v3 zone invite is invalid");
	}
	return Object.freeze({ roomInvite, zoneId });
}

function openPreparedTradeIntent(
	exactCanonicalIntentHex: string,
	exactCanonicalPayloadHex: string
): PreparedOutcomeIntent {
	const exactCanonicalIntentBytes = bytes(exactCanonicalIntentHex);
	const exactCanonicalPayloadBytes = bytes(exactCanonicalPayloadHex);
	const decoded = decodeCanonical(exactCanonicalIntentBytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("v3 zone trade intent is invalid");
	}
	const aclDigest = Reflect.get(decoded, "aclDigest");
	const anchorDigest = Reflect.get(decoded, "anchorDigest");
	const clientOperationId = Reflect.get(decoded, "clientOperationId");
	const counterparties = Reflect.get(decoded, "counterparties");
	const epoch = Reflect.get(decoded, "epoch");
	const objectId = Reflect.get(decoded, "objectId");
	const outcomeKind = Reflect.get(decoded, "outcomeKind");
	if (
		typeof aclDigest !== "string" ||
		typeof anchorDigest !== "string" ||
		typeof clientOperationId !== "string" ||
		!Array.isArray(counterparties) ||
		counterparties.some((counterparty) => typeof counterparty !== "string") ||
		typeof epoch !== "number" ||
		typeof objectId !== "string" ||
		typeof outcomeKind !== "string"
	) {
		throw new TypeError("v3 zone trade intent is invalid");
	}
	const prepared = prepareOutcomeIntent({
		aclDigest,
		anchorDigest,
		clientOperationId,
		counterparties: counterparties as string[],
		epoch,
		exactCanonicalPayloadBytes,
		objectId,
		outcomeKind,
	});
	if (!sameBytes(prepared.exactCanonicalIntentBytes, exactCanonicalIntentBytes)) {
		throw new TypeError("v3 zone trade intent bytes differ");
	}
	return prepared;
}

function tradeIntentView(
	prepared: PreparedOutcomeIntent,
	status: "accepted" | "approved" | "pending" | "ready" | "recovered",
	approvalCount: number
): TradeIntentView {
	return Object.freeze({
		aclDigest: prepared.intent.aclDigest,
		anchorDigest: prepared.intent.anchorDigest,
		approvalCount,
		clientOperationId: prepared.intent.clientOperationId,
		counterparties: Object.freeze([...prepared.intent.counterparties]),
		epoch: prepared.intent.epoch,
		intentDigest: prepared.intentDigest,
		objectId: prepared.intent.objectId,
		outcomeKind: prepared.intent.outcomeKind,
		status,
	});
}

function absentTradeIntent(): TradeIntentView {
	return Object.freeze({
		aclDigest: "",
		anchorDigest: "",
		approvalCount: 0,
		clientOperationId: "",
		counterparties: Object.freeze([]),
		epoch: 0,
		intentDigest: "",
		objectId: "",
		outcomeKind: "",
		status: "absent",
	});
}

function sameOutcomeContext(left: OutcomeContext, right: OutcomeContext): boolean {
	return (
		left.aclDigest === right.aclDigest &&
		left.anchorDigest === right.anchorDigest &&
		left.epoch === right.epoch &&
		left.objectId === right.objectId
	);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function validTradeAsset(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

function migrationTargetObjectId(sourceObjectId: string, rehearsalNonce: Uint8Array): string {
	const separator = sourceObjectId.indexOf(":");
	if (separator <= 0 || separator === sourceObjectId.length - 1) {
		throw new TypeError("v3 zone migration source object id is invalid");
	}
	const identity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce: new Uint8Array(rehearsalNonce), sourceObjectId })
	);
	const targetObjectId = `${sourceObjectId.slice(0, separator)}:${hex(identity.subarray(0, 16))}`;
	if (targetObjectId === sourceObjectId) throw new TypeError("v3 zone migration target object id is invalid");
	return targetObjectId;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError("v3 zone hex value is invalid");
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
