import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import { prepareTestAdmissionContext } from "./admission-context-fixture.js";
import {
	type AdmissionHooks,
	type AdmissionResult,
	admitVertex,
	digestRegistryPreimage,
	type SignaturePublicKey,
	signIdentityDigest,
	vertexDigest,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const IDENTITY_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const IDENTITY_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(IDENTITY_SEED),
	format: "raw",
};
const registry = protocolRegistry();
const parameters = {
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
} as const;

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function epochAnchor(): Readonly<Record<string, unknown>> {
	const preimage = {
		kind: "drp-epoch-anchor",
		protocolMajor: 2,
		objectId: "room-a",
		epoch: 4,
		previousAnchor: ZERO_DIGEST,
		cutDigest: ONE_DIGEST,
		stateDigest: ZERO_DIGEST,
		aclDigest: ONE_DIGEST,
		historyRoot: ZERO_DIGEST,
		historySize: 0,
		archiveIndexRoot: ONE_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		signerSetDigest: ONE_DIGEST,
		parametersDigest: hex(digestRegistryPreimage(registry, "parameters", parameters)),
		profileDigest: ONE_DIGEST,
		cryptoSuiteId: "ed25519-sha256-v1",
	};
	return {
		...preimage,
		hash: hex(digestRegistryPreimage(registry, "epochAnchor", preimage)),
	};
}

const currentEpochAnchor = epochAnchor();
const currentAnchor = currentEpochAnchor.hash as string;

function signedVertex(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	const preimage = {
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "room-a",
		epoch: 4,
		anchor: currentAnchor,
		author: "peer-a",
		logicalTime: 1,
		dependencies: [currentAnchor],
		operation: { action: "set", key: "greeting", value: "hello" },
		...overrides,
	};
	const digest = vertexDigest(preimage as never);
	return {
		...preimage,
		hash: hex(digest),
		signature: signIdentityDigest(IDENTITY_SEED, digest),
	};
}

function vertexWithIdentity(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return { ...signedVertex(), ...overrides };
}

const context = prepareTestAdmissionContext({
	cryptoSuiteId: "ed25519-sha256-v1",
	currentAnchor,
	currentEpoch: 4,
	currentEpochAnchor,
	isAncestor: () => false,
	objectId: "room-a",
	parameters,
	protocolMajor: 2,
});

const hooks: AdmissionHooks = {
	authorize: () => true,
	isDependencyAccepted: () => true,
	resolveAuthorPublicKey: () => IDENTITY_PUBLIC_KEY,
	resolveDependencies: (dependencies) =>
		dependencies.map((hash) => (hash === currentAnchor ? currentEpochAnchor : undefined)),
	validateDeterministicInvariant: () => true,
	validateOperationSchema: () => true,
};

type Relation = "<" | "=" | ">" | "malformed";
type ExpectedClassification = Readonly<Pick<AdmissionResult, "latchByHash" | "status">>;

const protocolValues = {
	"<": 1,
	"=": 2,
	">": 3,
	"malformed": "2",
} as const satisfies Record<Relation, unknown>;
const epochValues = {
	"<": 3,
	"=": 4,
	">": 5,
	"malformed": "4",
} as const satisfies Record<Relation, unknown>;
const anchorValues = {
	"<": ZERO_DIGEST,
	"=": currentAnchor,
	">": "f".repeat(64),
	"malformed": 4,
} as const satisfies Record<Relation, unknown>;
const relations = ["<", "=", ">", "malformed"] as const;

function expectedClassification(protocol: Relation, epoch: Relation, anchor: Relation): ExpectedClassification {
	if (protocol === ">") return { status: "pending", latchByHash: false };
	if (protocol !== "=") return { status: "terminal", latchByHash: false };
	if (epoch === ">") return { status: "pending", latchByHash: false };
	if (epoch !== "=") return { status: "terminal", latchByHash: false };
	if (anchor !== "=") return { status: "terminal", latchByHash: false };
	return { status: "accept", latchByHash: false };
}

describe("Phase 0f admission classifier", () => {
	it("uses only the fail-closed accept/pending/terminal/quarantine vocabulary", () => {
		const classifications: AdmissionResult[] = [
			admitVertex(signedVertex(), context, hooks),
			admitVertex(vertexWithIdentity({ protocolMajor: 3 }), context, hooks),
			admitVertex(vertexWithIdentity({ protocolMajor: 1 }), context, hooks),
			admitVertex({ ...signedVertex(), transportLocal: true }, context, hooks),
		];

		expect(classifications.map(({ status }) => status)).toEqual(["accept", "pending", "terminal", "quarantine"]);
		expect(new Set(classifications.map(({ status }) => status))).toEqual(
			new Set<AdmissionResult["status"]>(["accept", "pending", "terminal", "quarantine"])
		);
	});

	it("exhaustively classifies the exact protocol/epoch/anchor relation cross-product", () => {
		const corpus = relations.flatMap((protocol) =>
			relations.flatMap((epoch) =>
				relations.map((anchor) => {
					const result = admitVertex(
						vertexWithIdentity({
							protocolMajor: protocolValues[protocol],
							epoch: epochValues[epoch],
							anchor: anchorValues[anchor],
						}),
						context,
						hooks
					);
					return {
						anchor,
						epoch,
						latchByHash: result.latchByHash,
						protocol,
						status: result.status,
					};
				})
			)
		);

		expect(corpus).toHaveLength(4 ** 3);
		expect(corpus).toEqual(
			relations.flatMap((protocol) =>
				relations.flatMap((epoch) =>
					relations.map((anchor) => ({
						anchor,
						epoch,
						...expectedClassification(protocol, epoch, anchor),
						protocol,
					}))
				)
			)
		);
	});
});

type _ClassifierVocabularyIsClosed = AdmissionResult["status"] extends "accept" | "pending" | "terminal" | "quarantine"
	? true
	: never;
