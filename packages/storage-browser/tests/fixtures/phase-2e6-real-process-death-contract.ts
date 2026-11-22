import {
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";

import { phase2e6Edges, PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./phase-2e5-browser-request-inventory.js";

export interface Phase2e6ProcessIdentity {
	readonly birthToken: string;
	readonly command: string;
	readonly pgid: number;
	readonly pid: number;
	readonly ppid: number;
	readonly state: string;
}

export type Phase2e6DeclaredEdge = ReturnType<typeof phase2e6Edges>[number];

export interface Phase2e6TraceEvent {
	readonly id: string;
	readonly kind: "request-created" | "request-success" | "transaction-complete";
}

export interface Phase2e6PersistentImage {
	readonly blobs: readonly unknown[];
	readonly generations: readonly unknown[];
	readonly objects: readonly unknown[];
	readonly promotions: readonly unknown[];
}

export interface Phase2e6CaseEvidence {
	readonly armReachCount: number;
	readonly browserRoot: Phase2e6ProcessIdentity;
	readonly browserExecutable: string;
	readonly child: Phase2e6ProcessIdentity;
	readonly childExit: Readonly<{ code: number | null; signal: string | null }>;
	readonly controllerPgid: number;
	readonly databaseName: string;
	readonly databaseCreateCountAfterSeed: number;
	readonly databaseDeleteCount: number;
	readonly databaseIdentityPreserved: boolean;
	readonly edgeId: string;
	readonly expectedState: "new" | "old";
	readonly frozenForest: readonly Phase2e6ProcessIdentity[];
	readonly initialForest: readonly Phase2e6ProcessIdentity[];
	readonly killedGroups: readonly [
		Readonly<{ absent: true; killAccepted: true; pgid: number; role: "browser"; rootPid: number }>,
		Readonly<{ absent: true; killAccepted: true; pgid: number; role: "child"; rootPid: number }>,
	];
	readonly operationTransactionCount: number;
	readonly profilePath: string;
	readonly recordedProcessDeaths: readonly Readonly<{
		readonly birthToken: string;
		readonly currentBirthToken: string | null;
		readonly outcome: "absent" | "reused";
		readonly pid: number;
	}>[];
	readonly reachedRequestedArm: boolean;
	readonly recoveredDatabaseName: string;
	readonly recoveredImage: Phase2e6PersistentImage;
	readonly recoveryResult: "OK";
	readonly scenarioOperation: string;
	readonly sentinelRetained: boolean;
	readonly tracePrefix: readonly Phase2e6TraceEvent[];
	readonly unsupported: boolean;
	readonly workerCrossOriginIsolated: boolean;
	readonly workerRealm: boolean;
	readonly writeRequestCount: number;
	readonly head:
		| Readonly<{ kind: "unchanged"; old: string | null; recovered: string | null }>
		| Readonly<{ kind: "swap"; new: string; old: string | null; recovered: string | null; monotone: boolean }>;
}

export interface Phase2e6CampaignEvidence {
	readonly cases: readonly Phase2e6CaseEvidence[];
	readonly competingRecovery: Readonly<{
		future: "MONOTONE";
		rollback: "MONOTONE";
		same: "MONOTONE";
	}>;
	readonly staleExpectedRevision: "HEAD_CONFLICT";
}

export const PHASE_2E6_DECLARED_EDGES: readonly Phase2e6DeclaredEdge[] = Object.freeze(
	phase2e6Edges(PHASE_2E5_BROWSER_REQUEST_INVENTORY)
);

const ORACLE_OBJECT = must(parseStorageObjectId(`phase-2e6-object:${"a".repeat(32)}`));
const ORACLE_SENTINEL_OBJECT = must(parseStorageObjectId(`phase-2e6-sentinel:${"f".repeat(32)}`));
const ORACLE_GENERATION_A = must(parseGenerationId("a".repeat(64)));
const ORACLE_GENERATION_B = must(parseGenerationId("b".repeat(64)));
const ORACLE_SENTINEL_GENERATION = must(parseGenerationId("f".repeat(64)));
const ORACLE_REVISION_ONE = must(parseHeadRevision(1));
const ORACLE_PAYLOAD_A = Uint8Array.of(1, 2, 3, 4);
const ORACLE_PAYLOAD_B = Uint8Array.of(9, 8, 7);
const ORACLE_DIGEST_A = must(digestBlob(ORACLE_PAYLOAD_A));

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid Phase 2e6 independent oracle fixture");
	return result.value;
}

function noHead(objectId: StorageObjectId): ExpectedHead {
	return { kind: "none", objectId };
}

function generation(
	objectId: StorageObjectId,
	generationId: GenerationId,
	payload: Uint8Array,
	state: GenerationRecord["state"],
	baseExpectedHead: ExpectedHead = noHead(objectId)
): GenerationRecord {
	const reference = { byteLength: payload.byteLength, digest: must(digestBlob(payload)) };
	return {
		baseExpectedHead,
		closure: [reference],
		closureDigest: must(digestClosure([reference])),
		generationId,
		objectId,
		state,
	};
}

function generationRow(record: GenerationRecord): unknown {
	return Object.freeze({
		generationId: record.generationId,
		objectId: record.objectId,
		record: Object.freeze([...encodeGenerationRecordV1(record)]),
	});
}

function image(input: {
	readonly blob?: boolean;
	readonly generationB?: GenerationRecord;
	readonly head?: Exclude<ExpectedHead, { readonly kind: "none" }>;
	readonly promotion?: boolean;
	readonly targetGeneration?: GenerationRecord;
}): Phase2e6PersistentImage {
	const sentinel = generation(ORACLE_SENTINEL_OBJECT, ORACLE_SENTINEL_GENERATION, ORACLE_PAYLOAD_B, "Staged");
	return Object.freeze({
		blobs: Object.freeze(
			input.blob ? [Object.freeze({ bytes: Object.freeze([...ORACLE_PAYLOAD_A]), digest: ORACLE_DIGEST_A })] : []
		),
		generations: Object.freeze(
			[sentinel, input.targetGeneration, input.generationB]
				.filter((value): value is GenerationRecord => value !== undefined)
				.sort((left, right) =>
					left.objectId === right.objectId
						? left.generationId.localeCompare(right.generationId)
						: left.objectId.localeCompare(right.objectId)
				)
				.map(generationRow)
		),
		objects: Object.freeze(
			input.head === undefined
				? []
				: [Object.freeze({ objectId: ORACLE_OBJECT, record: Object.freeze([...encodeHeadRecordV1(input.head)]) })]
		),
		promotions: Object.freeze(
			input.promotion
				? [
						Object.freeze({
							digest: ORACLE_DIGEST_A,
							generationId: ORACLE_GENERATION_A,
							objectId: ORACLE_OBJECT,
						}),
					]
				: []
		),
	});
}

const STAGED_A = generation(ORACLE_OBJECT, ORACLE_GENERATION_A, ORACLE_PAYLOAD_A, "Staged");
const COMPLETE_A = generation(ORACLE_OBJECT, ORACLE_GENERATION_A, ORACLE_PAYLOAD_A, "Complete");
const HEAD_A = Object.freeze({
	closureDigest: COMPLETE_A.closureDigest,
	generationId: ORACLE_GENERATION_A,
	kind: "present" as const,
	objectId: ORACLE_OBJECT,
	revision: ORACLE_REVISION_ONE,
});
const ADOPTED_A = generation(ORACLE_OBJECT, ORACLE_GENERATION_A, ORACLE_PAYLOAD_A, "Adopted");

const PHASE_2E6_ORACLE_IMAGES = Object.freeze({
	"begin-generation-empty": Object.freeze({
		old: image({}),
		new: image({ targetGeneration: STAGED_A }),
	}),
	"begin-generation-certificate-match": Object.freeze({
		old: image({ blob: true, head: HEAD_A, promotion: true, targetGeneration: ADOPTED_A }),
		new: image({
			blob: true,
			generationB: generation(ORACLE_OBJECT, ORACLE_GENERATION_B, ORACLE_PAYLOAD_B, "Staged", HEAD_A),
			head: HEAD_A,
			promotion: true,
			targetGeneration: ADOPTED_A,
		}),
	}),
	"put-cached-blob-staged": Object.freeze({
		old: image({ targetGeneration: STAGED_A }),
		new: image({ blob: true, targetGeneration: STAGED_A }),
	}),
	"promote-reference-staged": Object.freeze({
		old: image({ blob: true, targetGeneration: STAGED_A }),
		new: image({ blob: true, promotion: true, targetGeneration: STAGED_A }),
	}),
	"complete-generation-empty-recovery": Object.freeze({
		old: image({ blob: true, promotion: true, targetGeneration: STAGED_A }),
		new: image({ blob: true, promotion: true, targetGeneration: COMPLETE_A }),
	}),
	"swap-head-certificate-match": Object.freeze({
		old: image({ blob: true, promotion: true, targetGeneration: COMPLETE_A }),
		new: image({ blob: true, head: HEAD_A, promotion: true, targetGeneration: ADOPTED_A }),
	}),
	"swap-head-fresh-recovery": Object.freeze({
		old: image({ blob: true, promotion: true, targetGeneration: COMPLETE_A }),
		new: image({ blob: true, head: HEAD_A, promotion: true, targetGeneration: ADOPTED_A }),
	}),
	"discard-generation-staged": Object.freeze({
		old: image({ targetGeneration: STAGED_A }),
		new: image({
			targetGeneration: generation(ORACLE_OBJECT, ORACLE_GENERATION_A, ORACLE_PAYLOAD_A, "Discarded"),
		}),
	}),
} satisfies Readonly<Record<string, Readonly<{ old: Phase2e6PersistentImage; new: Phase2e6PersistentImage }>>>);

/**
 * Returns checked-in semantic old/new images built without reading adapter
 * output. Unknown scenarios fail closed.
 * @param scenarioId - One selected Phase 2e5 scenario.
 * @returns Independently encoded old and complete-new persistent images.
 */
export function phase2e6OracleImages(scenarioId: string): Readonly<{
	old: Phase2e6PersistentImage;
	new: Phase2e6PersistentImage;
}> {
	const oracle = Reflect.get(PHASE_2E6_ORACLE_IMAGES, scenarioId) as
		| Readonly<{ old: Phase2e6PersistentImage; new: Phase2e6PersistentImage }>
		| undefined;
	if (oracle === undefined) throw new TypeError(`missing Phase 2e6 image oracle: ${scenarioId}`);
	return oracle;
}

function requestBase(scenarioId: string, index: number, request: Readonly<{ kind: string; store: string }>): string {
	return `${scenarioId}/request-${String(index).padStart(2, "0")}-${request.kind}-${request.store}`;
}

/**
 * Derives the exact occurrence-sensitive creation/settlement prefix that must
 * be observed before an armed Worker is frozen. No Phase 2e6 edge owns a
 * second request inventory.
 * @param edge - One data-derived durability edge.
 * @returns Exact trace prefix through the requested successful settlement.
 */
export function phase2e6ExpectedTracePrefix(edge: Phase2e6DeclaredEdge): readonly Phase2e6TraceEvent[] {
	const row = PHASE_2E5_BROWSER_REQUEST_INVENTORY.find(({ id }) => id === edge.scenarioId);
	if (row === undefined || row.transaction === null)
		throw new TypeError(`unknown Phase 2e6 scenario: ${edge.scenarioId}`);
	const targetIndex =
		edge.target === "transaction-terminal"
			? row.requests.length - 1
			: row.requests.findIndex((request, index) => edge.id.startsWith(requestBase(row.id, index, request)));
	if (targetIndex < 0) throw new TypeError(`edge does not name a declared request occurrence: ${edge.id}`);
	const prefix: Phase2e6TraceEvent[] = row.requests.slice(0, targetIndex + 1).flatMap((request, index) => {
		const base = requestBase(row.id, index, request);
		return [
			Object.freeze({ id: `${base}/created`, kind: "request-created" as const }),
			Object.freeze({ id: `${base}/success`, kind: "request-success" as const }),
		];
	});
	if (edge.target === "transaction-terminal") {
		prefix.push(
			Object.freeze({
				id: `${row.id}/transaction-terminal-complete/success`,
				kind: "transaction-complete" as const,
			})
		);
	}
	return Object.freeze(prefix);
}
