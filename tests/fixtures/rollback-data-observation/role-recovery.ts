/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, jsdoc/require-jsdoc -- Test-owned native controls and finite observation dispatch. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { openCreatorAuthorSettlement } from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { openCreatorIssuanceRetirement } from "@ts-drp/protocol-v3/creator-issuance-retirement";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheBoundedActiveRead,
	type AheBoundedRecoveryRoleRead,
	type AheBoundedRecoveryRoleStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	type GenerationRecord,
	parseStorageObjectId,
	type PresentHead,
} from "@ts-drp/storage";

import { arm, event, events, reset } from "./events.js";
import { editRefs } from "./integrity.js";
import { record, requireThat, transitionPrerequisite, trustedPair, unique, views } from "./proof.js";
import type { RoleBootstrap, RoleFault, RoleIdentity, RoleOracle, RoleReport } from "./role-assertions.js";
import type { Bootstrap, Floor, NativeImage, NativeOwners, NativePort } from "./types.js";
import { recoverPendingCreatorSuccessorAdoption } from "../../../packages/node/dist/src/creator-adoption-recover.js";
import * as product from "../../../packages/node/src/internal/creator-closed-rollback-data.js";
import {
	creatorSnapshotCatalogIdentity,
	creatorSnapshotProjectionAuthorityMatches,
	verifiedCreatorSnapshotCatalog,
} from "../../../packages/node/src/internal/creator-snapshot-data.js";
import { inspectCreatorTransitionAdvance } from "../../../packages/node/src/internal/creator-transition-advance.js";
import { application, digest, hex, parameters, seed, unhex } from "../cold-discovery/application.js";
import { prepareCandidates } from "../pending-discovery/candidates.js";
const method = (value: object, key: string) => Reflect.get(value, key) as unknown;
function store(owners: NativeOwners): AheBoundedRecoveryRoleStore {
	requireThat(
		typeof method(owners.ahe, "acquireBoundedRecoveryRoleRead") === "function",
		"required accepted native capability"
	);
	return owners.ahe as AheBoundedRecoveryRoleStore;
}
function bootstrap(b: RoleBootstrap): Bootstrap {
	const pin = record(unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes));
	return { ...b, profileId: pin.profileId as Bootstrap["profileId"] };
}
function derived(g: GenerationRecord): PresentHead {
	requireThat(g.baseExpectedHead.kind === "present", "genuine publication base");
	return {
		kind: "present",
		objectId: g.objectId,
		generationId: g.generationId,
		closureDigest: g.closureDigest,
		revision: (g.baseExpectedHead.revision + 1) as PresentHead["revision"],
	};
}
function tuple(reader: AheBoundedRecoveryRoleRead, epoch: number): GenerationRecord[] {
	const candidates = reader.generations.filter(
		(g) =>
			["Complete", "Adopted", "Superseded"].includes(g.state) &&
			g.closure.some((ref) => {
				const c = reader.blobs.find((x) => x.ref.digest === ref.digest)!;
				const r = record(c.bytes);
				return r.kind === (epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2") && r.epoch === epoch;
			})
	);
	// Q(n+1) carries P(n)'s projection. A publication row replaces it; inspect actual trust epoch.
	const matches = candidates.filter((g) =>
		g.closure.some((ref) => {
			const r = record(reader.blobs.find((x) => x.ref.digest === ref.digest)!.bytes);
			return r.kind === "drp-anchor-trust-state" && r.currentEpoch === epoch;
		})
	);
	requireThat(matches.length === 1, "controller unique genuine role publication");
	const l = matches[0]!;
	if (epoch === 0) return [l];
	requireThat(l.baseExpectedHead.kind === "present", "L base");
	const q = reader.generations.find((g) => g.generationId === (l.baseExpectedHead as PresentHead).generationId);
	requireThat(q && q.baseExpectedHead.kind === "present", "Q base");
	const p = reader.generations.find((g) => g.generationId === (q.baseExpectedHead as PresentHead).generationId);
	requireThat(p, "P retained");
	return [l, q, p];
}
function activeView(reader: AheBoundedRecoveryRoleRead, rows: GenerationRecord[]): AheBoundedActiveRead {
	return {
		head: derived(rows[0]!),
		generations: rows,
		blobs: reader.blobs,
		checkCurrent: () => Promise.reject(Error("controller view not authority")),
		release: () => Promise.reject(Error("controller view not reader")),
	};
}
const controlKinds: Record<string, string> = {
	"v3-live-generation-1": "projection",
	"v3-live-generation-2": "projection",
	"drp-anchor-trust-state": "trust",
	"drp-hard-epoch-cut": "cut",
	"drp-seal-qc": "commit-qc",
	"drp-creator-issuance-retirement-state": "retirement",
	"drp-creator-author-issuance-frontiers-state": "aggregate",
	"drp-creator-author-settlement-state": "settlement",
	"drp-v3-latched-acl": "closed-acl",
};
async function roleIdentity(
	b: Bootstrap,
	roomHead: Floor["stable"],
	reader: AheBoundedRecoveryRoleRead,
	rows: GenerationRecord[],
	owners: NativeOwners
) {
	const g = rows[0]!,
		view = activeView(reader, rows),
		v = views(view),
		n = roomHead.epoch;
	const controls = g.closure.flatMap((ref) => {
		const r = record(reader.blobs.find((x) => x.ref.digest === ref.digest)!.bytes);
		const kind = controlKinds[String(r.kind)];
		return kind && !(r.kind === "drp-seal-qc" && r.phase !== "commit") ? [{ kind, ref }] : [];
	});
	const identity: RoleIdentity = {
		roomHead,
		profileId: b.profileId,
		generation: { ...g, derivedHead: derived(g) },
		controls,
		snapshot: null,
	};
	const pair = trustedPair(b, { stable: roomHead, pending: null }, view);
	if (n === 0) {
		const actualTrust = unique(v[0]!, "drp-anchor-trust-state", 0),
			projection = record(unique(v[0]!, "v3-live-generation-1", 0).bytes),
			pinRecord = record(unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes)),
			anchor = record(pinRecord.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array),
			catalog = creatorSnapshotCatalogIdentity(projection);
		requireThat(
			compareBytes(actualTrust.bytes, unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes)) === 0 &&
				creatorSnapshotProjectionAuthorityMatches(projection, anchor, b.pinnedGenesisAnchorDigest) &&
				catalog &&
				verifiedCreatorSnapshotCatalog(application().catalog, anchor.blueprintDigest, catalog),
			"actual genesis projection/trust/catalog bind genuine pin"
		);
		return { identity, precondition: { early: true, deferred: true, predecessor: "genuine-genesis-pin" } };
	}
	const early = transitionPrerequisite(b, { stable: roomHead, pending: null }, view);
	requireThat(early.result.ok, "original aggregate/settlement transition");
	const cut = unique(v[1]!, "drp-hard-epoch-cut", n - 1),
		qc = unique(v[1]!, "drp-seal-qc", n - 1),
		c = record(cut.bytes),
		acl = unique(v[0]!, "drp-v3-latched-acl", n - 1);
	const scope = {
		objectId: b.objectId,
		epoch: n - 1,
		anchor: String(c.previousAnchor),
		manifestDigest: String(c.snapshotManifestDigest),
	};
	const ready = await owners.snapshot.recoveryStatus();
	requireThat(ready.migration === "ready", "actual owner ready");
	const lookup = await owners.snapshot.lookupRecoveryDeclaration(scope);
	requireThat(
		lookup.kind === "present" && lookup.state === "verified" && lookup.retention === "recovery",
		"genuine selected declaration"
	);
	const read = await owners.snapshot.acquireRecoveryRead(lookup.declaration);
	requireThat(read.kind === "present", "actual native selected target");
	const payload = new Uint8Array(read.declaration.totalBytes);
	try {
		let at = 0;
		for (const descriptor of read.declaration.chunks) {
			const bytes = await read.reader.read(descriptor);
			requireThat(
				bytes &&
					bytes.length === descriptor.byteLength &&
					snapshotChunkDigest(descriptor.index, bytes) === descriptor.digest,
				"actual native complete chunk"
			);
			payload.set(bytes, at);
			at += bytes.length;
		}
	} finally {
		await read.reader.release();
	}
	const p = record(payload),
		successorAcl = encodeCanonical(p.acl),
		manifest = decodeSnapshotManifest({
			exactCanonicalManifestBytes: read.declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: scope.manifestDigest,
			profile: {
				maxManifestBytes: 212387,
				maxSnapshotBytes: parameters.maxSnapshotBytes,
				snapshotChunkBytes: parameters.snapshotChunkBytes,
			},
		});
	const closedControl = v[1]!.find((x) =>
		["drp-creator-author-issuance-frontiers-state", "drp-creator-author-settlement-state"].includes(
			String(record(x.bytes).kind)
		)
	);
	requireThat(closedControl, "original aggregate/settlement custody preserved");
	const expectedAcl = String(record(closedControl.bytes).currentAclDigest),
		openedAcl = openCanonicalLatchedAclSnapshot({
			exactCanonicalLatchedAclBytes: acl.bytes,
			expectedAclDigest: expectedAcl,
			expectedEpoch: n - 1,
			expectedObjectId: b.objectId,
			expectedProfileId: b.profileId,
		});
	requireThat(openedAcl.ok, "genuine actual closed ACL");
	requireThat(
		digest("ts-drp/snapshot-payload/v3", payload) === manifest.manifest.payloadDigest &&
			digest("ts-drp/state/v3", encodeCanonical(p.application)) === c.stateDigest &&
			digest("ts-drp/latched-acl/v3", successorAcl) === c.aclDigest,
		"actual complete payload and ACL"
	);
	const deferred = inspectCreatorTransitionAdvance({
		current: { candidates: v[2]!, closure: rows[2]!.closure },
		proposed: { candidates: v[1]!, closure: rows[1]!.closure },
		currentTrust: pair.current,
		successorTrust: pair.successor,
		mode: "verify",
		proofRefs: [cut.ref, qc.ref],
		...(b.profileId === "creator-trusted-settlement-v1"
			? { settlementAcl: { current: acl.bytes, successor: successorAcl } }
			: {}),
	});
	requireThat(deferred.ok, "actual settlement repeat with genuine retained predecessor");
	identity.snapshot = {
		scope,
		manifestByteLength: read.declaration.exactCanonicalManifestBytes.length,
		payloadDigest: manifest.manifest.payloadDigest,
		stateDigest: String(c.stateDigest),
		closedAclDigest: expectedAcl,
		successorAclDigest: String(c.aclDigest),
		totalBytes: read.declaration.totalBytes,
		chunks: read.declaration.chunks,
	};
	return {
		identity,
		precondition: {
			early: true,
			deferred: true,
			predecessor: n === 1 ? "genuine-genesis-sentinel" : rows[2]!.generationId,
		},
	};
}
export async function census(b: RoleBootstrap, owners: NativeOwners, port: NativePort): Promise<RoleOracle> {
	const floor = await port.readFloor();
	requireThat(floor, "actual persisted host floor");
	const object = parseStorageObjectId(b.objectId);
	requireThat(object.ok, "object");
	const acquired = await store(owners).acquireBoundedRecoveryRoleRead({
		objectId: object.value,
		limits: AHE_BOUNDED_READ_LIMITS,
	});
	requireThat(acquired.ok && acquired.value.head.kind === "present", "genuine role native read");
	const reader = acquired.value;
	try {
		const currentRows = tuple(reader, floor.stable.epoch),
			current = await roleIdentity(bootstrap(b), floor.stable, reader, currentRows, owners);
		const pendingRows = floor.pending ? tuple(reader, floor.pending.next.epoch) : [],
			pending = floor.pending
				? await roleIdentity(bootstrap(b), floor.pending.next, reader, pendingRows, owners)
				: null;
		if (pending && current.identity.snapshot)
			requireThat(
				current.identity.snapshot.successorAclDigest === pending.identity.snapshot?.closedAclDigest,
				"actual distinct role ACL adjacency"
			);
		const support = [
				...new Map([...currentRows.slice(1), ...pendingRows.slice(1)].map((g) => [g.generationId, g])).values(),
			],
			used = new Set([
				currentRows[0]!.generationId,
				...pendingRows.map((g) => g.generationId),
				...support.map((g) => g.generationId),
			]);
		return {
			floor,
			head: reader.head as PresentHead,
			current: current.identity,
			pending: pending
				? {
						role: pending.identity,
						publication:
							reader.head.kind === "present" && reader.head.generationId === pendingRows[0]!.generationId
								? "already-published"
								: "before-publication",
					}
				: null,
			supportGenerations: support,
			heldGenerations: reader.generations.filter((g) => !used.has(g.generationId)),
			currency: "point-observed-no-incarnation",
			nativeUnionBytes: reader.blobs.reduce((n, c) => n + c.bytes.length, 0),
			allGenerations: reader.generations,
			preconditions: [current.precondition, ...(pending ? [pending.precondition] : [])],
		};
	} finally {
		await reader.release();
	}
}
function signed(
	bytes: Uint8Array,
	change: Record<string, unknown>,
	domain: string,
	field = "detachedCreatorSignature"
) {
	const r = record(bytes),
		preimage = { ...r, ...change };
	delete preimage[field];
	return encodeCanonical({ ...preimage, [field]: ed25519.sign(hashDomain(domain, encodeCanonical(preimage)), seed) });
}
function records(image: NativeImage) {
	return image.generations.map((r) => {
		const g = decodeGenerationRecordV1(r.record);
		requireThat(g.ok, "physical metadata");
		return g.value;
	});
}
function candidates(image: NativeImage, g: GenerationRecord) {
	return g.closure.map((ref) => {
		const row = image.blobs.find((b) => b.digest === ref.digest);
		requireThat(row, "physical candidate blob");
		return { ref, bytes: row.bytes };
	});
}
function pendingBootstrap(b: RoleBootstrap, floor: Floor) {
	requireThat(floor.pending, "genuine pending control");
	const pin = record(unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes));
	return {
		identity: b.identity,
		catalogDigest: application().catalog.catalogDigest,
		detachedSignature: hex(pin.detachedCurrentAnchorSignature as Uint8Array),
		exactCanonicalAnchorPreimageBytes: hex(pin.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array),
		exactCanonicalParametersCarrierBytes: hex(encodeCanonical(parameters)),
		pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
		expectedPreviousRoomHead: floor.pending.previous,
		expectedNextRoomHead: floor.pending.next,
	};
}
async function mutate(b: RoleBootstrap, floor: Floor, owners: NativeOwners, port: NativePort, fault: RoleFault) {
	if (fault === "published-equivalent-l") {
		const image = await port.image(),
			all = records(image),
			extra = all.find((g) => g.generationId === "0".repeat(63) + "1"),
			head = decodeHeadRecordV1(image.heads[0]!.record);
		requireThat(extra && extra.state === "Complete" && head.ok && head.value.kind === "present", "staged native retry");
		const publishedHead = head.value,
			original = all.find((g) => g.generationId === publishedHead.generationId);
		requireThat(
			original &&
				original.state === "Adopted" &&
				original.generationId !== extra.generationId &&
				compareBytes(encodeCanonical(original.closure), encodeCanonical(extra.closure)) === 0 &&
				compareBytes(encodeCanonical(original.baseExpectedHead), encodeCanonical(extra.baseExpectedHead)) === 0,
			"actual original published L and two equivalent native candidates"
		);
		return { fixtureCandidate: true };
	}
	if (
		[
			"equivalent-l",
			"contradictory-trust",
			"contradictory-projection",
			"legacy-retry",
			"legacy-active",
			"legacy-survivor",
		].includes(fault)
	) {
		const mode = fault === "contradictory-projection" ? "fork" : fault === "legacy-survivor" ? "fork" : "retry";
		await prepareCandidates(owners.ahe, pendingBootstrap(b, floor), mode);
		if (fault === "contradictory-trust" || fault === "legacy-survivor") {
			const image = await port.image(),
				all = records(image),
				g = all.find((g) => g.generationId === "0".repeat(63) + "1")!;
			const control = unique(
					candidates(image, g),
					fault === "legacy-survivor" ? "v3-live-generation-2" : "drp-anchor-trust-state",
					floor.pending!.next.epoch
				),
				r = record(control.bytes);
			let bytes: Uint8Array;
			if (fault === "legacy-survivor") bytes = encodeCanonical({ ...r, stateDigest: "f".repeat(64) });
			else {
				const sig = Uint8Array.from(r.detachedCurrentAnchorSignature as Uint8Array);
				sig[0] ^= 1;
				bytes = encodeCanonical({ ...r, detachedCurrentAnchorSignature: sig });
			}
			const d = digestBlob(bytes);
			requireThat(d.ok, "new contradiction digest");
			const closure = g.closure
					.map((ref) => (ref.digest === control.ref.digest ? { digest: d.value, byteLength: bytes.length } : ref))
					.sort((a, b) => a.digest.localeCompare(b.digest)),
				cd = digestClosure(closure);
			requireThat(cd.ok, "contradiction closure");
			image.generations.find((row) => row.generationId === g.generationId)!.record = encodeGenerationRecordV1({
				...g,
				closure,
				closureDigest: cd.value,
			});
			image.blobs.push({ digest: d.value, bytes });
			image.promotions = image.promotions.filter(
				(p) => !(p.generationId === g.generationId && p.digest === control.ref.digest)
			);
			image.promotions.push({ objectId: g.objectId, generationId: g.generationId, digest: d.value });
			await port.replace(image);
		}
		if (fault === "legacy-active") {
			const image = await port.image(),
				original = records(image).find((g) => g.state === "Complete" && g.generationId !== "0".repeat(63) + "1")!;
			requireThat(original && original.baseExpectedHead.kind === "present", "legacy active original candidate");
			requireThat(
				(
					await owners.ahe.swapHead({
						objectId: original.objectId,
						generationId: original.generationId,
						expectedHead: original.baseExpectedHead,
					})
				).ok,
				"fixture genuine original publication"
			);
		}
		return { fixtureCandidate: true };
	}
	let image = await port.image();
	const all = records(image),
		l = all.find(
			(g) =>
				["Complete", "Adopted"].includes(g.state) &&
				candidates(image, g).some(
					(x) =>
						record(x.bytes).kind ===
							((floor.pending?.next.epoch ?? floor.stable.epoch) === 0
								? "v3-live-generation-1"
								: "v3-live-generation-2") && record(x.bytes).epoch === (floor.pending?.next.epoch ?? floor.stable.epoch)
				)
		)!;
	const q = all.find(
		(g) => l.baseExpectedHead.kind === "present" && g.generationId === l.baseExpectedHead.generationId
	)!;
	const current = floor.pending
		? all.find((g) => q.baseExpectedHead.kind === "present" && g.generationId === q.baseExpectedHead.generationId)!
		: l;
	const cq = all.find(
		(g) => current.baseExpectedHead.kind === "present" && g.generationId === current.baseExpectedHead.generationId
	);
	if (fault === "missing-l") {
		image.generations = image.generations.filter((row) => row.generationId !== l.generationId);
		image.promotions = image.promotions.filter((p) => p.generationId !== l.generationId);
		await port.replace(image);
		return { fixtureRemovedCandidate: true };
	}
	if (fault === "stable-q") {
		await port.writeFloor({ ...floor, pending: null });
		return { fixtureHostOnly: true };
	}
	if (fault === "union-generic") {
		if (
			image.blobs.some((b) => {
				try {
					return record(b.bytes).kind === "test-owned-held-generic-bytes";
				} catch {
					return false;
				}
			})
		)
			return { nativeGeneric: true };
		const held = all.find(
			(g) =>
				g.state === "Superseded" && candidates(image, g).every((x) => record(x.bytes).kind === "drp-anchor-trust-state")
		)!;
		requireThat(held, "genuine unselected initial trust row");
		const bytes = encodeCanonical({ kind: "test-owned-held-generic-bytes" }),
			d = digestBlob(bytes);
		requireThat(d.ok, "held generic digest");
		const closure = [...held.closure, { digest: d.value, byteLength: bytes.length }].sort((a, b) =>
				a.digest.localeCompare(b.digest)
			),
			cd = digestClosure(closure);
		requireThat(cd.ok, "held generic closure");
		image.generations.find((r) => r.generationId === held.generationId)!.record = encodeGenerationRecordV1({
			...held,
			closure,
			closureDigest: cd.value,
		});
		image.blobs.push({ digest: d.value, bytes });
		image = editRefs(image, new Map());
		await port.replace(image);
		return { nativeGeneric: true };
	}
	if (fault === "unclassified-complete") {
		const object = parseStorageObjectId(b.objectId);
		requireThat(object.ok, "generic object");
		const id = (await import("@ts-drp/storage")).parseGenerationId("d".repeat(64));
		requireThat(id.ok, "generic id");
		const bytes = encodeCanonical({
				kind: "test-owned-unclassified-material",
				objectId: b.objectId,
				epoch: floor.stable.epoch + 1,
			}),
			d = digestBlob(bytes);
		requireThat(d.ok, "generic bytes");
		const head = await owners.ahe.readHead(object.value);
		requireThat(head.ok, "generic head");
		const begun = await owners.ahe.beginGeneration({
			objectId: object.value,
			generationId: id.value,
			baseExpectedHead: head.value,
			closure: [{ digest: d.value, byteLength: bytes.length }],
		});
		requireThat(begun.ok, "generic begin");
		requireThat(
			(await owners.ahe.putCachedBlob({ objectId: object.value, generationId: id.value, digest: d.value, bytes })).ok,
			"generic cache"
		);
		requireThat(
			(await owners.ahe.promoteReference({ objectId: object.value, generationId: id.value, digest: d.value })).ok,
			"generic promotion"
		);
		requireThat(
			(await owners.ahe.completeGeneration({ objectId: object.value, generationId: id.value })).ok,
			"generic complete"
		);
		return { nativeGeneric: true };
	}
	if (
		["current-missing-chunk", "pending-missing-chunk", "current-corrupt-chunk", "pending-corrupt-chunk"].includes(fault)
	) {
		await port.snapshotFault(
			fault.includes("missing") ? "older-missing-chunk" : "older-corrupt-chunk",
			b.objectId,
			fault.startsWith("current") ? floor.stable.epoch - 1 : floor.stable.epoch
		);
		return { nativeSnapshotEdit: true };
	}
	const replacements = new Map<string, Uint8Array>();
	if (fault === "current-q-binding" || fault === "pending-q-l-trust") {
		const g = fault === "current-q-binding" ? cq! : l,
			epoch = fault === "current-q-binding" ? floor.stable.epoch : floor.pending!.next.epoch,
			t = unique(candidates(image, g), "drp-anchor-trust-state", epoch),
			r = record(t.bytes),
			sig = Uint8Array.from(r.detachedCurrentAnchorSignature as Uint8Array);
		sig[0] ^= 1;
		const bytes = encodeCanonical({ ...r, detachedCurrentAnchorSignature: sig }),
			d = digestBlob(bytes);
		requireThat(d.ok, "distinct trust digest");
		const closure = g.closure
				.map((ref) => (ref.digest === t.ref.digest ? { digest: d.value, byteLength: bytes.length } : ref))
				.sort((a, b) => a.digest.localeCompare(b.digest)),
			cd = digestClosure(closure);
		requireThat(cd.ok, "trust closure");
		image.generations.find((r) => r.generationId === g.generationId)!.record = encodeGenerationRecordV1({
			...g,
			closure,
			closureDigest: cd.value,
		});
		image.blobs.push({ digest: d.value, bytes });
		image = editRefs(image, new Map());
		await port.replace(image);
		return { refAndBaseTuplesRepaired: true, pendingPairUnchanged: fault === "current-q-binding" };
	}
	if (fault === "complete-omission" || fault === "complete-replacement") {
		const ref = unique(candidates(image, l), "drp-seal-qc", floor.stable.epoch).ref;
		image = editRefs(image, new Map(), { generationId: l.generationId, digest: ref.digest });
		if (fault === "complete-replacement") {
			const bytes = encodeCanonical({ kind: "test-owned-complete-replacement" }),
				d = digestBlob(bytes);
			requireThat(d.ok, "replacement bytes");
			const g = records(image).find((g) => g.generationId === l.generationId)!;
			const closure = [...g.closure, { digest: d.value, byteLength: bytes.length }].sort((a, b) =>
					a.digest.localeCompare(b.digest)
				),
				cd = digestClosure(closure);
			requireThat(cd.ok, "replacement closure");
			image.generations.find((r) => r.generationId === l.generationId)!.record = encodeGenerationRecordV1({
				...g,
				closure,
				closureDigest: cd.value,
			});
			image.blobs.push({ digest: d.value, bytes });
			image = editRefs(image, new Map());
		}
		await port.replace(image);
		return { completeEquationMutant: true };
	}
	if (fault === "current-acl" || fault === "pending-acl") {
		const g = fault.startsWith("current") ? current : l,
			k = fault.startsWith("current") ? floor.stable.epoch - 1 : floor.stable.epoch,
			a = unique(candidates(image, g), "drp-v3-latched-acl", k);
		replacements.set(a.ref.digest, encodeCanonical({ ...record(a.bytes), permissionless: true }));
	}
	if (fault === "signed-qc-length") {
		const retired = unique(candidates(image, q), "drp-creator-issuance-retirement-state", floor.stable.epoch),
			qc = unique(candidates(image, q), "drp-seal-qc", floor.stable.epoch);
		const embedded = { ...qc.ref, byteLength: qc.ref.byteLength + 1 },
			bytes = signed(retired.bytes, { commitQcRef: embedded }, "ts-drp/creator-issuance-retirement/v1"),
			cut = unique(candidates(image, q), "drp-hard-epoch-cut", floor.stable.epoch);
		const native = await store(owners).acquireBoundedRecoveryRoleRead({
			objectId: q.objectId,
			limits: AHE_BOUNDED_READ_LIMITS,
		});
		requireThat(native.ok, "genuine signed-control native baseline");
		try {
			const pair = trustedPair(
				bootstrap(b),
				{ stable: floor.pending!.next, pending: null },
				activeView(native.value, tuple(native.value, floor.pending!.next.epoch))
			);
			const opened = openCreatorIssuanceRetirement({
				exactCanonicalRecordBytes: bytes,
				expectedCommitQcRef: embedded,
				expectedCutValueDigest: digest("ts-drp/hard-epoch-cut/v3", cut.bytes),
				expectedSnapshotManifestDigest: record(cut.bytes).snapshotManifestDigest,
				floorTrust: pair.successor,
			});
			requireThat(
				opened.ok,
				"genuine signed embedded-length control opens standalone; expected embedded ref is NOT native authority"
			);
		} finally {
			await native.value.release();
		}
		replacements.set(retired.ref.digest, bytes);
	}
	if (fault === "current-settlement" || fault === "pending-settlement") {
		const g = fault.startsWith("current") ? cq! : q,
			k = fault.startsWith("current") ? floor.stable.epoch - 1 : floor.stable.epoch,
			t = unique(candidates(image, g), "drp-creator-author-settlement-state", k),
			r = record(t.bytes),
			frontiers = r.frontiers as unknown[][];
		const changed = fault.startsWith("current")
				? frontiers.map((x) => [x[0], 1, x[2]])
				: frontiers.map((x) => [x[0], floor.pending!.next.epoch, x[2]]),
			bytes = signed(
				t.bytes,
				{ frontiers: changed },
				"ts-drp/creator-author-settlement/v1",
				"detachedAuthoritySignature"
			);
		replacements.set(t.ref.digest, bytes);
		if (fault.startsWith("current")) {
			const next = unique(candidates(image, q), "drp-creator-author-settlement-state", k + 1),
				d = digestBlob(bytes);
			requireThat(d.ok, "signed predecessor digest");
			replacements.set(
				next.ref.digest,
				signed(
					next.bytes,
					{ priorCheckpointDigest: d.value },
					"ts-drp/creator-author-settlement/v1",
					"detachedAuthoritySignature"
				)
			);
		}
		image = editRefs(image, replacements);
		await port.replace(image);
		// Real native union and actual ACL reader independently establish the intended deferred killer.
		const object = parseStorageObjectId(b.objectId);
		requireThat(object.ok, "deferred object");
		const native = await store(owners).acquireBoundedRecoveryRoleRead({
			objectId: object.value,
			limits: AHE_BOUNDED_READ_LIMITS,
		});
		requireThat(native.ok, "deferred native admitted");
		try {
			const rows = tuple(native.value, k + 1),
				view = activeView(native.value, rows),
				pair = trustedPair(
					bootstrap(b),
					{
						stable: {
							...floor.stable,
							epoch: k + 1,
							currentAnchorDigest: String(
								record(unique(views(view)[0]!, "drp-anchor-trust-state", k + 1).bytes).currentAnchorDigest
							),
						},
						pending: null,
					},
					view
				),
				v = views(view),
				cut = unique(v[1]!, "drp-hard-epoch-cut", k),
				qc = unique(v[1]!, "drp-seal-qc", k),
				s = unique(v[1]!, "drp-creator-author-settlement-state", k),
				sr = record(s.bytes);
			const crypto = openCreatorAuthorSettlement({
				exactCanonicalRecordBytes: s.bytes,
				expectedCommitQcRef: sr.commitQcRef,
				expectedCurrentAclDigest: sr.currentAclDigest,
				expectedCutValueDigest: sr.cutValueDigest,
				expectedSnapshotManifestDigest: sr.snapshotManifestDigest,
				expectedSuccessorAclDigest: sr.successorAclDigest,
				floorTrust: pair.successor,
			});
			requireThat(crypto.ok, "genuine signed settlement crypto");
			const input = {
				current: { candidates: v[2]!, closure: rows[2]!.closure },
				proposed: { candidates: v[1]!, closure: rows[1]!.closure },
				currentTrust: pair.current,
				successorTrust: pair.successor,
				mode: "verify" as const,
				proofRefs: [cut.ref, qc.ref],
			};
			requireThat(inspectCreatorTransitionAdvance(input).ok, "early crypto succeeds with retained predecessor");
			const c = record(cut.bytes),
				lookup = await owners.snapshot.lookupRecoveryDeclaration({
					objectId: b.objectId,
					epoch: k,
					anchor: String(c.previousAnchor),
					manifestDigest: String(c.snapshotManifestDigest),
				});
			requireThat(lookup.kind === "present", "genuine policy source");
			const read = await owners.snapshot.acquireRecoveryRead(lookup.declaration);
			requireThat(read.kind === "present", "genuine policy reader");
			const payload = new Uint8Array(read.declaration.totalBytes);
			try {
				let at = 0;
				for (const desc of read.declaration.chunks) {
					const x = await read.reader.read(desc);
					requireThat(x, "actual policy chunk");
					payload.set(x, at);
					at += x.length;
				}
			} finally {
				await read.reader.release();
			}
			requireThat(
				!inspectCreatorTransitionAdvance({
					...input,
					settlementAcl: {
						current: unique(v[0]!, "drp-v3-latched-acl", k).bytes,
						successor: encodeCanonical(record(payload).acl),
					},
				}).ok,
				"actual ACL policy rejects"
			);
		} finally {
			await native.value.release();
		}
		return {
			actualSignatures: true,
			earlyCryptoStructure: true,
			actualAclPolicy: false,
			refAndBaseTuplesRepaired: true,
			retainedPredecessor: true,
		};
	}
	if (replacements.size) {
		image = editRefs(image, replacements);
		await port.replace(image);
		return { refAndBaseTuplesRepaired: true };
	}
	return null;
}
function frozen(value: unknown): boolean {
	return (
		value === null ||
		typeof value !== "object" ||
		(Object.isFrozen(value) && Reflect.ownKeys(value).every((key) => frozen(Reflect.get(value, key))))
	);
}
export async function prepareRoleFixture(b: RoleBootstrap, owners: NativeOwners, port: NativePort): Promise<void> {
	const floor = await port.readFloor();
	requireThat(floor, "actual floor for held generic fixture");
	await mutate(b, floor, owners, port, "union-generic");
}
export async function preparePublishedEquivalentFixture(
	b: RoleBootstrap,
	owners: NativeOwners,
	port: NativePort,
	oracle: RoleOracle
): Promise<RoleOracle> {
	requireThat(oracle.pending?.publication === "before-publication", "original unique L fixed before retry staging");
	const original = oracle.pending.role.generation;
	requireThat(
		original.state === "Complete" && original.baseExpectedHead.kind === "present",
		"original staged native L"
	);
	await prepareCandidates(owners.ahe, pendingBootstrap(b, oracle.floor), "retry");
	const published = await owners.ahe.swapHead({
		objectId: original.objectId,
		generationId: original.generationId,
		expectedHead: original.baseExpectedHead,
	});
	requireThat(published.ok, "original L naturally published after genuine equivalent staging");
	const read = await store(owners).acquireBoundedRecoveryRoleRead({
		objectId: original.objectId,
		limits: AHE_BOUNDED_READ_LIMITS,
	});
	requireThat(read.ok, "actual final native candidate union");
	try {
		const reader = read.value,
			liveOriginal = reader.generations.find((g) => g.generationId === original.generationId),
			extra = reader.generations.find((g) => g.generationId === "0".repeat(63) + "1");
		requireThat(
			liveOriginal?.state === "Adopted" &&
				extra?.state === "Complete" &&
				compareBytes(encodeCanonical(reader.head), encodeCanonical(original.derivedHead)) === 0 &&
				compareBytes(encodeCanonical(liveOriginal.closure), encodeCanonical(original.closure)) === 0 &&
				compareBytes(encodeCanonical(extra.closure), encodeCanonical(original.closure)) === 0 &&
				compareBytes(encodeCanonical(extra.baseExpectedHead), encodeCanonical(original.baseExpectedHead)) === 0 &&
				compareBytes(encodeCanonical(await port.readFloor()), encodeCanonical(oracle.floor)) === 0,
			"original published head, unchanged pending host and both recognized equivalent native candidates"
		);
		const actualGeneration = (g: GenerationRecord) => {
			const actual = reader.generations.find((row) => row.generationId === g.generationId);
			requireThat(actual, "pre-census role row retained after original publication");
			return actual;
		};
		const actualRole = (role: RoleIdentity): RoleIdentity => ({
			...role,
			generation: { ...actualGeneration(role.generation), derivedHead: role.generation.derivedHead },
		});
		return {
			...oracle,
			head: reader.head as PresentHead,
			current: actualRole(oracle.current),
			pending: { role: actualRole(oracle.pending.role), publication: "already-published" },
			supportGenerations: oracle.supportGenerations.map(actualGeneration),
			heldGenerations: [...oracle.heldGenerations.map(actualGeneration), extra],
			allGenerations: reader.generations,
			nativeUnionBytes: reader.blobs.reduce((n, c) => n + c.bytes.length, 0),
		};
	} finally {
		await read.value.release();
	}
}
export async function recoverRoles(
	b: RoleBootstrap,
	fault: RoleFault,
	owners: NativeOwners,
	port: NativePort
): Promise<RoleReport> {
	reset();
	const observe = method(product, "observeCreatorProtectedRecoveryRoles"),
		resolve = method(product, "resolveCreatorProtectedRecoveryRoleObservation");
	if (typeof observe !== "function" || typeof resolve !== "function")
		return { classification: "WIRING_RED", result: null, summary: null, events: [] };
	const floor = await port.readFloor();
	requireThat(floor, "actual host floor");
	const mutation = await mutate(b, floor, owners, port, fault);
	const actualFloor = await port.readFloor();
	requireThat(actualFloor, "persisted mutated floor");
	if (fault.startsWith("legacy-")) {
		if (["legacy-genesis", "legacy-current", "legacy-pending"].includes(fault)) {
			const result = await product.authenticateCreatorClosedRollbackData({
				objectId: b.objectId,
				pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
				exactCanonicalPinnedGenesisTrustStateRecordBytes: unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes),
				roomHeadAuthority: { read: async () => ({ ok: true, state: actualFloor }) },
				catalog: application().catalog,
				store: owners.ahe,
				snapshotStore: owners.snapshot,
				liveJournalStore: owners.journal,
			});
			if (fault === "legacy-pending")
				requireThat(!result.ok && result.kind === "floor-pending", "old pending refusal unchanged");
			else {
				requireThat(result.ok, "old genuine stable observation");
				const summary = product.resolveCreatorClosedRollbackDataObservation(result.observation);
				requireThat(
					summary &&
						product.resolveCreatorClosedRollbackDataObservation({ ...result.observation }) === undefined &&
						product.resolveCreatorClosedRollbackDataObservation(JSON.parse(JSON.stringify(result.observation))) ===
							undefined,
					"old private fact unforgeable"
				);
				requireThat(
					Reflect.apply(resolve, undefined, [result.observation]) === undefined,
					"old fact cannot become role fact"
				);
			}
			return { classification: "REACHED", result: null, summary: null, events: [], legacy: { ok: true, result } };
		}
		const expectedBefore = await port.image(),
			head = decodeHeadRecordV1(expectedBefore.heads[0]!.record);
		requireThat(head.ok && head.value.kind === "present", "legacy original head");
		const input = pendingBootstrap(b, actualFloor);
		const result = await recoverPendingCreatorSuccessorAdoption({
			authenticationProfile: "creator-only",
			catalog: application().catalog,
			detachedSignature: unhex(input.detachedSignature),
			exactCanonicalAnchorPreimageBytes: unhex(input.exactCanonicalAnchorPreimageBytes),
			exactCanonicalParametersCarrierBytes: unhex(input.exactCanonicalParametersCarrierBytes),
			expectedPreviousRoomHead: input.expectedPreviousRoomHead,
			expectedNextRoomHead: input.expectedNextRoomHead,
			pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			snapshotStore: owners.snapshot,
			store: owners.ahe,
		});
		requireThat(result.ok === true, "original mutable good survivor");
		const after = decodeHeadRecordV1((await port.image()).heads[0]!.record);
		requireThat(after.ok && after.value.kind === "present", "legacy published head");
		if (fault === "legacy-retry")
			requireThat(after.value.generationId === "0".repeat(63) + "1", "original equivalent-ID ordering");
		if (fault === "legacy-active")
			requireThat(after.value.generationId === head.value.generationId, "already-active preference");
		if (fault === "legacy-survivor")
			requireThat(after.value.generationId !== "0".repeat(63) + "1", "original invalid survivor filtered");
		return {
			classification: "REACHED",
			result: null,
			summary: null,
			events: [],
			legacy: { ok: true, result, before: head.value, after: after.value },
		};
	}
	const object = parseStorageObjectId(b.objectId);
	requireThat(object.ok, "object");
	const check = await store(owners).acquireBoundedRecoveryRoleRead({
		objectId: object.value,
		limits: AHE_BOUNDED_READ_LIMITS,
	});
	requireThat(check.ok, "valid native mutant admission");
	const nativePrecondition = {
		ok: true,
		unionBytes: check.value.blobs.reduce((n, c) => n + c.bytes.length, 0),
		rows: check.value.generations.length,
		headEqual: true,
	};
	if (fault === "current-q-binding") {
		const view = activeView(check.value, tuple(check.value, floor.pending!.next.epoch));
		requireThat(
			transitionPrerequisite(bootstrap(b), { stable: floor.pending!.next, pending: null }, view).result.ok,
			"independent pending crypto pair still opens while own current Q/P law is broken"
		);
	}
	if (fault === "current-acl") {
		requireThat(
			transitionPrerequisite(
				bootstrap(b),
				{ stable: floor.stable, pending: null },
				activeView(check.value, tuple(check.value, floor.stable.epoch))
			).result.ok,
			"valid native current-only ACL mutant retains early current law"
		);
	}
	await check.value.release();
	const before = encodeCanonical(await port.image()),
		controller = new AbortController(),
		sideEffects: Record<string, number> = {},
		admitted: Promise<unknown>[] = [];
	let aheRelease = 0,
		floorReads = 0,
		getters = 0,
		redirects = 0,
		nativeTriggered = false,
		joinedReleaseRejected = false,
		chunkCount = 0,
		lookupCount = 0;
	const forbidden = [
		"recoverActiveGeneration",
		"beginGeneration",
		"putCachedBlob",
		"promoteReference",
		"completeGeneration",
		"discardGeneration",
		"swapHead",
		"pruneGeneration",
		"sweepCachedBlobs",
		"complete",
		"retain",
		"cancel",
		"open",
		"openScope",
		"sweepExpired",
		"discard",
		"close",
		"installGenesis",
		"transactIssue",
		"register",
		"sign",
	];
	for (const key of forbidden) sideEffects[key] = 0;
	let expectedSnapshot = encodeCanonical(await port.snapshotImage());
	const fixtureBoundaries: { kind: string; before: string; after: string }[] = [];
	const snapshotEdit = async (fault: "temporary" | "not-ready") => {
		const before = encodeCanonical(await port.snapshotImage());
		await port.snapshotFault(fault, b.objectId, floor.stable.epoch - 1);
		const after = encodeCanonical(await port.snapshotImage());
		fixtureBoundaries.push({
			kind: fault,
			before: digest("test-owned/logical-image", before),
			after: digest("test-owned/logical-image", after),
		});
		expectedSnapshot = after;
	};
	const watched = (owner: object) => {
		const overrides = new Map<PropertyKey, unknown>();
		return new Proxy(
			{},
			{
				get(_target, key) {
					if (overrides.has(key)) return overrides.get(key);
					const value = Reflect.get(owner, key, owner);
					if (typeof key === "string" && forbidden.includes(key) && typeof value === "function")
						return (...args: unknown[]) => {
							sideEffects[key]++;
							return Reflect.apply(value, owner, args);
						};
					return typeof value === "function" ? value.bind(owner) : value;
				},
				set(_target, key, value) {
					overrides.set(key, value);
					return true;
				},
			}
		);
	};
	const originalAheAcquire = store(owners).acquireBoundedRecoveryRoleRead;
	const productCustody = { calls: 0, admitted: 0, releaseCalls: 0, released: 0, unionBytes: 0, rows: 0 };
	const ahe = watched(owners.ahe),
		snapshot = watched(owners.snapshot),
		acquire = originalAheAcquire.bind(owners.ahe);
	Reflect.set(ahe, "acquireBoundedRecoveryRoleRead", async (input: Parameters<typeof acquire>[0]) => {
		productCustody.calls++;
		const result = await acquire(input);
		if (!result.ok) return result;
		productCustody.admitted++;
		productCustody.unionBytes = result.value.blobs.reduce((n, c) => n + c.bytes.length, 0);
		productCustody.rows = result.value.generations.length;
		event("role-ahe-admitted");
		const reader = result.value,
			release = reader.release.bind(reader),
			currency = reader.checkCurrency.bind(reader);
		return {
			...result,
			value: {
				...reader,
				checkCurrency: async () => {
					await Promise.all(admitted);
					event("role-currency-call");
					const result = await currency();
					event("role-currency-result", undefined, undefined, result);
					return result;
				},
				release: async () => {
					aheRelease++;
					productCustody.releaseCalls++;
					await release();
					productCustody.released++;
					event("role-ahe-release-joined");
					if (fault === "abort-cleanup") controller.abort();
					if (fault === "release-failed" || fault === "native-primary") {
						joinedReleaseRejected = true;
						throw Error("fixture after genuine joined release");
					}
				},
			},
		};
	});
	const acquireSnapshot = owners.snapshot.acquireRecoveryRead.bind(owners.snapshot);
	Reflect.set(snapshot, "acquireRecoveryRead", async (...args: Parameters<typeof acquireSnapshot>) => {
		const result = await acquireSnapshot(...args);
		if (result.kind !== "present") return result;
		const release = result.reader.release.bind(result.reader);
		return {
			...result,
			reader: {
				...result.reader,
				release: async () => {
					await release();
					event("role-snapshot-release-joined", result.declaration.scope.epoch);
				},
			},
		};
	});
	const lookup = owners.snapshot.lookupRecoveryDeclaration.bind(owners.snapshot);
	Reflect.set(snapshot, "lookupRecoveryDeclaration", async (...args: Parameters<typeof lookup>) => {
		const [scope] = args;
		lookupCount++;
		if (fault === "final-retention" && lookupCount === 3) {
			await snapshotEdit("temporary");
			event("role-final-retention-edit", scope.epoch, undefined, scope);
		}
		const result = await lookup(...args);
		event("role-lookup-result", scope.epoch, undefined, {
			scope,
			kind: result.kind,
			...("state" in result ? { state: result.state, retention: result.retention } : {}),
		});
		return result;
	});
	const originalStatus = owners.snapshot.recoveryStatus,
		status = originalStatus.bind(owners.snapshot);
	let changedReady = false;
	Reflect.set(snapshot, "recoveryStatus", async (...args: Parameters<typeof status>) => {
		if (fault === "final-readiness" && chunkCount === 2 && !changedReady) {
			changedReady = true;
			await snapshotEdit("not-ready");
			event("role-final-readiness-edit");
		}
		const result = await status(...args);
		event("role-status-result", undefined, undefined, result);
		return result;
	});
	const roomHeadAuthority = {
		read: async (input: { scope: { objectId: string; pinnedGenesisAnchorDigest: string } }) => {
			floorReads++;
			requireThat(
				input.scope.objectId === b.objectId && input.scope.pinnedGenesisAnchorDigest === b.pinnedGenesisAnchorDigest,
				"actual exact host scope"
			);
			if (floorReads === 2 && fault === "final-pending") {
				await port.writeFloor({ ...actualFloor, pending: null });
				event("role-final-pending-edit", undefined, undefined, actualFloor);
			}
			const state = await port.readFloor();
			event("role-host-result", undefined, undefined, state);
			return { ok: true, state };
		},
	};
	const pin = unhex(b.exactCanonicalPinnedGenesisTrustStateRecordBytes),
		input: Record<PropertyKey, unknown> = {
			objectId: b.objectId,
			pinnedGenesisAnchorDigest: b.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: pin,
			roomHeadAuthority,
			catalog: application().catalog,
			store: ahe,
			snapshotStore: snapshot,
			signal: controller.signal,
		};
	const extras: Partial<Record<RoleFault, string>> = {
		"capture-extra-journal": "liveJournalStore",
		"capture-extra-head": "expectedRoomHead",
		"capture-extra-role": "role",
		"capture-extra-acl": "closedAclBytes",
		"capture-extra-declaration": "snapshotDeclaration",
		"capture-extra-profile": "profileId",
	};
	if (extras[fault]) input[extras[fault]!] = {};
	if (fault === "capture-symbol") input[Symbol("extra")] = true;
	if (fault === "capture-accessor")
		Object.defineProperty(input, "objectId", {
			enumerable: true,
			get() {
				getters++;
				throw Error("capture getter");
			},
		});
	if (fault === "capture-signal") input.signal = { aborted: false };
	if (fault === "initial-abort") controller.abort();
	if (fault === "capture-pin-intrinsic")
		for (const key of ["byteLength", "buffer", "byteOffset"])
			Object.defineProperty(pin, key, {
				get() {
					getters++;
					throw Error("pin shadow getter");
				},
			});
	const passed =
		fault === "capture-throw"
			? new Proxy(input, {
					ownKeys() {
						throw Error("capture trap");
					},
				})
			: fault === "capture-null-prototype"
				? Object.assign(Object.create(null) as Record<PropertyKey, unknown>, input)
				: input;
	const nativeChunk = () => {
		chunkCount++;
		const descriptor = events.findLast((e) => e.name === "snapshot-read");
		requireThat(descriptor, "successful product native chunk has selected descriptor event");
		event("role-native-chunk-success", descriptor.epoch, descriptor.index);
		if ((fault === "abort-current" && chunkCount === 1) || (fault === "abort-pending" && chunkCount === 2))
			controller.abort();
	};
	arm((name) => {
		if (name === "snapshot-release" && fault === "non-head-current" && chunkCount === 2) {
			event("role-non-head-edit-start");
			admitted.push(
				(async () => {
					const image = await port.image(),
						all = records(image),
						head = decodeHeadRecordV1(image.heads[0]!.record);
					requireThat(head.ok && head.value.kind === "present", "currency original head");
					const g = all.find(
						(g) =>
							g.state === "Superseded" &&
							candidates(image, g).some(
								(x) => record(x.bytes).kind === "v3-live-generation-2" && record(x.bytes).epoch === floor.stable.epoch
							)
					)!;
					image.generations.find((r) => r.generationId === g.generationId)!.record = encodeGenerationRecordV1({
						...g,
						state: "Discarded",
					});
					await port.replace(image);
					const afterImage = await port.image(),
						after = decodeHeadRecordV1(afterImage.heads[0]!.record),
						afterGeneration = records(afterImage).find((r) => r.generationId === g.generationId)!;
					requireThat(
						after.ok && compareBytes(encodeCanonical(head.value), encodeCanonical(after.value)) === 0,
						"head unchanged"
					);
					event("role-non-head-edit-joined", undefined, undefined, {
						generationId: g.generationId,
						beforeState: g.state,
						afterState: afterGeneration.state,
						beforeHead: head.value,
						afterHead: after.ok ? after.value : null,
					});
				})()
			);
		}
	});
	let value: RoleReport;
	try {
		const observed = await port.observe(
			async () => {
				const promise = Reflect.apply(observe, undefined, [passed]) as Promise<RoleReport["result"]>;
				if (fault === "capture-mutation") {
					input.objectId = "creator:" + "f".repeat(32);
					pin.fill(0);
					input.store = {};
					input.snapshotStore = {};
					input.roomHeadAuthority = {};
					roomHeadAuthority.read = async () => {
						redirects++;
						throw Error("mutated method");
					};
					Reflect.set(ahe, "acquireBoundedRecoveryRoleRead", () => {
						redirects++;
						throw Error("mutated acquire method");
					});
					Reflect.set(snapshot, "lookupRecoveryDeclaration", () => {
						redirects++;
						throw Error("mutated lookup method");
					});
				}
				const result = await promise;
				await Promise.all(admitted);
				const summary = result?.ok
					? (Reflect.apply(resolve, undefined, [
							(result as unknown as { observation: object }).observation,
						]) as RoleOracle)
					: null;
				const token = result?.ok ? (result as unknown as { observation: object }).observation : undefined;
				return {
					classification: "REACHED",
					result,
					summary,
					events: [...events],
					tokenEmpty: token ? Reflect.ownKeys(token).length === 0 : false,
					tokenFrozen: token ? Object.isFrozen(token) : false,
					summaryFrozen: frozen(summary),
					foreign: token
						? [{}, Object.freeze({}), JSON.parse(JSON.stringify(token)), { ...token }, summary].map(
								(v) => Reflect.apply(resolve, undefined, [v]) ?? null
							)
						: [],
					floorReads,
					getters,
					sideEffects,
					cleanup: { aheRelease, borrowedAhe: true, borrowedSnapshot: true, joined: admitted.length },
					mutation:
						fault === "native-primary"
							? {
									nativeTriggered,
									laterAbort: controller.signal.aborted,
									joinedReleaseRejected,
									actualChunkCount: chunkCount,
								}
							: (mutation ?? {}),
					nativePrecondition,
					productCustody,
				};
			},
			nativeChunk,
			fault === "native-primary"
				? {
						ready: () => chunkCount === 2,
						trigger: () => {
							nativeTriggered = true;
							controller.abort();
						},
					}
				: undefined
		);
		value = { ...observed.value, native: observed.evidence as RoleReport["native"] };
	} finally {
		arm(undefined);
		await Promise.allSettled(admitted);
	}
	const after = encodeCanonical(await port.image());
	value.unchangedAhe = compareBytes(before, after) === 0;
	value.unchangedSnapshot = compareBytes(expectedSnapshot, encodeCanonical(await port.snapshotImage())) === 0;
	value.fixtureBoundaries = fixtureBoundaries;
	const borrowedHead = await owners.ahe.readHead(object.value);
	requireThat(borrowedHead.ok, "original borrowed AHE owner remains usable after joined observation");
	await originalStatus.call(owners.snapshot);
	if (value.cleanup) {
		value.cleanup.borrowedAhe = borrowedHead.ok;
		value.cleanup.borrowedSnapshot = true;
	}
	requireThat(redirects === 0, "captured original method receiver");
	return value;
}
