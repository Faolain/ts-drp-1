/**
 * Standing mutation probes for the Phase -1 gates. Each deliberately broken
 * implementation represents a production failure the real gate must reject.
 *
 * Findings from equivalent mutations, kept for the record:
 * - Removing `typeof value !== "number"` beside `!Number.isSafeInteger(value)`
 *   is NOT a bug: `Number.isSafeInteger` is already false for every non-number.
 * - Replacing the scalar `-0` normalization result `0` with `+0` is NOT a bug:
 *   those are the same Number value and canonical bytes.
 * - Most u32/u64 range-guard mutants in hash.ts are unreachable through the
 *   public API: TextEncoder and Uint8Array byteLength supply non-negative
 *   integers, and current engines cannot allocate a string/array near 2^32 or
 *   Number.MAX_SAFE_INTEGER bytes. Empty-length rejection is observable and is
 *   probed below; the unreachable guards remain documented, not called killed.
 */
import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
	type AdmissionContext,
	admitVertex,
	encodeCanonical,
	hashDomain,
	makeRegistryPreimageBuilder,
	quorumSize,
	type RegistryDocument,
	verifyVertexHash,
} from "../src/index.js";

type BuilderFactory = typeof makeRegistryPreimageBuilder;
type DomainHasher = (domain: string, ...parts: readonly Uint8Array[]) => Uint8Array;
type Encoder = (value: unknown) => Uint8Array;
type Quorum = (signerCount: number, callerFaultBound?: number) => number;

function expectGateToCatch(runGate: () => void): void {
	let caught: Error | undefined;
	try {
		runGate();
	} catch (error) {
		caught = error as Error;
	}
	expect(caught).toBeDefined();
}

function registryConsultationGate(factory: BuilderFactory): void {
	const document = {
		registryVersion: 1,
		domains: { probe: "ts-drp/probe/v2" },
		quorum: { q: "ceil(2*n/3)", f: "floor((n-1)/3)", callerSuppliedMaxByzantine: false },
		kinds: {
			probe: {
				domain: "ts-drp/probe/v2",
				encoding: "canonical",
				fields: [
					{ name: "base", type: "string", const: null, constraints: {}, required: true, sortRule: null },
					{ name: "registryOnly", type: "string", const: null, constraints: {}, required: true, sortRule: null },
				],
			},
		},
	} satisfies RegistryDocument;
	const output = factory(document, "probe")({ base: "a", registryOnly: "b" });
	if (output.registryOnly !== "b" || Object.keys(output).join(",") !== "base,registryOnly") {
		throw new Error("registry-driven builder ignored the registered field sequence");
	}
}

function sortRuleGate(factory: BuilderFactory): void {
	const document = {
		registryVersion: 1,
		domains: { probe: "ts-drp/probe/v2" },
		quorum: { q: "ceil(2*n/3)", f: "floor((n-1)/3)", callerSuppliedMaxByzantine: false },
		kinds: {
			probe: {
				domain: "ts-drp/probe/v2",
				encoding: "canonical",
				fields: [
					{
						name: "values",
						type: "array<canonical-value>",
						const: null,
						constraints: {},
						required: true,
						sortRule: "codepoint",
					},
				],
			},
		},
	} satisfies RegistryDocument;
	const output = factory(document, "probe")({ values: ["ä", "A", "_"] });
	if ((output.values as string[]).join(",") !== "A,_,ä") throw new Error("registered sortRule was ignored");
}

function hashFramingGate(hasher: DomainHasher): void {
	const emptyPart = new Uint8Array();
	if (!bytesEqual(hasher("", emptyPart), hashDomain("", emptyPart))) {
		throw new Error("hash framing magic, domain, or empty-part length drifted");
	}
	if (bytesEqual(hasher("ts-drp/a/v2", emptyPart), hasher("ts-drp/b/v2", emptyPart))) {
		throw new Error("domain separation is decorative");
	}
}

function negativeZeroGate(encoder: Encoder): void {
	if (!bytesEqual(encoder(Float32Array.of(-0)), encoder(Float32Array.of(+0)))) {
		throw new Error("Float32Array -0 was not normalized");
	}
}

function admissionOrderingGate(admit: typeof admitVertex): void {
	let digestReads = 0;
	const context: AdmissionContext = {
		currentAnchor: "0".repeat(64),
		currentEpoch: 1,
		maxBytes: 100,
		maxDependencies: 1,
		objectId: "right-room",
		protocolMajor: 2,
	};
	const vertex = {
		anchor: "0".repeat(64),
		author: "peer-a",
		dependencies: ["0".repeat(64)],
		encodedByteLength: 1,
		epoch: 1,
		get operation(): Readonly<Record<string, unknown>> {
			digestReads++;
			return {};
		},
		hash: "0".repeat(64),
		kind: "drp-vertex",
		logicalTime: 1,
		objectId: "wrong-room",
		protocolMajor: 2,
	};
	admit(vertex, context, {
		isAncestor: () => false,
		resolveDependencies: () => [],
	});
	if (digestReads !== 0) throw new Error("vertex was hashed before identity admission");
}

function quorumGate(quorum: Quorum): void {
	if (quorum(4) !== 3 || quorum(5) !== 4) throw new Error("quorum is not ceil(2*n/3)");
	if (quorum(4, 0) !== 3) throw new Error("caller-supplied fault bound changed consensus quorum");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

describe("protocol-v2 standing mutation checks", () => {
	it("catches a preimage builder that stops consulting the registry", () => {
		// Real-world failure: a frozen registry becomes decorative while a handwritten preimage silently omits new consensus fields.
		const hardCodedBuilder: BuilderFactory = () => (input) => Object.freeze({ base: input.base });
		expectGateToCatch(() => registryConsultationGate(hardCodedBuilder));
	});

	it("catches a builder that reads and ignores sortRule", () => {
		// Real-world failure: replicas hash caller insertion order even though the registry declares canonical codepoint order.
		const ignoreSortRule: BuilderFactory = (document, kind) => {
			const cloned = structuredClone(document) as RegistryDocument;
			const definition = cloned.kinds[kind];
			if (definition === undefined) throw new Error(`missing seeded registry kind ${kind}`);
			const withoutSort: RegistryDocument = {
				...cloned,
				kinds: {
					...cloned.kinds,
					[kind]: {
						...definition,
						fields: definition.fields.map((field) => ({ ...field, sortRule: null })),
					},
				},
			};
			return makeRegistryPreimageBuilder(withoutSort, kind);
		};
		expectGateToCatch(() => sortRuleGate(ignoreSortRule));
	});

	it("catches missing framing and domain separation", () => {
		// Real-world failure: two protocol domains or differently framed part lists acquire the same preimage namespace.
		const unframedHash: DomainHasher = (_domain, ...parts) =>
			sha256(Uint8Array.from(parts.flatMap((part) => [...part])));
		expectGateToCatch(() => hashFramingGate(unframedHash));
	});

	it("catches Float32Array negative-zero leakage", () => {
		// Real-world failure: peers serialize numerically equal zeros to different consensus bytes.
		const leakFloat32NegativeZero: Encoder = (value) => {
			if (!(value instanceof Float32Array)) return encodeCanonical(value);
			const output = new Uint8Array(2 + value.length * 4);
			output.set([0x0b, value.length], 0);
			const view = new DataView(output.buffer);
			for (let index = 0; index < value.length; index++) {
				view.setFloat32(2 + index * 4, value[index] as number, false);
			}
			return output;
		};
		expectGateToCatch(() => negativeZeroGate(leakFloat32NegativeZero));
	});

	it("catches hashing before the identity check", () => {
		// Real-world failure: unauthenticated wrong-room traffic consumes digest work before fail-closed identity admission.
		const hashFirst: typeof admitVertex = (vertex, context, hooks) => {
			verifyVertexHash(vertex);
			return admitVertex(vertex, context, hooks);
		};
		expectGateToCatch(() => admissionOrderingGate(hashFirst));
	});

	it("catches a floor quorum and a caller-supplied fault bound", () => {
		// Real-world failure: different callers certify different quorums for the same signer set.
		const callerControlledQuorum: Quorum = (signerCount, faultBound) =>
			faultBound === undefined ? Math.floor((2 * signerCount) / 3) : signerCount - faultBound;
		expectGateToCatch(() => quorumGate(callerControlledQuorum));
		expect(() => quorumGate((signerCount) => quorumSize(signerCount))).not.toThrow();
	});
});
