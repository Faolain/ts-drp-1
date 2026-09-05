import "fake-indexeddb/auto";

import { encodeCanonical } from "@ts-drp/canonical";
import type {
	DurableIssuanceStore,
	SettlementPlan,
	SettlementPlanEntry,
	SettlementReplacementProgress,
} from "@ts-drp/issuance-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { code, failure, PROGRESS_SCOPE } from "./fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.js";
import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

const scope = PROGRESS_SCOPE;
const empty: SettlementReplacementProgress = {
	version: 1,
	intentCount: 3,
	intentDigest: new Uint8Array(32).fill(2),
	chunks: [],
};
const partial: SettlementReplacementProgress = {
	...empty,
	chunks: [{ lastLogicalTime: 7, replacementSequence: 10, throughIntent: 1 }],
};
const completed: SettlementReplacementProgress = {
	...empty,
	chunks: [{ lastLogicalTime: 9, replacementSequence: 10, throughIntent: 3 }],
};
const source: SettlementPlanEntry = {
	sourceSequence: 7,
	sourceDigest: new Uint8Array(32).fill(1),
	disposition: "rebase",
	replacementSequence: null,
};
const states: readonly (readonly [string, SettlementPlanEntry])[] = [
	["unlinked", source],
	["legacy-linked", { ...source, replacementSequence: 10 }],
	["empty-progress", { ...source, replacementProgress: empty }],
	["in-progress", { ...source, replacementProgress: partial }],
	["completed-progress", { ...source, replacementSequence: 10, replacementProgress: completed }],
];
const mutations: readonly (readonly [string, (entry: SettlementPlanEntry) => SettlementPlanEntry])[] = [
	["source-digest", (entry): SettlementPlanEntry => ({ ...entry, sourceDigest: new Uint8Array(32).fill(3) })],
	["disposition", (entry): SettlementPlanEntry => ({ ...entry, disposition: "transform" })],
	[
		"link",
		(entry): SettlementPlanEntry => ({
			...entry,
			replacementSequence: 11,
			...(entry.replacementProgress === undefined
				? {}
				: {
						replacementProgress: {
							...entry.replacementProgress,
							chunks: [{ lastLogicalTime: 9, replacementSequence: 11, throughIntent: 3 }],
						},
					}),
		}),
	],
	[
		"progress",
		(entry): SettlementPlanEntry => ({
			...entry,
			replacementProgress:
				entry.replacementProgress === undefined
					? { ...empty, chunks: [{ lastLogicalTime: 7, replacementSequence: 9, throughIntent: 1 }] }
					: { ...entry.replacementProgress, intentDigest: new Uint8Array(32).fill(4) },
		}),
	],
];

async function withStore(
	kind: "memory" | "browser" | "node",
	run: (store: DurableIssuanceStore) => Promise<void>
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0w-store-"));
	const store =
		kind === "memory"
			? createEphemeralDurableIssuanceStore()
			: kind === "browser"
				? await createBrowserDurableIssuanceStore({ primaryDatabaseName: directory })
				: createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
	try {
		await run(store);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function plan(entry: SettlementPlanEntry): SettlementPlan {
	return { entries: [entry], fenceSequence: 4, revision: 0, scope };
}

async function refuseMutation(
	store: DurableIssuanceStore,
	before: SettlementPlan,
	candidate: SettlementPlanEntry
): Promise<void> {
	await store.transactWriteSettlementPlan({ expectedRevision: null, plan: before, scope });
	const error = await failure(
		store.transactWriteSettlementPlan({
			expectedRevision: 0,
			plan: { ...before, entries: [candidate], revision: 1 },
			scope,
		})
	);
	expect.soft(code(error), "D110C_F5B0W_RETAINED_ENTRY_MUTATION_ACCEPTED").toBe("ISSUANCE_RETRY_REQUIRED");
	expect
		.soft(encodeCanonical(await store.readSettlementPlan(scope)), "D110C_F5B0W_RETAINED_PLAN_BYTES_CHANGED")
		.toEqual(encodeCanonical(before));
	expect(await store.readLineage(scope)).toEqual({ exhausted: false, next: 0 });
	expect(await store.readIssued(scope, 0)).toBeNull();
}

describe.each(["memory", "browser", "node"] as const)("D.110c-0c1f5b0w %s retained settlement entries", (kind) => {
	for (const [state, entry] of states) {
		for (const [mutation, mutate] of mutations) {
			// A legacy linked row's progress upgrade must itself be shape-valid:
			// the final chunk/link agree, so rejection proves the transition law.
			const candidate =
				state === "legacy-linked" && mutation === "progress"
					? { ...entry, replacementProgress: completed }
					: mutate(entry);
			it(`${state} refuses ${mutation} direct CAS`, async () => {
				await withStore(kind, (store) => refuseMutation(store, plan(entry), candidate));
			});
		}
	}
	it.each(["expire", "rebase", "transform"] as const)(
		"refuses final %s to manual-review redisposition",
		async (disposition) => {
			await withStore(kind, (store) =>
				refuseMutation(store, plan({ ...source, disposition }), { ...source, disposition: "manual-review" })
			);
		}
	);
	it("legacy-linked refuses manual-review redisposition without altering its link", async () => {
		const entry = { ...source, replacementSequence: 10 };
		await withStore(kind, (store) => refuseMutation(store, plan(entry), { ...entry, disposition: "manual-review" }));
	});
	it("completed progress refuses manual-review redisposition even if progress is stripped", async () => {
		await withStore(kind, (store) =>
			refuseMutation(store, plan({ ...source, replacementSequence: 10, replacementProgress: completed }), {
				...source,
				replacementSequence: 10,
				disposition: "manual-review",
			})
		);
	});
	it.each(["digest", "disposition"] as const)("manual-review retains its exact %s", async (mutation) => {
		const held = { ...source, disposition: "manual-review" as const };
		await withStore(kind, (store) =>
			refuseMutation(
				store,
				plan(held),
				mutation === "digest"
					? { ...held, sourceDigest: new Uint8Array(32).fill(8) }
					: { ...held, disposition: "rebase" }
			)
		);
	});
	it("completed progress cannot be removed while retaining its source and link", async () => {
		await withStore(kind, (store) =>
			refuseMutation(store, plan({ ...source, replacementSequence: 10, replacementProgress: completed }), {
				...source,
				replacementSequence: 10,
			})
		);
	});
	it("completed progress freezes every chunk field and completion bounds", async () => {
		for (const changed of [
			{ ...completed, intentCount: 4, chunks: [{ lastLogicalTime: 9, replacementSequence: 10, throughIntent: 4 }] },
			{ ...completed, chunks: [{ lastLogicalTime: 10, replacementSequence: 10, throughIntent: 3 }] },
			{ ...completed, chunks: [{ lastLogicalTime: 8, replacementSequence: 9, throughIntent: 1 }, ...completed.chunks] },
		]) {
			await withStore(kind, (store) =>
				refuseMutation(store, plan({ ...source, replacementSequence: 10, replacementProgress: completed }), {
					...source,
					replacementSequence: 10,
					replacementProgress: changed,
				})
			);
		}
	});
	it("retains undefined to exact empty progress initialization control", async () => {
		await withStore(kind, async (store) => {
			const before = plan(source);
			await store.transactWriteSettlementPlan({ expectedRevision: null, plan: before, scope });
			const next = { ...before, entries: [{ ...source, replacementProgress: empty }], revision: 1 };
			await store.transactWriteSettlementPlan({ expectedRevision: 0, plan: next, scope });
			expect(encodeCanonical(await store.readSettlementPlan(scope))).toEqual(encodeCanonical(next));
		});
	});
	it("store removal control permits an owner re-derived plan without claiming store authentication", async () => {
		// The backend validates a CAS, not membership authority. Real authenticated
		// revoke/close/adopt removal remains the explicitly gated parent continuation.
		await withStore(kind, async (store) => {
			const before = plan({ ...source, disposition: "manual-review" });
			await store.transactWriteSettlementPlan({ expectedRevision: null, plan: before, scope });
			const next = { ...before, entries: [], revision: 1 };
			await store.transactWriteSettlementPlan({ expectedRevision: 0, plan: next, scope });
			expect(await store.readSettlementPlan(scope)).toEqual(next);
		});
	});
});
