import { z } from "zod";

const FinalityConfigSchema = z.object({
	enabled: z.boolean().optional(),
	finality_threshold: z.number().optional(),
});

const ReplicaModeSchema = z.enum(["writer", "observer"]);
const HistoryStorageSchema = z.enum(["full", "compact"]);

function compactRequiresObserver(value: {
	history_storage?: "compact" | "full";
	replica_mode?: "observer" | "writer";
}): boolean {
	return value.history_storage !== "compact" || value.replica_mode === "observer";
}

export const NodeCreateObjectOptionsSchema = z
	.object({
		id: z.string().min(1, "A valid object id must be provided").optional(),
		finality_config: FinalityConfigSchema.optional(),
		history_storage: HistoryStorageSchema.optional(),
		replica_mode: ReplicaModeSchema.optional(),
		sync: z
			.object({
				enabled: z.boolean(),
				peerId: z.string().min(1, "A valid peer id must be provided").optional(),
			})
			.optional(),
	})
	.refine(compactRequiresObserver, { message: "Compact history storage requires explicit observer replica mode" });

export const NodeConnectObjectOptionsSchema = z
	.object({
		id: z.string().min(1, "A valid object id must be provided"),
		finality_config: FinalityConfigSchema.optional(),
		history_storage: HistoryStorageSchema.optional(),
		replica_mode: ReplicaModeSchema.optional(),
		sync: z
			.object({
				peerId: z.string().min(1, "A valid peer id must be provided"),
			})
			.optional(),
	})
	.refine(compactRequiresObserver, { message: "Compact history storage requires explicit observer replica mode" });
