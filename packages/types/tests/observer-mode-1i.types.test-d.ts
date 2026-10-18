import type { DRPObjectConfig, IDRP, NodeConnectObjectOptions, NodeCreateObjectOptions } from "@ts-drp/types";
import { expectTypeOf } from "vitest";

type ReplicaMode<T> = "replica_mode" extends keyof T ? T["replica_mode" & keyof T] : never;
type ExpectedReplicaMode = "observer" | "writer" | undefined;

expectTypeOf<ReplicaMode<DRPObjectConfig>>().toEqualTypeOf<ExpectedReplicaMode>();
expectTypeOf<ReplicaMode<NodeCreateObjectOptions<IDRP>>>().toEqualTypeOf<ExpectedReplicaMode>();
expectTypeOf<ReplicaMode<NodeConnectObjectOptions<IDRP>>>().toEqualTypeOf<ExpectedReplicaMode>();
