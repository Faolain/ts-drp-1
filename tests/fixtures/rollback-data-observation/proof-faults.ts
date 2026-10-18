/* eslint-disable @typescript-eslint/no-non-null-assertion -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Real canonical hostile persistence with genuine signatures; never synthetic returns. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	openCreatorAuthorIssuanceFrontiers,
	openCreatorAuthorSettlement,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { openCreatorIssuanceRetirement } from "@ts-drp/protocol-v3/creator-issuance-retirement";
import { digestBlob, digestClosure, encodeGenerationRecordV1 } from "@ts-drp/storage";

import { editRefs, imageReader } from "./integrity.js";
import { record, requireThat, transitionPrerequisite, trustedPair, unique, views } from "./proof.js";
import type { Bootstrap, Fault, Floor, NativeOwners, NativePort } from "./types.js";
import { inspectCreatorTransitionAdvance } from "../../../packages/node/src/internal/creator-transition-advance.js";
import { digest, seed } from "../cold-discovery/application.js";
function genuinelySign(
	bytes: Uint8Array,
	change: Readonly<Record<string, unknown>>,
	domain: string,
	signatureField = "detachedCreatorSignature"
): Uint8Array {
	const preimage = Object.fromEntries(Object.entries(record(bytes)).filter(([key]) => key !== signatureField));
	const updated = { ...preimage, ...change };
	return encodeCanonical({
		...updated,
		[signatureField]: ed25519.sign(hashDomain(domain, encodeCanonical(updated)), seed),
	});
}
export async function mutateProof(
	b: Bootstrap,
	floor: Floor,
	owners: NativeOwners,
	port: NativePort,
	fault: Fault
): Promise<unknown> {
	if (
		![
			"forged-old-acl",
			"wrong-retirement-anchor",
			"old-qc-length",
			"bad-aggregate-link",
			"bad-settlement-frontier",
			"same-u",
		].includes(fault)
	)
		return null;
	let image = await port.image();
	const reader = imageReader(image),
		pair = trustedPair(b, floor, reader),
		v = views(reader),
		k = floor.stable.epoch - 2;
	const replacements = new Map<string, Uint8Array>();
	let crypto: unknown;
	if (fault === "forged-old-acl") {
		const old = unique(v[2]!, "drp-v3-latched-acl", k),
			actual = record(old.bytes);
		const forged = encodeCanonical({ ...actual, permissionless: true });
		replacements.set(old.ref.digest, forged);
		image = editRefs(image, replacements);
		await port.replace(image);
		const structural = transitionPrerequisite(b, floor, imageReader(image)).result;
		const originalDigest = digest("ts-drp/latched-acl/v3", old.bytes),
			forgedDigest = digest("ts-drp/latched-acl/v3", forged);
		requireThat(originalDigest !== forgedDigest, "otherwise valid old ACL differs");
		return {
			structural: { ok: structural.ok },
			sameObject: b.objectId,
			sameEpoch: k,
			originalDigest,
			forgedDigest,
			tupleRepaired: true,
			genuineSignedRetirementUnchanged: true,
		};
	}
	if (fault === "wrong-retirement-anchor" || fault === "old-qc-length") {
		const old = unique(v[2]!, "drp-creator-issuance-retirement-state", k),
			cut = unique(v[2]!, "drp-hard-epoch-cut", k),
			qc = unique(v[2]!, "drp-seal-qc", k);
		const change =
			fault === "wrong-retirement-anchor"
				? { closedAnchorDigest: "e".repeat(64) }
				: { commitQcRef: { ...qc.ref, byteLength: qc.ref.byteLength + 1 } };
		const bytes = genuinelySign(old.bytes, change, "ts-drp/creator-issuance-retirement/v1");
		replacements.set(old.ref.digest, bytes);
		crypto = openCreatorIssuanceRetirement({
			exactCanonicalRecordBytes: bytes,
			expectedCommitQcRef: fault === "old-qc-length" ? change.commitQcRef : qc.ref,
			expectedCutValueDigest: digest("ts-drp/hard-epoch-cut/v3", cut.bytes),
			expectedSnapshotManifestDigest: record(cut.bytes).snapshotManifestDigest,
			floorTrust: pair.current,
		});
		requireThat((crypto as { ok: boolean }).ok, "genuine signed wrong control opener passes standalone");
		// The latest signed retirement prior link is also repaired with a REAL creator signature.
		const next = unique(v[1]!, "drp-creator-issuance-retirement-state", k + 1),
			d = digestBlob(bytes);
		requireThat(d.ok, "new signed control digest");
		replacements.set(
			next.ref.digest,
			genuinelySign(next.bytes, { priorRetirementCandidateDigest: d.value }, "ts-drp/creator-issuance-retirement/v1")
		);
	} else if (fault === "bad-aggregate-link") {
		const next = unique(v[1]!, "drp-creator-author-issuance-frontiers-state");
		replacements.set(
			next.ref.digest,
			genuinelySign(
				next.bytes,
				{ priorAggregateCandidateDigest: "e".repeat(64) },
				"ts-drp/creator-author-issuance-frontiers/v1"
			)
		);
	} else if (fault === "bad-settlement-frontier") {
		const next = unique(v[1]!, "drp-creator-author-settlement-state"),
			r = record(next.bytes);
		const frontiers = (r.frontiers as unknown[][]).map((x) => [x[0], x[1], null]);
		replacements.set(
			next.ref.digest,
			genuinelySign(next.bytes, { frontiers }, "ts-drp/creator-author-settlement/v1", "detachedAuthoritySignature")
		);
	} else {
		// Native budget control, not a semantic profile positive. Every added generic ref is physical,
		// promoted and exact-hashed; native U is tested without filtering recognized content.
		for (const g of reader.generations) {
			let current = g;
			while (current.closure.length < 7) {
				const bytes = new Uint8Array(65536).fill(current.closure.length + reader.generations.indexOf(g) * 10),
					d = digestBlob(bytes);
				requireThat(d.ok, "actual generic digest");
				const closure = [...current.closure, { digest: d.value, byteLength: bytes.length }].sort((a, b) =>
						a.digest.localeCompare(b.digest)
					),
					cd = digestClosure(closure);
				requireThat(cd.ok, "generic exact closure");
				current = { ...current, closure, closureDigest: cd.value };
				image.blobs.push({ digest: d.value, bytes });
				image.promotions.push({ objectId: g.objectId, generationId: g.generationId, digest: d.value });
			}
			const row = image.generations.find((r) => r.generationId === g.generationId)!;
			row.record = encodeGenerationRecordV1(current);
		}
		// Recompute physical head and every selected base tuple, including the head's new closure.
		image = editRefs(image, new Map());
		await port.replace(image);
		return {
			nativeGenericOnly: true,
			actualDistinctUnionBytes: imageReader(image).blobs.reduce((s, c) => s + c.bytes.length, 0),
			noSecondBudget: true,
		};
	}
	if (fault === "bad-aggregate-link" || fault === "bad-settlement-frontier") {
		const old = unique(
				v[1]!,
				fault === "bad-aggregate-link"
					? "drp-creator-author-issuance-frontiers-state"
					: "drp-creator-author-settlement-state"
			),
			r = record(old.bytes),
			bytes = replacements.get(old.ref.digest)!;
		const opener = fault === "bad-aggregate-link" ? openCreatorAuthorIssuanceFrontiers : openCreatorAuthorSettlement;
		crypto = opener({
			exactCanonicalRecordBytes: bytes,
			expectedCommitQcRef: r.commitQcRef,
			expectedCurrentAclDigest: r.currentAclDigest,
			expectedCutValueDigest: r.cutValueDigest,
			expectedSnapshotManifestDigest: r.snapshotManifestDigest,
			expectedSuccessorAclDigest: r.successorAclDigest,
			floorTrust: pair.successor,
			...(fault === "bad-aggregate-link" ? { currentTrust: pair.current } : {}),
		});
		requireThat((crypto as { ok: boolean }).ok, "genuine signed frontier opener succeeds before continuity/ACL policy");
	}
	image = editRefs(image, replacements);
	await port.replace(image);
	if (fault === "bad-settlement-frontier") {
		const fresh = imageReader(image),
			early = transitionPrerequisite(b, floor, fresh),
			view = views(fresh),
			cut = unique(view[1]!, "drp-hard-epoch-cut", k + 1),
			qc = unique(view[1]!, "drp-seal-qc", k + 1),
			c = record(cut.bytes);
		const lookup = await owners.snapshot.lookupRecoveryDeclaration({
			objectId: b.objectId,
			epoch: k + 1,
			anchor: String(c.previousAnchor),
			manifestDigest: String(c.snapshotManifestDigest),
		});
		requireThat(lookup.kind === "present", "actual latest snapshot ACL policy source");
		const read = await owners.snapshot.acquireRecoveryRead(lookup.declaration);
		requireThat(read.kind === "present", "actual native snapshot policy reader");
		const payload = new Uint8Array(read.declaration.totalBytes);
		try {
			let at = 0;
			for (const descriptor of read.declaration.chunks) {
				const bytes = await read.reader.read(descriptor);
				requireThat(bytes, "actual native ACL policy chunk");
				payload.set(bytes, at);
				at += bytes.length;
			}
		} finally {
			await read.reader.release();
		}
		const actualAcl = encodeCanonical(record(payload).acl),
			currentAcl = unique(view[0]!, "drp-v3-latched-acl", k + 1).bytes;
		const policy = inspectCreatorTransitionAdvance({
			current: { candidates: view[2]!, closure: fresh.generations[2]!.closure },
			proposed: { candidates: view[1]!, closure: fresh.generations[1]!.closure },
			currentTrust: early.pair.current,
			successorTrust: early.pair.successor,
			mode: "verify",
			proofRefs: [cut.ref, qc.ref],
			settlementAcl: { current: currentAcl, successor: actualAcl },
		});
		requireThat(!policy.ok, "genuine signed settlement rejected only with actual ACL/frontier adjacency");
		return {
			actualSignatures: true,
			crypto: { ok: true },
			earlyCryptoStructure: { ok: true },
			actualAclPolicy: { ok: false },
			refAndBaseTuplesRepaired: true,
		};
	}
	return {
		actualSignatures: true,
		crypto: crypto ? { ok: (crypto as { ok: boolean }).ok } : null,
		refAndBaseTuplesRepaired: true,
	};
}
