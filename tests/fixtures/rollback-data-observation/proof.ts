/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/explicit-function-return-type -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Independent fixture prerequisites, not the product observer. */
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorCheckpointTrust } from "@ts-drp/protocol-v3/creator-checkpoint";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheBoundedActiveRead,
	type GenerationRef,
	parseStorageObjectId,
} from "@ts-drp/storage";

import type { Bootstrap, Floor, NativeOwners, TargetOracle } from "./types.js";
import { inspectCreatorTransitionAdvance } from "../../../packages/node/src/internal/creator-transition-advance.js";
import { digest, parameters, unhex } from "../cold-discovery/application.js";
export function requireThat(value: unknown, label: string): asserts value {
	if (!value) throw new Error("PRECONDITION:" + label);
}
export function record(bytes: Uint8Array): Record<string, unknown> {
	return decodeCanonical(bytes) as Record<string, unknown>;
}
export interface Candidate {
	readonly bytes: Uint8Array;
	readonly ref: GenerationRef;
}
export function unique(candidates: readonly Candidate[], kind: string, epoch?: number): Candidate {
	const found = candidates.filter((c) => {
		const r = record(c.bytes);
		return (
			r.kind === kind &&
			(epoch === undefined || (r.currentEpoch ?? r.closedEpoch ?? r.epoch) === epoch) &&
			(kind !== "drp-seal-qc" || r.phase === "commit")
		);
	});
	requireThat(found.length === 1, "unique " + kind + ":" + epoch);
	return found[0]!;
}
export function views(reader: AheBoundedActiveRead): Candidate[][] {
	return reader.generations.map((g) =>
		g.closure.map((ref) => {
			const c = reader.blobs.find((c) => c.ref.digest === ref.digest && c.ref.byteLength === ref.byteLength);
			requireThat(c, "exact selected native ref");
			return c;
		})
	);
}
export function trustedPair(b: Bootstrap, floor: Floor, reader: AheBoundedActiveRead) {
	const pin = record(unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes));
	const openedPin = openCurrentAnchorTrust({
		exactCanonicalTrustStateRecordBytes: unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes),
		expectedObjectId: b.objectId,
		pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
	});
	requireThat(openedPin.ok, "genuine pin opener");
	const v = views(reader),
		n = floor.stable.epoch;
	if (n === 0) return { current: openedPin.trust, successor: openedPin.trust, v };
	const cut = unique(v[1]!, "drp-hard-epoch-cut", n - 1),
		qc = unique(v[1]!, "drp-seal-qc", n - 1);
	const trust = unique(v[0]!, "drp-anchor-trust-state", n);
	if (n === 1) {
		const opened = openCreatorSuccessorTrust({
			currentTrust: openedPin.trust,
			exactCanonicalCommitQcBytes: qc.bytes,
			exactCanonicalCutValueBytes: cut.bytes,
			exactCanonicalTrustStateRecordBytes: trust.bytes,
		});
		requireThat(opened.ok, "genuine latest seal/current successor");
		return { current: openedPin.trust, successor: opened.trust, v };
	}
	const predecessor = unique(v[2]!, "drp-anchor-trust-state", n - 1);
	const opened = openCreatorCheckpointTrust({
		detachedGenesisSignature: pin.detachedCurrentAnchorSignature as Uint8Array,
		exactCanonicalCommitQcBytes: qc.bytes,
		exactCanonicalCurrentTrustStateRecordBytes: trust.bytes,
		exactCanonicalCutValueBytes: cut.bytes,
		exactCanonicalGenesisAnchorPreimageBytes: pin.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array,
		exactCanonicalPredecessorTrustStateRecordBytes: predecessor.bytes,
		expectedCurrentHead: floor.stable,
		expectedObjectId: b.objectId,
		pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
	});
	requireThat(opened.ok, "genuine bounded checkpoint/latest QC");
	return { current: opened.predecessorTrust, successor: opened.currentTrust, v };
}
export function transitionPrerequisite(b: Bootstrap, floor: Floor, reader: AheBoundedActiveRead) {
	const pair = trustedPair(b, floor, reader),
		n = floor.stable.epoch;
	if (n === 0) return { pair, result: { ok: true } };
	const cut = unique(pair.v[1]!, "drp-hard-epoch-cut", n - 1),
		qc = unique(pair.v[1]!, "drp-seal-qc", n - 1);
	const input = {
		current: { candidates: pair.v[2]!, closure: reader.generations[2]!.closure },
		proposed: { candidates: pair.v[1]!, closure: reader.generations[1]!.closure },
		currentTrust: pair.current,
		successorTrust: pair.successor,
		mode: "verify" as const,
		proofRefs: [cut.ref, qc.ref],
	};
	const result = inspectCreatorTransitionAdvance(input);
	requireThat(result.ok, "existing cryptographic/structural transition:" + JSON.stringify(result));
	return { pair, result };
}
export async function provePresentBytes(
	b: Bootstrap,
	floor: Floor,
	owners: NativeOwners
): Promise<{ targets: TargetOracle[]; proofBytes: number; rows: number; selectedIds: string[]; transition: unknown }> {
	const object = parseStorageObjectId(b.objectId);
	requireThat(object.ok, "object parsed");
	const read = await owners.ahe.acquireBoundedActiveRead({
		objectId: object.value,
		ancestorCount: floor.stable.epoch === 0 ? 0 : 2,
		limits: AHE_BOUNDED_READ_LIMITS,
	});
	requireThat(read.ok && read.value.kind === "present", "bounded genuine present " + JSON.stringify(read));
	const reader = read.value.reader;
	try {
		const { pair, result } = transitionPrerequisite(b, floor, reader);
		const targets: TargetOracle[] = [];
		const ready = await owners.snapshot.recoveryStatus();
		if (floor.stable.epoch > 0) requireThat(ready.migration === "ready", "real ready owner");
		for (const k of floor.stable.epoch === 0
			? []
			: floor.stable.epoch === 1
				? [0]
				: [floor.stable.epoch - 1, floor.stable.epoch - 2]) {
			const candidates = k === floor.stable.epoch - 1 ? pair.v[1]! : pair.v[2]!;
			const cut = unique(candidates, "drp-hard-epoch-cut", k),
				qc = unique(candidates, "drp-seal-qc", k),
				c = record(cut.bytes);
			const closedAcl = unique(k === floor.stable.epoch - 1 ? pair.v[0]! : pair.v[2]!, "drp-v3-latched-acl", k);
			const successorRecord = record(
				unique(k === floor.stable.epoch - 1 ? pair.v[0]! : pair.v[2]!, "drp-anchor-trust-state", k + 1).bytes
			);
			const successorAnchor = record(successorRecord.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array);
			let expectation: string, representation: TargetOracle["representation"];
			const settlement = candidates.find((x) => record(x.bytes).kind === "drp-creator-author-settlement-state");
			const aggregate = candidates.find((x) => record(x.bytes).kind === "drp-creator-author-issuance-frontiers-state");
			if (settlement) {
				expectation = String(record(settlement.bytes).currentAclDigest);
				representation = "settlement";
			} else if (aggregate) {
				expectation = String(record(aggregate.bytes).currentAclDigest);
				representation = "aggregate-retirement";
			} else {
				representation = "retirement-only";
				const retirement = record(unique(candidates, "drp-creator-issuance-retirement-state", k).bytes);
				requireThat(
					retirement.closedAnchorDigest === c.previousAnchor && successorAnchor.previousAnchor === c.previousAnchor,
					"BOTH genuine anchor commitments agree"
				);
				if (k === 0)
					expectation = String(
						record(
							record(unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes))
								.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array
						).aclDigest
					);
				else {
					const anchor = await owners.journal.readAnchorPreimage({
						scope: { objectId: b.objectId, epoch: k, anchorDigest: String(c.previousAnchor) },
						maxBytes: 8192,
					});
					requireThat(anchor.kind === "present", "actual existing historical journal");
					const d = digest("ts-drp/epoch-anchor/v3", anchor.exactCanonicalAnchorPreimageBytes);
					requireThat(
						d === retirement.closedAnchorDigest && d === successorAnchor.previousAnchor,
						"actual canonical anchor double bound"
					);
					expectation = String(record(anchor.exactCanonicalAnchorPreimageBytes).aclDigest);
				}
			}
			const acl = openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: closedAcl.bytes,
				expectedAclDigest: expectation,
				expectedEpoch: k,
				expectedObjectId: b.objectId,
				expectedProfileId: b.profileId,
			});
			requireThat(acl.ok, "actual closed ACL independently authenticated");
			const lookup = await owners.snapshot.lookupRecoveryDeclaration({
				objectId: b.objectId,
				epoch: k,
				anchor: String(c.previousAnchor),
				manifestDigest: String(c.snapshotManifestDigest),
			});
			requireThat(
				lookup.kind === "present" && lookup.state === "verified" && lookup.retention === "recovery",
				"real verified recovery snapshot"
			);
			const acquired = await owners.snapshot.acquireRecoveryRead(lookup.declaration);
			requireThat(acquired.kind === "present", "actual noncreating reader");
			let payload: Uint8Array;
			try {
				const chunks: Uint8Array[] = [];
				for (const descriptor of acquired.declaration.chunks) {
					const actual = await acquired.reader.read(descriptor);
					requireThat(
						actual &&
							actual.length === descriptor.byteLength &&
							snapshotChunkDigest(descriptor.index, actual) === descriptor.digest,
						"real complete descriptor bytes"
					);
					chunks.push(actual);
				}
				payload = new Uint8Array(acquired.declaration.totalBytes);
				let offset = 0;
				for (const chunk of chunks) {
					payload.set(chunk, offset);
					offset += chunk.length;
				}
			} finally {
				await acquired.reader.release();
			}
			const manifest = decodeSnapshotManifest({
				exactCanonicalManifestBytes: acquired.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: String(c.snapshotManifestDigest),
				profile: {
					maxManifestBytes: 212387,
					maxSnapshotBytes: parameters.maxSnapshotBytes,
					snapshotChunkBytes: parameters.snapshotChunkBytes,
				},
			});
			requireThat(
				manifest.manifest.totalBytes === payload.length &&
					manifest.chunks.length === acquired.declaration.chunks.length,
				"actual complete manifest/payload accounting"
			);
			const p = record(payload),
				stateBytes = encodeCanonical(p.application);
			requireThat(
				digest("ts-drp/state/v3", stateBytes) === c.stateDigest &&
					p.objectId === b.objectId &&
					p.epoch === k &&
					p.anchor === c.previousAnchor,
				"actual app/cut/scope bytes"
			);
			const payloadDigest = String(record(acquired.declaration.exactCanonicalManifestBytes).payloadDigest);
			requireThat(digest("ts-drp/snapshot-payload/v3", payload) === payloadDigest, "whole actual payload hash");
			const successorAclBytes = encodeCanonical(p.acl);
			requireThat(digest("ts-drp/latched-acl/v3", successorAclBytes) === c.aclDigest, "actual snapshot successor ACL");
			if (k === floor.stable.epoch - 1 && b.profileId === "creator-trusted-settlement-v1") {
				const current = { candidates: pair.v[2]!, closure: reader.generations[2]!.closure },
					proposed = { candidates: pair.v[1]!, closure: reader.generations[1]!.closure };
				const actual = inspectCreatorTransitionAdvance({
					current,
					proposed,
					currentTrust: pair.current,
					successorTrust: pair.successor,
					mode: "verify",
					proofRefs: [cut.ref, qc.ref],
					settlementAcl: { current: closedAcl.bytes, successor: successorAclBytes },
				});
				requireThat(actual.ok, "actual canonical settlement ACL/frontier second pass");
			}
			targets.push({
				epoch: k,
				state: p.application,
				stateDigest: String(c.stateDigest),
				closedAclDigest: expectation,
				successorAclDigest: String(c.aclDigest),
				manifestDigest: String(c.snapshotManifestDigest),
				payloadDigest,
				payloadByteLength: payload.length,
				closedAnchorDigest: String(c.previousAnchor),
				successorAnchorDigest: String(successorRecord.currentAnchorDigest),
				cutRef: cut.ref,
				commitQcRef: qc.ref,
				representation,
			});
		}
		if (targets.length === 2)
			requireThat(
				targets[0]!.stateDigest !== targets[1]!.stateDigest &&
					targets[0]!.closedAclDigest !== targets[1]!.closedAclDigest,
				"distinct actual older/newest app and closed ACL"
			);
		return {
			targets,
			proofBytes: reader.blobs.reduce((s, b) => s + b.bytes.length, 0),
			rows: reader.generations.length,
			selectedIds: reader.generations.map((g) => g.generationId),
			transition: { ok: result.ok },
		};
	} finally {
		await reader.release();
	}
}
