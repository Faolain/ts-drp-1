/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real module signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal generics describe the corresponding transparent observed module. */
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import type { V3PlaneHandle } from "@ts-drp/node/v3-live";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";

const observation = vi.hoisted(() => ({
	activate: [] as V3PlaneHandle[],
	commits: [] as DurableIssueCommit[],
	events: [] as string[],
	fault: "none" as "none" | "before-commit" | "partial-unknown" | "final-unknown",
	fired: false,
	stores: new Map<string, DurableIssuanceStore>(),
	bound: [] as { plane: V3PlaneHandle; handle: { status(): unknown } }[],
	failRebind: false,
	faultGate: undefined as undefined | Promise<void>,
	onFault: undefined as undefined | (() => void),
	closeFault: false,
}));

// Every operation and capability below is real. Only the receipt following one
// selected signed store transaction is lost, using the accepted f5b0b seam.
vi.mock("@ts-drp/storage-browser/issuance", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ts-drp/storage-browser/issuance")>();
	return {
		...actual,
		createBrowserDurableIssuanceStore: async (input: { primaryDatabaseName: string }) => {
			const real = await actual.createBrowserDurableIssuanceStore(input);
			const wrapped: DurableIssuanceStore = {
				...real,
				close: async () => {
					await real.close();
					if (observation.closeFault) throw new Error("D110C_0C1F5B0U_CONTROLLED_STORE_CLOSE_FAILED");
				},
				transactIssue: async (scope, build) => {
					let selected: DurableIssueCommit | undefined;
					let failAfter = false;
					const result = await real.transactIssue(scope, async (sequence) => {
						const candidate = await build(sequence);
						selected = candidate;
						const effect = candidate.planEffect as unknown as Record<string, unknown> | undefined;
						if (!observation.fired && effect?.kind === "replacement" && typeof effect.fromIntent === "number") {
							const current = await real.readSettlementPlan(scope);
							const entry = current?.entries.find((row) => row.sourceSequence === effect.sourceSequence);
							const progress = Reflect.get(entry as object, "replacementProgress") as Record<string, unknown>;
							const final = effect.throughIntent === progress.intentCount;
							if (
								observation.fault === "before-commit" ||
								(observation.fault === "partial-unknown" && !final) ||
								(observation.fault === "final-unknown" && final)
							) {
								observation.fired = true;
								observation.events.push(`signed-fault:${sequence}`);
								if (observation.fault === "before-commit")
									throw Object.assign(new Error("D110C_0C1F5B0U_SIGNED_NOT_COMMITTED"), {
										code: "ISSUANCE_OUTCOME_UNKNOWN",
									});
								failAfter = true;
							}
						}
						return candidate;
					});
					if (selected !== undefined) observation.commits.push(selected);
					observation.events.push(`commit:${result.authorSequence}`);
					if (failAfter) {
						observation.onFault?.();
						await observation.faultGate;
						throw Object.assign(new Error("D110C_0C1F5B0U_COMMITTED_RECEIPT_LOST"), {
							code: "ISSUANCE_OUTCOME_UNKNOWN",
						});
					}
					return result;
				},
			};
			observation.stores.set(input.primaryDatabaseName, wrapped);
			return wrapped;
		},
	};
});

vi.mock("@ts-drp/node/creator-close", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ts-drp/node/creator-close")>();
	const observed = async (...args: Parameters<typeof actual.bindCreatorLiveClose>) => {
		if (observation.failRebind && observation.fired && observation.bound.length > 0)
			return { ok: false as const, reason: "CREATOR_CONTINUITY_TERMINAL" };
		const result = await actual.bindCreatorLiveClose(...args);
		if (result.ok) observation.bound.push({ plane: args[0].plane, handle: result.handle });
		return result;
	};
	const descriptor = Object.getOwnPropertyDescriptor(
		actual.bindCreatorLiveClose,
		"installV3CreatorCloseRegistrationResolver"
	);
	if (descriptor === undefined || typeof descriptor.value !== "function")
		throw new TypeError("creator-close observer installer is unavailable");
	const install = descriptor.value as (...args: unknown[]) => unknown;
	Object.defineProperty(observed, "installV3CreatorCloseRegistrationResolver", {
		...descriptor,
		value: (...args: unknown[]) => Reflect.apply(install, actual.bindCreatorLiveClose, args),
	});
	return { ...actual, bindCreatorLiveClose: observed };
});

vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ts-drp/node/v3-live")>();
	return {
		...actual,
		activateV3LivePlane: (...args: Parameters<typeof actual.activateV3LivePlane>) => {
			const result = actual.activateV3LivePlane(...args);
			if (result.ok) {
				observation.activate.push(result.handle);
				observation.events.push("activate");
			}
			return result;
		},
	};
});

const sessions: V3RoomSession[] = [];
const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage");
let ordinal = 0;
const parameters = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const authorSeed = new Uint8Array(32).fill(71);
const publicKey = ed25519.getPublicKey(authorSeed);
const author = Buffer.from(publicKey).toString("hex");

function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new TypeError("D110C_0C1F5B0U_FIXTURE_REQUIRED_VALUE_MISSING");
	return value;
}

function roomHeadAuthority(): CreateV3RoomSessionInput["roomHeadAuthority"] {
	let state: { pending: null | { previous: unknown; next: unknown }; stable: unknown } | null = null;
	const success = () => ({ ok: true as const, state: structuredClone(state) as never });
	return {
		initialization: { kind: "create" },
		read: () => Promise.resolve(success()),
		create: async (input) => {
			await Promise.resolve();
			if (state === null) state = { pending: null, stable: input.stable };
			return success();
		},
		migrate: async (input) => {
			await Promise.resolve();
			state = { pending: null, stable: input.stable };
			return success();
		},
		begin: async (input) => {
			await Promise.resolve();
			if (JSON.stringify(input.expected) !== JSON.stringify(state)) return { ok: false, reason: "conflict" };
			state = { pending: { previous: required(state).stable, next: input.next }, stable: required(state).stable };
			return success();
		},
		commit: async (input) => {
			await Promise.resolve();
			if (JSON.stringify(input.expected) !== JSON.stringify(state) || state?.pending === null)
				return { ok: false, reason: "conflict" };
			state = { pending: null, stable: required(required(state).pending).next };
			return success();
		},
	};
}

async function openRebasePair(count: number, expandedBytes: number, withClose = false) {
	const identity = ++ordinal;
	const objectId = `creator:${identity.toString(16).padStart(32, "0")}`;
	const name = `d110c-f5b0u-runtime-${identity}`;
	const base = createV3ChatApplication("alice");
	const application = Object.freeze({
		...base,
		displacementPolicies: Object.freeze({ message: "transform" as const }),
		transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) =>
			Object.freeze({ ...operation, text: "x".repeat(expandedBytes) }),
	});
	const invite = async (target: boolean, selectedObjectId = objectId) => {
		const signer = author;
		const signers = [{ publicKey: signer, signerId: "creator" }];
		return createV3RoomCreatorInviteMaterial({
			blueprintDigest: base.catalog.blueprintDigests[0] as string,
			exactCanonicalApplicationStateBytes: encodeCanonical([]),
			exactCanonicalLatchedAclBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: [
					{ author, finalityKey: author, groups: ["admin", "finality", "writer"] },
					...(target
						? [
								{
									author: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(90))).toString("hex"),
									finalityKey: null,
									groups: ["writer"],
								},
							]
						: []),
				].sort((left, right) => (left.author < right.author ? -1 : 1)),
				objectId: selectedObjectId,
				permissionless: false,
				version: 3,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId: "creator-trusted-settlement-v1",
				quorum: 1,
				signers,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			objectId: selectedObjectId,
			signGenesisAnchorDigest: (value) => Promise.resolve(ed25519.sign(value, authorSeed)),
		});
	};
	const sourceInvite = await invite(false);
	const targetInvite = await invite(true);
	const finality = withClose ? await createRecoverableFinalitySigner({ seed: authorSeed }) : undefined;
	const input = (target: boolean): CreateV3RoomSessionInput => ({
		application,
		author,
		creatorInvite: target ? targetInvite : sourceInvite,
		databaseName: `${name}-${target ? "target" : "source"}`,
		initialLogicalTime: 3,
		issuanceDatabaseName: name,
		objectId,
		openTransport: () => ({
			networkNode: fakeNetwork(`${name}-${target ? "target" : "source"}`),
			close: () => undefined,
			openEphemeral: () => {
				throw new Error("not used");
			},
			requestRetainedHistory: () => undefined,
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
		onAcceptedVertex: () => undefined,
		onProjection: () => undefined,
		publicKeyBytes: publicKey,
		roomHeadAuthority: roomHeadAuthority(),
		...(target && finality !== undefined ? { creatorFinalitySigner: finality.signer } : {}),
		signRegisteredVertexDigest: (value) => Promise.resolve(ed25519.sign(value, authorSeed)),
		...(target ? { rebaseSourceInvite: sourceInvite } : {}),
	});
	const source = await createV3RoomSession(input(false));
	sessions.push(source);
	await Promise.all(
		Array.from({ length: count }, (_, index) =>
			source.issue({ action: "message", clientOperationId: `message-${index}`, text: "original" })
		)
	);
	await source.close();
	sessions.splice(sessions.indexOf(source), 1);
	observation.commits = [];
	observation.activate = [];
	observation.events = [];
	observation.bound = [];
	const target = await createV3RoomSession(input(true));
	sessions.push(target);
	const rehearsalNonce = new Uint8Array(32).fill(19);
	const migrationIdentity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce, sourceObjectId: objectId })
	);
	const targetCreatorInvite = await invite(
		true,
		`creator:${Buffer.from(migrationIdentity.subarray(0, 16)).toString("hex")}`
	);
	return { name, objectId, target, rehearsal: { rehearsalNonce, targetCreatorInvite } };
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
	observation.activate = [];
	observation.commits = [];
	observation.events = [];
	observation.fault = "none";
	observation.fired = false;
	observation.stores.clear();
	observation.bound = [];
	observation.failRebind = false;
	observation.faultGate = undefined;
	observation.onFault = undefined;
	observation.closeFault = false;
});
afterEach(async () => {
	try {
		for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
	} finally {
		if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
		else Object.defineProperty(navigator, "storage", originalStorage);
	}
});

describe("D.110c-0c1f5b0u genuine room Node settlement composition", () => {
	it.each([2, 16])("transforms %i actual source intents and persists exact real Node batch times", async (count) => {
		const { name, objectId, target } = await openRebasePair(count, count === 2 ? 33_000 : 22_000);
		await expect(
			target.issue({ action: "message", clientOperationId: "after", text: "continued" }),
			"D110C_0C1F5B0U_REAL_ROOM_SPLIT_DID_NOT_COMPLETE"
		).resolves.toBeUndefined();
		const store = observation.stores.get(name);
		expect(store).toBeDefined();
		const plan = await required(store).readSettlementPlan({ author, objectId });
		const entry = plan?.entries.find((row) => Object.hasOwn(row, "replacementProgress"));
		expect(entry, "D110C_0C1F5B0U_REAL_ROOM_NEVER_CREATED_PROGRESS").toBeDefined();
		const progress = Reflect.get(entry as object, "replacementProgress") as {
			chunks: { lastLogicalTime: number; replacementSequence: number; throughIntent: number }[];
			intentCount: number;
		};
		expect(progress.intentCount).toBe(count);
		expect(progress.chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of progress.chunks) {
			const row = await required(store).readIssued({ author, objectId }, chunk.replacementSequence);
			const preimage = decodeCanonical(required(row).envelope.canonicalPreimageBytes) as {
				logicalTime: number;
				operation: { action: string; batch?: { entries: { logicalTime: number }[] } };
			};
			const actual =
				preimage.operation.action === "applicationBatch"
					? required(required(preimage.operation.batch).entries.at(-1)).logicalTime
					: preimage.logicalTime;
			expect(chunk.lastLogicalTime).toBe(actual);
		}
		const projection = target.projection() as unknown as { accepted: { clientOperationId: string }[] };
		expect(projection.accepted.map((row) => row.clientOperationId).sort()).toEqual(
			["after", ...Array.from({ length: count }, (_, index) => `message-${index}`)].sort()
		);
	});
	it.each(["before-commit", "partial-unknown", "final-unknown"] as const)(
		"recovers one genuinely signed %s failure onto a fresh active owner",
		async (fault) => {
			observation.fault = fault;
			const { target } = await openRebasePair(2, 33_000);
			const attempted = await Promise.allSettled([
				target.issue({ action: "message", clientOperationId: "after", text: "continued" }),
			]);
			expect.soft(observation.fired, "D110C_0C1F5B0U_SIGNED_FAULT_NOT_REACHED").toBe(true);
			expect.soft(attempted[0]?.status, "D110C_0C1F5B0U_HALTED_HANDLE_NOT_RECOVERED").toBe("fulfilled");
			expect.soft(observation.activate.length, "D110C_0C1F5B0U_FRESH_ACTIVATION_MISSING").toBe(2);
			expect
				.soft(observation.activate[0]?.currentEphemeralAuthority(), "D110C_0C1F5B0U_OLD_OWNER_STILL_ACTIVE")
				.toBeUndefined();
			if (attempted[0]?.status === "fulfilled") {
				const projection = target.projection() as unknown as { accepted: { clientOperationId: string }[] };
				expect(projection.accepted.map((row) => row.clientOperationId).sort()).toEqual([
					"after",
					"message-0",
					"message-1",
				]);
			}
		}
	);
	it("queues migration rehearsal behind startup recovery without a nested lifetime-tail deadlock", async () => {
		observation.fault = "partial-unknown";
		let release!: () => void;
		observation.faultGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			observation.onFault = resolve;
		});
		const { target, rehearsal } = await openRebasePair(2, 33_000);
		const issued = target.issue({ action: "message", clientOperationId: "after", text: "continued" });
		await Promise.race([
			reached,
			issued.then(() => {
				throw new Error("D110C_0C1F5B0U_MIGRATION_FAULT_NOT_REACHED");
			}),
		]);
		const migration = target.rehearseMigration(rehearsal);
		const activation = migration.then((receipt) =>
			target.activateMigration({
				targetCreatorInvite: rehearsal.targetCreatorInvite,
				exactCanonicalRecordBytes: receipt.exactCanonicalRecordBytes,
				recordVertexDigest: receipt.recordVertexDigest,
			})
		);
		const observedActivation = activation.then(
			() => "fulfilled",
			() => "rejected"
		);
		release();
		const results = await Promise.allSettled([issued, migration]);
		expect.soft(results[0]?.status, "D110C_0C1F5B0U_QUEUED_ISSUE_NOT_RECOVERED").toBe("fulfilled");
		expect.soft(results[1]?.status, "D110C_0C1F5B0U_MIGRATION_DID_NOT_RESUME").toBe("fulfilled");
		await observedActivation;
		expect(
			observation.activate.filter((plane) => plane.currentEphemeralAuthority() !== undefined).length
		).toBeLessThanOrEqual(1);
	});
	it("keeps a store-close cleanup failure terminal after signed recovery", async () => {
		observation.fault = "partial-unknown";
		const { target } = await openRebasePair(2, 33_000);
		const issue = await Promise.allSettled([
			target.issue({ action: "message", clientOperationId: "after", text: "continued" }),
		]);
		expect.soft(issue[0]?.status, "D110C_0C1F5B0U_RECOVERY_BEFORE_CLEANUP_FAILED").toBe("fulfilled");
		observation.closeFault = true;
		await expect(target.close()).rejects.toThrow();
		await expect(
			target.issue({ action: "message", clientOperationId: "after-close", text: "forbidden" })
		).rejects.toThrow();
		expect(observation.activate.filter((plane) => plane.currentEphemeralAuthority() !== undefined)).toHaveLength(0);
	});
	it.each([false, true])(
		"rebinds creator-close to the fresh real plane or fails terminally (rebind failure %s)",
		async (failRebind) => {
			observation.fault = "partial-unknown";
			observation.failRebind = failRebind;
			const { target } = await openRebasePair(2, 33_000, true);
			const publicIssue = target.issue({ action: "message", clientOperationId: "after", text: "continued" });
			if (failRebind) {
				await expect(publicIssue, "D110C_0C1F5B0U_REBIND_TERMINAL_CODE_MISSING").rejects.toThrow(
					"D110C_B_CLOSE_REBIND_FAILED"
				);
				await expect(target.sealEpoch()).rejects.toThrow("D110C_B_CLOSE_REBIND_FAILED");
			} else {
				await expect(publicIssue, "D110C_0C1F5B0U_BOUND_RECOVERY_NOT_COMPLETED").resolves.toBeUndefined();
				expect(observation.bound).toHaveLength(2);
				expect(observation.bound[1]?.plane).toBe(observation.activate[1]);
				expect(observation.bound[0]?.plane.currentEphemeralAuthority()).toBeUndefined();
				// This prerequisite proves receiver custody, not the parent f5b checkpoint producer.
				await Promise.allSettled([target.sealEpoch(), target.adoptCreatorSuccessor()]);
				expect(observation.bound.at(-1)?.plane).toBe(observation.activate.at(-1));
			}
		}
	);
});
