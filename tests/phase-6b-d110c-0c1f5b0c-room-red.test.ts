/* eslint-disable @typescript-eslint/explicit-function-return-type -- controlled module factories expose exact room/plane probes. */
import { encodeCanonical } from "@ts-drp/canonical";
import type { SettlementPlan } from "@ts-drp/issuance-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { V3RoomCreatorInviteMaterial } from "../examples/v3-room/src/index.js";

const probe = vi.hoisted(() => ({
	acceptedActions: [] as string[],
	completedSources: [] as unknown[],
	events: [] as string[],
	issueInputs: [] as Readonly<Record<string, unknown>>[],
	issueOutcomes: [] as (Readonly<Record<string, unknown>> & { readonly applyEffect?: boolean })[],
	journalInstalled: true,
	nextCapabilityId: 0,
	nextSequence: 20,
	plan: null as Readonly<Record<string, unknown>> | null,
	profileId: "creator-trusted-settlement-v1",
	publicationOutcomes: [] as Readonly<Record<string, unknown>>[],
	rebasePages: [] as unknown[],
	rebaseReads: 0,
	recoveredVertices: [] as Readonly<Record<string, unknown>>[],
	settlementPlanReads: 0,
	settlementPlanWrites: [] as Readonly<Record<string, unknown>>[],
}));

const AUTHOR = "1".repeat(64);
const OBJECT_ID = `creator:${"d".repeat(32)}`;

function detachedPlan(plan: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const scope = Reflect.get(plan, "scope") as Readonly<Record<string, unknown>>;
	const entries = Reflect.get(plan, "entries") as readonly Readonly<Record<string, unknown>>[];
	return Object.freeze({
		entries: Object.freeze(
			entries.map((entry) =>
				Object.freeze({
					disposition: Reflect.get(entry, "disposition"),
					replacementSequence: Reflect.get(entry, "replacementSequence"),
					sourceDigest: new Uint8Array(Reflect.get(entry, "sourceDigest") as Uint8Array),
					sourceSequence: Reflect.get(entry, "sourceSequence"),
				})
			)
		),
		fenceSequence: Reflect.get(plan, "fenceSequence"),
		revision: Reflect.get(plan, "revision"),
		scope: Object.freeze({ author: Reflect.get(scope, "author"), objectId: Reflect.get(scope, "objectId") }),
	});
}

function applyPlanEffect(effect: Readonly<Record<string, unknown>>, sequence: number): void {
	const current = probe.plan;
	if (current === null) throw new TypeError("controlled settlement plan is absent");
	const entries = Reflect.get(current, "entries") as readonly Readonly<Record<string, unknown>>[];
	const kind = Reflect.get(effect, "kind");
	if (kind === "fence") {
		probe.plan = detachedPlan(
			Object.freeze({
				...current,
				fenceSequence: sequence,
				revision: (Reflect.get(current, "revision") as number) + 1,
			})
		);
		return;
	}
	if (kind !== "replacement") throw new TypeError("controlled settlement effect is invalid");
	const sourceSequence = Reflect.get(effect, "sourceSequence");
	const selected = entries.findIndex((entry) => Reflect.get(entry, "sourceSequence") === sourceSequence);
	if (selected < 0) throw new TypeError("controlled settlement entry is absent");
	probe.plan = detachedPlan(
		Object.freeze({
			...current,
			entries: Object.freeze(
				entries.map((entry, index) =>
					index === selected ? Object.freeze({ ...entry, replacementSequence: sequence }) : entry
				)
			),
			revision: (Reflect.get(current, "revision") as number) + 1,
		})
	);
}

vi.mock("@ts-drp/control-plane", async (importOriginal) => ({
	...(await importOriginal()),
	createCurrentAnchorTrustStore: () => ({
		install: () => Promise.resolve({ ok: true, trust: { profileId: probe.profileId } }),
		open: () => Promise.resolve({ ok: true, trust: { profileId: probe.profileId } }),
	}),
}));

vi.mock("@ts-drp/storage", async (importOriginal) => ({
	...(await importOriginal()),
	parseStorageObjectId: (value: string) => ({ ok: true, value }),
}));

vi.mock("@ts-drp/storage-browser", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserAheDurableStore: () => Promise.resolve({ close: () => Promise.resolve() }),
}));

vi.mock("../packages/storage-browser/dist/src/issuance.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableIssuanceStore: () =>
		Promise.resolve({
			close: () => Promise.resolve(),
			compareAndMarkOutboxPublished: () => Promise.resolve(),
			readIssued: () => Promise.resolve(null),
			readLineage: () => Promise.resolve({ exhausted: false, next: probe.nextSequence }),
			readOutboxPage: () => Promise.resolve([]),
			readSettlementPlan: () => {
				probe.settlementPlanReads += 1;
				probe.events.push("plan-read");
				return Promise.resolve(probe.plan === null ? null : detachedPlan(probe.plan));
			},
			transactIssue: () => Promise.reject(new Error("controlled active plane owns issue transactions")),
			transactWriteSettlementPlan: (input: Readonly<Record<string, unknown>>) => {
				const expectedRevision = Reflect.get(input, "expectedRevision");
				const currentRevision = probe.plan === null ? null : Reflect.get(probe.plan, "revision");
				if (expectedRevision !== currentRevision) throw new TypeError("controlled settlement CAS changed");
				const plan = detachedPlan(Reflect.get(input, "plan") as Readonly<Record<string, unknown>>);
				probe.events.push("plan-write");
				probe.settlementPlanWrites.push(Object.freeze({ ...input, plan }));
				probe.plan = plan;
				return Promise.resolve(detachedPlan(plan));
			},
		}),
}));

vi.mock("../packages/storage-browser/dist/src/live-journal.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableLiveJournalStore: () =>
		Promise.resolve({
			appendAccepted: () => Promise.resolve({ ok: true }),
			close: () => Promise.resolve(),
			installGenesis: () => Promise.resolve({ idempotent: true, ok: true }),
			readPage: () => Promise.resolve({ nextSequence: null, ok: true, rows: [] }),
			readiness: () =>
				Promise.resolve({
					ok: true,
					ready: true,
					rowCount: 1,
					scope: { anchorDigest: "b".repeat(64), epoch: 0, objectId: `creator:${"d".repeat(32)}` },
					snapshot: {
						genesisDigest: "1".repeat(64),
						highWatermark: 0,
						kind: "v3-live-journal-snapshot-token-1",
						orderedRowDigest: "2".repeat(64),
						parametersDigest: "3".repeat(64),
						scope: { anchorDigest: "b".repeat(64), epoch: 0, objectId: `creator:${"d".repeat(32)}` },
						snapshotDigest: "4".repeat(64),
					},
				}),
		}),
}));

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => ({
	...(await importOriginal()),
	createAdmissionBoundTransactionalVertexIssuer: () => ({ issue: () => Promise.resolve({}) }),
	prepareBlueprintAdmission: () => ({}),
}));

function acceptedVertex(
	operation: Readonly<Record<string, unknown>>,
	logicalTime: number,
	authorSequence: number,
	digestByte: number
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		anchor: "b".repeat(64),
		author: AUTHOR,
		authorSequence,
		dependencies: Object.freeze(["b".repeat(64)]),
		digest: new Uint8Array(32).fill(digestByte),
		epoch: 0,
		kind: "drp-vertex",
		logicalTime,
		objectId: OBJECT_ID,
		operation,
		protocolMajor: 3,
	});
}

vi.mock("@ts-drp/node/v3-live", async (importOriginal) => ({
	...(await importOriginal()),
	prepareV3LiveGeneration: (input: { pinnedGenesisAnchorDigest: string }) => {
		probe.nextCapabilityId += 1;
		return Promise.resolve({
			capability: Object.freeze({ anchor: input.pinnedGenesisAnchorDigest, id: probe.nextCapabilityId }),
			descriptor: {
				anchorDigest: input.pinnedGenesisAnchorDigest,
				blueprintDigest: "b".repeat(64),
				signerSetDigest: "c".repeat(64),
				trustProfile: "creator-only",
			},
			ok: true,
		});
	},
	recoverV3LiveReplica: () =>
		Promise.resolve({ capability: {}, descriptor: { recoveredVertices: probe.recoveredVertices }, ok: true }),
	activateV3LivePlane: (input: Readonly<Record<string, unknown>>) => {
		const admittedSink = Reflect.get(input, "onAdmittedVertex") as
			| ((delivery: Readonly<Record<string, unknown>>) => void | Promise<void>)
			| undefined;
		return {
			handle: {
				beginTerminalTransition: () => Promise.resolve({ kind: "not-active", ok: false }),
				completeRebaseSource: (source: unknown) => {
					probe.completedSources.push(source);
					probe.events.push(`complete:${String(Reflect.get(source as object, "authorSequence"))}`);
					return Promise.resolve({ kind: "published", ok: true });
				},
				currentEphemeralAuthority: () => undefined,
				deactivate: () => undefined,
				issueLocal: async (issueInput: Readonly<Record<string, unknown>>) => {
					probe.issueInputs.push(issueInput);
					const operations = Reflect.get(issueInput, "operations") as readonly Readonly<Record<string, unknown>>[];
					const first = operations[0] as Readonly<Record<string, unknown>>;
					const operation = Reflect.get(first, "operation") as Readonly<Record<string, unknown>>;
					const action = String(Reflect.get(operation, "action"));
					const sequence = probe.nextSequence;
					probe.nextSequence += 1;
					const planEffect = Reflect.get(issueInput, "planEffect") as Readonly<Record<string, unknown>> | undefined;
					const effectivePlanEffect = action === "$drp.author-fence.v1" ? Object.freeze({ kind: "fence" }) : planEffect;
					probe.events.push(
						action === "$drp.author-fence.v1"
							? `issue:fence:${sequence}`
							: `issue:${String(Reflect.get(planEffect ?? {}, "sourceSequence") ?? "ordinary")}:${action}`
					);
					const selectedOutcome = probe.issueOutcomes.shift();
					if (
						effectivePlanEffect !== undefined &&
						(selectedOutcome?.applyEffect !== false || selectedOutcome === undefined)
					) {
						applyPlanEffect(effectivePlanEffect, sequence);
					}
					if (selectedOutcome !== undefined) {
						const { applyEffect: _applyEffect, ...outcome } = selectedOutcome;
						return Object.freeze(outcome);
					}
					if (action !== "$drp.author-fence.v1" && admittedSink !== undefined) {
						probe.acceptedActions.push(action);
						await admittedSink(
							Object.freeze({
								exactReceivedCanonicalPreimageBytes: new Uint8Array(),
								signature: new Uint8Array(64),
								transportSender: "peer:local",
								vertex: acceptedVertex(operation, Reflect.get(first, "logicalTime") as number, sequence, sequence),
							})
						);
					}
					return Object.freeze({
						authorSequence: sequence,
						digest: sequence.toString(16).padStart(64, "0"),
						kind: "accepted",
						ok: true,
					});
				},
				publishPending: () => {
					probe.events.push("publish");
					return Promise.resolve(probe.publicationOutcomes.shift() ?? { kind: "empty", ok: true });
				},
				readRebaseOutbox: () => {
					probe.rebaseReads += 1;
					return Promise.resolve(probe.rebasePages.shift() ?? { kind: "empty", ok: true });
				},
				republishRetained: () => Promise.resolve({ kind: "empty", ok: true }),
			},
			ok: true,
		};
	},
	routeV3Ingress: () => false,
	routeV3RetainedIngress: () => false,
}));

const roomModule = import("../examples/v3-room/src/index.js");

function invite(anchor: string): V3RoomCreatorInviteMaterial {
	return Object.freeze({
		detachedGenesisSignature: new Uint8Array(64).fill(anchor === "a".repeat(64) ? 1 : 2),
		exactCanonicalGenesisAnchorPreimageBytes: encodeCanonical({
			blueprintDigest: "b".repeat(64),
			objectId: OBJECT_ID,
		}),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [
				{
					author: AUTHOR,
					finalityKey: AUTHOR,
					groups: ["admin", "finality", "writer"],
				},
			],
			objectId: OBJECT_ID,
			permissionless: false,
			version: probe.profileId === "creator-trusted-settlement-v1" ? 3 : 1,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical({
			maxDependencies: 16,
			maxEpochBytes: 8_388_608,
			maxEpochVertices: 8_192,
			maxPendingBytes: 16_777_216,
			maxPendingEntries: 4_096,
			maxSnapshotBytes: 268_435_456,
			snapshotChunkBytes: 131_072,
		}),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: probe.profileId,
			quorum: 1,
			signers: [AUTHOR],
		}),
		exactCanonicalSignerSetBytes: encodeCanonical({ signers: [AUTHOR] }),
		pinnedGenesisAnchorDigest: anchor,
	});
}

function application(
	overrides: Readonly<Record<string, "expire" | "manual-review" | "rebase" | "transform">> = {}
): Readonly<Record<string, unknown>> {
	const actions = Object.freeze(["acl", "expire-me", "message", "review-me", "transform-me"]);
	const displacementPolicies = Object.freeze({
		"acl": "manual-review" as const,
		"expire-me": "expire" as const,
		"message": "rebase" as const,
		"review-me": "manual-review" as const,
		"transform-me": "transform" as const,
		...overrides,
	});
	return Object.freeze({
		batchableOperationActions: actions,
		bootstrapOperation: Object.freeze({ action: "join", peerId: "peer:local" }),
		canonicalBlueprintPackageBytes: encodeCanonical({ manifest: { operations: [] } }),
		catalog: Object.freeze({
			blueprintDigests: Object.freeze(["b".repeat(64)]),
			catalogDigest: "c".repeat(64),
			resolve: () =>
				Object.freeze({ blueprintDigest: "b".repeat(64), canonicalBlueprintPackageBytes: new Uint8Array() }),
		}),
		displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>) => {
			const action = String(Reflect.get(operation, "action"));
			probe.events.push(`policy:${action}`);
			return String(Reflect.get(operation, "clientOperationId") ?? action);
		},
		displacementPolicies,
		projectAcceptedOperations: () =>
			Object.freeze({ acceptedDigests: [], transportPeerAuthors: [], writerAuthors: [] }),
		transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) =>
			Object.freeze({ ...operation, transformed: true }),
	});
}

function roomInput(selectedApplication = application()): Readonly<Record<string, unknown>> {
	return Object.freeze({
		application: selectedApplication,
		author: AUTHOR,
		creatorInvite: invite("b".repeat(64)),
		databaseName: "settlement-target-plane",
		initialLogicalTime: 40,
		issuanceDatabaseName: "settlement-shared-lineage",
		objectId: OBJECT_ID,
		onAcceptedVertex: () => undefined,
		onProjection: () => undefined,
		openTransport: () => ({
			close: () => undefined,
			networkNode: {},
			openEphemeral: () => ({ close: () => undefined }),
			requestRetainedHistory: () => undefined,
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
		publicKeyBytes: Uint8Array.of(1),
		rebaseSourceInvite: invite("a".repeat(64)),
		signRegisteredVertexDigest: () => Promise.resolve(new Uint8Array(64)),
	});
}

function intent(action: string, clientOperationId: string, logicalTime: number): Readonly<Record<string, unknown>> {
	return Object.freeze({
		logicalTime,
		operation: Object.freeze({
			action,
			clientOperationId,
			...(action === "transform-me" ? { transformed: false } : {}),
		}),
		operationCount: 1,
		operationIndex: 0,
	});
}

function displaced(
	authorSequence: number,
	vertexDigest: string,
	intents: readonly Readonly<Record<string, unknown>>[],
	publishState: "pending" | "published" = "pending"
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		kind: "displaced",
		ok: true,
		source: Object.freeze({
			author: AUTHOR,
			authorSequence,
			intents: Object.freeze(intents),
			publishState,
			vertexDigest,
		}),
	});
}

function entry(
	sourceSequence: number,
	disposition: "expire" | "manual-review" | "rebase" | "transform",
	replacementSequence: number | null = null,
	digestByte = sourceSequence
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		disposition,
		replacementSequence,
		sourceDigest: new Uint8Array(32).fill(digestByte),
		sourceSequence,
	});
}

function plan(
	entries: readonly Readonly<Record<string, unknown>>[],
	fenceSequence: number | null = null,
	revision = 0
): SettlementPlan {
	return detachedPlan(
		Object.freeze({
			entries: Object.freeze(entries),
			fenceSequence,
			revision,
			scope: Object.freeze({ author: AUTHOR, objectId: OBJECT_ID }),
		})
	) as unknown as SettlementPlan;
}

function selectedActions(): readonly string[] {
	return probe.issueInputs.flatMap((input) => {
		const operations = Reflect.get(input, "operations");
		return Array.isArray(operations)
			? operations.map((selected) => String(Reflect.get(Reflect.get(selected, "operation") as object, "action")))
			: [];
	});
}

async function openRoom(): Promise<{
	close(): Promise<void>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
}> {
	const create = Reflect.get(await roomModule, "createV3RoomSession") as (input: unknown) => Promise<{
		close(): Promise<void>;
		issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	}>;
	return create(roomInput());
}

async function settleRoomWork(): Promise<void> {
	for (let turn = 0; turn < 64; turn += 1) await Promise.resolve();
}

beforeEach(() => {
	probe.acceptedActions = [];
	probe.completedSources = [];
	probe.events = [];
	probe.issueInputs = [];
	probe.issueOutcomes = [];
	probe.journalInstalled = true;
	probe.nextCapabilityId = 0;
	probe.nextSequence = 20;
	probe.plan = null;
	probe.profileId = "creator-trusted-settlement-v1";
	probe.publicationOutcomes = [];
	probe.rebasePages = [];
	probe.rebaseReads = 0;
	probe.recoveredVertices = [];
	probe.settlementPlanReads = 0;
	probe.settlementPlanWrites = [];
});

describe("D.110c-0c1f5b0c room settlement orchestration RED", () => {
	it("[RED] durably builds the plan before a fence, then links rebase/transform replacements while expire issues nothing", async () => {
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("message", "rebase-7", 7)]),
			displaced(8, "08".repeat(32), [intent("expire-me", "expire-8", 9)]),
			displaced(9, "09".repeat(32), [intent("transform-me", "transform-9", 11)]),
			{ kind: "empty", ok: true },
		];
		const session = await openRoom();
		await session.issue(Object.freeze({ action: "message", clientOperationId: "after-settlement" }));
		const actions = selectedActions();
		expect(actions).toEqual(["$drp.author-fence.v1", "message", "transform-me", "message"]);
		expect(Reflect.get(probe.issueInputs[1] ?? {}, "planEffect")).toEqual({
			kind: "replacement",
			sourceSequence: 7,
		});
		expect(Reflect.get(probe.issueInputs[2] ?? {}, "planEffect")).toEqual({
			kind: "replacement",
			sourceSequence: 9,
		});
		expect(probe.events.indexOf("plan-write")).toBeLessThan(probe.events.indexOf("issue:fence:20"));
		expect(probe.events.indexOf("issue:fence:20")).toBeLessThan(probe.events.indexOf("issue:7:message"));
		expect(probe.completedSources).toEqual([]);
		expect(probe.plan).toMatchObject({
			entries: [
				{ disposition: "rebase", replacementSequence: 21, sourceSequence: 7 },
				{ disposition: "expire", replacementSequence: null, sourceSequence: 8 },
				{ disposition: "transform", replacementSequence: 22, sourceSequence: 9 },
			],
			fenceSequence: 20,
		});
		await session.close();
	});

	it("[RED] keeps manual-review durable and holds public issue before any fence or replacement", async () => {
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("review-me", "review-7", 7)]),
			{ kind: "empty", ok: true },
		];
		const session = await openRoom();
		let settled = false;
		void session.issue(Object.freeze({ action: "message", clientOperationId: "must-wait" })).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		await settleRoomWork();
		expect(probe.plan).toMatchObject({
			entries: [{ disposition: "manual-review", replacementSequence: null, sourceSequence: 7 }],
			fenceSequence: null,
		});
		expect(selectedActions()).toEqual([]);
		expect(probe.completedSources).toEqual([]);
		expect(settled).toBe(false);
		await session.close();
	});

	it("[RED] preserves linked entries across same-epoch reopen and plans a displaced linked replacement as a new source", async () => {
		probe.plan = plan([entry(7, "rebase", 11)], 10, 2) as unknown as Readonly<Record<string, unknown>>;
		probe.nextSequence = 12;
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("message", "original-7", 7)]),
			displaced(11, "0b".repeat(32), [intent("message", "replacement-11", 11)]),
			{ kind: "empty", ok: true },
		];
		const session = await openRoom();
		await session.issue(Object.freeze({ action: "message", clientOperationId: "after-reopen" }));
		const replacementEffects = probe.issueInputs.flatMap((input) => {
			const effect = Reflect.get(input, "planEffect");
			return effect !== null && typeof effect === "object" && Reflect.get(effect, "kind") === "replacement"
				? [effect]
				: [];
		});
		expect(replacementEffects).toEqual([{ kind: "replacement", sourceSequence: 11 }]);
		expect(probe.plan).toMatchObject({
			entries: [
				{ replacementSequence: 11, sourceSequence: 7 },
				{ replacementSequence: 12, sourceSequence: 11 },
			],
			fenceSequence: 10,
		});
		expect(probe.completedSources).toEqual([]);
		await session.close();
	});

	it("[RED] clears a displaced fence and drops terminal plan rows before issuing one larger fence", async () => {
		probe.plan = plan([entry(5, "rebase"), entry(7, "rebase")], 10, 4) as unknown as Readonly<Record<string, unknown>>;
		probe.nextSequence = 20;
		probe.rebasePages = [
			displaced(10, "0a".repeat(32), []),
			displaced(7, "07".repeat(32), [intent("message", "live-7", 7)]),
			{ kind: "empty", ok: true },
		];
		const session = await openRoom();
		await session.issue(Object.freeze({ action: "message", clientOperationId: "after-new-fence" }));
		expect(selectedActions().filter((action) => action === "$drp.author-fence.v1")).toHaveLength(1);
		expect(probe.events).toContain("issue:fence:20");
		expect(probe.plan).toMatchObject({
			entries: [{ sourceSequence: 7 }],
			fenceSequence: 20,
		});
		expect(probe.completedSources).toEqual([]);
		await session.close();
	});

	it("[RED] rebases a published displaced source without requiring in-memory target-map presence", async () => {
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("message", "published-7", 7)], "published"),
			{ kind: "empty", ok: true },
		];
		const session = await openRoom();
		await session.issue(Object.freeze({ action: "message", clientOperationId: "after-published" }));
		expect(selectedActions()).toEqual(["$drp.author-fence.v1", "message", "message"]);
		expect(probe.plan).toMatchObject({ entries: [{ replacementSequence: 21, sourceSequence: 7 }] });
		expect(probe.completedSources).toEqual([]);
		await session.close();
	});

	it("[RED] surfaces an ACL source into a durable manual-review entry before any fence", async () => {
		probe.rebasePages = [displaced(7, "07".repeat(32), [intent("acl", "acl-7", 7)]), { kind: "empty", ok: true }];
		const session = await openRoom();
		await settleRoomWork();
		expect(probe.events.indexOf("policy:acl")).toBeLessThan(probe.events.indexOf("plan-write"));
		expect(probe.plan).toMatchObject({
			entries: [{ disposition: "manual-review", replacementSequence: null, sourceSequence: 7 }],
			fenceSequence: null,
		});
		expect(selectedActions()).toEqual([]);
		expect(probe.completedSources).toEqual([]);
		await session.close();
	});

	it("[RED] covers reserved empty-intent rows with a settlement fence and never calls the legacy completion owner", async () => {
		probe.rebasePages = [displaced(7, "07".repeat(32), []), { kind: "empty", ok: true }];
		const session = await openRoom();
		await session.issue(Object.freeze({ action: "message", clientOperationId: "after-control" }));
		expect(selectedActions()).toEqual(["$drp.author-fence.v1", "message"]);
		expect(probe.acceptedActions).toEqual(["message"]);
		expect(probe.plan).toMatchObject({ entries: [], fenceSequence: 20 });
		expect(probe.completedSources).toEqual([]);
		await session.close();
	});

	it("[RED] reads back an ambiguous atomic replacement link and never reissues it after reopen", async () => {
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("message", "ambiguous-7", 7)]),
			{ kind: "empty", ok: true },
		];
		probe.issueOutcomes = [
			Object.freeze({ authorSequence: 20, digest: "14".repeat(32), kind: "accepted", ok: true }),
			Object.freeze({ applyEffect: true, detail: "controlled unknown", kind: "issuance-rejected", ok: false }),
		];
		const first = await openRoom();
		await settleRoomWork();
		expect(probe.plan).toMatchObject({ entries: [{ replacementSequence: 21, sourceSequence: 7 }], fenceSequence: 20 });
		expect(probe.issueInputs).toHaveLength(2);
		await first.close();

		probe.issueInputs = [];
		probe.events = [];
		probe.issueOutcomes = [];
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("message", "ambiguous-7", 7)]),
			{ kind: "empty", ok: true },
		];
		const reopened = await openRoom();
		await reopened.issue(Object.freeze({ action: "message", clientOperationId: "after-unknown-reopen" }));
		expect(
			probe.issueInputs.filter((input) => {
				const effect = Reflect.get(input, "planEffect");
				return effect !== null && typeof effect === "object" && Object.is(Reflect.get(effect, "sourceSequence"), 7);
			})
		).toEqual([]);
		await reopened.close();
	});

	it("keeps creator-trusted-v1 on the retained completion path with no settlement plan or fence", async () => {
		probe.profileId = "creator-trusted-v1";
		probe.rebasePages = [
			displaced(7, "07".repeat(32), [intent("message", "legacy-7", 7)]),
			{ kind: "empty", ok: true },
		];
		const session = await openRoom();
		await session.issue(Object.freeze({ action: "message", clientOperationId: "legacy-after" }));
		expect(selectedActions()).toEqual(["message", "message"]);
		expect(probe.issueInputs.every((input) => Reflect.get(input, "planEffect") === undefined)).toBe(true);
		expect(probe.plan).toBeNull();
		expect(probe.settlementPlanReads).toBe(0);
		expect(probe.completedSources).toEqual([{ authorSequence: 7, digest: "07".repeat(32) }]);
		await session.close();
	});
});
