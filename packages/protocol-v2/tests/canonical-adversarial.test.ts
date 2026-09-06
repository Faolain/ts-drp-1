import { ed25519 } from "@noble/curves/ed25519.js";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { makeAdmissionContext } from "./admission-context-fixture.js";
import {
	type AdmissionHooks,
	admitVertex,
	decodeCanonical,
	encodeCanonical,
	type PreparedAdmissionContext,
	type QcVote,
	quorumCertificateBytes,
	type SignaturePublicKey,
	type Signer,
	signerSetBytes,
	signIdentityDigest,
	vertexDigest,
} from "../src/index.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const ADMISSION_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ADMISSION_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(ADMISSION_SEED),
	format: "raw",
};

const context: PreparedAdmissionContext = makeAdmissionContext({ objectId: "room-a" });

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

function admissionEnvelope(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const digest = vertexDigest(fields as never);
	return {
		...fields,
		hash: Buffer.from(digest).toString("hex"),
		signature: signIdentityDigest(ADMISSION_SEED, digest),
	};
}

function admissionHooks(resolveDependencies: AdmissionHooks["resolveDependencies"] = () => []): AdmissionHooks {
	return {
		authorize: () => true,
		isDependencyAccepted: () => true,
		resolveAuthorPublicKey: () => ADMISSION_PUBLIC_KEY,
		resolveDependencies,
		validateDeterministicInvariant: () => true,
		validateOperationSchema: () => true,
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

	it("D3 quarantines embedded transport measurement before identity, digest, and dependencies", () => {
		const resolveDependencies = vi.fn(() => []);
		const otherwiseExact = admissionEnvelope({
			anchor: context.currentAnchor,
			author: "peer-a",
			dependencies: [context.currentAnchor],
			epoch: 4,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: "room-a",
			operation: { op: "set" },
			protocolMajor: 2,
		});
		const result = admitVertex({ ...otherwiseExact, encodedByteLength: 1025 }, context, {
			...admissionHooks(),
			resolveDependencies,
		});

		expect(result).toEqual({
			status: "quarantine",
			code: "NON_CANONICAL_ENVELOPE",
			latchByHash: false,
		});
		expect(resolveDependencies).not.toHaveBeenCalled();
	});

	it("D3 rejects wrong-room identity before invoking the digest", () => {
		const resolveDependencies = vi.fn(() => []);
		const result = admitVertex(
			{
				anchor: context.currentAnchor,
				author: "peer-a",
				dependencies: [ZERO_DIGEST],
				epoch: 4,
				hash: ONE_DIGEST,
				kind: "drp-vertex",
				logicalTime: 1,
				objectId: "wrong-room",
				operation: { op: "set" },
				protocolMajor: 2,
			},
			context,
			{ ...admissionHooks(), resolveDependencies }
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
			anchor: context.currentAnchor,
			author: "peer-a",
			logicalTime: 1,
			dependencies: [context.currentAnchor],
			operation: { op: "parent" },
		});
		const vertex = admissionEnvelope({
			kind: "drp-vertex",
			protocolMajor: 2,
			objectId: "room-a",
			epoch: 4,
			anchor: context.currentAnchor,
			author: "peer-a",
			logicalTime: 2,
			dependencies: [parent.hash],
			operation: { op: "child" },
		});
		const result = admitVertex(
			vertex,
			context,
			admissionHooks(() => {
				calls.push("dependencies");
				return [parent];
			})
		);

		expect(calls).toEqual(["dependencies"]);
		expect(result.status).toBe("accept");
	});
});
