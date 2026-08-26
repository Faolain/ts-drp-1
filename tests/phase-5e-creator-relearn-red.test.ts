/* eslint import/no-unresolved: "off" */
import "fake-indexeddb/auto";
import { compareBytes } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CREATOR_RELEARN_FAILURES,
	CREATOR_RELEARN_LIMITS,
	CREATOR_RELEARN_PROTOCOL,
	CREATOR_RELEARN_REQUEST_FIELDS,
	CREATOR_RELEARN_RESPONSE_FIELDS,
	CREATOR_RELEARN_STATUSES,
	creatorRelearnReadiness,
	exactKeys,
	EXPECTED_EXPORTS,
	NEW_SEMANTIC_OWNERS,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	REQUIRED_RED_PATHS,
} from "./fixtures/phase-5e-v3/creator-relearn-contract.js";
import {
	createGenuineCreatorPeerEvidence,
	type ExactCreatorPeerEvidence,
	IndependentCreatorSigningGate,
	persistBeforeAcknowledge,
	runIndependentCreatorRelearn,
	type ScriptedEvidencePeer,
} from "./fixtures/phase-5e-v3/creator-relearn-driver.js";

const readiness = creatorRelearnReadiness();
const databases: string[] = [];

function database(label: string): string {
	const name = `phase5e-relearn-${label}-${crypto.randomUUID()}`;
	databases.push(name);
	return name;
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolvePromise) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("blocked", () => resolvePromise(), { once: true });
		request.addEventListener("error", () => resolvePromise(), { once: true });
		request.addEventListener("success", () => resolvePromise(), { once: true });
	});
}

function peer(
	peerId: string,
	response: unknown,
	queried: string[],
	options: Readonly<{ authenticated?: boolean; delay?: number }> = {}
): ScriptedEvidencePeer {
	return Object.freeze({
		authenticated: options.authenticated ?? true,
		peerId,
		async query(): Promise<unknown> {
			queried.push(peerId);
			if ((options.delay ?? 0) > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, options.delay));
			return structuredClone(response);
		},
	});
}

function mutated(
	evidence: ExactCreatorPeerEvidence,
	changes: Partial<Record<keyof ExactCreatorPeerEvidence, unknown>>
): unknown {
	return { ...structuredClone(evidence), ...changes };
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(databases.splice(0).map(async (name) => deleteDatabase(name)));
});

describe("Phase 5e persistent creator evidence and bounded re-learn RED", () => {
	it("freezes the exact seven RED and exact eight GREEN owners", () => {
		expect(REQUIRED_RED_PATHS).toHaveLength(7);
		expect(REQUIRED_GREEN_PATHS).toHaveLength(8);
		expect(NEW_SEMANTIC_OWNERS).toEqual(["packages/network/src/seal.ts", "packages/node/src/creator-seal.ts"]);
		expect(REQUIRED_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
	});

	it("pins one connected-only bounded protocol and a closed recovery state machine", () => {
		expect(CREATOR_RELEARN_PROTOCOL).toBe("/ts-drp/v3/seal-evidence/1.0.0");
		expect(CREATOR_RELEARN_LIMITS).toEqual({ maxEvidenceBytes: 262_144, queryTimeoutMs: 10_000 });
		expect(CREATOR_RELEARN_STATUSES).toEqual(["equivocation", "ready", "relearn-required", "relearning", "stalled"]);
		expect(CREATOR_RELEARN_FAILURES).toEqual([
			"ABORTED",
			"EQUIVOCATION",
			"MALFORMED_EVIDENCE",
			"NO_AUTHENTICATED_EVIDENCE",
			"QUERY_TIMEOUT",
			"SIGNING_BLOCKED",
			"UNAUTHORIZED_PEER",
		]);
		expect(CREATOR_RELEARN_REQUEST_FIELDS).toEqual(["anchor", "epoch", "kind", "objectId"]);
		expect(CREATOR_RELEARN_RESPONSE_FIELDS).toEqual([
			"carrier",
			"exactCanonicalCommitQcBytes",
			"exactCanonicalCutValueBytes",
			"exactCanonicalTrustStateRecordBytes",
			"kind",
			"signerPublicKey",
		]);
	});

	it("persists exact registered evidence before acknowledgement or relay", async () => {
		const fixture = await createGenuineCreatorPeerEvidence(database("persist"));
		const external: string[] = [];
		const ledger = await persistBeforeAcknowledge({
			acknowledge: () => external.push("acknowledged"),
			evidence: fixture.evidence,
			persist: async (evidence) => {
				external.push("persist-started");
				expect(evidence).not.toBe(fixture.evidence);
				await Promise.resolve();
				external.push("persisted");
			},
			relay: () => external.push("relayed"),
		});
		expect(ledger).toEqual(["received", "persisted", "acknowledged", "relayed"]);
		expect(external).toEqual(["persist-started", "persisted", "acknowledged", "relayed"]);
	});

	it("queries every snapshotted authenticated peer and ignores foreign, malformed, and digest-only replies", async () => {
		const fixture = await createGenuineCreatorPeerEvidence(database("all-peers"));
		const queried: string[] = [];
		vi.useFakeTimers();
		const resultTask = runIndependentCreatorRelearn({
			authority: fixture.authority,
			currentTrust: fixture.currentTrust,
			peers: [
				peer("honest", fixture.evidence, queried, { delay: 5 }),
				peer("digest-only", { kind: "drp-creator-seal-evidence", valueDigest: fixture.valueDigest }, queried),
				peer("malformed", mutated(fixture.evidence, { exactCanonicalTrustStateRecordBytes: Uint8Array.of() }), queried),
				peer("foreign", mutated(fixture.evidence, { signerPublicKey: new Uint8Array(32).fill(0xff) }), queried),
				Object.freeze({
					authenticated: true,
					peerId: "timeout",
					query: async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<unknown> => {
						queried.push("timeout");
						await new Promise<void>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
						return undefined;
					},
				}),
				peer("unauthenticated", fixture.evidence, queried, { authenticated: false }),
			],
		});
		await vi.advanceTimersByTimeAsync(10_000);
		const result = await resultTask;
		expect(queried.sort()).toEqual(["digest-only", "foreign", "honest", "malformed", "timeout"]);
		expect(result).toMatchObject({
			ignoredPeers: ["digest-only", "malformed", "foreign", "timeout"],
			ok: true,
			queriedPeers: ["honest", "digest-only", "malformed", "foreign", "timeout"],
			status: "ready",
			valueDigest: fixture.valueDigest,
		});
	});

	it("terminalizes conflicting own-signed evidence independently of arrival or lexical order", async () => {
		const first = await createGenuineCreatorPeerEvidence(database("conflict-a"), "b".repeat(64));
		const second = await createGenuineCreatorPeerEvidence(database("conflict-b"), "1".repeat(64));
		expect(first.valueDigest).not.toBe(second.valueDigest);
		for (const responses of [
			[first.evidence, second.evidence],
			[second.evidence, first.evidence],
		] as const) {
			const result = await runIndependentCreatorRelearn({
				authority: first.authority,
				currentTrust: first.currentTrust,
				peers: responses.map((response, index) => peer(`peer-${index}`, response, [])),
			});
			expect(result).toEqual({
				ok: false,
				queriedPeers: ["peer-0", "peer-1"],
				reason: "EQUIVOCATION",
				status: "equivocation",
			});
		}
	});

	it("stalls with no evidence and releases only the exact old value and carrier after complete re-learn", async () => {
		const fixture = await createGenuineCreatorPeerEvidence(database("restore"));
		const gate = new IndependentCreatorSigningGate();
		expect(gate.status()).toBe("relearn-required");
		expect(gate.release()).toEqual({ ok: false, reason: "SIGNING_BLOCKED" });
		const stalled = await runIndependentCreatorRelearn({
			authority: fixture.authority,
			currentTrust: fixture.currentTrust,
			peers: [],
		});
		gate.apply(stalled);
		expect(gate.status()).toBe("stalled");
		expect(gate.release()).toEqual({ ok: false, reason: "SIGNING_BLOCKED" });
		const recovered = await runIndependentCreatorRelearn({
			authority: fixture.authority,
			currentTrust: fixture.currentTrust,
			peers: [peer("peer-a", fixture.evidence, []), peer("peer-b", fixture.evidence, [])],
		});
		gate.apply(recovered);
		const released = gate.release();
		expect(released).toMatchObject({ ok: true });
		if (!released.ok) return;
		expect(compareBytes(released.evidence.carrier.signature, fixture.evidence.carrier.signature)).toBe(0);
		expect(
			compareBytes(
				released.evidence.carrier.exactCanonicalPreimageBytes,
				fixture.evidence.carrier.exactCanonicalPreimageBytes
			)
		).toBe(0);
		expect(recovered).toMatchObject({ ok: true, status: "ready", valueDigest: fixture.valueDigest });
	});

	it("[RED readiness] requires the connected carrier and node recovery owner", () => {
		expect(readiness, `missing D.107c owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("keeps the new runtime subpaths closed", async () => {
		const [network, node] = await Promise.all([import("@ts-drp/network/seal"), import("@ts-drp/node/creator-seal")]);
		expect(exactKeys(network)).toEqual(EXPECTED_EXPORTS.network);
		expect(Reflect.get(network, "SEAL_EVIDENCE_PROTOCOL")).toBe(CREATOR_RELEARN_PROTOCOL);
		expect(exactKeys(node)).toEqual(EXPECTED_EXPORTS.node);
	});
});
