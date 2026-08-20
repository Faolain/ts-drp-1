import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { EphemeralChannel } from "@ts-drp/ephemeral";
import {
	createV3RoomSession,
	type V3RoomAcceptedVertex,
	type V3RoomCreatorInviteMaterial,
} from "@ts-drp/example-v3-room";
import type { DRPNode } from "@ts-drp/node";

const ZONE_ARTIFACT_SOURCE = `function joinReducer(input){return {output:input.operation,state:input.state}}function placeBlockReducer(input){return {output:input.operation,state:input.state}}export const blueprint={exportSchemaVersion:1,artifactId:"v3-zone.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{join:joinReducer,placeBlock:placeBlockReducer}};`;
const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const ZONE_INVITE_KEYS = ["kind", "roomInvite", "version", "zoneId"] as const;

export interface ZoneBlock {
	readonly id: string;
	readonly kind: string;
	readonly x: number;
	readonly y: number;
}

export interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly blocks: readonly ZoneBlock[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly localPeerId: string;
	readonly ready: boolean;
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

interface ZoneInvite {
	readonly roomInvite: string;
	readonly zoneId: string;
}

interface ZoneOperationDescriptor {
	readonly argumentSchema: Readonly<{
		readonly fields: readonly Readonly<{ readonly name: string; readonly required: true; readonly type: string }>[];
		readonly kind: "closed-record";
	}>;
	readonly name: string;
}

export interface V3ZoneApi {
	close(): Promise<void>;
	create(memberEnrollment: string): Promise<void>;
	join(invite: string): Promise<void>;
	move(dx: number, dy: number): void;
	placeBlock(input: ZoneBlock): Promise<void>;
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
	const transientPositions = new Map<string, Readonly<{ x: number; y: number }>>();
	let room: Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>> | undefined;
	let ephemeral: EphemeralChannel | undefined;
	let projection = emptyProjection();
	let invite = "";
	let zoneId = "";
	let localX = 0;
	let localY = 0;
	let closeRequested = false;
	let closing: Promise<void> | undefined;
	let opening: Promise<void> | undefined;
	const resetZoneState = (): void => {
		projection = emptyProjection();
		transientPositions.clear();
		invite = "";
		zoneId = "";
		localX = 0;
		localY = 0;
	};

	const snapshot = (): ZoneSnapshot => {
		const positionEntries = [...transientPositions.entries()].sort(([left], [right]) => compareText(left, right));
		return Object.freeze({
			acceptedOperationDigest: digest(
				"ts-drp/d9346-zone-accepted-operations/v1",
				encodeCanonical(projection.acceptedDigests)
			),
			blocks: projection.blocks,
			durableVertexCount: projection.acceptedDigests.length,
			enrollment,
			invite,
			localAuthor,
			localPeerId,
			ready: room !== undefined,
			transientPositions: Object.freeze(Object.fromEntries(positionEntries)),
			transportPeerAuthors: projection.transportPeerAuthors,
			zoneId,
		});
	};
	const emit = (): void => onProjection(snapshot());
	const performOpen = async (
		selectedZoneId: string,
		creatorInvite: string | V3RoomCreatorInviteMaterial,
		bootstrapMembers: readonly Readonly<Enrollment & { readonly order: number }>[]
	): Promise<void> => {
		resetZoneState();
		zoneId = selectedZoneId;
		let opened: Awaited<ReturnType<typeof createV3RoomSession<ZoneProjection>>> | undefined;
		try {
			const separator = selectedZoneId.indexOf(":");
			if (separator <= 0) throw new TypeError("v3 zone creator identity is invalid");
			const creatorPeerId = selectedZoneId.slice(0, separator);
			const creatorAuthor = creatorAuthorFromInvite(creatorInvite);
			const application = zoneApplication(bootstrapMembers, creatorPeerId, creatorAuthor);
			opened = await createV3RoomSession<ZoneProjection>({
				application,
				author: localAuthor,
				creatorInvite,
				databaseName: `ts-drp-v3-zone--${digest("ts-drp/d9346-zone-database/v1", new TextEncoder().encode(zoneId))}`,
				initialLogicalTime: 3,
				objectId: zoneId,
				onAcceptedVertex: () => undefined,
				onProjection: (value): void => {
					projection = value;
					emit();
				},
				openTransport: () => node.openRoomNetwork(zoneId),
				publicKeyBytes: bytes(localAuthor),
				signRegisteredVertexDigest: (registeredDigest) => node.keychain.signWithLocalAuthor(registeredDigest),
			});
			if (closeRequested) throw new Error("v3 zone closed during open");
			const openedEphemeral = opened.openEphemeral({
				maxMessageBytes: 65_536,
				maxSequencedKeys: 1,
				maxSequencedSenders: 2,
			});
			openedEphemeral.subscribe(({ payload, sender }) => {
				const position = decodePosition(payload);
				if (position === undefined) return;
				transientPositions.set(sender, position);
				emit();
			});
			room = opened;
			ephemeral = openedEphemeral;
			emit();
		} catch (error) {
			await opened?.close().catch(() => undefined);
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

	const api: V3ZoneApi = {
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closeRequested = true;
			const attempt = (async (): Promise<void> => {
				await opening?.catch(() => undefined);
				const selected = room;
				const selectedEphemeral = ephemeral;
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
					await selected?.close();
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
		async create(memberEnrollment: string): Promise<void> {
			await trackOpen(async (): Promise<void> => {
				const member = decodeEnrollment(memberEnrollment);
				if (member.author === localAuthor || member.peerId === localPeerId) {
					throw new TypeError("v3 zone member enrollment duplicates the creator");
				}
				const salt = new Uint8Array(16);
				crypto.getRandomValues(salt);
				const selectedZoneId = `${localPeerId}:${hex(salt)}`;
				const members = Object.freeze([
					Object.freeze({ author: localAuthor, order: 0, peerId: localPeerId }),
					Object.freeze({ ...member, order: 1 }),
				]);
				const material = await createCreatorInviteMaterial(node, selectedZoneId, members);
				await performOpen(selectedZoneId, material, members);
				if (room === undefined) throw new Error("v3 zone did not open");
				invite = encodeZoneInvite({ roomInvite: room.invite, zoneId: selectedZoneId });
				emit();
			});
		},
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
			localX += dx;
			localY += dy;
			transientPositions.set(localPeerId, Object.freeze({ x: localX, y: localY }));
			void ephemeral.publish({
				class: "unreliable-sequenced",
				key: localPeerId,
				payload: new TextEncoder().encode(JSON.stringify({ x: localX, y: localY })),
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
		snapshot,
	};
	emit();
	return Object.freeze(api);
}

function zoneApplication(
	members: readonly Readonly<Enrollment & { readonly order: number }>[],
	creatorPeerId: string,
	creatorAuthor: string
): Parameters<typeof createV3RoomSession<ZoneProjection>>[0]["application"] {
	const material = applicationMaterial();
	return Object.freeze({
		bootstrapOperation: Object.freeze({
			action: "join",
			roster: Object.freeze({ entries: Object.freeze(members.map((entry) => Object.freeze({ ...entry }))) }),
		}),
		canonicalBlueprintPackageBytes: material.canonicalBlueprintPackageBytes,
		catalog: material.catalog,
		projectAcceptedVertices: (vertices: readonly V3RoomAcceptedVertex[]) =>
			projectZone(vertices, creatorPeerId, creatorAuthor),
	});
}

function projectZone(
	vertices: readonly V3RoomAcceptedVertex[],
	creatorPeerId: string,
	creatorAuthor: string
): ZoneProjection {
	const roster = new Map<string, Readonly<Enrollment & { readonly order: number }>>();
	const rosterOrders = new Map<number, Readonly<Enrollment & { readonly order: number }>>();
	const blocks = new Map<string, ZoneBlock>();
	for (const vertex of vertices) {
		const action = Reflect.get(vertex.operation, "action");
		if (action === "join") {
			const rosterValue = Reflect.get(vertex.operation, "roster");
			const members =
				typeof rosterValue === "object" && rosterValue !== null ? Reflect.get(rosterValue, "entries") : undefined;
			if (!Array.isArray(members)) continue;
			const parsedMembers = members.map(exactMember);
			const creatorSignedRoster = parsedMembers.some(
				(member) =>
					member?.order === 0 &&
					member.author === creatorAuthor &&
					vertex.author === creatorAuthor &&
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
			const block = exactBlock(vertex.operation);
			if (block !== undefined) blocks.set(block.id, block);
		}
	}
	const entries = [...roster.values()].sort(
		(left, right) =>
			left.order - right.order || compareText(left.author, right.author) || compareText(left.peerId, right.peerId)
	);
	return Object.freeze({
		acceptedDigests: Object.freeze(vertices.map((vertex) => hex(vertex.digest))),
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
		(order === 0 || order === 1) &&
		typeof peerId === "string" &&
		peerId.length > 0
		? Object.freeze({ author, order, peerId })
		: undefined;
}

function exactBlock(value: unknown): ZoneBlock | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id = Reflect.get(value, "id");
	const kind = Reflect.get(value, "kind");
	const x = Reflect.get(value, "x");
	const y = Reflect.get(value, "y");
	return typeof id === "string" &&
		id.length > 0 &&
		typeof kind === "string" &&
		kind.length > 0 &&
		Number.isSafeInteger(x) &&
		Number.isSafeInteger(y)
		? Object.freeze({ id, kind, x: x as number, y: y as number })
		: undefined;
}

function decodePosition(payload: Uint8Array): Readonly<{ x: number; y: number }> | undefined {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(payload));
		if (typeof value !== "object" || value === null) return undefined;
		const x = Reflect.get(value, "x");
		const y = Reflect.get(value, "y");
		return Number.isSafeInteger(x) && Number.isSafeInteger(y)
			? Object.freeze({ x: x as number, y: y as number })
			: undefined;
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
	const exactCanonicalGenesisAnchorPreimageBytes = encodeCanonical({
		aclDigest: digest("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: application.blueprintDigest,
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "0".repeat(64),
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest: digest("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes),
		previousAnchor: "0".repeat(64),
		profileDigest: digest("ts-drp/profile/v3", exactCanonicalProfileBytes),
		protocolMajor: 3,
		signerSetDigest: digest("ts-drp/signer-set/v3", exactCanonicalSignerSetBytes),
		stateDigest: "7".repeat(64),
	});
	const anchorDigestBytes = hashDomain("ts-drp/epoch-anchor/v3", exactCanonicalGenesisAnchorPreimageBytes);
	return Object.freeze({
		detachedGenesisSignature: await node.keychain.signWithLocalAuthor(anchorDigestBytes),
		exactCanonicalLatchedAclBytes,
		exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: hex(anchorDigestBytes),
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
			schemaVersion: 1,
			operationDiscriminator: "action",
			operations: Object.freeze([
				operation("join", [Object.freeze({ name: "roster", type: "canonical-object" })]),
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
