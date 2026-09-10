import type { decodeSnapshotManifest } from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";
import type { SnapshotRecoveryDeclarationLookup } from "../../../packages/storage/dist/src/snapshot-transfer.js";

type Hit = Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }>;
type Decoded = ReturnType<typeof decodeSnapshotManifest>;
interface Observation {
	kind: "set" | "decoder-return";
	stack: string;
	rawSource?: boolean;
	bytes?: number;
}
interface CaseResult {
	id: string;
	controls: Record<string, boolean>;
	normative: Record<string, boolean> | null;
	observations: Observation[];
	selectorObservations: Observation[];
	value: string;
}

/**
 * Observe actual built shared/protocol owners without replacing either owner function.
 * @param instrument - Whether isolated native observation hooks are installed before import.
 * @returns Compatibility controls, ownership predicates, and reached native call stacks.
 */
export async function probe(instrument: boolean): Promise<{ instrument: boolean; results: CaseResult[] }> {
	const nativeFreeze = Object.freeze;
	const nativeSet = Uint8Array.prototype.set;
	const ownSet = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "set");
	let armed = false;
	let raw: Uint8Array | undefined;
	let decoded: Decoded[] = [];
	let observations: Observation[] = [];
	let protocolDestinations: Uint8Array[] = [];
	const freeze = <T>(value: T): Readonly<T> => {
		const result = nativeFreeze(value);
		if (
			armed &&
			value &&
			typeof value === "object" &&
			Object.keys(value).sort().join(",") === "chunks,exactCanonicalManifestBytes,manifest,manifestDigest"
		) {
			const stack = new Error("ownership freeze observation").stack ?? "";
			if (protocolDestinations.includes(Reflect.get(value, "exactCanonicalManifestBytes") as Uint8Array)) {
				decoded.push(value as unknown as Decoded);
				observations.push({ kind: "decoder-return", stack });
			}
		}
		return result;
	};
	if (instrument) {
		Object.freeze = freeze as typeof Object.freeze;
		Uint8Array.prototype.set = function (this: Uint8Array, source: ArrayLike<number>, offset?: number): void {
			if (armed) {
				const stack = new Error("ownership set observation").stack ?? "";
				if (/copyExactCarrier/.test(stack)) protocolDestinations.push(this);
				if (/copyExactCarrier|\bexactBytes\b|captureDeclaration/.test(stack))
					observations.push({ kind: "set", stack, rawSource: source === raw, bytes: source.length });
			}
			Reflect.apply(nativeSet, this, [source, offset]);
		};
	}
	try {
		const { snapshotQuarantineContract: owner } = await import(
			"../../../packages/storage/dist/src/snapshot-transfer.js"
		);
		const protocol = await import("../../../packages/protocol-v3/dist/src/snapshot-transfer.js");
		const results: CaseResult[] = [];
		for (const size of [17, 131080]) {
			const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
			const encoded = protocol.encodeSnapshotTransfer({
				objectId: "ownership-provenance",
				epoch: 1,
				schemaVersion: 1,
				anchor: "a".repeat(64),
				aclDigest: "b".repeat(64),
				stateDigest: "c".repeat(64),
				exactCanonicalPayloadBytes: new Uint8Array(size).fill(65),
				profile,
			});
			const baseline = protocol.decodeSnapshotManifest({
				exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
				expectedManifestDigest: encoded.manifestDigest,
				profile,
			});
			for (const legacy of [false, true]) {
				const scope = owner.captureScope({
					objectId: "ownership-provenance",
					epoch: 1,
					anchor: "a".repeat(64),
					manifestDigest: encoded.manifestDigest,
				});
				raw = encoded.exactCanonicalManifestBytes.slice();
				const metadata = {
					exactCanonicalManifestBytes: raw,
					totalBytes: size,
					chunkCount: baseline.chunks.length,
					descriptors: legacy ? null : baseline.chunks.map((item) => ({ ...item })),
					incarnation: "ownership-incarnation",
					state: "verified",
					retention: legacy ? "legacy-unclassified" : "recovery",
					expiresAt: 0,
				};
				const original = Array.from(raw).join(",");
				decoded = [];
				observations = [];
				protocolDestinations = [];
				armed = instrument;
				const direct = protocol.decodeSnapshotManifest({
					exactCanonicalManifestBytes: raw,
					expectedManifestDigest: encoded.manifestDigest,
					profile,
				});
				armed = false;
				const selectorControl =
					!instrument ||
					(decoded.length === 1 &&
						decoded[0] === direct &&
						protocolDestinations.length === 1 &&
						protocolDestinations[0] === direct.exactCanonicalManifestBytes);
				const selectorObservations = observations.slice();
				decoded = [];
				observations = [];
				protocolDestinations = [];
				armed = instrument;
				const first = owner.validateRecoveryManifest(scope, metadata);
				const firstReached = !instrument || (decoded.length === 1 && protocolDestinations.length === 1);
				const second = owner.validateRecoveryManifest(scope, metadata);
				armed = false;
				const firstDecoded = decoded[0];
				const secondDecoded = decoded[1];
				const calls = observations.slice();
				const protocolCopies = calls.filter((event) => event.kind === "set" && /copyExactCarrier/.test(event.stack));
				const sharedCopies = calls.filter((event) => event.kind === "set" && /\bexactBytes\b/.test(event.stack));
				const recaptures = calls.filter((event) => /captureDeclaration/.test(event.stack));
				const freezeControl = (hit: Hit): boolean =>
					[hit, hit.declaration, hit.declaration.scope, hit.declaration.chunks, ...hit.declaration.chunks].every(
						Object.isFrozen
					);
				const stable = (hit: Hit): string =>
					JSON.stringify({
						...hit,
						declaration: {
							...hit.declaration,
							exactCanonicalManifestBytes: Array.from(hit.declaration.exactCanonicalManifestBytes),
						},
					});
				const value = stable(first);
				const normative = instrument
					? {
							rawCarrierToProtocol: protocolCopies.length === 2 && protocolCopies.every((event) => event.rawSource),
							decoderBytesReused:
								first.declaration.exactCanonicalManifestBytes === firstDecoded?.exactCanonicalManifestBytes &&
								second.declaration.exactCanonicalManifestBytes === secondDecoded?.exactCanonicalManifestBytes,
							decoderVectorReused:
								first.declaration.chunks === firstDecoded?.chunks &&
								second.declaration.chunks === secondDecoded?.chunks,
							decoderRecordsReused:
								first.declaration.chunks.every((item, index) => item === firstDecoded?.chunks[index]) &&
								second.declaration.chunks.every((item, index) => item === secondDecoded?.chunks[index]),
							noSharedExactBytesCopy: sharedCopies.length === 0,
							noDeclarationRecapture: recaptures.length === 0,
						}
					: null;
				const controls: Record<string, boolean> = {
					selectorControl,
					uniqueReturnPerOperation:
						firstReached &&
						(!instrument ||
							(decoded.length === 2 &&
								protocolDestinations.length === 2 &&
								decoded.every(
									(item, index) =>
										item.exactCanonicalManifestBytes === protocolDestinations[index] &&
										item.manifestDigest === scope.manifestDigest
								))),
					valueValid:
						first.kind === "present" &&
						first.declaration.totalBytes === size &&
						first.declaration.chunks.length === baseline.chunks.length &&
						value === stable(second),
					frozenHierarchy: freezeControl(first) && freezeControl(second),
					freshBytes:
						first.declaration.exactCanonicalManifestBytes !== second.declaration.exactCanonicalManifestBytes &&
						first.declaration.exactCanonicalManifestBytes !== raw,
					observationReached:
						!instrument ||
						(decoded.length === 2 &&
							protocolCopies.length === 2 &&
							decoded.every((item) => Object.isFrozen(item) && Object.isFrozen(item.chunks))),
				};
				first.declaration.exactCanonicalManifestBytes.fill(0);
				const later = owner.validateRecoveryManifest(scope, metadata);
				controls.mutationIsolation =
					Array.from(raw).join(",") === original &&
					stable(second) === value &&
					stable(later) === value &&
					later.declaration.exactCanonicalManifestBytes !== second.declaration.exactCanonicalManifestBytes;
				for (const [name, key, data] of [
					["scope-binding", { ...scope, anchor: "d".repeat(64) }, metadata],
					["total-binding", scope, { ...metadata, totalBytes: size + 1 }],
					[
						"descriptor-binding",
						scope,
						{
							...metadata,
							retention: "recovery",
							descriptors: baseline.chunks.map((item) => ({ ...item, digest: "e".repeat(64) })),
						},
					],
				] as const) {
					let error: unknown;
					try {
						owner.validateRecoveryManifest(key, data);
					} catch (caught) {
						error = caught;
					}
					controls[name] = !!error && typeof error === "object" && Reflect.get(error, "code") === "poisoned";
				}
				results.push({
					id: `${size}-${legacy ? "legacy" : "recovery"}`,
					controls,
					normative,
					observations: calls,
					selectorObservations,
					value,
				});
			}
		}
		return { instrument, results };
	} finally {
		armed = false;
		Object.freeze = nativeFreeze;
		if (ownSet) Object.defineProperty(Uint8Array.prototype, "set", ownSet);
		else Reflect.deleteProperty(Uint8Array.prototype, "set");
	}
}
