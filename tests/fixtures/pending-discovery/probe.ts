import { closeAll } from "./cleanup.js";
import { freshEffects, observe, trace } from "./observer.js";
import { observedSnapshot } from "./snapshot-observation.js";
import type { NativeMutations, OwnerCase, ProbeInput, ProbeReport, RecoveryOwners } from "./types.js";
import { decodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import {
	decodeSnapshotManifest,
	snapshotChunkDigest,
} from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";
import type { SnapshotQuarantineScope } from "../../../packages/storage/dist/src/snapshot-transfer.js";
import { digest, parameters } from "../cold-discovery/application.js";
import { observeNativeReads } from "../cold-discovery/read-observer.js";
/**
 * Direct owner preconditions. No production authentication or recovery call exists in this graph.
 * @param input - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param owners - Explicit fixture-owned input for this isolated control.
 * @param mutations - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function probe(
	input: ProbeInput,
	mode: OwnerCase,
	owners: RecoveryOwners,
	mutations: NativeMutations
): Promise<ProbeReport> {
	const effects = freshEffects();
	effects.mutations += await mutations.before(mode, input.bootstrap);
	const snapshot = observedSnapshot(owners.snapshot, effects, mode, mutations);
	const report: ProbeReport = { mode, effects, competing: false, acquired: false, verified: false, bytes: 0 };
	return observe(effects, () =>
		observeNativeReads(
			() => {
				effects.reads++;
				trace({ site: "native-read" });
			},
			async () => {
				// Probe the neighboring scope directly with the actual owner, not the fault decorator.
				const competing = await owners.snapshot.lookupRecoveryDeclaration(input.competingScope);
				report.competing = competing.kind === "present" && competing.state === "verified";
				let scope: SnapshotQuarantineScope<object> | undefined;
				let port: ReturnType<SnapshotQuarantineScope<object>["verificationQuarantine"]["open"]> | undefined;
				try {
					const observation = await snapshot.lookupRecoveryDeclaration(input.scope);
					report.observation = {
						kind: observation.kind,
						...(observation.kind === "present" ? { state: observation.state, retention: observation.retention } : {}),
					};
					if (observation.kind !== "present" || observation.state === "poisoned") return report;
					const declaration = observation.declaration;
					const profile = {
						maxManifestBytes: 212387,
						maxSnapshotBytes: parameters.maxSnapshotBytes,
						snapshotChunkBytes: parameters.snapshotChunkBytes,
					} as const;
					const manifest = decodeSnapshotManifest({
						exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
						expectedManifestDigest: declaration.scope.manifestDigest,
						profile,
					});
					scope = await snapshot.openScope(declaration);
					report.acquired = true;
					port = scope.verificationQuarantine.open(new AbortController().signal);
					const nativePort = port;
					const bodies: Uint8Array[] = [];
					const read = async (descriptor: (typeof manifest.chunks)[number]): Promise<Uint8Array | undefined> => {
						const bytes = await nativePort.read(descriptor);
						if (
							bytes === undefined ||
							bytes.byteLength !== descriptor.byteLength ||
							snapshotChunkDigest(descriptor.index, bytes) !== descriptor.digest
						)
							return undefined;
						bodies[descriptor.index] = Uint8Array.from(bytes);
						return bytes;
					};
					if ((await scope.status()).kind === "verified") {
						for (const descriptor of manifest.chunks)
							if ((await read(descriptor)) === undefined) throw new Error("PROBE_BYTES_INVALID");
					} else {
						const verification = verifySnapshotStreamWithReceipt({
							exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
							expectedManifestDigest: declaration.scope.manifestDigest,
							expectedScope: declaration.scope,
							profile,
							quarantine: scope.verificationQuarantine,
							source: { read },
						});
						await verification.completion;
						await scope.complete(await verification.receipt);
						// The stream may satisfy reads from its native quarantine without invoking source.read.
						// Read the completed native scope explicitly to bind payload evidence to durable bytes.
						for (const descriptor of manifest.chunks)
							if ((await read(descriptor)) === undefined) throw new Error("PROBE_BYTES_INVALID");
					}
					const payload = new Uint8Array(bodies.reduce((sum, bytes) => sum + bytes.byteLength, 0));
					let offset = 0;
					for (const bytes of bodies) {
						payload.set(bytes, offset);
						offset += bytes.byteLength;
					}
					const manifestRecord = decodeCanonical(declaration.exactCanonicalManifestBytes) as Record<string, unknown>;
					if (digest("ts-drp/snapshot-payload/v3", payload) !== manifestRecord.payloadDigest)
						throw new Error("PROBE_PAYLOAD_INVALID");
					report.bytes = payload.byteLength;
					const payloadRecord = decodeCanonical(payload) as Record<string, unknown>;
					if (typeof payloadRecord.application !== "number" || typeof manifestRecord.stateDigest !== "string")
						throw new Error("PROBE_APPLICATION_SHAPE");
					report.application = payloadRecord.application;
					report.stateDigest = manifestRecord.stateDigest;
					report.payloadDigest = String(manifestRecord.payloadDigest);
					report.verified = true;
				} catch (error) {
					report.failure = error instanceof Error ? error.message : String(error);
					if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string")
						report.failureCode = error.code;
				} finally {
					await closeAll([
						async (): Promise<void> => {
							await port?.discard();
						},
						async (): Promise<void> => {
							await scope?.release();
						},
					]);
				}
				return report;
			}
		)
	);
}
