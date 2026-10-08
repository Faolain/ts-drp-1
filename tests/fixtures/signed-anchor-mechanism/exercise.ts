/* eslint-disable jsdoc/require-jsdoc -- Explicit future consumer tests; baseline absence never supplies product behavior. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { InstallLiveJournalGenesisInput, LiveJournalScope } from "@ts-drp/live-journal";
import * as protocol from "@ts-drp/protocol-v3/creator-close";

import { arm, events, type Frame, signedDispatches } from "./capture.js";
import { type FutureJournal, type FuturePrivate, type FutureProtocol, MAX_ENVELOPE } from "./contract.js";
import * as privateOwner from "../../../packages/node/src/internal/creator-closed-rollback-data.js";
import { application, seed, unhex } from "../cold-discovery/application.js";
import { record, requireThat } from "../rollback-data-observation/proof.js";
import type { Bootstrap, NativeOwners, NativePort } from "../rollback-data-observation/types.js";

export const CASES = [
	"in-place",
	"empty-import",
	"same-u-unit-below",
	"same-u-unit-equal",
	"same-u-unit-dedup",
	"source-absent",
	"foreign-requirement",
	"foreign-ledger",
	"capture-accessor",
	"initial-abort",
	"floor-stale",
	"floor-pending",
	"head-stale",
	"source-close",
	"destination-close",
	"signature",
	"parameters",
	"authority",
	"storage-capture",
	"envelope-budget",
	"empty-idempotence",
	"populated-refusal",
	"orphan-nonnumeric",
	"zero-nonnumeric",
	"nonzero-empty",
	"physical-signature",
	"physical-parameters",
	"physical-digest",
	"physical-next",
	"terminal-precommit",
	"terminal-postcommit",
	"terminal-concurrent",
] as const;
export const CRASH_CASES = [
	"crash-after-acquire",
	"crash-during-write",
	"crash-after-commit",
	"crash-after-confirmation",
] as const;
export type Case = (typeof CASES)[number] | (typeof CRASH_CASES)[number] | "baseline" | "census";
export interface Controls {
	readonly scope: LiveJournalScope;
	readonly genuinePopulated: boolean;
	readonly originalSignatureValid: boolean;
	readonly genuineEntryCount: number;
}
export interface NativeMechanism {
	mutate(mode: Case, envelope: InstallLiveJournalGenesisInput): Promise<void>;
	faultImport(mode: Case, envelope: InstallLiveJournalGenesisInput): Promise<unknown>;
}
export async function exercise(
	b: Bootstrap,
	mode: Case,
	owners: NativeOwners,
	destination: FutureJournal,
	port: NativePort,
	control: Controls,
	nativeMechanism?: NativeMechanism
): Promise<Record<string, unknown>> {
	const floor = await port.readFloor();
	requireThat(floor && floor.stable.epoch === 3, "actual first-k1 floor");
	requireThat(
		control.genuinePopulated && control.genuineEntryCount > 0 && control.originalSignatureValid,
		"present genuine populated signed source"
	);
	const donor = owners.journal as FutureJournal;
	const api = privateOwner as unknown as Partial<FuturePrivate>,
		pure = protocol as unknown as Partial<FutureProtocol>;
	const missing = [
		["readSignedAnchorEnvelope", donor.readSignedAnchorEnvelope],
		["importHistoricalAnchor", destination.importHistoricalAnchor],
		["inspectCreatorHistoricalAnchorEnvelope", pure.inspectCreatorHistoricalAnchorEnvelope],
		["importCreatorClosedRollbackAnchor", api.importCreatorClosedRollbackAnchor],
	]
		.filter(([, value]) => typeof value !== "function")
		.map(([name]) => name);
	let classification = "REACHED",
		importerResult: unknown,
		importerMaterialFrozen = false,
		importerMaterialFieldless = false,
		storageResults: unknown,
		frame: Frame | undefined,
		getterReads = 0,
		calls = 0,
		observedEvents: string[] = [],
		postRelease: unknown,
		importNative: unknown,
		hookFailure: unknown;
	const controller = new AbortController();
	const invoke = api.importCreatorClosedRollbackAnchor;
	const run = async (actual: Frame): Promise<void> => {
		frame = actual;
		requireThat(actual.fullUnionBytes > 0 && actual.fullUnionBytes <= 262144, "genuine full actual SAME-U input");
		if (mode === "baseline") return;
		if (missing.length) {
			classification = "WIRING_RED";
			return;
		}
		requireThat(invoke && pure.inspectCreatorHistoricalAnchorEnvelope, "future real consumers");
		if (mode === "census") {
			const read = await destination.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: MAX_ENVELOPE });
			if (read.ok && read.kind === "present")
				requireThat(
					pure.inspectCreatorHistoricalAnchorEnvelope({
						successorTrust: actual.successorTrust,
						envelope: read.envelope,
					}).ok,
					"independent crash reopen reauthenticates original signed destination"
				);
			storageResults = read;
			return;
		}
		if (mode.startsWith("same-u-unit-")) {
			classification = "REACHED_IMPORTER_UNIT_COMPOSITION";
			const read = await donor.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: MAX_ENVELOPE });
			requireThat(read.ok && read.kind === "present", "genuine original native envelope for qualified composition");
			const bytes = [
					read.envelope.exactCanonicalAnchorPreimageBytes,
					read.envelope.detachedAnchorSignature,
					read.envelope.exactCanonicalParametersCarrierBytes,
				],
				total = bytes.reduce((sum, value) => sum + value.length, 0),
				accounting = actual.accounting;
			if (mode === "same-u-unit-dedup")
				for (const carrier of bytes)
					requireThat(accounting.charge(carrier), "precharge real original envelope at same actual owner");
			const target = 262144 - total + (mode === "same-u-unit-below" ? 1 : 0),
				prechargeLength = target - accounting.chargedBytes;
			requireThat(prechargeLength > 0, "explicit synthetic composition pressure");
			requireThat(
				accounting.charge(new Uint8Array(prechargeLength).fill(0xbb)),
				"synthetic precharge ORIGINAL live owner, no factory or second U"
			);
			const before = accounting.chargedBytes;
			signedDispatches.length = 0;
			const result = await invoke({
				requirement: actual.requirement,
				sourceJournal: donor,
				proofLedger: actual.proofLedger,
			});
			importerResult = result;
			const dispatches = [...signedDispatches];
			requireThat(dispatches.length > 0, "actual signed native dispatch observation reached");
			for (const dispatch of dispatches)
				requireThat(
					dispatch.maxBytes === Math.min(262144 - Number(dispatch.chargedBytes), MAX_ENVELOPE),
					"actual dispatched allowance is SAME remaining U, not second entitlement"
				);
			if (mode === "same-u-unit-below") {
				requireThat(
					!result.ok && result.kind === "proof-budget-exceeded",
					"one byte below genuine total refuses whole importer"
				);
				requireThat(accounting.chargedBytes === before, "refused carriers never billed as admitted material");
			} else {
				if (mode === "same-u-unit-equal")
					requireThat(
						!result.ok && result.kind === "proof-budget-exceeded",
						"exact U after genuine first envelope admission conservatively refuses required reread"
					);
				else requireThat(result.ok, "precharged genuine equal envelope rereads execute importer success");
				requireThat(
					accounting.chargedBytes === (mode === "same-u-unit-equal" ? 262144 : before),
					"ALL three carriers charged once; equal rereads cannot rebill"
				);
				const after = accounting.chargedBytes;
				for (const carrier of bytes)
					requireThat(
						accounting.charge(Uint8Array.from(carrier)) && accounting.chargedBytes === after,
						"actual equality, not carrier identity, deduplicates"
					);
				const unequal = new Uint8Array(bytes[1]?.length ?? 64).fill(0xcc);
				requireThat(
					!bytes.some((carrier) => compareBytes(carrier, unequal) === 0),
					"unequal same-length actual carrier"
				);
				const was = accounting.chargedBytes,
					accepted = accounting.charge(unequal);
				requireThat(
					mode === "same-u-unit-equal"
						? !accepted && accounting.chargedBytes === was
						: accepted && accounting.chargedBytes === was + unequal.length,
					"unequal same-length bytes never deduplicate"
				);
			}
			storageResults = {
				qualifiedSyntheticPrecharge: true,
				nativePublishedPressure: "HELD",
				actualFullReaderUnion: actual.fullUnionBytes,
				actualEnvelopeLengths: bytes.map((value) => value.length),
				total,
				before,
				chargedAfter: accounting.chargedBytes,
				dispatches,
				result,
			};
			return;
		}
		if (
			[
				"signature",
				"parameters",
				"authority",
				"storage-capture",
				"envelope-budget",
				"empty-idempotence",
				"populated-refusal",
				"orphan-nonnumeric",
				"zero-nonnumeric",
				"nonzero-empty",
			].includes(mode) ||
			mode.startsWith("physical-") ||
			mode.startsWith("terminal-") ||
			mode.startsWith("crash-")
		) {
			const read = await donor.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: MAX_ENVELOPE });
			requireThat(read.ok && read.kind === "present", "actual complete donor envelope");
			const envelope = read.envelope;
			const total =
				envelope.exactCanonicalAnchorPreimageBytes.length +
				envelope.detachedAnchorSignature.length +
				envelope.exactCanonicalParametersCarrierBytes.length;
			requireThat(
				pure.inspectCreatorHistoricalAnchorEnvelope({ successorTrust: actual.successorTrust, envelope }).ok,
				"genuine original signature/profile continuity"
			);
			if (mode.startsWith("physical-")) {
				requireThat(nativeMechanism, "physical native fixture provided");
				await nativeMechanism.mutate(mode, envelope);
				const observed = await port.observe(() =>
					donor.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: MAX_ENVELOPE })
				);
				requireThat(
					!observed.value.ok && observed.value.kind === "store-poisoned",
					"proved physical metadata/carrier corruption"
				);
				storageResults = observed;
			} else if (mode === "orphan-nonnumeric" || mode === "zero-nonnumeric" || mode === "nonzero-empty") {
				requireThat(nativeMechanism, "complete-prefix corruption fixture provided");
				if (mode !== "orphan-nonnumeric")
					requireThat(
						(await destination.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE })).ok,
						"real complete-zero prerequisite"
					);
				await nativeMechanism.mutate(mode, envelope);
				const observed = await port.observe(() =>
					destination.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE })
				);
				requireThat(
					!observed.value.ok && observed.value.kind === "store-poisoned",
					"complete scope-prefix including nonnumeric keys proves corruption"
				);
				const after = await destination.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: MAX_ENVELOPE });
				requireThat(!after.ok && after.kind === "store-poisoned", "contradiction preserves poison");
				storageResults = { ...observed, after };
			} else if (mode.startsWith("terminal-") || mode.startsWith("crash-")) {
				requireThat(nativeMechanism, "actual native terminal fixture provided");
				storageResults = await nativeMechanism.faultImport(mode, envelope);
			} else if (mode === "authority") {
				const refusals = [];
				for (const field of [
					"objectId",
					"epoch",
					"profileDigest",
					"signerSetDigest",
					"cryptoSuiteId",
					"blueprintDigest",
					"parametersDigest",
				]) {
					const anchor = record(envelope.exactCanonicalAnchorPreimageBytes),
						change =
							field === "epoch"
								? 0
								: field === "objectId"
									? "creator:" + "e".repeat(32)
									: field === "cryptoSuiteId"
										? "unsupported"
										: "e".repeat(64);
					const bytes = encodeCanonical({ ...anchor, [field]: change });
					const signature = ed25519.sign(hashDomain("ts-drp/epoch-anchor/v3", bytes), seed);
					const inspected = pure.inspectCreatorHistoricalAnchorEnvelope({
						successorTrust: actual.successorTrust,
						envelope: { ...envelope, exactCanonicalAnchorPreimageBytes: bytes, detachedAnchorSignature: signature },
					});
					requireThat(!inspected.ok, "independently signed wrong material refuses:" + field);
					refusals.push({ field, inspected, independentlySignedNegativeOnly: true });
				}
				const foreign = pure.inspectCreatorHistoricalAnchorEnvelope({
					successorTrust: { ...actual.successorTrust },
					envelope,
				});
				requireThat(!foreign.ok, "copied successor identity cannot replace private trust");
				storageResults = { refusals, foreign };
			} else if (mode === "storage-capture") {
				const malformed: unknown[] = [
					{ scope: control.scope, maxBytes: MAX_ENVELOPE, extra: true },
					{ scope: control.scope, maxBytes: 262145 },
					{ scope: control.scope, maxBytes: -1 },
					{ scope: control.scope, maxBytes: 0.5 },
				];
				const accessor = { scope: control.scope };
				Object.defineProperty(accessor, "maxBytes", {
					enumerable: true,
					get: () => {
						getterReads++;
						throw new Error("capture accessor");
					},
				});
				malformed.push(accessor);
				const symbols = { scope: control.scope, maxBytes: MAX_ENVELOPE, [Symbol("extra")]: 1 };
				malformed.push(symbols);
				const reads = [];
				for (const input of malformed) {
					const observed = await port.observe(() =>
						donor.readSignedAnchorEnvelope(input as { scope: LiveJournalScope; maxBytes: number })
					);
					requireThat(!observed.value.ok && observed.value.kind === "malformed-input", "strict read capture");
					reads.push(observed);
				}
				const oversized = new Uint8Array(8193);
				Object.defineProperty(oversized, "byteLength", { value: 1 });
				const shared = new Uint8Array(new SharedArrayBuffer(64));
				const imports = [];
				for (const changed of [
					{ ...envelope, exactCanonicalAnchorPreimageBytes: oversized },
					{ ...envelope, detachedAnchorSignature: shared },
					{ ...envelope, exactCanonicalParametersCarrierBytes: new Uint8Array(65537) },
					{ ...envelope, detachedAnchorSignature: new Uint8Array(63) },
				]) {
					const observed = await port.observe(() =>
						destination.importHistoricalAnchor({ envelope: changed, maxBytes: MAX_ENVELOPE })
					);
					requireThat(
						!observed.value.ok && ["malformed-input", "read-budget-exceeded"].includes(observed.value.kind),
						"intrinsic pre-copy carrier gate"
					);
					imports.push(observed);
				}
				requireThat(getterReads === 0, "accessor never invoked");
				storageResults = { reads, imports };
			} else if (mode === "signature") {
				const corrupt = Uint8Array.from(envelope.detachedAnchorSignature);
				corrupt[0] ^= 1;
				const inspected = pure.inspectCreatorHistoricalAnchorEnvelope({
					successorTrust: actual.successorTrust,
					envelope: { ...envelope, detachedAnchorSignature: corrupt },
				});
				requireThat(!inspected.ok, "correct anchor digest never replaces original signature");
				storageResults = { total, inspected };
			} else if (mode === "parameters") {
				const corrupt = Uint8Array.from(envelope.exactCanonicalParametersCarrierBytes);
				corrupt[corrupt.length - 1] ^= 1;
				const inspected = pure.inspectCreatorHistoricalAnchorEnvelope({
					successorTrust: actual.successorTrust,
					envelope: { ...envelope, exactCanonicalParametersCarrierBytes: corrupt },
				});
				requireThat(!inspected.ok, "actual canonical parameter digest binds both anchors");
				storageResults = { total, inspected };
			} else if (mode === "envelope-budget") {
				const observed = await port.observe(() =>
					donor.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: total - 1 })
				);
				const refused = observed.value;
				requireThat(
					!refused.ok && refused.kind === "read-budget-exceeded",
					"all actual envelope extras precede BLOB projection"
				);
				const exact = await donor.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: total });
				requireThat(exact.ok && exact.kind === "present", "inclusive actual envelope allowance");
				storageResults = { total, refused, exactKind: exact.kind, native: observed.evidence };
			} else if (mode === "populated-refusal") {
				const refusal = await donor.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE });
				requireThat(!refusal.ok && refusal.kind === "import-populated", "population is ordinary nonpoison refusal");
				const after = await donor.readSignedAnchorEnvelope({ scope: control.scope, maxBytes: MAX_ENVELOPE });
				requireThat(after.ok && after.kind === "present", "population refusal leaves donor usable");
				storageResults = { refusal, afterKind: after.kind };
			} else {
				const first = await destination.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE });
				requireThat(first.ok && !first.idempotent, "genuine absent complete-zero install");
				const second = await destination.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE });
				requireThat(second.ok && second.idempotent, "complete-zero exact idempotence");
				const corrupt = Uint8Array.from(envelope.detachedAnchorSignature);
				corrupt[0] ^= 1;
				const conflict = await destination.importHistoricalAnchor({
					envelope: { ...envelope, detachedAnchorSignature: corrupt },
					maxBytes: MAX_ENVELOPE,
				});
				requireThat(!conflict.ok && conflict.kind === "genesis-conflict", "unequal empty envelope conflict");
				storageResults = { first, second, conflict };
			}
			return;
		}
		if (mode === "floor-stale" || mode === "floor-pending")
			await port.writeFloor(
				mode === "floor-stale"
					? { stable: { ...floor.stable, currentAnchorDigest: "e".repeat(64) }, pending: null }
					: {
							stable: floor.stable,
							pending: {
								previous: floor.stable,
								next: { ...floor.stable, epoch: 4, currentAnchorDigest: "e".repeat(64) },
							},
						}
			);
		if (mode === "head-stale") {
			const replacement = await port.prepareStaleHead(b.objectId);
			try {
				await replacement.run();
			} finally {
				await replacement.close();
			}
		}
		if (mode === "source-close") await donor.close();
		if (mode === "destination-close") await destination.close();
		if (mode === "initial-abort") controller.abort();
		const input = {
			requirement: mode === "foreign-requirement" ? Object.freeze({}) : actual.requirement,
			sourceJournal: donor,
			proofLedger: mode === "foreign-ledger" ? Object.freeze({}) : actual.proofLedger,
			signal: controller.signal,
		};
		if (mode === "capture-accessor")
			Object.defineProperty(input, "sourceJournal", {
				enumerable: true,
				get: () => {
					getterReads++;
					throw new Error("must not read accessor");
				},
			});
		calls++;
		const observed = await port.observe(async () => {
			const result = await invoke(input);
			if (result.ok) {
				importerMaterialFrozen = Object.isFrozen(result.material);
				importerMaterialFieldless = Reflect.ownKeys(result.material).length === 0;
				requireThat(importerMaterialFrozen, "actual importer material is frozen before JSON serialization");
				requireThat(importerMaterialFieldless, "actual importer material is fieldless before JSON serialization");
			}
			return result;
		});
		importerResult = observed.value;
		importNative = observed.evidence;
	};
	arm(async (actual) => {
		try {
			await run(actual);
		} catch (error) {
			hookFailure = error;
			throw error;
		}
	});
	let observer: unknown;
	try {
		observer = await privateOwner.authenticateCreatorClosedRollbackData({
			objectId: b.objectId,
			pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes),
			roomHeadAuthority: { read: async () => ({ ok: true, state: await port.readFloor() }) },
			catalog: application().catalog,
			store: owners.ahe,
			snapshotStore: owners.snapshot,
			liveJournalStore: destination,
		});
	} finally {
		observedEvents = [...events];
		arm(undefined);
	}
	requireThat(frame, "genuine requirement reached before absent destination refusal");
	if (hookFailure) throw hookFailure;
	if (mode === "in-place" && classification === "REACHED" && invoke)
		postRelease = await invoke({
			requirement: frame.requirement,
			sourceJournal: donor,
			proofLedger: frame.proofLedger,
		});
	return {
		classification,
		missing,
		mode,
		control,
		observer,
		importerResult,
		importerMaterialFrozen,
		importerMaterialFieldless,
		storageResults,
		getterReads,
		calls,
		postRelease,
		importNative,
		events: observedEvents,
		fullUnionBytes: frame.fullUnionBytes,
		ledgerAuthority: "unproven-until-real-importer-validates-genuine-frame-pairing",
		requirementFrozen: Object.isFrozen(frame.requirement),
		requirementFieldless: Reflect.ownKeys(frame.requirement).length === 0,
	};
}

export function equalEnvelope(a: InstallLiveJournalGenesisInput, b: InstallLiveJournalGenesisInput): boolean {
	return (
		a.objectId === b.objectId &&
		compareBytes(a.exactCanonicalAnchorPreimageBytes, b.exactCanonicalAnchorPreimageBytes) === 0 &&
		compareBytes(a.detachedAnchorSignature, b.detachedAnchorSignature) === 0 &&
		compareBytes(a.exactCanonicalParametersCarrierBytes, b.exactCanonicalParametersCarrierBytes) === 0
	);
}
