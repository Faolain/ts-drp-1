import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import { SeededRandom } from "../../test-utils/dist/src/property-harness.js";
import * as protocolV2 from "../src/index.js";

const PRIVATE_KEY_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const PUBLIC_KEY = ed25519.getPublicKey(PRIVATE_KEY_SEED);
const ANCHOR = "a".repeat(64);

interface LocalIssueInput {
	readonly anchor: string;
	readonly author: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly protocolMajor: number;
}

interface LocalVertexIssuer {
	issue(input: LocalIssueInput): Readonly<Record<string, unknown>>;
}

interface ExpectedIssuanceApi {
	createLocalVertexIssuer(options: { readonly privateKeySeed: Uint8Array }): LocalVertexIssuer;
}

function issuanceApi(): ExpectedIssuanceApi {
	const candidate = protocolV2 as typeof protocolV2 & Partial<ExpectedIssuanceApi>;
	expect(
		candidate.createLocalVertexIssuer,
		"Phase 0g(ii) must own a v2 local issuer; the legacy LocalMutationLane is not a signed-sequence issuer"
	).toBeTypeOf("function");
	return candidate as typeof protocolV2 & ExpectedIssuanceApi;
}

function issueInput(objectId: string, author: string, ordinal: number): LocalIssueInput {
	return {
		anchor: ANCHOR,
		author,
		dependencies: [ANCHOR],
		epoch: 0,
		logicalTime: ordinal + 1,
		objectId,
		operation: { action: "append", ordinal },
		protocolMajor: 2,
	};
}

function bytes(value: unknown, label: string): Uint8Array {
	expect(value, label).toBeInstanceOf(Uint8Array);
	return value as Uint8Array;
}

describe("Phase 0g(ii) local signed-sequence issuance", () => {
	it("issues gapless stable sequences per (objectId, author) under a seed-pinned interleaving", () => {
		const issuer = issuanceApi().createLocalVertexIssuer({ privateKeySeed: PRIVATE_KEY_SEED });
		const scopes = [
			{ objectId: "room-a", author: "alice" },
			{ objectId: "room-a", author: "bob" },
			{ objectId: "room-b", author: "alice" },
		] as const;
		const scheduled = scopes.flatMap((scope) => Array.from({ length: 8 }, (_, ordinal) => ({ ...scope, ordinal })));
		const random = new SeededRandom(0x0_0a_02);
		const shuffled = random.shuffle(scheduled);
		const issued = shuffled.map(({ objectId, author, ordinal }) => issuer.issue(issueInput(objectId, author, ordinal)));

		const byScope = new Map<string, number[]>();
		for (let index = 0; index < issued.length; index++) {
			const vertex = issued[index] as Readonly<Record<string, unknown>>;
			const scheduledVertex = shuffled[index];
			expect(scheduledVertex).toBeDefined();
			const key = `${scheduledVertex?.objectId}\u0000${scheduledVertex?.author}`;
			const sequence = vertex.authorSequence;
			expect(Number.isSafeInteger(sequence), `seed=0x0a02 index=${index}`).toBe(true);
			expect(sequence, `seed=0x0a02 index=${index}`).toBeGreaterThanOrEqual(0);
			const values = byScope.get(key) ?? [];
			values.push(sequence as number);
			byScope.set(key, values);

			const hash = protocolV2.vertexDigest(vertex as never);
			expect(protocolV2.verifyVertexHash(vertex), `seed=0x0a02 index=${index}`).toBe(true);
			expect(
				protocolV2.verifyRegisteredSignature({
					expectedScope: { anchor: ANCHOR, domain: "ts-drp/vertex/v2" },
					publicKey: { bytes: PUBLIC_KEY, format: "raw" },
					registeredDigest: {
						anchor: ANCHOR,
						bytes: hash,
						domain: "ts-drp/vertex/v2",
					},
					signature: bytes(vertex.signature, `seed=0x0a02 index=${index} signature`),
					suiteId: "ed25519-sha256-v1",
				}),
				`seed=0x0a02 index=${index} signature`
			).toBe(true);
		}

		const firstValues = new Set<number>();
		for (const [scope, values] of byScope) {
			const first = values[0];
			expect(first, `${scope}: registry correction must select initial ordinal 0 or 1`).toSatisfy(
				(value: unknown) => value === 0 || value === 1
			);
			firstValues.add(first as number);
			expect(values, scope).toEqual(Array.from({ length: values.length }, (_, index) => (first as number) + index));
		}
		expect(firstValues.size, "independent scopes must use the same selected initial ordinal").toBe(1);

		const retained = issued.map((vertex) => ({
			hash: vertex.hash,
			sequence: vertex.authorSequence,
			signature: new Uint8Array(bytes(vertex.signature, "retained signature")),
		}));
		for (const scope of scopes) {
			issuer.issue(issueInput(scope.objectId, scope.author, 99));
		}
		expect(
			issued.map((vertex) => ({
				hash: vertex.hash,
				sequence: vertex.authorSequence,
				signature: bytes(vertex.signature, "stable signature"),
			}))
		).toEqual(retained);
	});

	it("does not share a counter across objects or authors", () => {
		const issuer = issuanceApi().createLocalVertexIssuer({ privateKeySeed: PRIVATE_KEY_SEED });
		const a0 = issuer.issue(issueInput("room-a", "alice", 0));
		const a1 = issuer.issue(issueInput("room-a", "alice", 1));
		const b0 = issuer.issue(issueInput("room-b", "alice", 0));
		const c0 = issuer.issue(issueInput("room-a", "bob", 0));

		expect(a1.authorSequence).toBe((a0.authorSequence as number) + 1);
		expect(b0.authorSequence).toBe(a0.authorSequence);
		expect(c0.authorSequence).toBe(a0.authorSequence);
		expect(new Set([a0.hash, a1.hash, b0.hash, c0.hash]).size).toBe(4);
	});
});
