/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real module signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal generics describe the corresponding transparent observed module. */
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, SettlementPlan } from "@ts-drp/issuance-store";
import type { V3PlaneHandle } from "@ts-drp/node/v3-live";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { microtaskTurns, observeResult } from "./fixtures/phase-6b-d110c-0c1f5b0w/manual-review-probe.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";

const observation = vi.hoisted(() => ({
	activate: [] as V3PlaneHandle[],
	commits: [] as DurableIssueCommit[],
	events: [] as string[],
	fault: "none" as "none" | "before-commit" | "partial-unknown" | "final-unknown" | "legacy-unknown",
	fired: false,
	stores: new Map<string, DurableIssuanceStore>(),
	bound: [] as { plane: V3PlaneHandle; handle: { status(): unknown } }[],
	failRebind: false,
	faultGate: undefined as undefined | Promise<void>,
	onFault: undefined as undefined | (() => void),
	closeFault: false,
	onAdmissionError: undefined as undefined | ((error: unknown) => void),
	onPlan: undefined as undefined | ((plan: SettlementPlan, write: boolean) => void),
	planWrites: [] as SettlementPlan[],
	captureClose: false,
	closeCalls: 0,
	accepted: 0,
	publications: 0,
	migrations: 0,
	issueTransactions: 0,
}));

// Every operation and capability below is real. Only the receipt following one
// selected signed store transaction is lost, using the accepted f5b0b seam.
vi.mock("../packages/storage-browser/dist/src/issuance.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ts-drp/storage-browser/issuance")>();
	return {
		...actual,
		createBrowserDurableIssuanceStore: async (input: { primaryDatabaseName: string }) => {
			const real = await actual.createBrowserDurableIssuanceStore(input);
			const wrapped: DurableIssuanceStore = {
				...real,
				readSettlementPlan: async (scope) => {
					const plan = await real.readSettlementPlan(scope);
					if (plan !== null) observation.onPlan?.(plan, false);
					return plan;
				},
				transactWriteSettlementPlan: async (input) => {
					const plan = await real.transactWriteSettlementPlan(input);
					observation.planWrites.push(plan);
					observation.onPlan?.(plan, true);
					return plan;
				},
				close: async () => {
					await real.close();
					if (observation.closeFault) throw new Error("D110C_0C1F5B0U_CONTROLLED_STORE_CLOSE_FAILED");
				},
				transactIssue: async (scope, build) => {
					observation.issueTransactions += 1;
					let selected: DurableIssueCommit | undefined;
					let failAfter = false;
					const result = await real.transactIssue(scope, async (sequence) => {
						const candidate = await build(sequence);
						selected = candidate;
						const effect = candidate.planEffect as unknown as Record<string, unknown> | undefined;
						if (
							!observation.fired &&
							effect?.kind === "replacement" &&
							(typeof effect.fromIntent === "number" || observation.fault === "legacy-unknown")
						) {
							const current = await real.readSettlementPlan(scope);
							const entry = current?.entries.find((row) => row.sourceSequence === effect.sourceSequence);
							const progress = Reflect.get(entry as object, "replacementProgress") as Record<string, unknown>;
							const final = progress !== undefined && effect.throughIntent === progress.intentCount;
							if (
								observation.fault === "before-commit" ||
								observation.fault === "legacy-unknown" ||
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
		// Only the f5b0w seal probe observes this boundary. The real close closure
		// retains its registered owner; no adoption/resolver is called with this view.
		if (result.ok && observation.captureClose) {
			const real = result.handle;
			return {
				...result,
				handle: {
					...real,
					close: () => {
						observation.closeCalls += 1;
						return real.close();
					},
				},
			};
		}
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
			const captureError = observation.onAdmissionError;
			const input = args[0];
			const result = actual.activateV3LivePlane(
				captureError === undefined
					? input
					: {
							...input,
							onAdmittedVertex: async (delivery) => {
								try {
									return await input.onAdmittedVertex(delivery);
								} catch (error) {
									captureError(error);
									throw error;
								}
							},
						}
			);
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

function roomHeadAuthority(scoped = false): CreateV3RoomSessionInput["roomHeadAuthority"] {
	if (scoped) {
		const owners = new Map<string, CreateV3RoomSessionInput["roomHeadAuthority"]>();
		const owner = (scope: { readonly objectId: string }) => {
			let selected = owners.get(scope.objectId);
			if (selected === undefined) {
				selected = roomHeadAuthority();
				owners.set(scope.objectId, selected);
			}
			return selected;
		};
		return {
			initialization: { kind: "create" },
			read: (input) => owner(input.scope).read(input),
			create: (input) => owner(input.scope).create(input),
			migrate: (input) => owner(input.scope).migrate(input),
			begin: (input) => owner(input.scope).begin(input),
			commit: (input) => owner(input.scope).commit(input),
		};
	}
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

async function openRebasePair(
	count: number,
	expandedBytes: number,
	withClose = false,
	migrationRecovery = false,
	options: { hold?: boolean; singleGeneration?: boolean; prepareActivation?: boolean } = {}
) {
	const identity = ++ordinal;
	const objectId = `creator:${identity.toString(16).padStart(32, "0")}`;
	const name = `d110c-f5b0u-runtime-${identity}`;
	const base = createV3ChatApplication("alice");
	const application = Object.freeze({
		...base,
		displacementPolicies: Object.freeze({
			message: options.hold ? ("manual-review" as const) : ("transform" as const),
		}),
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
	const network = (target: boolean) => {
		const real = fakeNetwork(`${name}-${target ? "target" : "source"}`);
		return {
			...real,
			publishMessage: (...args: Parameters<typeof real.publishMessage>) => {
				observation.publications += 1;
				return real.publishMessage(...args);
			},
		};
	};
	const input = (target: boolean): CreateV3RoomSessionInput => ({
		application,
		author,
		creatorInvite: target ? targetInvite : sourceInvite,
		databaseName: `${name}-${target ? "target" : "source"}`,
		initialLogicalTime: 3,
		issuanceDatabaseName: name,
		objectId,
		openTransport: () => ({
			networkNode: network(target),
			close: () => undefined,
			openEphemeral: () => {
				throw new Error("not used");
			},
			requestRetainedHistory: () => undefined,
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
		onAcceptedVertex: () => {
			observation.accepted += 1;
		},
		onMigrationTarget: () => {
			observation.migrations += 1;
		},
		onProjection: () => undefined,
		publicKeyBytes: publicKey,
		roomHeadAuthority: roomHeadAuthority(migrationRecovery),
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
	const rehearsalNonce = new Uint8Array(32).fill(19);
	const migrationIdentity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce, sourceObjectId: objectId })
	);
	const targetCreatorInvite = await invite(
		true,
		`creator:${Buffer.from(migrationIdentity.subarray(0, 16)).toString("hex")}`
	);
	const rehearsal = { rehearsalNonce, targetCreatorInvite };
	if (options.singleGeneration)
		return { name, objectId, target: source, rehearsal, input: input(false), activation: undefined };
	await source.close();
	sessions.splice(sessions.indexOf(source), 1);
	let activation;
	if (options.prepareActivation) {
		// Genuine rehearsal with the exact held target's genesis authority and
		// empty canonical projection, before any hold exists. No plan is injected.
		const { rebaseSourceInvite: _source, ...donorInput } = input(true);
		const donor = await createV3RoomSession({
			...donorInput,
			databaseName: `${name}-rehearsal-source`,
			issuanceDatabaseName: `${name}-rehearsal-issuance`,
		});
		sessions.push(donor);
		const receipt = await donor.rehearseMigration(rehearsal);
		activation = {
			targetCreatorInvite,
			exactCanonicalRecordBytes: receipt.exactCanonicalRecordBytes,
			recordVertexDigest: receipt.recordVertexDigest,
		};
		await donor.close();
		sessions.splice(sessions.indexOf(donor), 1);
	}
	observation.commits = [];
	observation.activate = [];
	observation.events = [];
	observation.bound = [];
	observation.planWrites = [];
	observation.accepted = 0;
	observation.publications = 0;
	observation.issueTransactions = 0;
	const targetInput = input(true);
	const target = await createV3RoomSession(targetInput);
	sessions.push(target);
	return { name, objectId, target, rehearsal, input: targetInput, activation };
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
	observation.onAdmissionError = undefined;
	observation.onPlan = undefined;
	observation.planWrites = [];
	observation.captureClose = false;
	observation.closeCalls = 0;
	observation.accepted = 0;
	observation.publications = 0;
	observation.migrations = 0;
	observation.issueTransactions = 0;
});

const manualReviewMessage = "v3 room settlement plan requires manual review";

function holdEffects() {
	return {
		issueTransactions: observation.issueTransactions,
		commits: observation.commits.length,
		accepted: observation.accepted,
		publications: observation.publications,
		migrations: observation.migrations,
		planWrites: observation.planWrites.length,
	};
}

function observeHold(writeOnly: boolean) {
	return new Promise<{ plan: SettlementPlan; effects: ReturnType<typeof holdEffects> }>((resolve) => {
		observation.onPlan = (plan, write) => {
			if ((!writeOnly || write) && plan.entries.some((entry) => entry.disposition === "manual-review")) {
				// Capture synchronously after the real durable write/read, before its
				// caller resumes. Startup attempts are not post-hold issue attempts.
				resolve({ plan, effects: holdEffects() });
			}
		};
	});
}

async function openHeld(options: { withClose?: boolean; prepareActivation?: boolean } = {}) {
	const durable = observeHold(true);
	const fixture = await openRebasePair(1, 100, options.withClose, true, {
		hold: true,
		prepareActivation: options.prepareActivation,
	});
	const { plan, effects } = await durable;
	expect(plan).toMatchObject({
		scope: { author, objectId: fixture.objectId },
		fenceSequence: null,
		entries: [{ disposition: "manual-review", replacementSequence: null }],
	});
	expect(plan.entries).toHaveLength(1);
	const store = required(observation.stores.get(fixture.name));
	const row = required(await store.readIssued(plan.scope, required(plan.entries[0]).sourceSequence));
	expect(required(plan.entries[0]).sourceDigest).toEqual(row.envelope.digest);
	await microtaskTurns();
	return {
		...fixture,
		plan,
		effects,
		row,
		lineage: await store.readLineage(plan.scope),
		outbox: await store.readOutboxPage({ scope: plan.scope, limit: 128 }),
	};
}

async function holdCustody(fixture: Awaited<ReturnType<typeof openHeld>>) {
	const store = required(observation.stores.get(fixture.name));
	const plan = required(await store.readSettlementPlan(fixture.plan.scope));
	expect(encodeCanonical(plan)).toEqual(encodeCanonical(fixture.plan));
	expect(await store.readIssued(plan.scope, fixture.row.authorSequence)).toEqual(fixture.row);
	expect(await store.readLineage(plan.scope)).toEqual(fixture.lineage);
	expect(await store.readOutboxPage({ scope: plan.scope, limit: 128 })).toEqual(fixture.outbox);
	expect(holdEffects()).toEqual(fixture.effects);
	expect(observation.planWrites).toEqual([fixture.plan]);
	expect(() => fixture.target.projection()).not.toThrow();
	expect(() => fixture.target.status()).not.toThrow();
}

function expectPromptRefusal(result: ReturnType<typeof observeResult>, token: string) {
	expect(result.result().settled, token).toBe(true);
	expect(result.result().error).toBeInstanceOf(TypeError);
	expect((result.result().error as Error).message).toBe(manualReviewMessage);
}

describe("D.110c-0c1f5b0w durable manual-review hold semantics", () => {
	it("refuses held issue promptly after the real durable plan write without an issuance effect", async () => {
		const fixture = await openHeld();
		const result = observeResult(
			fixture.target.issue({ action: "message", clientOperationId: "held", text: "forbidden" })
		);
		await microtaskTurns();
		await holdCustody(fixture);
		expectPromptRefusal(result, "D110C_F5B0W_MANUAL_REVIEW_ISSUE_HANG");
	});
	it("creator-held seal reaches the existing close owner and exact successor-codec terminus", async () => {
		observation.captureClose = true;
		const fixture = await openHeld({ withClose: true });
		expect(observation.bound).toHaveLength(1);
		const sealing = fixture.target.sealEpoch();
		const result = observeResult(sealing);
		await microtaskTurns();
		await holdCustody(fixture);
		expect(observation.closeCalls, "D110C_F5B0W_MANUAL_REVIEW_CLOSE_HANG").toBe(1);
		await sealing.catch(() => undefined);
		expect(result.result().error).toBeInstanceOf(TypeError);
		expect((result.result().error as Error).message).toBe("creator close actor failed: CERTIFIED_VALUE_MISMATCH");
		await holdCustody(fixture);
	});
	it("no-hold creator close retains the exact existing thrown codec terminus", async () => {
		observation.captureClose = true;
		const { target } = await openRebasePair(1, 100, true);
		await target.issue({ action: "message", clientOperationId: "ordinary", text: "continued" });
		const error = await target.sealEpoch().then(
			() => undefined,
			(reason: unknown) => reason
		);
		expect(observation.closeCalls).toBe(1);
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe("creator close actor failed: CERTIFIED_VALUE_MISMATCH");
	});
	it("same-epoch shutdown and reopen preserve exact hold scope revision source disposition and null link", async () => {
		const fixture = await openHeld();
		await holdCustody(fixture);
		const projection = structuredClone(fixture.target.projection());
		const canonicalStateBytes = required(fixture.input.application.migration).canonicalStateBytes;
		const canonicalProjection = canonicalStateBytes(fixture.target.projection());
		await fixture.target.close();
		sessions.splice(sessions.indexOf(fixture.target), 1);
		const reread = observeHold(false);
		const reopened = await createV3RoomSession(fixture.input);
		sessions.push(reopened);
		const reopenedHold = await reread;
		expect(encodeCanonical(reopenedHold.plan)).toEqual(encodeCanonical(fixture.plan));
		// Restart may replay the authenticated accepted notification (f5b0v),
		// not canonical application, issuance, publication or durable plan effects.
		expect({
			...reopenedHold.effects,
			accepted: fixture.effects.accepted,
			issueTransactions: fixture.effects.issueTransactions,
		}).toEqual(fixture.effects);
		expect(reopened.projection()).toEqual(projection);
		expect(canonicalStateBytes(reopened.projection())).toEqual(canonicalProjection);
		await microtaskTurns();
		await holdCustody({ ...fixture, effects: reopenedHold.effects, target: reopened });
		expect(reopened.projection()).toEqual(projection);
		expect(canonicalStateBytes(reopened.projection())).toEqual(canonicalProjection);
		expect(observation.closeCalls).toBe(0);
		await reopened.close();
	});
	it.each(["rehearsal", "activation"] as const)(
		"held source refuses %s without target import or terminal effect",
		async (operation) => {
			const fixture = await openHeld({ prepareActivation: operation === "activation" });
			const storesBefore = [...observation.stores.keys()];
			const result = observeResult(
				operation === "rehearsal"
					? fixture.target.rehearseMigration(fixture.rehearsal)
					: fixture.target.activateMigration(required(fixture.activation))
			);
			await microtaskTurns();
			await holdCustody(fixture);
			expect([...observation.stores.keys()]).toEqual(storesBefore);
			expectPromptRefusal(result, `D110C_F5B0W_MANUAL_REVIEW_${operation.toUpperCase()}_HANG`);
		}
	);
	it("changed retained held policy remains terminal source-diff refusal rather than redisposition", async () => {
		const fixture = await openHeld();
		await holdCustody(fixture);
		const commits = [...observation.commits];
		await fixture.target.close();
		sessions.splice(sessions.indexOf(fixture.target), 1);
		const reopened = await createV3RoomSession({
			...fixture.input,
			application: Object.freeze({
				...fixture.input.application,
				displacementPolicies: Object.freeze({ message: "rebase" as const }),
			}),
		});
		sessions.push(reopened);
		await expect(
			reopened.issue({ action: "message", clientOperationId: "changed", text: "forbidden" })
		).rejects.toThrow(new TypeError("v3 room settlement plan source differs"));
		expect(() => reopened.projection()).toThrow("v3 room settlement plan source differs");
		// Terminal failure closed the session's store. A fresh public capability
		// reads the same database only; it neither mutates nor revives the session.
		const readback = await createBrowserDurableIssuanceStore({ primaryDatabaseName: fixture.name });
		try {
			expect(encodeCanonical(await readback.readSettlementPlan(fixture.plan.scope))).toEqual(
				encodeCanonical(fixture.plan)
			);
		} finally {
			await readback.close();
		}
		expect(observation.commits).toEqual(commits);
		expect({ ...holdEffects(), accepted: fixture.effects.accepted }).toEqual(fixture.effects);
		expect(observation.planWrites).toEqual([fixture.plan]);
	});
	it("single-generation internal redirect pins target hold refusal and orderly source cleanup", async () => {
		const admissionErrors: unknown[] = [];
		observation.onAdmissionError = (error) => admissionErrors.push(error);
		const fixture = await openRebasePair(1, 100, false, true, { singleGeneration: true });
		const receipt = await fixture.target.rehearseMigration(fixture.rehearsal);
		const durable = observeHold(true);
		const activation = fixture.target.activateMigration({
			targetCreatorInvite: fixture.rehearsal.targetCreatorInvite,
			// Only the three existing public fields cross the activation boundary.
			exactCanonicalRecordBytes: receipt.exactCanonicalRecordBytes,
			recordVertexDigest: receipt.recordVertexDigest,
		} as Parameters<V3RoomSession["activateMigration"]>[0]);
		const outcome = activation.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error })
		);
		const first = await Promise.race([durable, outcome]);
		expect(first).toHaveProperty("plan");
		const result = observeResult(activation);
		await microtaskTurns();
		expect(observation.migrations).toBe(0);
		if (!result.result().settled) {
			// The genuine target hold also leaves public source cleanup pending in
			// RED. Own that promise here, not in the unbounded generic cleanup hook.
			// This neither resolves the target hold nor claims successful shutdown.
			const cleanup = observeResult(fixture.target.close());
			await microtaskTurns();
			expect(cleanup.result()).toEqual({ error: undefined, settled: false });
			expect(result.result()).toEqual({ error: undefined, settled: false });
			const index = sessions.indexOf(fixture.target);
			expect(index).toBeGreaterThanOrEqual(0);
			sessions.splice(index, 1);
			console.info("f5b0w redirect RED cleanup observation", {
				durableHold: true,
				publicCloseSettled: false,
				orderlyShutdownClaimed: false,
			});
			throw new Error("D110C_F5B0W_MANUAL_REVIEW_REDIRECT_HANG");
		}
		expectPromptRefusal(result, "D110C_F5B0W_MANUAL_REVIEW_REDIRECT_HANG");
		expect(admissionErrors).toContainEqual(new TypeError(manualReviewMessage));
		expect(observation.migrations).toBe(0);
		expect(() => fixture.target.projection()).toThrow();
		await expect(
			fixture.target.issue({ action: "message", clientOperationId: "after-terminal", text: "forbidden" })
		).rejects.toThrow();
		await fixture.target.close();
		sessions.splice(sessions.indexOf(fixture.target), 1);
	});
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
		observation.fault = "legacy-unknown";
		const admissionErrors: unknown[] = [];
		observation.onAdmissionError = (error) => admissionErrors.push(error);
		let release!: () => void;
		observation.faultGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			observation.onFault = resolve;
		});
		const { target, rehearsal } = await openRebasePair(2, 100, false, true);
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
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({
				status: "rejected" as const,
				message: error instanceof Error ? error.message : String(error),
			})
		);
		release();
		const results = await Promise.allSettled([issued, migration]);
		expect.soft(results[0]?.status, "D110C_0C1F5B0U_QUEUED_ISSUE_NOT_RECOVERED").toBe("fulfilled");
		expect.soft(results[1]?.status, "D110C_0C1F5B0U_MIGRATION_DID_NOT_RESUME").toBe("fulfilled");
		expect.soft(await observedActivation, "D110C_0C1F5B0U_MIGRATION_ACTIVATION_BOUNDARY_DIFFERS").toEqual({
			status: "rejected",
			message: "v3 room migration activation failed: terminal-rejected",
		});
		expect
			.soft(
				admissionErrors.map((error) => (error instanceof Error ? error.message : String(error))),
				"D110C_0C1F5B0U_MIGRATION_FRONTIER_CAUSE_DIFFERS"
			)
			.toEqual(["v3 room rebase outbox failed: record-rejected"]);
		expect(
			observation.activate.filter((plane) => plane.currentEphemeralAuthority() !== undefined).length
		).toBeLessThanOrEqual(1);
		await target.close();
		expect(observation.activate.filter((plane) => plane.currentEphemeralAuthority() !== undefined)).toHaveLength(0);
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
