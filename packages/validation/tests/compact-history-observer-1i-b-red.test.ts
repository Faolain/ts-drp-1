import { describe, expect, it } from "vitest";

import { NodeConnectObjectOptionsSchema, NodeCreateObjectOptionsSchema } from "../src/schemas/object.js";

describe("Phase 1i-b compact-history configuration validation", () => {
	it("retains the explicit observer+compact capability at create and connect boundaries", () => {
		expect(NodeCreateObjectOptionsSchema.parse({ history_storage: "compact", replica_mode: "observer" })).toEqual({
			history_storage: "compact",
			replica_mode: "observer",
		});
		expect(
			NodeConnectObjectOptionsSchema.parse({
				history_storage: "compact",
				id: "creator:phase-1i-b-validation",
				replica_mode: "observer",
			})
		).toEqual({
			history_storage: "compact",
			id: "creator:phase-1i-b-validation",
			replica_mode: "observer",
		});
	});

	it("rejects every illegal compact-history combination", () => {
		for (const [name, value] of [
			["writer plus compact", { history_storage: "compact", replica_mode: "writer" }],
			["ambiguous omitted replica mode", { history_storage: "compact" }],
			["unknown history storage", { history_storage: "archive", replica_mode: "observer" }],
		] as const) {
			expect.soft(NodeCreateObjectOptionsSchema.safeParse(value).success, name).toBe(false);
		}
	});

	it("preserves omitted writer and full-history observer configuration", () => {
		expect(NodeCreateObjectOptionsSchema.parse({})).toEqual({});
		expect(NodeCreateObjectOptionsSchema.parse({ replica_mode: "writer" })).toEqual({ replica_mode: "writer" });
		expect(NodeCreateObjectOptionsSchema.parse({ replica_mode: "observer" })).toEqual({ replica_mode: "observer" });
	});
});
