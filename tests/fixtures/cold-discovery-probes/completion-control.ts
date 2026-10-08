import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import type { NativeMutations, NativeOwners, SetupReport } from "../cold-discovery/types.js";

export const completionModes = ["open-native", "open-wrapper", "legacy-native", "legacy-wrapper"] as const;
export type CompletionMode = (typeof completionModes)[number];

/**
 * Isolated native receipt diagnostic; not a public cold-recovery test.
 * @param setup - Persisted setup identity and diagnostic oracle.
 * @param mode - Native or wrapper completion path.
 * @param owners - Reopened native owners.
 * @param mutations - Existing isolated-fixture mutation owner.
 * @returns Observed completion and port-read sequence.
 */
export async function completionControl(
	setup: SetupReport,
	mode: CompletionMode,
	owners: NativeOwners,
	mutations: NativeMutations
): Promise<Record<string, unknown>> {
	const mutationCount = await mutations.before(mode.startsWith("legacy") ? "legacy" : "open", setup.bootstrap);
	if (mutationCount !== 1) throw new Error("CONTROL_EXPECTED_ONE_MUTATION");
	const found = await owners.snapshot.lookupRecoveryDeclaration(setup.oracle.lookupScope);
	if (found.kind !== "present") throw new Error("CONTROL_EXPECTED_DECLARATION");
	const scope = await owners.snapshot.openScope(found.declaration);
	const events: { event: string; index?: number; byteLength?: number }[] = [];
	let sourceReads = 0;
	const wrapped = mode.endsWith("wrapper");
	const quarantine = wrapped
		? {
				open(signal: AbortSignal): ReturnType<typeof scope.verificationQuarantine.open> {
					const port = scope.verificationQuarantine.open(signal);
					return {
						...port,
						read: async (...args: Parameters<typeof port.read>): ReturnType<typeof port.read> => {
							events.push({ event: "read-start", index: args[0].index });
							const bytes = await port.read(...args);
							events.push({ event: "read-end", index: args[0].index, byteLength: bytes?.byteLength });
							return bytes;
						},
					};
				},
			}
		: scope.verificationQuarantine;
	try {
		const before = await scope.status();
		if (before.kind !== "open") throw new Error("CONTROL_EXPECTED_OPEN");
		const verified = verifySnapshotStreamWithReceipt({
			exactCanonicalManifestBytes: found.declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: found.declaration.scope.manifestDigest,
			expectedScope: found.declaration.scope,
			profile: { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 },
			quarantine,
			source: {
				read: () => {
					sourceReads += 1;
					return Promise.resolve(undefined);
				},
			},
		});
		// These fixtures already contain valid native chunk bytes. A source request is a control failure.
		const receiptResult = verified.receipt.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error })
		);
		await verified.completion;
		const receipt = await receiptResult;
		if (!receipt.ok) throw receipt.error;
		events.push({ event: "complete-start" });
		let complete = "fulfilled";
		try {
			await scope.complete(receipt.value);
		} catch (error) {
			if (!(error instanceof Error) || typeof Reflect.get(error, "code") !== "string") throw error;
			complete = String(Reflect.get(error, "code"));
		}
		events.push({ event: "complete-end" });
		const expected = mode.startsWith("legacy") ? "migration-required" : wrapped ? "receipt-invalid" : "fulfilled";
		if (complete !== expected || sourceReads !== 0) throw new Error(`CONTROL_OUTCOME:${complete}:${sourceReads}`);
		if (wrapped && !events.some((event) => event.event === "read-end" && (event.byteLength ?? 0) > 0))
			throw new Error("CONTROL_INTERNAL_READ_NOT_OBSERVED");
		return {
			proofClass: "DIRECT_NATIVE_RECEIPT_CONTROL_NOT_COLD_PROOF",
			mode,
			mutationCount,
			lookupState: found.state,
			lookupRetention: found.retention,
			before,
			quarantineIdentityPreserved: quarantine === scope.verificationQuarantine,
			stream: "fulfilled",
			complete,
			sourceReads,
			events,
			after: await scope.status(),
		};
	} finally {
		await scope.release();
	}
}
