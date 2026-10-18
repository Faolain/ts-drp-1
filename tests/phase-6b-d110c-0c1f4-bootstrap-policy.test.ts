import "fake-indexeddb/auto";

import { encodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { createRecoveryInput } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { recoverV3LiveReplica } from "../packages/node/src/v3-live.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const BOOTSTRAP_POLICY_KEY = "exactCanonicalPinnedGenesisBootstrapOperationBytes";
const BOOTSTRAP_OPERATION = Object.freeze({ action: "add", value: 1 });

function source(path: string): string {
	return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

function section(contents: string, start: string, end: string): string {
	const from = contents.indexOf(start);
	const to = contents.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new TypeError(`D110C_0C1F4_SOURCE_SECTION_MISSING:${start}`);
	return contents.slice(from, to);
}

function deepOperation(): Readonly<Record<string, unknown>> {
	let value: Readonly<Record<string, unknown>> = Object.freeze({ leaf: true });
	for (let index = 0; index < 10; index += 1) value = Object.freeze({ next: value });
	return value;
}

describe("D.110c-0c1f4 exact pinned-genesis bootstrap policy", () => {
	it("accepts only the four frozen recovery key combinations", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const bindings = await createRecoveryInput(fixture, fixture.capability, BOOTSTRAP_OPERATION);
			const operationAdmissionPolicy = Object.freeze({
				reserve: () => Object.freeze({ kind: "duplicate" as const }),
			});
			const bootstrapBytes = encodeCanonical(BOOTSTRAP_OPERATION);
			const variants = [
				bindings.input,
				{ ...bindings.input, operationAdmissionPolicy },
				{ ...bindings.input, [BOOTSTRAP_POLICY_KEY]: bootstrapBytes },
				{ ...bindings.input, [BOOTSTRAP_POLICY_KEY]: bootstrapBytes, operationAdmissionPolicy },
			] as const;
			for (const variant of variants) {
				const result = await recoverV3LiveReplica({
					...variant,
					capability: Object.freeze({ counterfeit: true }) as never,
				});
				expect(result).toMatchObject({ kind: "capability-consumed", ok: false });
			}
			await expect(
				recoverV3LiveReplica({
					...bindings.input,
					capability: Object.freeze({ counterfeit: true }) as never,
					extra: true,
				} as never)
			).resolves.toMatchObject({ kind: "malformed-input", ok: false });
		} finally {
			await fixture.close();
		}
	});

	it("rejects malformed bounded policy bytes before consuming the prepared capability", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const bindings = await createRecoveryInput(fixture, fixture.capability, BOOTSTRAP_OPERATION);
			const malformed = [
				new Uint8Array(),
				Uint8Array.of(0xa1, 0x61, 0x61, 0x18, 0x00),
				encodeCanonical("not-an-operation"),
				new Uint8Array(65_537),
				encodeCanonical(deepOperation()),
				encodeCanonical({ values: Array.from({ length: 1_025 }, (_, index) => index) }),
			] as const;
			for (const exactCanonicalPinnedGenesisBootstrapOperationBytes of malformed) {
				await expect(
					recoverV3LiveReplica({
						...bindings.input,
						exactCanonicalPinnedGenesisBootstrapOperationBytes,
					})
				).resolves.toMatchObject({ kind: "malformed-input", ok: false });
			}
			expect(bindings.journal.appendAccepted).not.toHaveBeenCalled();
			const recovered = await recoverV3LiveReplica({
				...bindings.input,
				exactCanonicalPinnedGenesisBootstrapOperationBytes: encodeCanonical(BOOTSTRAP_OPERATION),
			});
			expect(recovered).toMatchObject({ ok: true });
		} finally {
			await fixture.close();
		}
	});

	it("freezes the one shared exact predicate and its custody boundaries", () => {
		const live = source("packages/node/src/v3-live.ts");
		const activation = source("packages/node/src/creator-adoption-activate.ts");
		const pending = source("packages/node/src/creator-adoption-recover.ts");
		const room = source("examples/v3-room/src/index.ts");
		const snapshotInput = section(live, "function snapshotRecoveryRecord(", "function isInstanceOf(");
		const exactPredicate = section(
			live,
			"function authenticatedPinnedGenesisOutboxRow(",
			"function authenticatedCoveredHistoricalOutboxRow("
		);
		const coveredHistorical = section(
			live,
			"function authenticatedCoveredHistoricalOutboxRow(",
			"function creatorFilteredIssuanceStore("
		);
		const filteredStore = section(
			live,
			"function creatorFilteredIssuanceStore(",
			"function openRecoveryAuthorization("
		);
		const displacedActivation = section(
			live,
			"async function activateCreatorSuccessorLive(",
			"if (!installCreatorSuccessorLive(activateCreatorSuccessorLive))"
		);
		const hotKeys = section(activation, "const HOT_KEYS", "const COLD_KEYS");
		const coldKeys = section(activation, "const COLD_KEYS", "type PlainRecord");

		expect(snapshotInput.match(/snapshotClosedRecord\(/gu)).toHaveLength(4);
		expect(snapshotInput).toContain("PINNED_GENESIS_BOOTSTRAP_OPERATION_KEY");
		expect(live.match(/authenticatedPinnedGenesisOutboxRow\(/gu)).toHaveLength(3);
		for (const required of [
			"row.authorSequence !== 0",
			"extracted.vertex.anchor !== pinnedGenesisAnchorDigest",
			"extracted.vertex.authorSequence !== 0",
			"extracted.vertex.dependencies.length !== 1",
			"extracted.vertex.dependencies[0] !== pinnedGenesisAnchorDigest",
			"extracted.vertex.epoch !== 0",
			"extracted.vertex.logicalTime !== 1",
			"extracted.vertex.objectId !== issuanceScope.objectId",
			"extracted.vertex.author !== issuanceScope.author",
			"lowerHexDigest(extracted.vertex.digest) !== lowerHexDigest(row.digest)",
			"exactCanonicalPinnedGenesisBootstrapOperationBytes",
		] as const) {
			expect(exactPredicate).toContain(required);
		}
		expect(exactPredicate).not.toContain('action !== "join"');
		expect(exactPredicate).not.toContain('action === "join"');
		expect(coveredHistorical).toContain("row.authorSequence === 0");
		expect(filteredStore).toContain("authenticatedPinnedGenesisOutboxRow(");
		expect(displacedActivation).toContain(
			"transportHandoff.displacedSource.exactCanonicalPinnedGenesisBootstrapOperationBytes"
		);
		expect(displacedActivation).toContain("transportHandoff.displacedSource.pinnedGenesisAnchorDigest");
		expect(hotKeys).not.toContain(BOOTSTRAP_POLICY_KEY);
		expect(coldKeys).toContain("COLD_BOOTSTRAP_POLICY_KEYS");
		expect(coldKeys).toContain(BOOTSTRAP_POLICY_KEY);
		expect(pending).not.toContain(BOOTSTRAP_POLICY_KEY);
		expect(room.match(/exactCanonicalPinnedGenesisBootstrapOperationBytes/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
	});
});
