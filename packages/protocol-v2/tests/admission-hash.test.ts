import { describe, expect, it, vi } from "vitest";

import { type AdmissionContext, admitVertex } from "../src/index.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);

describe("B1 fail-closed vertex digest admission", () => {
	it("rejects a declared hash that differs from the computed vertex digest before dependency work", () => {
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
				objectId: "room-a",
				operation: { op: "set" },
				protocolMajor: 2,
			},
			{
				currentAnchor: ZERO_DIGEST,
				currentEpoch: 4,
				maxBytes: 1024,
				maxDependencies: 16,
				objectId: "room-a",
				protocolMajor: 2,
			},
			{
				isAncestor: () => false,
				resolveDependencies,
			}
		);

		expect(result).toEqual({ status: "terminal", code: "INVALID_HASH" });
		expect(resolveDependencies).not.toHaveBeenCalled();
	});

	it("matches the pinned oracle's INVALID_HASH classification for a tampered vertex", async () => {
		const protocolPath: string = "../conformance/ahe-reference/src/protocol.js";
		const admissionPath: string = "../conformance/ahe-reference/src/admission.js";
		const referenceProtocol = (await import(protocolPath)) as {
			createUnsignedVertex(fields: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
		};
		const referenceAdmission = (await import(admissionPath)) as {
			classifyVertex(
				vertex: Readonly<Record<string, unknown>>,
				context: Readonly<Record<string, unknown>>
			): Promise<Readonly<Record<string, unknown>>>;
		};
		const valid = await referenceProtocol.createUnsignedVertex({
			anchor: ZERO_DIGEST,
			author: "peer-a",
			dependencies: [ZERO_DIGEST],
			epoch: 4,
			logicalTime: 1,
			objectId: "room-a",
			operation: { op: "set" },
			protocolMajor: 2,
		});
		const computedHash = valid.hash as string;
		const tampered = { ...valid, encodedByteLength: 128, hash: computedHash === ONE_DIGEST ? ZERO_DIGEST : ONE_DIGEST };
		const context: AdmissionContext = {
			currentAnchor: ZERO_DIGEST,
			currentEpoch: 4,
			maxBytes: 1024,
			maxDependencies: 16,
			objectId: "room-a",
			protocolMajor: 2,
		};

		const oracle = await referenceAdmission.classifyVertex(tampered, {
			activeVertices: new Map(),
			batchVertices: new Map(),
			currentAnchor: ZERO_DIGEST,
			currentEpoch: 4,
			objectId: "room-a",
			parameters: { maxDependencies: 16 },
			protocolMajor: 2,
			suppliedDependencies: new Map(),
		});
		const candidate = admitVertex(tampered, context, {
			isAncestor: () => false,
			resolveDependencies: () => [],
		});

		expect(oracle).toMatchObject({ status: "terminal", code: "INVALID_HASH" });
		expect(candidate).toEqual(oracle);
	});
});
