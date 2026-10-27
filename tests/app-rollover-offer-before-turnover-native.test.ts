/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the native owners' signatures. */
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { CANVAS_GENESIS_PROFILE } from "../examples/canvas/src/profile.js";
import { CANVAS_ROLLOVER_BUDGET } from "../examples/canvas/src/rollover.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	createV3RoomSession,
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	type V3RoomRolloverEvent,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../packages/blueprints/src/v3-canvas.js";
import { type CanvasProjection, createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import { DRPNode } from "../packages/node/src/index.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Epoch-4 step, creator side. The shipped pages open every new room with the scheduled
// recovery-pool lull (examples/v3-room createV3RoomSession), and the shipped rollover policy
// seals, adopts, exports and then publishes each successor offer. A member cannot start its
// install before that publication. From successor epoch 4 the creator's bounded recovery pool is
// full, so the lull it schedules at each adoption is a full turnover (about 1.3 s on Node SQLite,
// several seconds on IndexedDB). In c08d8680 that lull joins the lifecycle FIFO inside the
// adoption, ahead of the policy's export, so every offer from epoch 4 on is published only after
// the turnover: the member's install end steps at epoch 4 and so does the creator's rollover time.
//
// The measure is a work count, not wall time: the number of the creator's recovery-pool turnovers
// ("maintained" lulls) for successor epoch N that completed before its offer for N was published.
// It must be zero at every epoch. The lull itself must still run before the seal that closes N
// (the scheduled lull's own contract: it runs before any later transition), and turnovers must
// occur at all (otherwise the count is vacuous).

const directories = new Set<string>();
const nodes = new Set<DRPNode>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const closers = new Set<() => void>();
const heads = new Set<{ close(): Promise<void> }>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const SUCCESSOR_EPOCHS = Number(process.env.APP_ROLLOVER_OFFER_EPOCHS ?? 6);
const SIDE = 8;

function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("APP_ROLLOVER_OFFER_REQUIRED");
	return value;
}

type Mark =
	| Readonly<{ kind: "lull"; epoch: number; result: string; trigger: string; ms: number }>
	| Readonly<{ kind: "publish"; epoch: number }>
	| Readonly<{ kind: "seal"; epoch: number }>;

const previousObserver = Reflect.get(globalThis, "__warmProofEvent");
afterEach(async () => {
	Reflect.set(globalThis, "__warmProofEvent", previousObserver);
	for (const close of closers) close();
	closers.clear();
	const joined = await Promise.allSettled([...rooms].map((room) => room.close()));
	rooms.clear();
	const headJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const nodeJoined = await Promise.allSettled([...nodes].map((node) => node.stop()));
	nodes.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	expect(
		[...joined, ...headJoined, ...nodeJoined].filter((result) => result.status === "rejected"),
		"native owners join"
	).toEqual([]);
});

async function creatorRoom(marks: Mark[]) {
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-offer-"));
	directories.add(directory);
	const node = new DRPNode({
		keychain_config: { private_key_seed: "app-rollover-offer-creator" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
	});
	nodes.add(node);
	await node.start();
	const application = createV3CanvasApplication(SIDE, SIDE);
	const objectId = `${node.networkNode.peerId}:${hex(hashDomain("app-rollover-offer/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const author = node.keychain.localAuthorId;
	const signers = [{ publicKey: author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: CANVAS_GENESIS_PROFILE.latchedAclVersion,
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
			profileId: CANVAS_GENESIS_PROFILE.profileId,
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => node.keychain.signWithLocalAuthor(digest),
	});
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	const floor = await host.openRoomHead("creator", { kind: "create" });
	heads.add(floor);
	const events: V3RoomRolloverEvent[] = [];
	const errors: unknown[] = [];
	const delivery = createV3RoomSuccessorDelivery({
		role: "creator",
		objectId,
		channel: createV3RoomSuccessorChannel(node, objectId),
		hooks: { onError: (error) => errors.push(error) },
	});
	closers.add(() => delivery.close());
	const policy = createV3RoomRolloverPolicy({
		role: "creator",
		budget: CANVAS_ROLLOVER_BUDGET,
		hooks: {
			// The offer leaves the creator here; a member's install cannot start earlier.
			publishSuccessor: async (offer, successorEpoch) => {
				marks.push({ kind: "publish", epoch: successorEpoch });
				await delivery.publish(offer, successorEpoch);
			},
			onRollover: (event) => events.push(event),
			onError: (error) => errors.push(error),
		},
	});
	closers.add(() => policy.close());
	const room = await createV3RoomSession<CanvasProjection>({
		application,
		storageHost: host,
		// As the browser binding opens every new room (examples/v3-room createV3RoomSession).
		recoveryPoolScheduledLull: true,
		author,
		creatorFinalitySigner: await node.keychain.acquireLocalAuthorFinalitySigner(),
		creatorInvite: invite,
		databaseName: "creator",
		issuanceDatabaseName: "creator",
		migrationDatabaseNamespace: "creator",
		initialLogicalTime: 3,
		objectId,
		publicKeyBytes: Uint8Array.from(Buffer.from(author, "hex")),
		roomHeadAuthority: floor,
		signRegisteredVertexDigest: (digest) => node.keychain.signWithLocalAuthor(digest),
		onProjection: () => undefined,
		onAcceptedVertex: (vertex) => policy.observe(vertex),
		openTransport: (id) => node.openRoomNetwork(id),
	});
	rooms.add(room);
	await waitForV3RoomStartupForDiagnostics(room);
	// The policy drives the room through this view; only the seal is marked (observation only).
	// The session is frozen, so the view is a separate object that forwards every member.
	const observed = new Proxy({} as V3RoomSession<CanvasProjection>, {
		get(_target, key) {
			const value = Reflect.get(room, key) as unknown;
			if (key === "sealEpoch" && typeof value === "function")
				return () => {
					marks.push({ kind: "seal", epoch: room.authority()?.epoch ?? 0 });
					return (value as () => unknown).call(room);
				};
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(room) : value;
		},
	});
	policy.bind(observed);
	delivery.bind(room);
	return { room, policy, events, errors, delivery };
}

const paint = (index: number) =>
	toCanvasWireOperation(
		{ action: "paint", offset: [index % SIDE, Math.floor(index / SIDE) % SIDE], rgb: [index % 251, 7, 3] },
		`offer-${index}`
	);

it(`the creator publishes each of ${SUCCESSOR_EPOCHS} successor offers before its recovery-pool turnover for that epoch`, async () => {
	const marks: Mark[] = [];
	// This process holds one room only, so every lull event is the creator's.
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event?.kind === "recovery-pool-lull" && typeof event.epoch === "number")
			marks.push({
				kind: "lull",
				epoch: event.epoch,
				result: String(event.result),
				trigger: String(event.trigger),
				ms: Number(event.ms),
			});
	});
	const creator = await creatorRoom(marks);
	const budget = CANVAS_ROLLOVER_BUDGET.movesPerAuthor;
	for (let moves = 0; (creator.room.authority()?.epoch ?? 0) < SUCCESSOR_EPOCHS; ) {
		await creator.policy.issue(paint(moves));
		moves++;
		if (moves % budget === 0) await creator.policy.settled();
		if (moves > SUCCESSOR_EPOCHS * budget * 3) throw new Error("APP_ROLLOVER_OFFER_NO_PROGRESS");
	}
	await creator.policy.settled();
	// The last epoch's lull is requested at its adoption; let it settle before reading the marks.
	await creator.room.maintainRecoveryPool();
	expect(creator.errors.map(String), "creator policy and delivery errors").toEqual([]);

	const perEpoch = Array.from({ length: SUCCESSOR_EPOCHS }, (_, index) => {
		const epoch = index + 1;
		const published = marks.findIndex((mark) => mark.kind === "publish" && mark.epoch === epoch);
		const sealedNext = marks.findIndex((mark) => mark.kind === "seal" && mark.epoch === epoch);
		const lulls = marks.flatMap((mark, at) => (mark.kind === "lull" && mark.epoch === epoch ? [{ ...mark, at }] : []));
		const scheduled = lulls.find((lull) => lull.trigger === "scheduled");
		return {
			epoch,
			published: published >= 0,
			// The work count: turnovers for this epoch that completed before its offer left.
			turnoversBeforePublish: lulls.filter((lull) => lull.result === "maintained" && lull.at < published).length,
			scheduled: scheduled?.result ?? null,
			scheduledMs: scheduled === undefined ? null : Math.round(scheduled.ms),
			// The scheduled lull still precedes the seal that closes this epoch (when one ran).
			scheduledBeforeNextSeal: sealedNext < 0 ? null : scheduled !== undefined && scheduled.at < sealedNext,
		};
	});
	console.log(
		"APP_ROLLOVER_OFFER",
		JSON.stringify({ perEpoch, rolloverMs: creator.events.map((event) => Math.round(event.ms)) })
	);
	expect(
		perEpoch.every((row) => row.published),
		"every successor offer was published"
	).toBe(true);
	// Not vacuous: the bounded pool fills and the scheduled lull turns it over from epoch 4.
	expect(
		perEpoch.filter((row) => row.scheduled === "maintained").map((row) => row.epoch),
		"scheduled turnovers ran"
	).toEqual(perEpoch.filter((row) => row.epoch >= 4).map((row) => row.epoch));
	expect(
		perEpoch.filter((row) => row.scheduledBeforeNextSeal === false).map((row) => row.epoch),
		"each scheduled lull still runs before the seal that closes its epoch"
	).toEqual([]);
	expect(
		perEpoch.map((row) => row.turnoversBeforePublish),
		"recovery-pool turnovers completed before the epoch's offer was published"
	).toEqual(perEpoch.map(() => 0));
}, 300_000);
