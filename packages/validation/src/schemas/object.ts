import { z } from "zod";

const FinalityConfigSchema = z.object({
	enabled: z.boolean().optional(),
	finality_threshold: z.number().optional(),
});

const ReplicaModeSchema = z.enum(["writer", "observer"]);

export const NodeCreateObjectOptionsSchema = z.object({
	id: z.string().min(1, "A valid object id must be provided").optional(),
	finality_config: FinalityConfigSchema.optional(),
	replica_mode: ReplicaModeSchema.optional(),
	sync: z
		.object({
			enabled: z.boolean(),
			peerId: z.string().min(1, "A valid peer id must be provided").optional(),
		})
		.optional(),
});

export const NodeConnectObjectOptionsSchema = z.object({
	id: z.string().min(1, "A valid object id must be provided"),
	finality_config: FinalityConfigSchema.optional(),
	replica_mode: ReplicaModeSchema.optional(),
	sync: z
		.object({
			peerId: z.string().min(1, "A valid peer id must be provided"),
		})
		.optional(),
});
