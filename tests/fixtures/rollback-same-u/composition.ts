import { encodeCanonical } from "@ts-drp/canonical";
import { AHE_BOUNDED_READ_LIMITS, digestBlob, parseStorageObjectId } from "@ts-drp/storage";
import {
	authenticateCreatorClosedRollbackData,
	createCreatorClosedRollbackProofAccounting,
	resolveCreatorClosedRollbackDataObservation,
} from "same-u-observer-under-test";

import type { CompositionMode } from "./contract.js";
import { configure, dispatches, events, owners, results } from "./hooks.js";
import { application, digest, hex, unhex } from "../cold-discovery/application.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
import { nodePort } from "../rollback-data-observation/node-port.js";
import { record, requireThat, transitionPrerequisite, unique } from "../rollback-data-observation/proof.js";
import type { Bootstrap } from "../rollback-data-observation/types.js";

const [bootstrapText, modeText] = process.argv.slice(2);
if (!bootstrapText || !modeText) throw new Error("COMPOSITION_ARGUMENTS");
const b = JSON.parse(bootstrapText) as Bootstrap,
	native = nodeOwners(b.identity),
	port = nodePort(b.identity);
const U = AHE_BOUNDED_READ_LIMITS.maxUnionBytes;
try {
	const floor = await port.readFloor(),
		parsed = parseStorageObjectId(b.objectId);
	requireThat(floor && floor.stable.epoch === 3 && parsed.ok, "original genuine first-k1 source");
	const acquired = await native.ahe.acquireBoundedActiveRead({
		objectId: parsed.value,
		ancestorCount: 2,
		limits: AHE_BOUNDED_READ_LIMITS,
	});
	requireThat(acquired.ok && acquired.value.kind === "present", "actual complete native AHE union");
	const reader = acquired.value.reader;
	let actualUnion: { digest: string; byteLength: number }[],
		scope: { objectId: string; epoch: number; anchorDigest: string },
		anchorBytes: Uint8Array;
	try {
		const { pair } = transitionPrerequisite(b, floor, reader),
			retirement = record(unique(pair.v[2] ?? [], "drp-creator-issuance-retirement-state", 1).bytes),
			cut = record(unique(pair.v[2] ?? [], "drp-hard-epoch-cut", 1).bytes),
			trust = record(unique(pair.v[2] ?? [], "drp-anchor-trust-state", 2).bytes),
			successor = record(trust.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
		requireThat(
			!pair.v[2]?.some((x) => record(x.bytes).kind === "drp-creator-author-issuance-frontiers-state"),
			"genuine supported older retirement-only representation"
		);
		requireThat(
			retirement.closedAnchorDigest === cut.previousAnchor && successor.previousAnchor === cut.previousAnchor,
			"both genuine unchanged commitments"
		);
		scope = { objectId: b.objectId, epoch: 1, anchorDigest: String(cut.previousAnchor) };
		const actual = await native.journal.readAnchorPreimage({ scope, maxBytes: 8192 });
		requireThat(actual.ok && actual.kind === "present", "original genuine signed provisioned native anchor");
		anchorBytes = actual.exactCanonicalAnchorPreimageBytes;
		requireThat(
			digest("ts-drp/epoch-anchor/v3", anchorBytes) === retirement.closedAnchorDigest &&
				digest("ts-drp/epoch-anchor/v3", anchorBytes) === successor.previousAnchor,
			"actual returned canonical bytes double bound"
		);
		actualUnion = reader.blobs.map(({ ref, bytes }) => {
			const whole = digestBlob(bytes);
			requireThat(
				whole.ok && whole.value === ref.digest && bytes.length === ref.byteLength,
				"actual complete native union byte/hash capture"
			);
			return { digest: ref.digest, byteLength: bytes.length };
		}); // Retain compact actual-byte identities only, never a second AHE payload cache.
	} finally {
		await reader.release();
	}
	const precondition = {
		scope,
		anchorByteLength: anchorBytes.length,
		anchorWholeBytes: hex(anchorBytes),
		actualCompleteUnionBytes: actualUnion.reduce((sum, ref) => sum + ref.byteLength, 0),
		actualUnion,
		sourceIdentity: b.identity,
		genuineOriginalSignedSource: true,
		joinedActualReadAndRelease: true,
	};
	if (
		typeof createCreatorClosedRollbackProofAccounting !== "function" ||
		typeof authenticateCreatorClosedRollbackData !== "function" ||
		typeof resolveCreatorClosedRollbackDataObservation !== "function"
	) {
		console.log(
			JSON.stringify({
				classification: "WIRING_RED",
				label: "UNIT_COMPOSITION_NOT_SUPPORTED_AHE_HISTORY_OR_WHOLE_NATIVE_PRESSURE",
				mode: modeText,
				precondition,
				missing: "actual private factory/observer/resolver",
				productAssertionsReached: false,
			})
		);
	} else if (modeText === "owner-unit") {
		const recognized = encodeCanonical({ kind: "drp-hard-epoch-cut", unitOnly: true }),
			generic = new Uint8Array([0xff, 0x02, 0x91, 0x73]);
		const blobs = [recognized, generic].map((bytes) => {
			const d = digestBlob(bytes);
			requireThat(d.ok, "actual unit byte digest");
			return { bytes, ref: { digest: d.value, byteLength: bytes.length } };
		});
		const owner = createCreatorClosedRollbackProofAccounting(blobs),
			start = owner.chargedBytes;
		requireThat(start === recognized.length + generic.length, "recognized-only initial subtotal mutant");
		requireThat(owner.charge(anchorBytes), "actual genuine anchor charge");
		const afterAnchor = owner.chargedBytes;
		requireThat(afterAnchor === start + anchorBytes.length, "unbilled actual anchor mutant");
		requireThat(
			owner.charge(Uint8Array.from(anchorBytes)) && owner.chargedBytes === afterAnchor,
			"actual whole-byte equality charge once"
		);
		const unequal = Uint8Array.from(anchorBytes);
		unequal[unequal.length - 1] ^= 1;
		requireThat(
			owner.charge(unequal) && owner.chargedBytes === afterAnchor + unequal.length,
			"unequal same-length or domain-label dedup mutant"
		);
		const beforeFill = owner.chargedBytes,
			fill = new Uint8Array(U - beforeFill).fill(0xda);
		requireThat(owner.charge(fill) && owner.chargedBytes === U, "fixed actual U equality boundary");
		requireThat(
			!owner.charge(new Uint8Array([0x98, 0x11, 0x31])) && owner.chargedBytes === U,
			"over-budget whole refusal without reset"
		);
		requireThat(
			owner.charge(Uint8Array.from(anchorBytes)) && owner.chargedBytes === U,
			"equal already-charged bytes remain free at exact U"
		);
		console.log(
			JSON.stringify({
				classification: "REACHED_OWNER_UNIT",
				label: "UNIT_COMPOSITION_ONLY",
				precondition,
				start,
				afterAnchor,
				unequalLength: unequal.length,
				finalChargedBytes: owner.chargedBytes,
			})
		);
	} else {
		const mode = modeText as CompositionMode;
		requireThat(
			["below", "equal", "above", "cap", "equal-bytes", "unequal-same-length"].includes(mode),
			"composition mode"
		);
		configure({ mode, actualUnion, anchorBytes });
		const result = await authenticateCreatorClosedRollbackData({
			objectId: b.objectId,
			pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes),
			catalog: application().catalog,
			store: native.ahe,
			snapshotStore: native.snapshot,
			liveJournalStore: native.journal,
			roomHeadAuthority: { read: async () => ({ ok: true, state: await port.readFloor() }) },
		});
		const outcome = result as { ok: boolean; kind?: string; observation?: unknown };
		const summary = outcome.ok ? resolveCreatorClosedRollbackDataObservation(outcome.observation) : undefined;
		console.log(
			JSON.stringify({
				classification: "REACHED_OBSERVER_UNIT_COMPOSITION",
				label: "SYNTHETIC_OWNER_PRECHARGE_NOT_SUPPORTED_PUBLISHED_AHE_OR_UNMODIFIED_NATIVE_PRESSURE",
				mode,
				precondition,
				result: outcome,
				summary,
				ownerCount: owners.length,
				finalChargedBytes: owners[0]?.chargedBytes,
				events,
				dispatches,
				nativeResults: results.map((value) =>
					value.ok && value.kind === "present"
						? {
								...value,
								exactCanonicalAnchorPreimageBytes: hex(value.exactCanonicalAnchorPreimageBytes),
								actualByteLength: value.exactCanonicalAnchorPreimageBytes.length,
							}
						: value
				),
			})
		);
	}
} finally {
	await native.close();
}
