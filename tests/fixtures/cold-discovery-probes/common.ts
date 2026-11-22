import { decodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import {
	decodeSnapshotManifest,
	snapshotChunkDigest,
} from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";
import { digestBlob, parseBlobDigest } from "../../../packages/storage/dist/src/index.js";
import { hex } from "../cold-discovery/application.js";
import type { NativeMutations, NativeOwners, RecoveryCase, SetupReport } from "../cold-discovery/types.js";

export const modes = [
	"delete-after-lookup",
	"replace-after-lookup",
	"identical-replacement",
	"legacy",
	"bad-trust",
	"bad-cut",
	"bad-qc",
] as const;
export type Mode = (typeof modes)[number];
export interface Inspector {
	snapshot(): Promise<unknown>;
	blobs(): Promise<{ digest: string; bytes: Uint8Array }[]>;
}
const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
export function errorView(error: unknown): unknown {
	return error instanceof Error
		? {
				name: error.name,
				message: error.message,
				code: Reflect.get(error, "code"),
				reason: Reflect.get(error, "reason"),
			}
		: error;
}

/** Direct storage-path diagnostics only. This deliberately does not invoke public cold recovery. */
export async function probe(
	setup: SetupReport,
	mode: Mode,
	owners: NativeOwners,
	mutations: NativeMutations,
	inspect: Inspector
): Promise<Record<string, unknown>> {
	const report: Record<string, unknown> = {
		proofClass: "DIRECT_NATIVE_STORAGE_DIAGNOSTIC_NOT_COLD_PROOF",
		mode,
		epoch: setup.bootstrap.expectedRoomHead.epoch,
		scope: setup.oracle.lookupScope,
	};
	const stages: Record<string, unknown> = {};
	report.stages = stages;
	if (mode.startsWith("bad-")) {
		const desired =
			mode === "bad-trust" ? "drp-anchor-trust-state" : mode === "bad-cut" ? "drp-hard-epoch-cut" : "drp-seal-qc";
		const candidates = (await inspect.blobs()).filter((row) => {
			const value = decodeCanonical(row.bytes) as Record<string, unknown>;
			return (
				value.kind === desired &&
				(desired === "drp-anchor-trust-state"
					? value.currentEpoch === setup.bootstrap.expectedRoomHead.epoch
					: value.epoch === setup.bootstrap.expectedRoomHead.epoch - 1) &&
				(desired !== "drp-seal-qc" || value.phase === "commit")
			);
		});
		if (candidates.length !== 1) throw new Error("PROBE_BLOB_TARGET_NOT_UNIQUE");
		const original = candidates[0]!;
		const parsed = parseBlobDigest(original.digest);
		if (!parsed.ok) throw new Error("PROBE_BLOB_KEY_INVALID");
		stages.before = {
			key: original.digest,
			digestOfBytes: digestBlob(original.bytes),
			bytesHex: hex(original.bytes),
			getBlob: await owners.ahe.getBlob(parsed.value),
		};
		stages.mutationCount = await mutations.before(mode, setup.bootstrap);
		const changed = (await inspect.blobs()).find((row) => row.digest === original.digest);
		if (!changed) throw new Error("PROBE_MUTATED_BLOB_MISSING");
		stages.after = { key: changed.digest, digestOfBytes: digestBlob(changed.bytes), bytesHex: hex(changed.bytes) };
		try {
			stages.getBlob = await owners.ahe.getBlob(parsed.value);
		} catch (error) {
			stages.getBlobThrown = errorView(error);
		}
		return report;
	}
	stages.before = await inspect.snapshot();
	if (mode === "legacy") stages.mutationCount = await mutations.before(mode, setup.bootstrap);
	let declaration;
	try {
		const lookup = await owners.snapshot.lookupRecoveryDeclaration(setup.oracle.lookupScope);
		stages.lookup =
			lookup.kind === "present"
				? {
						kind: lookup.kind,
						state: lookup.state,
						retention: lookup.retention,
						declarationScope: lookup.declaration.scope,
					}
				: lookup;
		if (lookup.kind !== "present") return report;
		declaration = lookup.declaration;
	} catch (error) {
		stages.lookupThrown = errorView(error);
		return report;
	}
	if (mode !== "legacy") stages.mutationCount = await mutations.after(mode as RecoveryCase, setup.oracle.lookupScope);
	stages.after = await inspect.snapshot();
	let scope: Awaited<ReturnType<NativeOwners["snapshot"]["openScope"]>> | undefined;
	let port: ReturnType<NonNullable<typeof scope>["verificationQuarantine"]["open"]> | undefined;
	try {
		scope = await owners.snapshot.openScope(declaration);
		stages.open = "fulfilled";
		stages.afterOpen = await inspect.snapshot();
		port = scope.verificationQuarantine.open(new AbortController().signal);
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: declaration.scope.manifestDigest,
			profile,
		});
		const status = await scope.status();
		stages.status = status;
		const reads: unknown[] = [];
		stages.reads = reads;
		const read = async (descriptor: (typeof decoded.chunks)[number]): Promise<Uint8Array | undefined> => {
			const bytes = await port!.read(descriptor);
			const actualDigest = bytes === undefined ? undefined : snapshotChunkDigest(descriptor.index, bytes);
			reads.push({
				index: descriptor.index,
				expectedDigest: descriptor.digest,
				actualDigest,
				byteLength: bytes?.byteLength,
				bytesHex: bytes === undefined ? undefined : hex(bytes),
			});
			return bytes !== undefined && bytes.byteLength === descriptor.byteLength && actualDigest === descriptor.digest
				? bytes
				: undefined;
		};
		// Mirror only the unchanged shared verifier's native byte/check path, never its cold authentication entrypoint.
		if (status.kind === "verified") {
			stages.verifiedReadPass = true;
			for (const descriptor of decoded.chunks)
				if ((await read(descriptor)) === undefined) stages.verifiedReadPass = false;
		} else {
			const verified = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: declaration.scope.manifestDigest,
				expectedScope: declaration.scope,
				profile,
				quarantine: scope.verificationQuarantine,
				source: { read },
			});
			const receipt = verified.receipt.then(
				(value) => ({ ok: true as const, value }),
				(error) => ({ ok: false as const, error: errorView(error) })
			);
			try {
				stages.streamCompletion = await verified.completion;
			} catch (error) {
				stages.streamThrown = errorView(error);
			}
			const received = await receipt;
			if (!received.ok) stages.receiptThrown = received.error;
			else {
				try {
					await scope.complete(received.value);
					stages.complete = "fulfilled";
				} catch (error) {
					stages.completeThrown = errorView(error);
				}
			}
		}
	} catch (error) {
		stages.ownerThrown = errorView(error);
	} finally {
		await port?.discard();
		await scope?.release();
	}
	stages.final = await inspect.snapshot();
	return report;
}
