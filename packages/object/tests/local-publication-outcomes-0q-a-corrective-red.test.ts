import {
	ActionType,
	type DrpType,
	type IACL,
	type IDRP,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { AdoptionCommitExhaustedError } from "../src/errors.js";
import { MAX_ADOPTION_COMMIT_ATTEMPTS, type PostOperation } from "../src/operation.js";
import { createPipeline } from "../src/pipeline/pipeline.js";
import { DRPProxy, type DRPProxyChainArgs } from "../src/proxy.js";

interface MockDRP extends IDRP {
	mutate(intent: string): string;
}

const mockVertex: Vertex = {
	hash: "local-publication-outcome",
	peerId: "local-peer",
	operation: {
		drpType: "DRP",
		opType: "mutate",
		value: [],
	},
	dependencies: [],
	timestamp: 0,
	signature: new Uint8Array(),
};

const mockACL: IACL = {
	id: "local-acl",
	type: "acl",
	data: {},
	semanticsType: SemanticsType.pair,
	permissionless: false,
	grant: () => {},
	revoke: () => {},
	setKey: () => {},
	query_hasPermission: () => false,
	query_getPermissions: () => [],
	query_getKeys: () => [],
	query_getKey: () => undefined,
	query_getFinalitySigners: () => new Map(),
	query_isAdmin: () => false,
	query_isFinalitySigner: () => false,
	query_isWriter: () => false,
	query_getPeerKey: () => undefined,
	resolveConflicts: (_vertices: Vertex[]): ResolveConflictsType => ({ action: ActionType.Nop }),
};

const mockDRP: MockDRP = {
	id: "local-drp",
	type: "drp",
	data: {},
	semanticsType: SemanticsType.pair,
	mutate: (intent: string) => intent,
	resolveConflicts: (_vertices: Vertex[]): ResolveConflictsType => ({ action: ActionType.Nop }),
};

type CommitOutcome = NonNullable<PostOperation<IDRP>["commitOutcome"]>;

function controlledProxy(
	outcomes: readonly CommitOutcome[],
	asynchronous = false
): {
	readonly calls: DRPProxyChainArgs[];
	readonly proxy: MockDRP;
} {
	const calls: DRPProxyChainArgs[] = [];
	const pipeline = createPipeline<DRPProxyChainArgs, PostOperation<IDRP>>((request) => {
		calls.push(request);
		const commitOutcome = outcomes[calls.length - 1] ?? "committed";
		const response = {
			stop: false,
			result: {
				isACL: false,
				isLocal: true,
				vertex: mockVertex,
				lcaResult: { lca: "root", linearizedVertices: [] },
				drpVertices: [mockVertex],
				aclVertices: [],
				acl: mockACL,
				drp: mockDRP,
				result: `result-${calls.length}`,
				commitOutcome,
			},
		};
		return asynchronous ? Promise.resolve(response) : response;
	});
	return {
		calls,
		proxy: new DRPProxy(mockDRP, pipeline, "drp" as DrpType).proxy,
	};
}

function invokeAsync(controlled: ReturnType<typeof controlledProxy>, intent: string): Promise<string> {
	return controlled.proxy.mutate(intent) as unknown as Promise<string>;
}

describe("Phase 0q-a corrective local publication outcome RED", () => {
	it("treats duplicate as terminal without executing or applying the intent twice", () => {
		const controlled = controlledProxy(["duplicate", "committed"]);

		expect(controlled.proxy.mutate("one-intent")).toBe("result-1");
		expect(controlled.calls).toEqual([{ prop: "mutate", args: ["one-intent"], type: "drp" }]);
	});

	it("re-executes the same intent once after a retry outcome", () => {
		const controlled = controlledProxy(["retry", "committed"]);

		expect(controlled.proxy.mutate("one-intent")).toBe("result-2");
		expect(controlled.calls).toEqual([
			{ prop: "mutate", args: ["one-intent"], type: "drp" },
			{ prop: "mutate", args: ["one-intent"], type: "drp" },
		]);
	});

	it("stops after exactly three retry outcomes", () => {
		const controlled = controlledProxy(["retry", "retry", "retry", "committed"]);

		expect(() => controlled.proxy.mutate("bounded-intent")).toThrow(
			expect.objectContaining<Partial<AdoptionCommitExhaustedError>>({
				attempts: MAX_ADOPTION_COMMIT_ATTEMPTS,
				vertexHash: mockVertex.hash,
			})
		);
		expect(controlled.calls).toHaveLength(MAX_ADOPTION_COMMIT_ATTEMPTS);
	});

	it("treats an async duplicate as terminal", async () => {
		const controlled = controlledProxy(["duplicate", "committed"], true);

		await expect(invokeAsync(controlled, "async-duplicate")).resolves.toBe("result-1");
		expect(controlled.calls).toEqual([{ prop: "mutate", args: ["async-duplicate"], type: "drp" }]);
	});

	it("re-executes the same async intent once after a retry outcome", async () => {
		const controlled = controlledProxy(["retry", "committed"], true);

		await expect(invokeAsync(controlled, "async-retry")).resolves.toBe("result-2");
		expect(controlled.calls).toEqual([
			{ prop: "mutate", args: ["async-retry"], type: "drp" },
			{ prop: "mutate", args: ["async-retry"], type: "drp" },
		]);
	});

	it("stops after exactly three async retry outcomes", async () => {
		const controlled = controlledProxy(["retry", "retry", "retry", "committed"], true);
		let error: unknown;

		try {
			await invokeAsync(controlled, "async-bounded");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AdoptionCommitExhaustedError);
		expect(error).toMatchObject({
			attempts: MAX_ADOPTION_COMMIT_ATTEMPTS,
			vertexHash: mockVertex.hash,
		});
		expect(controlled.calls).toHaveLength(MAX_ADOPTION_COMMIT_ATTEMPTS);
	});
});
