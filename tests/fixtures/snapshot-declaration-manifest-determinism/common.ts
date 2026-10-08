import type { Observer } from "./observe.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";
import {
	decodeSnapshotManifest,
	SNAPSHOT_MANIFEST_MAX_BYTES,
} from "../../../packages/protocol-v3/dist/src/snapshot-transfer.js";
import {
	chain,
	check,
	fixture,
	type NativeEnvironment,
	stable,
} from "../snapshot-declaration-native-provenance/common.js";

export const CASES = ["bom-byte-comparison", "oversized-carrier"] as const;
export type Case = (typeof CASES)[number];
export interface Result {
	name: Case;
	backend: NativeEnvironment["backend"];
	instrument: boolean;
	canonicalEvidence: Record<string, unknown>;
	expectedProtocolCode: string;
	direct: ReturnType<typeof chain>;
	native: ReturnType<typeof chain>;
	semantics: Record<string, string | boolean | null | undefined>;
	positiveControls: Record<string, boolean> | null;
	normative: Record<string, boolean> | null;
	classification: string;
	events: Observer["events"];
	image: Record<string, string>;
	qualification: string;
}
const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
const digest = (bytes: Uint8Array): string =>
	Array.from(hashDomain("ts-drp/snapshot-manifest/v3", bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const fingerprint = (value: string): string => digest(new TextEncoder().encode(value));

/**
 * Pin deterministic protocol categories and genuine native discovery consequences.
 * @param env - Unmodified native owner and durable metadata helpers.
 * @param observer - Observe-only pre-import native instrumentation.
 * @param name - Specific deterministic branch.
 * @returns Separate semantic controls and raw protocol-gate obligation.
 */
export async function run(env: NativeEnvironment, observer: Observer, name: Case): Promise<Result> {
	const { declaration } = fixture();
	const ordinary = declaration.exactCanonicalManifestBytes;
	const manifest = decodeCanonical(ordinary) as Record<string, unknown>;
	check(typeof manifest.objectId === "string", "real manifest object identity");
	const bytes =
		name === "bom-byte-comparison"
			? encodeCanonical({ ...manifest, objectId: "\ufeff" + manifest.objectId })
			: new Uint8Array(SNAPSHOT_MANIFEST_MAX_BYTES + 1).fill(65);
	const exactDigest = digest(bytes);
	const originalBytes = stable(bytes);
	let canonicalEvidence: Record<string, unknown>;
	if (name === "bom-byte-comparison") {
		const decoded = decodeCanonical(bytes);
		const reencoded = encodeCanonical(decoded);
		check(stable(decoded) === stable(manifest), "BOM carrier canonically decodes to exact original manifest value");
		check(stable(reencoded) === stable(ordinary), "successful canonical re-encode returns original manifest bytes");
		check(
			bytes.length === reencoded.length + 3 && stable(bytes) !== stable(reencoded),
			"one BOM causes actual byte mismatch"
		);
		canonicalEvidence = {
			decodedSuccessfully: true,
			reencodedSuccessfully: true,
			decodedEqualsOriginalManifest: true,
			reencodedEqualsOriginalBytes: true,
			originalLength: ordinary.length,
			carrierLength: bytes.length,
			reencodedLength: reencoded.length,
			carrierHex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
			carrierDigest: exactDigest,
			reencodedDigest: digest(reencoded),
			originalDigest: declaration.scope.manifestDigest,
		};
	} else
		canonicalEvidence = {
			carrierLength: bytes.length,
			limit: SNAPSHOT_MANIFEST_MAX_BYTES,
			oneByteOverLimit: bytes.length === SNAPSHOT_MANIFEST_MAX_BYTES + 1,
			carrierDigest: exactDigest,
		};
	observer.begin("direct-control", ordinary);
	const directControl = decodeSnapshotManifest({
		exactCanonicalManifestBytes: ordinary,
		expectedManifestDigest: declaration.scope.manifestDigest,
		profile,
	});
	check(stable(directControl.exactCanonicalManifestBytes) === stable(ordinary), "direct no-fault manifest accepted");
	observer.begin("direct-case", bytes);
	let directFailure: unknown;
	try {
		decodeSnapshotManifest({ exactCanonicalManifestBytes: bytes, expectedManifestDigest: exactDigest, profile });
	} catch (error) {
		directFailure = error;
	}
	observer.begin("inspection");
	const direct = chain(directFailure, undefined);
	const expectedProtocolCode = name === "bom-byte-comparison" ? "manifest-noncanonical" : "manifest-too-large";
	check(direct[0]?.code === expectedProtocolCode, "exact direct protocol deterministic code");
	check(direct.length === 1, "direct deterministic branch has no wrapped canonical/native failure");
	check(
		direct[0]?.message ===
			(name === "bom-byte-comparison"
				? "manifest bytes are not canonical"
				: "manifest exceeds the pre-copy byte limit"),
		"specific protocol comparison/length branch reached"
	);
	const store = await env.open();
	try {
		await store.openScope(declaration);
		observer.begin("native-control");
		const control = await store.lookupRecoveryDeclaration(declaration.scope);
		check(control.kind === "present", "genuine no-fault native present control");
		if (control.kind !== "present") throw new Error("native control absent");
		check(stable(control.declaration) === stable(declaration), "native control exact original declaration");
		observer.begin("inspection");
		const row = await env.row(declaration.scope);
		row.exactCanonicalManifestBytes = bytes;
		row.manifestDigest = exactDigest;
		const key = { ...declaration.scope, manifestDigest: exactDigest };
		await env.put(row);
		const persisted = await env.row(key);
		check(
			stable(persisted.exactCanonicalManifestBytes) === originalBytes,
			"native persisted exact deterministic carrier"
		);
		const before = stable(await env.image()),
			status = stable(await store.recoveryStatus());
		observer.begin("native-case");
		let nativeFailure: unknown;
		try {
			await store.lookupRecoveryDeclaration(key);
		} catch (error) {
			nativeFailure = error;
		}
		observer.begin("inspection");
		const native = chain(nativeFailure, undefined);
		check(native[0]?.code === "poisoned", "actual native deterministic carrier maps to poisoned");
		if (name === "bom-byte-comparison") {
			check(
				native.some(
					(error) => error.code === "manifest-noncanonical" && error.message === "manifest bytes are not canonical"
				),
				"native actual protocol byte-comparison cause"
			);
			check(
				!native.some((error) => error.code === "CANONICAL_DECODING" || error.message === "invalid UTF-8 string"),
				"native rejection is not malformed UTF-8"
			);
		}
		const after = stable(await env.image());
		check(after === before, "entire durable native image unchanged by rejection");
		check(stable(await store.recoveryStatus()) === status, "owner status unchanged by rejection");
		const retry = await store.lookupRecoveryDeclaration(declaration.scope);
		check(stable(retry) === stable(control), "ordinary native control still present after rejection");
		check(
			stable(await env.image()) === before && stable(await store.recoveryStatus()) === status,
			"retry preserves same durable image and owner status"
		);
		check(stable(bytes) === originalBytes, "test carrier itself unmodified");
		const directControlEvents = observer.events.filter((event) => event.phase === "direct-control");
		const directEvents = observer.events.filter((event) => event.phase === "direct-case");
		const nativeControlEvents = observer.events.filter((event) => event.phase === "native-control");
		const nativeEvents = observer.events.filter((event) => event.phase === "native-case");
		const positive = {
			directRawGate: directControlEvents.some(
				(event) => event.kind === "gate" && event.directRaw && event.bytes === ordinary.length
			),
			directOwnedCopy: directControlEvents.some(
				(event) => event.kind === "owned-allocation" && event.bytes === ordinary.length
			),
			nativeRawCaptured: nativeControlEvents.some((event) => event.kind === "raw" && event.bytes === ordinary.length),
			nativeRawPath:
				nativeControlEvents.some(
					(event) => event.kind === "copy" && event.directRaw && event.bytes === ordinary.length
				) || nativeControlEvents.some((event) => event.kind === "gate" && event.directRaw),
			nativeGateLineage: nativeControlEvents.some(
				(event) => event.kind === "gate" && event.fromRaw && event.bytes === ordinary.length
			),
		};
		if (observer.instrument) {
			check(
				Object.values(positive).every(Boolean),
				"positive raw identity / direct gate / native gate attribution controls"
			);
			check(
				directEvents.some((event) => event.kind === "gate" && event.directRaw && event.bytes === bytes.length),
				"direct selected protocol gate saw exact raw carrier"
			);
			if (name === "oversized-carrier")
				check(
					!directEvents.some((event) => event.kind === "owned-allocation" || event.kind === "copy"),
					"oversized direct raw carrier rejected before owned copy"
				);
		}
		const requiredNativeRawGate = env.backend === "indexeddb" && name === "oversized-carrier";
		const nativeRawGate = nativeEvents.some(
			(event) => event.kind === "gate" && event.directRaw && event.bytes === bytes.length
		);
		const nativeTooLarge = native.some((error) => error.code === "manifest-too-large");
		return {
			name,
			backend: env.backend,
			instrument: observer.instrument,
			canonicalEvidence,
			expectedProtocolCode,
			direct,
			native,
			semantics: {
				directCode: direct[0]?.code,
				nativeCode: native[0]?.code,
				exactPersistedCarrier: true,
				durableUnchanged: true,
				ownerStatusUnchanged: true,
				validControl: true,
				retryPresent: true,
				inputUnchanged: true,
			},
			positiveControls: observer.instrument ? positive : null,
			normative:
				observer.instrument && requiredNativeRawGate
					? { nativeRawProtocolGate: nativeRawGate, nativeProtocolTooLarge: nativeTooLarge }
					: null,
			classification:
				observer.instrument && requiredNativeRawGate && (!nativeRawGate || !nativeTooLarge)
					? "NATIVE_RAW_PROTOCOL_GATE_ABSENT"
					: "PASS",
			events: observer.events,
			image: {
				before: fingerprint(before),
				after: fingerprint(after),
				status: fingerprint(status),
				comparison: "full normalized native rows/schema, not SQLite physical-file bytes",
			},
			qualification:
				env.backend === "sqlite" && name === "oversized-carrier"
					? "SQLite may reject in real preflight; native protocol-stage reach is not required or claimed."
					: "No synthetic throws or owner replacements. Missing IndexedDB raw protocol reach is a deterministic stage obligation, not operational injection evidence.",
		};
	} finally {
		observer.begin("cleanup");
		await store.close();
	}
}
