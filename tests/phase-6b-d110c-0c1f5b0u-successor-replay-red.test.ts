/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent observers preserve the real runtime signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal describes the observed module. */
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
import type { V3AdmittedVertexSink, V3PlaneHandle } from "@ts-drp/node/v3-live";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomHeadState,
	type V3RoomSession,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";

type Delivery = Parameters<V3AdmittedVertexSink>[0];
const observed = vi.hoisted(() => ({
	phase: "prepare" as "prepare" | "reopen",
	fault: "none" as "none" | "sink" | "commit" | "second-commit",
	deliveries: [] as Delivery[],
	events: [] as string[],
	handles: [] as V3PlaneHandle[],
	transportCloses: 0,
}));

// Resolve the existing adoption exports to the same source-module identity as
// vite.config.mts's v3-live/creator-close aliases. These are real implementations,
// not manufactured capabilities, transition records or future exports.
vi.mock("../packages/node/dist/src/creator-adoption.js", () => import("../packages/node/src/creator-adoption.js"));
vi.mock(
	"../packages/node/dist/src/creator-adoption-stage.js",
	() => import("../packages/node/src/creator-adoption-stage.js")
);
vi.mock(
	"../packages/node/dist/src/creator-adoption-recover.js",
	() => import("../packages/node/src/creator-adoption-recover.js")
);
vi.mock("../packages/node/dist/src/creator-adoption-activate.js", async () => {
	const actual = await import("../packages/node/src/creator-adoption-activate.js");
	const observe = async (owner: typeof actual.reopenCreatorSuccessorAdoption, value: unknown) => {
		const input = value as Record<string, unknown> & { onAdmittedVertex: V3AdmittedVertexSink };
		const result = await owner({
			...input,
			onAdmittedVertex: async (delivery: Delivery) => {
				observed.deliveries.push(structuredClone(delivery));
				if (observed.phase === "reopen") {
					observed.events.push(`sink:${delivery.vertex.authorSequence}`);
					if (observed.fault === "sink") throw new Error("D110C_0C1F5B0U_REPLAY_SINK_FAILED");
				}
				return await input.onAdmittedVertex(delivery);
			},
		});
		if (result.ok === true) observed.handles.push(result.handle as V3PlaneHandle);
		return result;
	};
	return {
		...actual,
		activateCreatorSuccessorAdoption: (input: unknown) => observe(actual.activateCreatorSuccessorAdoption, input),
		reopenCreatorSuccessorAdoption: (input: unknown) => observe(actual.reopenCreatorSuccessorAdoption, input),
	};
});

vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ts-drp/node/v3-live")>();
	return {
		...actual,
		bindV3BlueprintLivePlane: (...args: Parameters<typeof actual.bindV3BlueprintLivePlane>) => {
			const result = actual.bindV3BlueprintLivePlane(...args);
			if (observed.phase === "reopen" && Reflect.get(args[0], "purpose") === "projection-base" && result.ok)
				observed.events.push("authenticated-projection-base");
			return result;
		},
	};
});

const sessions: V3RoomSession[] = [];
const seed = new Uint8Array(32).fill(73);
const publicKey = ed25519.getPublicKey(seed);
const author = Buffer.from(publicKey).toString("hex");
const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage");
let ordinal = 0;

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new TypeError("D110C_0C1F5B0U_REPLAY_FIXTURE_MISSING");
	return value;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

// Read the declaration actually produced by seal/adoption, exactly as the
// retained D.108 successor room fixture does. Never synthesize epoch authority.
async function snapshotDeclaration(databaseName: string) {
	const database = await request(indexedDB.open(`${databaseName}--drp-snapshot-quarantine-v1`));
	try {
		const transaction = database.transaction(["chunks", "scopes"], "readonly");
		const [scopes, chunks] = await Promise.all([
			request(transaction.objectStore("scopes").getAll()) as Promise<Record<string, unknown>[]>,
			request(transaction.objectStore("chunks").getAll()) as Promise<Record<string, unknown>[]>,
		]);
		// The close snapshots predecessor epoch 0; its verified payload is the
		// authenticated application base imported by the epoch-1 successor.
		const verified = scopes.filter((scope) => scope.state === "verified" && scope.epoch === 0);
		if (verified.length !== 1) throw new TypeError("D110C_0C1F5B0U_REPLAY_SNAPSHOT_AMBIGUOUS");
		const scope = required(verified[0]);
		const selected = chunks
			.filter((row) => ["objectId", "epoch", "anchor", "manifestDigest"].every((key) => row[key] === scope[key]))
			.sort((left, right) => Number(left.index) - Number(right.index));
		if (selected.length !== scope.chunkCount) throw new TypeError("D110C_0C1F5B0U_REPLAY_SNAPSHOT_INCOMPLETE");
		return {
			chunks: selected.map((row) => ({ byteLength: row.byteLength, digest: row.digest, index: row.index })),
			exactCanonicalManifestBytes: new Uint8Array(scope.exactCanonicalManifestBytes as Uint8Array),
			scope: {
				anchor: scope.anchor,
				epoch: scope.epoch,
				manifestDigest: scope.manifestDigest,
				objectId: scope.objectId,
			},
			totalBytes: scope.totalBytes,
		} as NonNullable<CreateV3RoomSessionInput["successorSnapshotDeclaration"]>;
	} finally {
		database.close();
	}
}

async function genuineSuccessor() {
	const identity = ++ordinal;
	const databaseName = `d110c-f5b0u-successor-replay-${identity}`;
	const objectId = `creator:${identity.toString(16).padStart(32, "0")}`;
	const base = createV3ChatApplication("alice");
	const migration = required(base.migration);
	const application = {
		...base,
		migration: {
			...migration,
			canonicalStateBytes: (...args: Parameters<typeof migration.canonicalStateBytes>) => {
				const bytes = migration.canonicalStateBytes(...args);
				if (observed.phase === "reopen") observed.events.push("validated-application-state");
				return bytes;
			},
		},
	};
	const signers = [{ publicKey: author, signerId: "creator" }];
	const creatorInvite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(base.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: encodeCanonical([]),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: 1,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical({
			maxDependencies: 16,
			maxEpochBytes: 8_388_608,
			maxEpochVertices: 8192,
			maxPendingBytes: 16_777_216,
			maxPendingEntries: 4096,
			maxSnapshotBytes: 268_435_456,
			snapshotChunkBytes: 131_072,
		}),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, seed)),
	});
	let state: V3RoomHeadState | null = null;
	const success = () => ({ ok: true as const, state: structuredClone(state) });
	const roomHeadAuthority: CreateV3RoomSessionInput["roomHeadAuthority"] = {
		initialization: { kind: "create" },
		read: () => Promise.resolve(success()),
		create: async (input) => {
			await Promise.resolve();
			if (state === null) state = { pending: null, stable: input.stable };
			return success();
		},
		migrate: () => Promise.resolve({ ok: false, reason: "conflict" }),
		begin: async (input) => {
			await Promise.resolve();
			if (!Buffer.from(encodeCanonical(input.expected)).equals(Buffer.from(encodeCanonical(state))))
				return { ok: false, reason: "conflict" };
			const previous = required(state).stable;
			state = { stable: previous, pending: { previous, next: input.next } };
			return success();
		},
		commit: async (input) => {
			await Promise.resolve();
			if (!Buffer.from(encodeCanonical(input.expected)).equals(Buffer.from(encodeCanonical(state))))
				return { ok: false, reason: "conflict" };
			state = { pending: null, stable: required(required(state).pending).next };
			return success();
		},
	};
	const finality = await createRecoverableFinalitySigner({ seed });
	const accepted: string[] = [];
	const input: CreateV3RoomSessionInput = {
		application,
		author,
		creatorInvite,
		databaseName,
		initialLogicalTime: 3,
		issuanceDatabaseName: databaseName,
		objectId,
		onAcceptedVertex: (vertex) => {
			if (observed.phase !== "reopen") return;
			observed.events.push(`commit:${vertex.authorSequence}`);
			if (observed.fault === "commit") throw new Error("D110C_0C1F5B0U_REPLAY_COMMIT_FAILED");
			if (observed.fault === "second-commit" && accepted.length === 1) {
				observed.fault = "none";
				throw new Error("D110C_0C1F5B0U_REPLAY_SECOND_COMMIT_FAILED");
			}
			accepted.push(Buffer.from(vertex.digest).toString("hex"));
		},
		onProjection: () => undefined,
		openTransport: () => ({
			networkNode: fakeNetwork(databaseName),
			close: () => {
				observed.transportCloses += 1;
			},
			openEphemeral: () => {
				throw new Error("not used");
			},
			requestRetainedHistory: () => undefined,
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
		publicKeyBytes: publicKey,
		roomHeadAuthority,
		signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, seed)),
	};
	const room = await createV3RoomSession({ ...input, creatorFinalitySigner: finality.signer });
	sessions.push(room);
	await room.issue({ action: "message", clientOperationId: "snapshot", text: "snapshot" });
	const sealed = await room.sealEpoch();
	if (sealed.ok !== true) throw new TypeError(`D110C_0C1F5B0U_REPLAY_CLOSE_FAILED:${JSON.stringify(sealed)}`);
	await room.adoptCreatorSuccessor();
	if (room.authority()?.epoch !== 1) throw new TypeError("D110C_0C1F5B0U_REPLAY_ADOPTION_FAILED");
	observed.deliveries = [];
	for (const clientOperationId of ["above-snapshot-1", "above-snapshot-2"])
		await room.issue({ action: "message", clientOperationId, text: clientOperationId });
	const expected = structuredClone(observed.deliveries);
	if (expected.length !== 2) throw new TypeError("D110C_0C1F5B0U_REPLAY_ISSUED_EVIDENCE_INCOMPLETE");
	const projection = room.projection();
	const authority = room.authority();
	const declaration = await snapshotDeclaration(databaseName);
	await room.close();
	sessions.splice(sessions.indexOf(room), 1);
	observed.phase = "reopen";
	observed.deliveries = [];
	observed.events = [];
	observed.transportCloses = 0;
	const reopen = async () => {
		const reopened = await createV3RoomSession({
			...input,
			roomHeadAuthority: { ...roomHeadAuthority, initialization: { kind: "reopen" } },
			successorSnapshotDeclaration: declaration,
		});
		sessions.push(reopened);
		return reopened;
	};
	const readIssuance = async () => {
		const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
		try {
			const scope = { author, objectId };
			const lineage = await store.readLineage(scope);
			if (lineage.next > 16) throw new TypeError("D110C_0C1F5B0V_UNEXPECTED_ISSUANCE_GROWTH");
			const rows = await Promise.all(
				Array.from({ length: lineage.next + 1 }, (_, sequence) => store.readIssued(scope, sequence))
			);
			return { lineage, rows };
		} finally {
			await store.close();
		}
	};
	return { accepted, authority, expected, projection, readIssuance, reopen };
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
	observed.phase = "prepare";
	observed.fault = "none";
	observed.deliveries = [];
	observed.events = [];
	observed.handles = [];
	observed.transportCloses = 0;
});

afterEach(async () => {
	observed.fault = "none";
	await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
	await Promise.all(observed.handles.map((handle) => Promise.resolve(handle.deactivate())));
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});

describe("D.110c-0c1f5b0u genuine successor recovered-delivery RED", () => {
	it("replays exact above-snapshot evidence once after authority/base validation and before resumed issue", async () => {
		const fixture = await genuineSuccessor();
		const reopened = await fixture.reopen();
		const replay = [...observed.deliveries];
		const expectedDigests = fixture.expected.map(({ vertex }) => Buffer.from(vertex.digest).toString("hex"));
		expect
			.soft(
				replay.map(({ vertex }) => Buffer.from(vertex.digest).toString("hex")),
				"REPLAY_EXACT_ORDER"
			)
			.toEqual(expectedDigests);
		expect
			.soft(
				replay.map(({ exactReceivedCanonicalPreimageBytes, signature }) => ({
					exactReceivedCanonicalPreimageBytes,
					signature,
				})),
				"REPLAY_EXACT_BYTES_SIGNATURES"
			)
			.toEqual(
				fixture.expected.map(({ exactReceivedCanonicalPreimageBytes, signature }) => ({
					exactReceivedCanonicalPreimageBytes,
					signature,
				}))
			);
		expect.soft(fixture.accepted, "REPLAY_EXACTLY_ONCE_COMMIT").toEqual(expectedDigests);
		const canonicalStateBytes = required(createV3ChatApplication("alice").migration).canonicalStateBytes;
		expect
			.soft(Reflect.apply(canonicalStateBytes, undefined, [reopened.projection()]), "REPLAY_RECOVERS_APPLICATION_STATE")
			.toEqual(Reflect.apply(canonicalStateBytes, undefined, [fixture.projection]));
		const reopenedMessages = Reflect.get(reopened.projection(), "accepted") as readonly Record<string, unknown>[];
		expect
			.soft(
				reopenedMessages.filter((message) => message.provenance === "authenticated-snapshot"),
				"REPLAY_AUTHENTICATED_SNAPSHOT_PROVENANCE"
			)
			.toEqual([{ clientOperationId: "snapshot", provenance: "authenticated-snapshot", text: "snapshot" }]);
		expect.soft(reopened.authority()).toEqual(fixture.authority);
		const validation = observed.events.indexOf("validated-application-state");
		expect.soft(observed.events.indexOf("authenticated-projection-base")).toBeGreaterThanOrEqual(0);
		for (const { vertex } of fixture.expected) {
			expect
				.soft(observed.events.indexOf(`sink:${vertex.authorSequence}`), "REPLAY_SINK_PRESENT")
				.toBeGreaterThanOrEqual(0);
			expect
				.soft(observed.events.indexOf(`commit:${vertex.authorSequence}`), "REPLAY_COMMIT_AFTER_VALIDATION")
				.toBeGreaterThan(validation);
		}
		observed.events.push("public-issue");
		await reopened.issue({ action: "message", clientOperationId: "resumed", text: "resumed" });
		expect.soft(fixture.accepted.slice(0, 2), "REPLAY_BEFORE_PUBLIC_ISSUE").toEqual(expectedDigests);
		expect.soft(new Set(fixture.accepted).size, "REPLAY_NO_DUPLICATE_COMMIT").toBe(3);
		expect
			.soft(
				observed.handles.filter((handle) => handle.currentEphemeralAuthority() !== undefined),
				"REPLAY_ONE_ACTIVE_OWNER"
			)
			.toHaveLength(1);
	});

	it("replays authenticated notifications after callback two rejects without duplicating canonical state or issuance", async () => {
		const fixture = await genuineSuccessor();
		const expectedDigests = fixture.expected.map(({ vertex }) => Buffer.from(vertex.digest).toString("hex"));
		const issuedBefore = await fixture.readIssuance();
		expect(issuedBefore.lineage.exhausted, "REPLAY_ISSUANCE_NOT_EXHAUSTED").toBe(false);
		expect(issuedBefore.lineage.next, "REPLAY_EXACT_NEXT_DURABLE_SEQUENCE").toBe(
			required(fixture.expected.at(-1)).vertex.authorSequence + 1
		);
		expect(issuedBefore.rows.at(-1), "REPLAY_NO_UNALLOCATED_ISSUED_ROW").toBeNull();
		for (const { vertex, exactReceivedCanonicalPreimageBytes, signature } of fixture.expected) {
			const row = required(issuedBefore.rows[vertex.authorSequence]);
			expect(row.envelope.canonicalPreimageBytes, "REPLAY_EXACT_DURABLE_PREIMAGE").toEqual(
				exactReceivedCanonicalPreimageBytes
			);
			expect(row.envelope.signature, "REPLAY_EXACT_DURABLE_SIGNATURE").toEqual(signature);
			expect(row.envelope.digest, "REPLAY_EXACT_DURABLE_DIGEST").toEqual(vertex.digest);
			expect(row.authorSequence, "REPLAY_EXACT_DURABLE_SEQUENCE").toBe(vertex.authorSequence);
		}
		observed.fault = "second-commit";
		const outcome = await fixture.reopen().then(
			() => "unexpected-success",
			() => "rejected"
		);
		expect.soft(outcome, "REPLAY_SECOND_FAILURE_REFUSED").toBe("rejected");
		expect
			.soft(
				observed.events.filter((event) => event.startsWith("commit:")),
				"REPLAY_SECOND_CALLBACK_REACHED"
			)
			.toEqual(fixture.expected.map(({ vertex }) => `commit:${vertex.authorSequence}`));
		expect.soft(observed.fault, "REPLAY_SECOND_FAULT_CONSUMED_ONCE").toBe("none");
		expect
			.soft(
				observed.handles.filter((handle) => handle.currentEphemeralAuthority() !== undefined),
				"REPLAY_SECOND_FAILURE_NO_ACTIVE_OWNER"
			)
			.toHaveLength(0);
		expect.soft(observed.transportCloses, "REPLAY_SECOND_FAILURE_TRANSPORT_RELEASED").toBe(1);
		// This ledger is external observer state: do not reset or deduplicate it across reopen.
		expect
			.soft([...fixture.accepted], "REPLAY_SECOND_FAILURE_OBSERVED_NOTIFICATION_PREFIX")
			.toEqual([required(expectedDigests[0])]);
		expect(await fixture.readIssuance(), "REPLAY_REJECTION_DURABLE_ISSUANCE_UNCHANGED").toEqual(issuedBefore);
		observed.fault = "none";
		const secondAttemptStart = observed.events.length;
		const recovered = await fixture.reopen();
		expect
			.soft(fixture.accepted, "REPLAY_COLD_REOPEN_REPEATED_NOTIFICATION_ATTEMPTS")
			.toEqual([required(expectedDigests[0]), ...expectedDigests]);
		expect(await fixture.readIssuance(), "REPLAY_RECOVERY_DURABLE_ISSUANCE_UNCHANGED").toEqual(issuedBefore);
		const secondAttemptEvents = observed.events.slice(secondAttemptStart);
		const authentication = secondAttemptEvents.indexOf("authenticated-projection-base");
		const validation = secondAttemptEvents.indexOf("validated-application-state");
		const firstCallback = secondAttemptEvents.findIndex((event) => event.startsWith("commit:"));
		expect(authentication, "REPLAY_SECOND_ATTEMPT_AUTHENTICATES_BASE").toBeGreaterThanOrEqual(0);
		expect(validation, "REPLAY_SECOND_ATTEMPT_VALIDATES_STATE").toBeGreaterThan(authentication);
		expect(firstCallback, "REPLAY_SECOND_ATTEMPT_VALIDATES_BEFORE_NOTIFICATION").toBeGreaterThan(validation);
		const canonicalStateBytes = required(createV3ChatApplication("alice").migration).canonicalStateBytes;
		expect
			.soft(
				Reflect.apply(canonicalStateBytes, undefined, [recovered.projection()]),
				"REPLAY_RECOVERY_CANONICAL_STATE_ONCE"
			)
			.toEqual(Reflect.apply(canonicalStateBytes, undefined, [fixture.projection]));
		const messages = Reflect.get(recovered.projection(), "accepted") as readonly Record<string, unknown>[];
		expect
			.soft(messages.map((message) => message.clientOperationId).sort(), "REPLAY_RECOVERY_EACH_DURABLE_OPERATION_ONCE")
			.toEqual(["above-snapshot-1", "above-snapshot-2", "snapshot"]);
		expect.soft(recovered.authority(), "REPLAY_RECOVERY_AUTHORITY_UNCHANGED").toEqual(fixture.authority);
		expect
			.soft(
				observed.handles.filter((handle) => handle.currentEphemeralAuthority() !== undefined),
				"REPLAY_RECOVERY_ONE_ACTIVE_OWNER"
			)
			.toHaveLength(1);
	});

	for (const fault of ["sink", "commit"] as const) {
		it(`fails closed and releases successor custody when recovered ${fault} fails`, async () => {
			const fixture = await genuineSuccessor();
			observed.fault = fault;
			const outcome = await fixture.reopen().then(
				() => "unexpected-success",
				() => "rejected"
			);
			expect.soft(outcome, "REPLAY_FAILURE_REFUSED").toBe("rejected");
			expect.soft(observed.deliveries.length, "REPLAY_FAILURE_SEAM_REACHED").toBeGreaterThan(0);
			expect
				.soft(
					observed.handles.filter((handle) => handle.currentEphemeralAuthority() !== undefined),
					"REPLAY_FAILURE_NO_ACTIVE_OWNER"
				)
				.toHaveLength(0);
			expect.soft(observed.transportCloses, "REPLAY_FAILURE_TRANSPORT_RELEASED").toBe(1);
			expect.soft(fixture.accepted, "REPLAY_FAILURE_NO_PARTIAL_COMMIT").toEqual([]);
		});
	}
});
