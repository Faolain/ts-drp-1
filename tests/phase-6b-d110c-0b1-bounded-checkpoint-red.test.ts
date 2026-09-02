import "fake-indexeddb/auto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type D110c0b1ClosureEntry,
	type D110c0b1RedFixture,
	D110C_0B1_BOUNDED_ADVANCE_MISSING,
	D110C_0B1_CHECKPOINT_OPENER_MISSING,
	D110C_0B1_COLD_REOPEN_EPOCH_PINNED,
	openD110c0b1RedFixture,
} from "./fixtures/phase-6b-d110c-0b1/bounded-checkpoint-contract.js";

function entries(
	census: readonly D110c0b1ClosureEntry[],
	kind: string,
	epoch: number,
	phase?: string
): readonly D110c0b1ClosureEntry[] {
	return census.filter(
		(entry) => entry.kind === kind && entry.epoch === epoch && (phase === undefined || entry.phase === phase)
	);
}

async function requireMissingSubpath(specifier: string, exportName: string, token: string): Promise<void> {
	try {
		const surface = (await import(specifier)) as Readonly<Record<string, unknown>>;
		if (typeof surface[exportName] !== "function") throw new TypeError(token);
	} catch (error) {
		if (error instanceof TypeError && error.message === token) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(specifier)) throw error;
		throw new TypeError(token);
	}
}

describe("D.110c-0b1 bounded checkpoint and control-proof causal RED", () => {
	let fixture: D110c0b1RedFixture;

	beforeAll(async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		fixture = await openD110c0b1RedFixture();
	});

	afterAll(async () => {
		await fixture?.close();
	});

	it("cannot open the genuine epoch-two checkpoint from pinned genesis and its immediate pair", async () => {
		expect(fixture.evidence.currentOpenReasons).toEqual(["trust-state-inconsistent", "trust-state-inconsistent"]);
		expect(fixture.evidence.oneStepFromGenesis).toEqual({ ok: false, reason: "EPOCH_GAP" });
		await requireMissingSubpath(
			"@ts-drp/protocol-v3/creator-checkpoint",
			"openCreatorCheckpointTrust",
			D110C_0B1_CHECKPOINT_OPENER_MISSING
		);
	});

	it("retains the stale proof pair and predecessor ACL under the existing additive advance", async () => {
		const { activeCensus, currentCensus, existingAdvance, proposedCensus } = fixture.evidence;
		expect(existingAdvance).toMatchObject({ ok: true });
		expect(currentCensus).toHaveLength(5);
		expect(proposedCensus).toHaveLength(7);
		expect(activeCensus).toHaveLength(8);
		expect(entries(currentCensus, "drp-hard-epoch-cut", 0)).toHaveLength(1);
		expect(entries(currentCensus, "drp-seal-qc", 0, "commit")).toHaveLength(1);
		expect(entries(currentCensus, "drp-v3-latched-acl", 0)).toHaveLength(1);
		expect(entries(proposedCensus, "drp-hard-epoch-cut", 0)).toHaveLength(1);
		expect(entries(proposedCensus, "drp-seal-qc", 0, "commit")).toHaveLength(1);
		expect(entries(proposedCensus, "drp-v3-latched-acl", 0)).toHaveLength(1);
		expect(entries(proposedCensus, "drp-hard-epoch-cut", 1)).toHaveLength(1);
		expect(entries(proposedCensus, "drp-seal-qc", 1, "commit")).toHaveLength(1);
		expect(entries(activeCensus, "drp-v3-latched-acl", 0)).toHaveLength(1);
		expect(entries(activeCensus, "drp-v3-latched-acl", 1)).toHaveLength(1);
		await requireMissingSubpath(
			"@ts-drp/control-plane/creator-trust-checkpoint-advance",
			"inspectBoundedCreatorTrustAdvance",
			D110C_0B1_BOUNDED_ADVANCE_MISSING
		);
	});

	it("cannot cold reopen the genuine active epoch-two room through the epoch-zero-one owner", () => {
		const { active, current, proposed } = fixture.evidence.durableHeads;
		expect(Number(proposed.revision)).toBe(Number(current.revision) + 1);
		expect(Number(active.revision)).toBe(Number(proposed.revision) + 1);
		expect(fixture.evidence.coldReopen).toMatchObject({ kind: "chain-invalid", ok: false });
		expect(fixture.evidence.coldReopen).not.toHaveProperty("handle");
		throw new TypeError(D110C_0B1_COLD_REOPEN_EPOCH_PINNED);
	});
});
