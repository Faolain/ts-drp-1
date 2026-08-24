import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { decodeEntityDeltaBatch, encodeEntityDeltaBatch, type EphemeralChannel } from "@ts-drp/ephemeral";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomAcceptedOperation,
	type V3RoomCreatorInviteMaterial,
	type V3RoomMigrationActivationReceipt,
	type V3RoomMigrationProjection,
	type V3RoomMigrationRehearsalReceipt,
} from "@ts-drp/example-v3-room";
import type { DRPNode } from "@ts-drp/node";

const ZONE_ARTIFACT_SOURCE = `function exactKeys(value,keys){return value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key))}const migrationKeys=["applicationStateDigest","archivePolicy","authorityKind","exactCanonicalApplicationStateBytes","kind","rehearsalNonce","sourceAcceptedOperationCount","sourceAcceptedOperationsDigest","sourceAnchorDigest","sourceBlueprintDigest","sourceCreatorAuthor","sourceObjectId","targetAnchorDigest","targetBlueprintDigest","targetCreatorAuthor","targetImportOperationCount","targetImportOperationsDigest","targetObjectId","version"];function applicationBatchReducer(input){const operation=input.operation;if(!exactKeys(operation,["action","batch"])||operation.action!=="applicationBatch"||!exactKeys(operation.batch,["entries","version"])||operation.batch.version!==1||!Array.isArray(operation.batch.entries)||operation.batch.entries.length<2||operation.batch.entries.length>16)throw new TypeError("invalid application batch");let prior=-1;const output=[];for(const entry of operation.batch.entries){const child=entry.operation;if(!exactKeys(entry,["logicalTime","operation"])||!Number.isSafeInteger(entry.logicalTime)||entry.logicalTime<0||entry.logicalTime<=prior||!exactKeys(child,["action","id","kind","x","y"])||child.action!=="placeBlock"||typeof child.id!=="string"||child.id.length===0||typeof child.kind!=="string"||child.kind.length===0||!Number.isSafeInteger(child.x)||!Number.isSafeInteger(child.y))throw new TypeError("invalid application batch entry");prior=entry.logicalTime;output.push(child)}return {output,state:input.state}}function causalJoinReducer(input){return {output:null,state:input.state}}function joinReducer(input){return {output:input.operation,state:input.state}}function migrationActivationReducer(input){const operation=input.operation;if(!exactKeys(operation,["action","decision"])||operation.action!=="migrationActivation"||operation.decision===null||typeof operation.decision!=="object"||Array.isArray(operation.decision))throw new TypeError("invalid migration activation");return {output:null,state:input.state}}function migrationRecordReducer(input){const operation=input.operation;const record=operation&&operation.record;if(!exactKeys(operation,["action","record"])||operation.action!=="migrationRecord"||!exactKeys(record,migrationKeys)||record.kind!=="ts-drp-v3-room-migration-record"||record.version!==1||record.archivePolicy!=="retain-source"||record.authorityKind!=="creator-ed25519-registered-vertex-v1")throw new TypeError("invalid migration record");return {output:null,state:input.state}}function placeBlockReducer(input){return {output:input.operation,state:input.state}}export const blueprint={exportSchemaVersion:1,artifactId:"v3-zone.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{applicationBatch:applicationBatchReducer,causalJoin:causalJoinReducer,join:joinReducer,migrationActivation:migrationActivationReducer,migrationRecord:migrationRecordReducer,placeBlock:placeBlockReducer}};`;
const PARAMETERS = Object.freeze({
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
		readonly transport: Readonly<{
			readonly fallbackCount: 0;
			readonly raw: readonly Readonly<{
				readonly iceRestarts: 0;
				readonly maxRetransmits: 0;
				readonly ordered: false;
				readonly peerId: string;
				readonly readyState: "open";
			}>[];
		}>;
		readonly trialId: string;
	}>;
}

export interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
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
		readonly received: number;
		readonly routedBytesReceived: number;
		readonly routedBytesSent: number;
		readonly sent: number;
	}>;
	readonly transientPositions: Readonly<Record<string, Readonly<{ readonly x: number; readonly y: number }>>>;
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly zoneId: string;
}

interface ZoneProjection {
	readonly acceptedDigests: readonly string[];
	readonly blocks: readonly ZoneBlock[];
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

interface Enrollment {
	readonly author: string;
	readonly peerId: string;
}

interface AoiProjectionSenderState {
	readonly authorityGeneration: number;
	readonly maxEnvelopeBytes: number;
	nextSequence: number;
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

interface ZoneOperationDescriptor {
	readonly argumentSchema: Readonly<{
		readonly fields: readonly Readonly<{ readonly name: string; readonly required: true; readonly type: string }>[];
		readonly kind: "closed-record";
	}>;
	readonly maxCanonicalOperationBytes: 65_536;
	readonly name: string;
}

export interface V3ZoneApi {
	activateMigration(receipt: V3RoomMigrationRehearsalReceipt): Promise<V3RoomMigrationActivationReceipt>;
	close(): Promise<void>;
	create(memberEnrollments: string | readonly string[]): Promise<void>;
	readonly fabric: ZoneFabricWorkbench;
	join(invite: string): Promise<void>;
	move(dx: number, dy: number): void;
	placeBlock(input: ZoneBlock): Promise<void>;
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
	snapshot(): ZoneSnapshot;
}

/**
 * Create the grid-specific durable projection over the shared v3 room.
 * @param node Authenticated node that owns the room transport and signer.
 * @param onProjection Observer for deterministic durable and transient projections.
 * @returns The bounded zone application API.
 */
export function createV3ZoneApi(node: DRPNode, onProjection: (snapshot: ZoneSnapshot) => void): V3ZoneApi {
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
	let ephemeral: EphemeralChannel | undefined;
	let projection = emptyProjection();
	let migrationCreatorAuthor = "";
	let migrationMembers: readonly Readonly<Enrollment & { readonly order: number }>[] = Object.freeze([]);
	let invite = "";
	let zoneId = "";
	let localX = 0;
	let localY = 0;
	let localMovementSequence = 0;
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
		projection = emptyProjection();
		migrationCreatorAuthor = "";
		migrationMembers = Object.freeze([]);
		clearAoiProjection();
		transientPositions.clear();
		invite = "";
		zoneId = "";
		localX = 0;
		localY = 0;
		localMovementSequence = 0;
		fabricTrials.clear();
	};

	const snapshot = (): ZoneSnapshot => {
		const aoiEntries = [...aoiPopulations.entries()].sort(([left], [right]) => compareText(left, right));
		const aoiProjectionEntries = [...aoiReceivers.entries()]
			.map(([peerId, { receiver }]) => [peerId, projectionView(receiver.snapshot())] as const)
			.sort(([left], [right]) => compareText(left, right));
		const positionEntries = [...transientPositions.entries()].sort(([left], [right]) => compareText(left, right));
		const raw = zoneId.length === 0 ? undefined : node.ephemeralUnreliableWebRtcSnapshot(zoneId);
		return Object.freeze({
			acceptedOperationDigest: digest(
				"ts-drp/d9346-zone-accepted-operations/v1",
				encodeCanonical(projection.acceptedDigests)
			),
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
				received: raw?.received ?? 0,
				routedBytesReceived: raw?.routedBytesReceived ?? 0,
				routedBytesSent: raw?.routedBytesSent ?? 0,
				sent: raw?.sent ?? 0,
			}),
			transientPositions: Object.freeze(Object.fromEntries(positionEntries)),
			transportPeerAuthors: projection.transportPeerAuthors,
			zoneId,
		});
	};
	const emit = (): void => onProjection(snapshot());
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
			emit();
		});
	};
	const performOpen = async (
		selectedZoneId: string,
		creatorInvite: string | V3RoomCreatorInviteMaterial,
		bootstrapMembers: readonly Readonly<Enrollment & { readonly order: number }>[]
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
			const application = createV3ZoneApplication(bootstrapMembers, creatorPeerId, creatorAuthor);
			opened = await createV3RoomSession<ZoneProjection>({
				application,
				author: localAuthor,
				creatorInvite,
				databaseName: `ts-drp-v3-zone--${digest("ts-drp/d9346-zone-database/v1", new TextEncoder().encode(zoneId))}`,
				initialLogicalTime: 3,
				issuanceDatabaseName: `ts-drp-v3-zone--${digest("ts-drp/d9346-zone-database/v1", new TextEncoder().encode(zoneId))}`,
				migrationDatabaseNamespace: `${localAuthor}:${zoneId}`,
				objectId: zoneId,
				onAcceptedVertex: () => undefined,
				onMigrationTarget: (target, targetObjectId): void => {
					redirectedDuringOpen = target;
					if (sourceRoom !== undefined) retainedSourceBridges.add(sourceRoom);
					room = target;
					zoneId = targetObjectId;
					ephemeral?.close();
					clearAoiProjection();
					const redirectedEphemeral = target.openEphemeral(ZONE_EPHEMERAL_OPTIONS);
					subscribeEphemeral(redirectedEphemeral);
					ephemeral = redirectedEphemeral;
				},
				onProjection: (value): void => {
					projection = value;
					emit();
				},
				openTransport: (openedObjectId) => node.openRoomNetwork(openedObjectId),
				publicKeyBytes: bytes(localAuthor),
				signRegisteredVertexDigest: (registeredDigest) => node.keychain.signWithLocalAuthor(registeredDigest),
			});
			sourceRoom = opened;
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
				transport: Object.freeze({
					fallbackCount: 0 as const,
					raw: Object.freeze(
						(raw?.links ?? []).map(({ maxRetransmits, ordered, peerId }) =>
							Object.freeze({
								iceRestarts: 0 as const,
								maxRetransmits: maxRetransmits as 0,
								ordered: ordered as false,
								peerId,
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
			invite = encodeZoneInvite({ roomInvite: selected.invite, zoneId: targetObjectId });
			emit();
			return activated;
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
				room = undefined;
				ephemeral = undefined;
				resetZoneState();
				let failure: unknown;
				try {
					selectedEphemeral?.close();
				} catch (error) {
					failure = error;
				}
				try {
					await Promise.all([selected?.close(), ...sources.map((source) => source.close())]);
				} catch (error) {
					failure ??= error;
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
				await performOpen(selectedZoneId, material, members);
				if (room === undefined) throw new Error("v3 zone did not open");
				invite = encodeZoneInvite({ roomInvite: room.invite, zoneId: selectedZoneId });
				emit();
			});
		},
		fabric,
		async join(encodedInvite: string): Promise<void> {
			await trackOpen(async (): Promise<void> => {
				const decoded = decodeZoneInvite(encodedInvite);
				await performOpen(
					decoded.zoneId,
					decoded.roomInvite,
					Object.freeze([Object.freeze({ author: localAuthor, order: 1, peerId: localPeerId })])
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
			emit();
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
			await selected.issue(
				Object.freeze({ action: "placeBlock", id: input.id, kind: input.kind, x: input.x, y: input.y })
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
				senderState = {
					authorityGeneration,
					maxEnvelopeBytes,
					nextSequence: 0,
					sender: createAoiProjectionSender({ generation: authorityGeneration, maxPayloadBytes: maxEnvelopeBytes }),
				};
				aoiSenders.set(input.observerPeerId, senderState);
			}
			const packets = senderState.sender.encode({ entities: selected, sequence: senderState.nextSequence });
			senderState.nextSequence += 1;
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
			}
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
	return encodeCanonical(projection.blocks);
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
	creatorAuthor: string
): Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["application"] {
	const material = applicationMaterial();
	return Object.freeze({
		batchableOperationActions: Object.freeze(["placeBlock"]),
		bootstrapOperation: Object.freeze({
			action: "join",
			roster: Object.freeze({ entries: Object.freeze(members.map((entry) => Object.freeze({ ...entry }))) }),
		}),
		canonicalBlueprintPackageBytes: material.canonicalBlueprintPackageBytes,
		catalog: material.catalog,
		displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>) => {
			const identity = Reflect.get(operation, "id");
			if (typeof identity !== "string" || identity.length === 0) {
				throw new TypeError("v3 zone block identity is invalid");
			}
			return identity;
		},
		displacementPolicies: Object.freeze({ placeBlock: "rebase" as const }),
		migration: Object.freeze({
			canonicalStateBytes: canonicalZoneStateBytes,
			prepare: prepareZoneMigration,
		}),
		projectAcceptedOperations: (operations: readonly V3RoomAcceptedOperation[]) =>
			projectZone(operations, creatorPeerId, creatorAuthor),
	});
}

function projectZone(
	operations: readonly V3RoomAcceptedOperation[],
	creatorPeerId: string,
	creatorAuthor: string
): ZoneProjection {
	const roster = new Map<string, Readonly<Enrollment & { readonly order: number }>>();
	const rosterOrders = new Map<number, Readonly<Enrollment & { readonly order: number }>>();
	const blocks = new Map<string, ZoneBlock>();
	const acceptedDigests = new Set<string>();
	for (const acceptedOperation of operations) {
		acceptedDigests.add(acceptedOperation.vertexDigest);
		const action = Reflect.get(acceptedOperation.operation, "action");
		if (action === "migrationActivation" || action === "migrationRecord") continue;
		if (action === "join") {
			const rosterValue = Reflect.get(acceptedOperation.operation, "roster");
			const members =
				typeof rosterValue === "object" && rosterValue !== null ? Reflect.get(rosterValue, "entries") : undefined;
			if (!Array.isArray(members)) continue;
			const parsedMembers = members.map(exactMember);
			const creatorSignedRoster = parsedMembers.some(
				(member) =>
					member?.order === 0 &&
					member.author === creatorAuthor &&
					acceptedOperation.author === creatorAuthor &&
					member.peerId === creatorPeerId
			);
			if (!creatorSignedRoster) continue;
			for (const member of parsedMembers) {
				if (member === undefined) continue;
				if (member.order === 0 && member.peerId !== creatorPeerId) continue;
				const existing = roster.get(member.peerId);
				const existingOrder = rosterOrders.get(member.order);
				if (
					(existing === undefined || existing.author === member.author) &&
					(existingOrder === undefined ||
						(existingOrder.author === member.author && existingOrder.peerId === member.peerId))
				) {
					roster.set(member.peerId, member);
					rosterOrders.set(member.order, member);
				}
			}
		}
		if (action === "placeBlock") {
			const block = exactBlock(acceptedOperation.operation);
			if (block === undefined) throw new TypeError("v3 zone placeBlock operation is invalid");
			blocks.set(block.id, block);
		}
	}
	const entries = [...roster.values()].sort(
		(left, right) =>
			left.order - right.order || compareText(left.author, right.author) || compareText(left.peerId, right.peerId)
	);
	return Object.freeze({
		acceptedDigests: Object.freeze([...acceptedDigests]),
		blocks: Object.freeze([...blocks.values()].sort((left, right) => compareText(left.id, right.id))),
		transportPeerAuthors: Object.freeze(entries.map(({ author, peerId }) => Object.freeze({ author, peerId }))),
		writerAuthors: Object.freeze(entries.map(({ author }) => author)),
	});
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

function creatorAuthorFromInvite(invite: string | V3RoomCreatorInviteMaterial): string {
	if (typeof invite !== "string") return creatorAuthorFromSignerSet(invite.exactCanonicalSignerSetBytes);
	const decoded = decodeCanonical(bytes(invite), { maxBytes: 131_072, maxDepth: 4, maxItems: 128 });
	if (typeof decoded !== "object" || decoded === null) throw new TypeError("v3 zone creator invite is invalid");
	const signerSet = Reflect.get(decoded, "exactCanonicalSignerSetBytes");
	if (!(signerSet instanceof Uint8Array)) throw new TypeError("v3 zone creator invite is invalid");
	return creatorAuthorFromSignerSet(signerSet);
}

function emptyProjection(): ZoneProjection {
	return Object.freeze({
		acceptedDigests: Object.freeze([]),
		blocks: Object.freeze([]),
		transportPeerAuthors: Object.freeze([]),
		writerAuthors: Object.freeze([]),
	});
}

function exactMember(value: unknown): Readonly<Enrollment & { readonly order: number }> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const author = Reflect.get(value, "author");
	const order = Reflect.get(value, "order");
	const peerId = Reflect.get(value, "peerId");
	return typeof author === "string" &&
		/^[0-9a-f]{64}$/u.test(author) &&
		Number.isSafeInteger(order) &&
		Number(order) >= 0 &&
		Number(order) <= 8 &&
		typeof peerId === "string" &&
		peerId.length > 0
		? Object.freeze({ author, order: Number(order), peerId })
		: undefined;
}

function exactBlock(value: unknown): ZoneBlock | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== 5 ||
		!keys.every((key) => key === "action" || key === "id" || key === "kind" || key === "x" || key === "y")
	) {
		return undefined;
	}
	const action = Reflect.get(value, "action");
	const id = Reflect.get(value, "id");
	const kind = Reflect.get(value, "kind");
	const x = Reflect.get(value, "x");
	const y = Reflect.get(value, "y");
	return action === "placeBlock" &&
		typeof id === "string" &&
		id.length > 0 &&
		typeof kind === "string" &&
		kind.length > 0 &&
		Number.isSafeInteger(x) &&
		Number.isSafeInteger(y)
		? Object.freeze({ id, kind, x: x as number, y: y as number })
		: undefined;
}

function prepareZoneMigration(operations: readonly V3RoomAcceptedOperation[]): V3RoomMigrationProjection {
	const blocks = new Map<string, ZoneBlock>();
	for (const row of operations) {
		if (Reflect.get(row.operation, "action") !== "placeBlock") continue;
		const block = exactBlock(row.operation);
		if (block === undefined) throw new TypeError("v3 zone migration block is invalid");
		if (blocks.has(block.id)) throw new TypeError("v3 zone migration identity conflicts");
		blocks.set(block.id, block);
	}
	const state = Object.freeze([...blocks.values()].sort((left, right) => compareText(left.id, right.id)));
	return Object.freeze({
		exactCanonicalApplicationStateBytes: encodeCanonical(state),
		importOperations: Object.freeze(state.map((block) => Object.freeze({ action: "placeBlock", ...block }))),
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
	if (!fixedCampaign && !fixedCalibration) throw new TypeError("fabric trial profile differs");
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

function fabricAgeOfInformation(
	observations: readonly FabricObservation[],
	startedAtMs: number,
	deadlineMs: number,
	intervalMs: number
): readonly number[] {
	const delivered = [...observations].sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	const ages: number[] = [];
	let cursor = 0;
	let freshestSentAt = startedAtMs;
	for (let sampledAt = startedAtMs; sampledAt <= deadlineMs; sampledAt += intervalMs) {
		while (cursor < delivered.length && (delivered[cursor]?.receivedAtMs ?? Number.POSITIVE_INFINITY) <= sampledAt) {
			freshestSentAt = Math.max(freshestSentAt, delivered[cursor]?.sentAtMs ?? freshestSentAt);
			cursor += 1;
		}
		ages.push(sampledAt - freshestSentAt);
	}
	return ages;
}

function fabricPercentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
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
		version: 1,
	});
	const signerSet = Object.freeze([Object.freeze({ publicKey: node.keychain.localAuthorId, signerId: "creator" })]);
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalProfileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: "creator-trusted-v1",
		quorum: 1,
		signers: signerSet,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
	const creator = members.find(({ author, order }) => author === node.keychain.localAuthorId && order === 0);
	if (creator === undefined) throw new TypeError("v3 zone creator enrollment is unavailable");
	return createV3RoomCreatorInviteMaterial({
		blueprintDigest: application.blueprintDigest,
		exactCanonicalApplicationStateBytes: canonicalZoneStateBytes(
			projectZone([], creator.peerId, node.keychain.localAuthorId)
		),
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		objectId,
		signGenesisAnchorDigest: (anchorDigest) => node.keychain.signWithLocalAuthor(anchorDigest),
	});
}

function applicationMaterial(): Readonly<{
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["application"]["catalog"];
}> {
	const exactArtifactBytes = new TextEncoder().encode(ZONE_ARTIFACT_SOURCE);
	const artifactDigest = digest("ts-drp/blueprint-artifact/v3", exactArtifactBytes);
	const operation = (
		name: string,
		fields: readonly Readonly<{ name: string; type: string }>[]
	): ZoneOperationDescriptor =>
		Object.freeze({
			name,
			maxCanonicalOperationBytes: 65_536,
			argumentSchema: Object.freeze({
				kind: "closed-record",
				fields: Object.freeze(fields.map((field) => Object.freeze({ ...field, required: true }))),
			}),
		});
	const blueprintPackage = Object.freeze({
		kind: "drp-blueprint-admission-package",
		protocolMajor: 3,
		schemaVersion: 1,
		implementation: Object.freeze({
			artifactId: "v3-zone.v1",
			artifactDigest,
			runtimeProfile: "ecmascript-2024-sync-v1",
		}),
		manifest: Object.freeze({
			schemaVersion: 2,
			operationDiscriminator: "action",
			workBudgetProfile: "blueprint-work-budget-v1",
			operations: Object.freeze([
				operation("applicationBatch", [Object.freeze({ name: "batch", type: "canonical-object" })]),
				operation("causalJoin", []),
				operation("join", [Object.freeze({ name: "roster", type: "canonical-object" })]),
				operation("migrationActivation", [Object.freeze({ name: "decision", type: "canonical-object" })]),
				operation("migrationRecord", [Object.freeze({ name: "record", type: "canonical-object" })]),
				operation("placeBlock", [
					Object.freeze({ name: "id", type: "string" }),
					Object.freeze({ name: "kind", type: "string" }),
					Object.freeze({ name: "x", type: "safe-integer" }),
					Object.freeze({ name: "y", type: "safe-integer" }),
				]),
			]),
		}),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
	const blueprintDigest = digest("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes);
	const catalogDigest = digest("ts-drp/d9346-zone-catalog/v1", canonicalBlueprintPackageBytes);
	const resolved = Object.freeze({
		artifactDigest,
		artifactId: "v3-zone.v1",
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		runtimeProfile: "ecmascript-2024-sync-v1" as const,
		evidence: Object.freeze({
			catalogDigest,
			lintEvidenceDigest: "a".repeat(64),
			conformanceReceiptDigest: "b".repeat(64),
			conformanceDigest: "c".repeat(64),
			conformanceTier: "nightly" as const,
			conformanceResult: "passed" as const,
			engines: Object.freeze([
				Object.freeze({ name: "node" as const, build: "d9346" }),
				Object.freeze({ name: "chromium" as const, build: "d9346" }),
				Object.freeze({ name: "firefox" as const, build: "d9346" }),
				Object.freeze({ name: "webkit" as const, build: "d9346" }),
			]),
		}),
	});
	return Object.freeze({
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		catalog: Object.freeze({
			blueprintDigests: Object.freeze([blueprintDigest]),
			catalogDigest,
			resolve(requested: string) {
				if (requested !== blueprintDigest) throw new TypeError("unknown v3 zone blueprint");
				return resolved;
			},
		}),
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
