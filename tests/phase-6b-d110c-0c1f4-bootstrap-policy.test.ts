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
			// ea4eb158's receive-only restriction exists only beside a latched ACL; a
			// legacy author-list recovery still accepts exactly the four combinations.
			expect(Reflect.has(bindings.input, "exactCanonicalLatchedAclBytes")).toBe(false);
			for (const variant of variants) {
				await expect(
					recoverV3LiveReplica({
						...variant,
						capability: Object.freeze({ counterfeit: true }) as never,
						receiveOnly: true,
					} as never)
				).resolves.toMatchObject({ kind: "malformed-input", ok: false });
			}
		} finally {
			await fixture.close();
		}
	});

	it("accepts the receive-only restriction on each of the four combinations only beside a latched ACL", async () => {
		const fixture = await createGenuinePreparedV3Fixture({ authorizationMode: "latched-acl" });
		try {
			const bindings = await createRecoveryInput(fixture, fixture.capability, BOOTSTRAP_OPERATION);
			expect(Reflect.has(bindings.input, "exactCanonicalLatchedAclBytes")).toBe(true);
			const operationAdmissionPolicy = Object.freeze({
				reserve: () => Object.freeze({ kind: "duplicate" as const }),
			});
			const bootstrapBytes = encodeCanonical(BOOTSTRAP_OPERATION);
			for (const variant of [
				bindings.input,
				{ ...bindings.input, operationAdmissionPolicy },
				{ ...bindings.input, [BOOTSTRAP_POLICY_KEY]: bootstrapBytes },
				{ ...bindings.input, [BOOTSTRAP_POLICY_KEY]: bootstrapBytes, operationAdmissionPolicy },
			]) {
				await expect(
					recoverV3LiveReplica({
						...variant,
						capability: Object.freeze({ counterfeit: true }) as never,
						receiveOnly: true,
					} as never)
				).resolves.toMatchObject({ kind: "capability-consumed", ok: false });
			}
			await expect(
				recoverV3LiveReplica({
					...bindings.input,
					capability: Object.freeze({ counterfeit: true }) as never,
					receiveOnly: false,
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
		// ea4eb158 moved the room session into the node package; the example re-exports it.
		const room = source("packages/node/src/v3-room.ts");
		expect(source("examples/v3-room/src/index.ts")).toContain('from "@ts-drp/node/v3-room"');
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
		const coldOptional = section(activation, "const optional = [", "const bindings = runtimeBindings(captured);");

		// ea4eb158 adds the receive-only restriction: the same four combinations again,
		// each with "receiveOnly", reachable only when the keys carry a latched ACL.
		const [ordinaryInput, receiveOnlyInput] = snapshotInput.split("if (ordinary !== undefined) return ordinary;");
		expect(ordinaryInput?.match(/snapshotClosedRecord\(/gu)).toHaveLength(4);
		expect(ordinaryInput).not.toContain("receiveOnly");
		expect(receiveOnlyInput).toContain('if (!keys.includes("exactCanonicalLatchedAclBytes")) return undefined;');
		expect(receiveOnlyInput?.match(/snapshotClosedRecord\(/gu)).toHaveLength(4);
		expect(receiveOnlyInput?.match(/"receiveOnly"/gu)).toHaveLength(4);
		expect(snapshotInput.match(/snapshotClosedRecord\(/gu)).toHaveLength(8);
		expect(snapshotInput).toContain("PINNED_GENESIS_BOOTSTRAP_OPERATION_KEY");
		// ea4eb158 routes four more owners (both census source branches, the hidden native
		// census and the displaced/current plane classification) through the SAME predicate.
		// Freeze one definition, and that every call hands it exact pinned bootstrap bytes.
		expect(live.match(/function authenticatedPinnedGenesisOutboxRow\(/gu)).toHaveLength(1);
		const pinnedCalls = live
			.split(/(?<!function )authenticatedPinnedGenesisOutboxRow\(/u)
			.slice(1)
			.map((tail) => tail.slice(0, tail.indexOf(")")));
		expect(pinnedCalls).toHaveLength(6);
		for (const call of pinnedCalls) {
			const args = call.split(",").map((argument) => argument.trim());
			expect(args).toHaveLength(6);
			expect(args[4]).toMatch(/^(?:[A-Za-z.]+\.)?(?:exactCanonicalPinnedGenesisBootstrapOperationBytes|pinnedBootstrapBytes|bootstrapBytes)$/u);
		}
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
		// ea4eb158 names the same displaced-source custody once (originalNativeBranch)
		// and filters the original native branch with its exact pinned bootstrap bytes.
		expect(displacedActivation).toContain("const originalNativeBranch = transportHandoff?.displacedSource;");
		expect(displacedActivation).toContain("originalNativeBranch.exactCanonicalPinnedGenesisBootstrapOperationBytes");
		expect(displacedActivation).toContain("originalNativeBranch.pinnedGenesisAnchorDigest");
		expect(hotKeys).not.toContain(BOOTSTRAP_POLICY_KEY);
		// ea4eb158 replaces the closed COLD_BOOTSTRAP_POLICY_KEYS variant with one list of
		// optional OWN keys captured beside COLD_KEYS; the bootstrap key stays cold-only and
		// must be an exact plain Uint8Array, copied, or the reopen fails closed.
		expect(coldKeys).not.toContain(BOOTSTRAP_POLICY_KEY);
		expect(coldOptional).toContain(`const optional = ["${BOOTSTRAP_POLICY_KEY}"`);
		expect(coldOptional).toContain("Object.hasOwn(input, key)");
		expect(coldOptional).toContain("captureRuntimeInput(input, [...COLD_KEYS, ...optional])");
		expect(coldOptional).toContain("Object.getPrototypeOf(rawBootstrapOperationBytes) === Uint8Array.prototype");
		expect(coldOptional).toContain("Uint8Array.from(rawBootstrapOperationBytes)");
		expect(coldOptional).toContain('"creator successor bootstrap policy input is invalid"');
		expect(pending).not.toContain(BOOTSTRAP_POLICY_KEY);
		expect(room.match(/exactCanonicalPinnedGenesisBootstrapOperationBytes/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
	});
});
