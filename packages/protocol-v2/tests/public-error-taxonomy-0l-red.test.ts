import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import { makeAdmissionContext } from "./admission-context-fixture.js";
import {
	type AdmissionHooks,
	admitVertex,
	prepareAdmissionContext,
	quorumCertificateBytes,
	type SignaturePublicKey,
	signIdentityDigest,
	vertexDigest,
} from "../src/index.js";
import * as protocolRoot from "../src/index.js";

type ErrorRoot = {
	DRP_ERROR_CODES: readonly string[];
	isDRPError(value: unknown): boolean;
};

const errorRootSpecifier = "@ts-drp/errors";
const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const IDENTITY_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const IDENTITY_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(IDENTITY_SEED),
	format: "raw",
};

async function loadErrorRoot(): Promise<ErrorRoot> {
	return (await import(errorRootSpecifier)) as ErrorRoot;
}

function capture(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected action to throw");
}

async function expectCataloguedRootError(error: unknown, code: string): Promise<void> {
	const errors = await loadErrorRoot();

	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({ code });
	expect(errors.DRP_ERROR_CODES).toContain(code);
	expect(errors.isDRPError(error)).toBe(true);
	expect(Object.values(protocolRoot)).toContain((error as Error).constructor);
}

function validVertex(context: ReturnType<typeof makeAdmissionContext>): Readonly<Record<string, unknown>> {
	const preimage = {
		anchor: context.currentAnchor,
		author: "peer-a",
		dependencies: [context.currentAnchor],
		epoch: context.currentEpoch,
		kind: "drp-vertex",
		logicalTime: 1,
		objectId: context.objectId,
		operation: { action: "set", value: 1 },
		protocolMajor: context.protocolMajor,
	};
	const digest = vertexDigest(preimage);
	return {
		...preimage,
		hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		signature: signIdentityDigest(IDENTITY_SEED, digest),
	};
}

function validHooks(
	context: ReturnType<typeof makeAdmissionContext>,
	validateOperationSchema: AdmissionHooks["validateOperationSchema"]
): AdmissionHooks {
	return {
		authorize: () => true,
		isDependencyAccepted: () => true,
		resolveAuthorPublicKey: () => IDENTITY_PUBLIC_KEY,
		resolveDependencies: () => [context.currentEpochAnchor],
		validateDeterministicInvariant: () => true,
		validateOperationSchema,
	};
}

describe("Phase 0l protocol-v2 public error taxonomy RED", () => {
	it("replaces EMPTY_QC and MIXED_QC message prefixes with root-importable coded classes", async () => {
		const certificate = {
			epoch: 1,
			objectId: "phase-0l",
			phase: "prepare" as const,
			proposalDigest: ZERO_DIGEST,
			proposalHash: ONE_DIGEST,
			round: 1,
			votes: [],
		};
		const empty = capture(() => quorumCertificateBytes(certificate));
		const mixed = capture(() =>
			quorumCertificateBytes({
				...certificate,
				votes: [
					{
						epoch: 1,
						objectId: "phase-0l",
						phase: "prepare",
						proposalDigest: ONE_DIGEST,
						proposalHash: ONE_DIGEST,
						round: 1,
						signature: "signature",
						signerId: "signer",
					},
				],
			})
		);

		await expectCataloguedRootError(empty, "EMPTY_QC");
		await expectCataloguedRootError(mixed, "MIXED_QC");
	});

	it("registers the existing root-importable UNSUPPORTED_PROFILE class", async () => {
		const UnsupportedProfileError = Reflect.get(protocolRoot, "UnsupportedProfileError") as new (
			...args: unknown[]
		) => Error;
		const error = new UnsupportedProfileError("requested", ["available"]);

		await expectCataloguedRootError(error, "UNSUPPORTED_PROFILE");
	});
});

describe("Phase 0l protocol-v2 preservation controls", () => {
	it("keeps exact preparation and admission result keysets", () => {
		const preparation = prepareAdmissionContext({} as never);
		const admission = admitVertex({}, {} as never, {} as never);

		expect(preparation).toEqual({ code: "ADMISSION_CONTEXT_INVALID", ok: false });
		expect(Object.keys(preparation).sort()).toEqual(["code", "ok"]);
		expect(admission).toEqual({
			code: "ADMISSION_CONTEXT_UNPREPARED",
			latchByHash: false,
			status: "terminal",
		});
		expect(Object.keys(admission).sort()).toEqual(["code", "latchByHash", "status"]);
	});

	it("continues to propagate a raw trusted-hook throwable by exact identity", () => {
		const context = makeAdmissionContext({ objectId: "phase-0l" });
		const sentinel = new Error("raw-operation-schema-hook-0l");
		const hooks = validHooks(context, () => {
			throw sentinel;
		});

		const error = capture(() => admitVertex(validVertex(context), context, hooks));

		expect(error).toBe(sentinel);
	});
});
