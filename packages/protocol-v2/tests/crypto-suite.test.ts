import { describe, expect, it } from "vitest";

import registryJson from "../registry/field-registry.json" with { type: "json" };
import {
	cryptoSuiteStatus,
	makeRegistryPreimageBuilder,
	negotiateGenesisCryptoSuite,
	type RegistryDocument,
} from "../src/index.js";

const ACTIVE_SUITE_IDS = ["ed25519-sha256-v1", "ed25519-seal-v1"] as const;
const RESERVED_SUITE_ID = "p256-sha256-v1";
const ZERO_DIGEST = "0".repeat(64);

function epochAnchor(cryptoSuiteId: string): Readonly<Record<string, unknown>> {
	return {
		objectId: "room-a",
		epoch: 0,
		previousAnchor: ZERO_DIGEST,
		cutDigest: ZERO_DIGEST,
		stateDigest: ZERO_DIGEST,
		aclDigest: ZERO_DIGEST,
		historyRoot: ZERO_DIGEST,
		historySize: 0,
		archiveIndexRoot: ZERO_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		signerSetDigest: ZERO_DIGEST,
		parametersDigest: ZERO_DIGEST,
		profileDigest: ZERO_DIGEST,
		cryptoSuiteId,
	};
}

function captureError(run: () => unknown): unknown {
	try {
		run();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("Phase -1e(i) cryptoSuiteId", () => {
	it("rejects an epoch anchor naming an unenumerated suite", () => {
		const buildAnchor = makeRegistryPreimageBuilder(registryJson as RegistryDocument, "epochAnchor");

		expect(() => buildAnchor(epochAnchor("rsa-pss-sha256-v1"))).toThrow(/cryptoSuiteId.*one of/i);
	});

	it("enumerates active and reserved suites and marks negotiation genesis-only", () => {
		for (const kind of ["epochAnchor", "profile"]) {
			const suiteField = (registryJson as RegistryDocument).kinds[kind]?.fields.find(
				(field) => field.name === "cryptoSuiteId"
			);
			expect(suiteField).toMatchObject({
				type: "enum",
				constraints: {
					negotiatedAt: "genesis-only",
					reservedValues: [RESERVED_SUITE_ID],
					values: ACTIVE_SUITE_IDS,
				},
			});
		}
	});

	it.each(ACTIVE_SUITE_IDS)("negotiates the genesis-named active suite %s without substitution", (suiteId) => {
		expect(
			negotiateGenesisCryptoSuite({
				namedSuiteId: suiteId,
				peerSuiteIds: [...ACTIVE_SUITE_IDS],
			})
		).toBe(suiteId);
	});

	it("rejects a peer lacking the genesis-named suite with UNSUPPORTED_PROFILE", () => {
		const error = captureError(() =>
			negotiateGenesisCryptoSuite({
				namedSuiteId: "ed25519-seal-v1",
				peerSuiteIds: ["ed25519-sha256-v1"],
			})
		);

		expect(error).toMatchObject({ code: "UNSUPPORTED_PROFILE" });
	});

	it("recognises p256-sha256-v1 as reserved and refuses to negotiate it", () => {
		const error = captureError(() =>
			negotiateGenesisCryptoSuite({
				namedSuiteId: RESERVED_SUITE_ID,
				peerSuiteIds: [RESERVED_SUITE_ID],
			})
		);

		expect(error).toMatchObject({
			code: "UNSUPPORTED_PROFILE",
			suiteStatus: "reserved",
		});
	});

	it("classifies the production registry's active, reserved, and unknown suites", () => {
		expect(cryptoSuiteStatus("ed25519-sha256-v1")).toBe("active");
		expect(cryptoSuiteStatus("ed25519-seal-v1")).toBe("active");
		expect(cryptoSuiteStatus("p256-sha256-v1")).toBe("reserved");
		expect(cryptoSuiteStatus("rsa-pss-sha256-v1")).toBe("unknown");
	});

	it("rejects a cross-kind crypto-suite enumeration mismatch", () => {
		const document = structuredClone(registryJson) as RegistryDocument;
		const profileSuite = document.kinds.profile?.fields.find(({ name }) => name === "cryptoSuiteId");
		if (profileSuite === undefined) throw new Error("profile cryptoSuiteId fixture is missing");
		(profileSuite.constraints as Record<string, unknown>).values = ["ed25519-sha256-v1"];

		expect(() => cryptoSuiteStatus("ed25519-sha256-v1", document)).toThrow(
			/epochAnchor and profile crypto suite enumerations must match/i
		);
	});
});
