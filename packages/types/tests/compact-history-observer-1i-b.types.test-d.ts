import type {
	DRPObjectConfig,
	Hash,
	HistoryInventory,
	HistoryReadResult,
	HistoryRehydrationResult,
	HistoryStorage,
	IDRP,
	IDRPObject,
	NodeConnectObjectOptions,
	NodeCreateObjectOptions,
	Vertex,
	VertexPayloadResult,
} from "@ts-drp/types";
import { expectTypeOf } from "vitest";

const compactObjectConfig: DRPObjectConfig = { history_storage: "compact", replica_mode: "observer" };
const compactCreateConfig: NodeCreateObjectOptions<IDRP> = {
	history_storage: "compact",
	replica_mode: "observer",
};
const compactConnectConfig: NodeConnectObjectOptions<IDRP> = {
	history_storage: "compact",
	id: "creator:compact-history",
	replica_mode: "observer",
};

void compactObjectConfig;
void compactCreateConfig;
void compactConnectConfig;

// @ts-expect-error compact history is never a writer configuration.
const writerCompact: DRPObjectConfig = { history_storage: "compact", replica_mode: "writer" };
// @ts-expect-error omitting replica_mode would make compact-history promotion ambiguous.
const ambiguousCompact: NodeCreateObjectOptions<IDRP> = { history_storage: "compact" };
// @ts-expect-error history storage has only full and compact public values.
const unknownHistoryStorage: NodeCreateObjectOptions<IDRP> = { history_storage: "archive", replica_mode: "observer" };

void writerCompact;
void ambiguousCompact;
void unknownHistoryStorage;

expectTypeOf<HistoryStorage>().toEqualTypeOf<"compact" | "full">();
expectTypeOf<HistoryInventory>().toEqualTypeOf<{
	readonly availablePayloadHashes: readonly Hash[];
	readonly knownHashes: readonly Hash[];
}>();
expectTypeOf<VertexPayloadResult>().toEqualTypeOf<
	| { readonly status: "available"; readonly vertex: Vertex }
	| { readonly missingHashes: readonly Hash[]; readonly status: "history-unavailable" }
	| { readonly hash: Hash; readonly status: "unknown" }
>();
expectTypeOf<HistoryReadResult>().toEqualTypeOf<
	| { readonly status: "available"; readonly vertices: readonly Vertex[] }
	| { readonly missingHashes: readonly Hash[]; readonly status: "history-unavailable" }
	| { readonly status: "unknown"; readonly unknownHashes: readonly Hash[] }
>();
expectTypeOf<HistoryRehydrationResult>().toEqualTypeOf<
	| { readonly historyStorage: "full"; readonly status: "complete" }
	| {
			readonly reason: "incomplete" | "interrupted" | "invalid" | "wrong-history";
			readonly status: "rejected";
	  }
>();

type CompactObject = IDRPObject<IDRP>;
expectTypeOf<CompactObject["historyStorage"]>().toEqualTypeOf<HistoryStorage>();
expectTypeOf<CompactObject["historyInventory"]>().toEqualTypeOf<HistoryInventory>();
expectTypeOf<CompactObject["getVertexPayload"]>().toEqualTypeOf<(hash: Hash) => VertexPayloadResult>();
expectTypeOf<CompactObject["readHistory"]>().toEqualTypeOf<(hashes: readonly Hash[]) => HistoryReadResult>();
expectTypeOf<CompactObject["rehydrateHistory"]>().toEqualTypeOf<
	(vertices: readonly Vertex[], options?: { readonly signal?: AbortSignal }) => Promise<HistoryRehydrationResult>
>();
