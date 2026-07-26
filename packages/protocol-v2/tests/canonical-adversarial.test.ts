import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import {
	type AdmissionContext,
	admitVertex,
	decodeCanonical,
	encodeCanonical,
	type QcVote,
	quorumCertificateBytes,
	type Signer,
	signerSetBytes,
	vertexDigest,
} from "../src/index.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);

const context: AdmissionContext = {
	currentAnchor: ZERO_DIGEST,
	currentEpoch: 4,
	maxBytes: 1024,
	maxDependencies: 16,
	objectId: "room-a",
	protocolMajor: 2,
};

function utf8Compare(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
	const shuffled = [...values];
	let state = seed >>> 0;
	for (let index = shuffled.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const target = state % (index + 1);
		[shuffled[index], shuffled[target]] = [shuffled[target] as T, shuffled[index] as T];
	}
	return shuffled;
}

function makeVote(signerId: string): QcVote {
	return {
		epoch: 4,
		objectId: "room-a",
		phase: "prepare",
		proposalDigest: ZERO_DIGEST,
		proposalHash: ONE_DIGEST,
		round: 2,
		signature: `sig-${signerId}`,
		signerId,
	};
}

function admissionEnvelope(
	fields: Readonly<Record<string, unknown>>,
	encodedByteLength = 128
): Readonly<Record<string, unknown>> {
	return {
		...fields,
		hash: Buffer.from(vertexDigest(fields as never)).toString("hex"),
		encodedByteLength,
	};
}

describe("Phase -1b canonical adversarial cases", () => {
	it("D1 property: signer-set bytes follow UTF-8 Buffer order under hostile localeCompare", () => {
		const ids = ["peer-B", "peer-a", "Peer-a", "peer_a", "peerä", "peer-😀"];
		const localeSpy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
			this: string,
			other: string
		): number {
			return -utf8Compare(String(this), other);
		});
		try {
			for (let seed = 1; seed <= 64; seed++) {
				const shuffled = deterministicShuffle(ids, seed);
				const signers: Signer[] = shuffled.map((signerId) => ({ publicKey: `pk-${signerId}`, signerId }));
				const expected = [...signers].sort((left, right) => utf8Compare(left.signerId, right.signerId));
				expect(signerSetBytes(signers)).toEqual(signerSetBytes(expected));
			}
		} finally {
			localeSpy.mockRestore();
		}
	});

	it("D1 property: QC bytes follow UTF-8 Buffer order under hostile localeCompare", () => {
		const ids = ["peer-B", "peer-a", "Peer-a", "peer_a", "peerä", "peer-😀"];
		const localeSpy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
			this: string,
			other: string
		): number {
			return -utf8Compare(String(this), other);
		});
		try {
			for (let seed = 65; seed <= 128; seed++) {
				const votes = deterministicShuffle(ids, seed).map(makeVote);
				const expectedVotes = [...votes].sort((left, right) => utf8Compare(left.signerId, right.signerId));
				const certificate = {
					epoch: 4,
					objectId: "room-a",
					phase: "prepare" as const,
					proposalDigest: ZERO_DIGEST,
					proposalHash: ONE_DIGEST,
					round: 2,
					votes,
				};
				expect(quorumCertificateBytes(certificate)).toEqual(
					quorumCertificateBytes({ ...certificate, votes: expectedVotes })
				);
			}
		} finally {
			localeSpy.mockRestore();
		}
	});

	it("D1 rejects signerId control characters, including NUL vote-key smuggling", () => {
		expect(() => signerSetBytes([{ publicKey: "pk", signerId: "peer\u0000forged" }])).toThrowError(
			/control character/i
		);
	});

	it("D2 normalizes Float32Array negative zero and decodes both encodings", () => {
		const negative = encodeCanonical(Float32Array.of(-0));
		const positive = encodeCanonical(Float32Array.of(+0));

		expect(negative).toEqual(positive);
		expect(decodeCanonical(negative)).toEqual(Float32Array.of(0));
		expect(decodeCanonical(positive)).toEqual(Float32Array.of(0));
	});

	it("D3 rejects syntactic or limit failures before identity, digest, and dependencies", () => {
		const resolveDependencies = vi.fn(() => []);
		const result = admitVertex({ encodedByteLength: 1025, objectId: "room-a", protocolMajor: 2, epoch: 4 }, context, {
			isAncestor: () => false,
			resolveDependencies,
		});

		expect(result).toMatchObject({ status: "terminal", code: "LIMIT_EXCEEDED" });
		expect(resolveDependencies).not.toHaveBeenCalled();
	});

	it("D3 rejects wrong-room identity before invoking the digest", () => {
		const resolveDependencies = vi.fn(() => []);
		const result = admitVertex(
			{
				anchor: ZERO_DIGEST,
				author: "peer-a",
				dependencies: [ZERO_DIGEST],
				encodedByteLength: 128,
				epoch: 4,
				hash: ONE_DIGEST,
				kind: "drp-vertex",
				logicalTime: 1,
				objectId: "wrong-room",
				operation: { op: "set" },
				protocolMajor: 2,
			},
			context,
			{ isAncestor: () => false, resolveDependencies }
		);

		expect(result).toMatchObject({ status: "terminal", code: "WRONG_OBJECT" });
		expect(resolveDependencies).not.toHaveBeenCalled();
	});

	it("D3 evaluates the package digest after identity and before dependencies for an eligible input", () => {
		const calls: string[] = [];
		const parent = admissionEnvelope({
			kind: "drp-vertex",
			protocolMajor: 2,
			objectId: "room-a",
			epoch: 4,
			anchor: ZERO_DIGEST,
			author: "peer-a",
			logicalTime: 1,
			dependencies: [ZERO_DIGEST],
			operation: { op: "parent" },
		});
		const vertex = admissionEnvelope({
			kind: "drp-vertex",
			protocolMajor: 2,
			objectId: "room-a",
			epoch: 4,
			anchor: ZERO_DIGEST,
			author: "peer-a",
			logicalTime: 2,
			dependencies: [parent.hash],
			operation: { op: "child" },
		});
		const result = admitVertex(vertex, context, {
			resolveDependencies: () => {
				calls.push("dependencies");
				return [parent];
			},
			isAncestor: () => false,
		});

		expect(calls).toEqual(["dependencies"]);
		expect(result.status).toBe("accept");
	});
});
