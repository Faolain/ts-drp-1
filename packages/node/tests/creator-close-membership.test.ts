import "@ts-drp/protocol-v3";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	buildMerkleTree,
	CompactMerkleAccumulator,
	deriveCloseSetHistoryCommitment,
	type EpochVertex,
} from "@ts-drp/compaction";
import { LIVE_JOURNAL_RETIREMENT_LIMITS } from "@ts-drp/live-journal";
import { describe, expect, it } from "vitest";

import {
	encodeCreatorCloseMembership,
	captureCreatorCloseMembershipSubset, openCreatorCloseMembershipSubset,
	openCreatorCloseMembership,
	rewriteCreatorCloseMembershipWitnesses,
	type CreatorCloseLocalVertexWitnessInput,
} from "../src/internal/creator-close-membership.js";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function fixture(
	count = 2,
	historyStart = 0,
	local = false,
	sameIdentity = false,
	foreign = false,
	operationBytes = 0
) {
	const objectId = "a1".repeat(32),
		epoch = 4,
		maxEpochVertices = count + 1;
	const previous = new CompactMerkleAccumulator();
	for (let index = 0; index < historyStart; index++) await previous.append(encodeCanonical({ old: index }));
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		kind: "drp-v3-latched-acl",
		objectId,
		epoch,
		version: 3,
		permissionless: false,
		members: [],
	});
	const anchorBytes = encodeCanonical({
		aclDigest: hex(hashDomain("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes)),
		archiveIndexRoot: "02".repeat(32),
		blueprintDigest: "03".repeat(32),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "04".repeat(32),
		epoch,
		historyRoot: hex(previous.root()),
		historySize: historyStart,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest: "05".repeat(32),
		previousAnchor: "06".repeat(32),
		profileDigest: "07".repeat(32),
		protocolMajor: 3,
		signerSetDigest: "08".repeat(32),
		stateDigest: "09".repeat(32),
	});
	const anchor = hex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const vertices = new Map<string, EpochVertex>([
		[
			anchor,
			{
				dependencies: [],
				epoch,
				hash: anchor,
				kind: "drp-epoch-anchor",
				objectId,
			},
		],
	]);
	const charges = new Map<string, number>();
	const localVertexWitnesses: CreatorCloseLocalVertexWitnessInput[] = [];
	let last = anchor;
	for (let index = 0; index < count; index++) {
		const preimage = encodeCanonical({
			kind: "drp-vertex",
			protocolMajor: 3,
			objectId: foreign ? "ff".repeat(32) : objectId,
			epoch,
			anchor,
			author: "b1".repeat(32),
			authorSequence: sameIdentity ? 0 : index,
			operation: { ordinal: index, ...(operationBytes === 0 ? {} : { data: new Uint8Array(operationBytes) }) },
			dependencies: [last],
		});
		const digestBytes = local
			? hashDomain("ts-drp/vertex/v3", preimage)
			: hashDomain("test/membership", encodeCanonical(index));
		const digest = hex(digestBytes);
		if (local)
			localVertexWitnesses.push({
				vertexDigest: digest,
				exactCanonicalPreimageBytes: preimage,
				detachedSignature: new Uint8Array(64).fill(index + 1),
			});
		vertices.set(digest, {
			anchor,
			dependencies: [last],
			epoch,
			hash: digest,
			kind: "drp-vertex",
			objectId,
		});
		charges.set(digest, local ? preimage.byteLength : 64);
		last = digest;
	}
	const commitment = await deriveCloseSetHistoryCommitment({
		authenticatedCanonicalPreimageByteLengths: charges,
		exactCanonicalEpochAnchorPreimageBytes: anchorBytes,
		frontier: [last],
		maxEpochBytes: Math.max(65536, count * (operationBytes + 1024)),
		maxEpochVertices,
		previousHistorySnapshot: previous.snapshot(),
		vertices,
	});
	// The helper receives an independently authenticated Cut; these controls test
	// its exact membership binding, not protocol Cut/QC signature verification.
	const cut = {
		kind: "drp-hard-epoch-cut",
		protocolMajor: 3,
		objectId,
		epoch,
		previousAnchor: anchor,
		previousHistorySize: historyStart,
		historySize: commitment.historySize,
		historyRoot: commitment.historyRoot,
		closeSetRoot: commitment.closeSetRoot,
		closeSetCount: commitment.closeSetCount,
		parameters: { maxEpochVertices },
	};
	const exactCanonicalCutValueBytes = encodeCanonical(cut);
	const bytes = await encodeCreatorCloseMembership({
		commitment,
		exactCanonicalCutValueBytes,
		exactCanonicalLatchedAclBytes,
		maxEpochVertices,
		localVertexWitnesses: foreign || sameIdentity ? [] : localVertexWitnesses,
	});
	return {
		commitment,
		cut,
		bytes,
		exactCanonicalCutValueBytes,
		exactCanonicalLatchedAclBytes,
		maxEpochVertices,
		localVertexWitnesses,
	};
}

const opened = (
	f: Awaited<ReturnType<typeof fixture>>,
	bytes = f.bytes,
	cut = f.exactCanonicalCutValueBytes,
	max = f.maxEpochVertices
) =>
	openCreatorCloseMembership({
		bytes,
		exactCanonicalCutValueBytes: cut,
		maxEpochVertices: max,
	});

function changed(f: Awaited<ReturnType<typeof fixture>>, update: (value: Record<string, unknown>) => void): Uint8Array {
	const value = decodeCanonical(f.bytes) as Record<string, unknown>;
	update(value);
	return encodeCanonical(value);
}

describe("bounded native closed-membership carrier", () => {
	it("retains sparse original inclusion paths with exact index, tree size and Cut root bindings", async () => {
		const f = await fixture(17, 11), original = await opened(f);
		const selected = [original!.orderedVertexDigests[1]!, original!.orderedVertexDigests[15]!];
		const bytes = await captureCreatorCloseMembershipSubset({...f, vertexDigests: selected});
		const open = (candidate = bytes, cut = f.exactCanonicalCutValueBytes) =>
			openCreatorCloseMembershipSubset({...f, bytes: candidate, exactCanonicalCutValueBytes: cut});
		expect([...open()!]).toEqual(selected.map(hex));
		for (const mutate of [
			(value: Record<string, unknown>) => {value.leafIndex = Number(value.leafIndex) + 1;},
			(value: Record<string, unknown>) => {value.treeSize = Number(value.treeSize) + 1;},
			(value: Record<string, unknown>) => {(value.vertexDigest as Uint8Array)[0] ^= 1;},
			(value: Record<string, unknown>) => {(value.auditPath as Uint8Array)[0] ^= 1;},
			(value: Record<string, unknown>) => {value.auditPath = (value.auditPath as Uint8Array).slice(32);},
		]) {
			const subset = decodeCanonical(bytes) as {members: Record<string, unknown>[]};
			mutate(subset.members[0]!); expect(open(encodeCanonical(subset))).toBeUndefined();
		}
		for (const changedCut of [{...f.cut, closeSetRoot: "ff".repeat(32)}, {...f.cut, objectId: "ff".repeat(32)},
			{...f.cut, epoch: f.cut.epoch + 1}, {...f.cut, previousHistorySize: f.cut.previousHistorySize + 1, historySize: f.cut.historySize + 1}]) {
			const cut = encodeCanonical(changedCut), subset = decodeCanonical(bytes) as Record<string, unknown>;
			subset.cutValueDigest = hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut));
			expect(open(encodeCanonical(subset), cut)).toBeUndefined();
		}
	});
	it("detaches inclusion projection inputs before asynchronous work and rejects nonmembers", async () => {
		const f = await fixture(3, 4), original = await opened(f), selected = new Uint8Array(original!.orderedVertexDigests[1]!);
		const bytes = new Uint8Array(f.bytes), cut = new Uint8Array(f.exactCanonicalCutValueBytes);
		const pending = captureCreatorCloseMembershipSubset({...f, bytes, exactCanonicalCutValueBytes: cut, vertexDigests: [selected]});
		bytes.fill(0); cut.fill(0); selected.fill(0);
		expect([...openCreatorCloseMembershipSubset({...f, bytes: await pending})!]).toEqual([hex(original!.orderedVertexDigests[1]!)]);
		await expect(captureCreatorCloseMembershipSubset({...f, vertexDigests: [new Uint8Array(32)]})).rejects.toThrow("outside the Cut");
	});

	it("transfers membership without the source's witnesses and records only the recipient's own subset", async () => {
		const f = await fixture(3, 7, true);
		const transferred = await rewriteCreatorCloseMembershipWitnesses({
			...f,
			localVertexWitnesses: [],
		});
		const transfer = await opened(f, transferred);
		expect(transfer?.orderedVertexDigests.map(hex)).toEqual(f.commitment.closeSetOrder);
		expect(transfer?.localVertexWitnesses).toEqual([]);
		const local = f.localVertexWitnesses.slice(0, 1);
		const received = await rewriteCreatorCloseMembershipWitnesses({
			...f,
			bytes: transferred,
			localVertexWitnesses: local,
		});
		expect((await opened(f, received))?.localVertexWitnesses).toEqual(local);
		expect((await opened(f, received))?.orderedVertexDigests).toEqual(transfer?.orderedVertexDigests);
	});
	it("rejects a transferred list with a changed Cut or a witness outside its membership", async () => {
		const f = await fixture(2, 0, true);
		await expect(
			rewriteCreatorCloseMembershipWitnesses({
				...f,
				exactCanonicalCutValueBytes: encodeCanonical({ ...f.cut, closeSetRoot: "ff".repeat(32) }),
				localVertexWitnesses: [],
			})
		).rejects.toThrow("authenticated Cut");
		await expect(
			rewriteCreatorCloseMembershipWitnesses({
				...f,
				localVertexWitnesses: [{ ...f.localVertexWitnesses[0]!, vertexDigest: "ff".repeat(32) }],
			})
		).rejects.toThrow("local witness");
	});
	it("round-trips a genuine complete close commitment with packed32-byte digests", async () => {
		const f = await fixture();
		const value = await opened(f);
		expect(value?.orderedVertexDigests.map(hex)).toEqual(f.commitment.closeSetOrder);
		expect(value?.scope).toEqual({
			objectId: f.cut.objectId,
			epoch: f.cut.epoch,
			anchorDigest: f.cut.previousAnchor,
		});
		expect((decodeCanonical(f.bytes) as { orderedVertexDigests: Uint8Array }).orderedVertexDigests.byteLength).toBe(64);
	});
	it("uses history start rather than journal ordinal and supports empty close sets", async () => {
		for (const [count, start] of [
			[2, 7],
			[0, 0],
			[0, 5],
		]) {
			const f = await fixture(count, start);
			const value = await opened(f);
			expect(value?.historyStart).toBe(start);
			expect(value?.orderedVertexDigests.length).toBe(count);
		}
	});
	it("rejects changed digest, order, missing and extra members", async () => {
		const f = await fixture();
		for (const update of [
			(v: Record<string, unknown>) => {
				(v.orderedVertexDigests as Uint8Array)[0] ^= 1;
			},
			(v: Record<string, unknown>) => {
				const b = v.orderedVertexDigests as Uint8Array;
				v.orderedVertexDigests = Uint8Array.from([...b.slice(32), ...b.slice(0, 32)]);
			},
			(v: Record<string, unknown>) => {
				v.orderedVertexDigests = (v.orderedVertexDigests as Uint8Array).slice(0, 32);
			},
			(v: Record<string, unknown>) => {
				v.orderedVertexDigests = new Uint8Array(96);
			},
		])
			expect(await opened(f, changed(f, update))).toBeUndefined();
	});
	it("rejects duplicate identities even if the supplied root was computed over duplicates", async () => {
		const f = await fixture();
		const digest = f.commitment.closeSetOrder[0]!;
		const leaves = [0, 1].map((ordinal) =>
			encodeCanonical({
				epoch: f.cut.epoch,
				kind: "drp-history-leaf",
				objectId: f.cut.objectId,
				ordinal,
				protocolMajor: 3,
				vertexHash: digest,
			})
		);
		const cutBytes = encodeCanonical({
			...f.cut,
			closeSetRoot: hex((await buildMerkleTree(leaves)).root),
		});
		const bytes = changed(f, (v) => {
			const packed = v.orderedVertexDigests as Uint8Array;
			packed.set(packed.slice(0, 32), 32);
			v.cutValueDigest = hex(hashDomain("ts-drp/hard-epoch-cut/v3", cutBytes));
		});
		expect(await opened(f, bytes, cutBytes)).toBeUndefined();
	});
	it("rejects foreign scope, exact Cut binding and history-start changes", async () => {
		const f = await fixture(2, 5);
		for (const update of [
			(v: Record<string, unknown>) => {
				(v.scope as Record<string, unknown>).objectId = "ff".repeat(32);
			},
			(v: Record<string, unknown>) => {
				(v.scope as Record<string, unknown>).epoch = 5;
			},
			(v: Record<string, unknown>) => {
				(v.scope as Record<string, unknown>).anchorDigest = "ff".repeat(32);
			},
			(v: Record<string, unknown>) => {
				v.cutValueDigest = "ff".repeat(32);
			},
			(v: Record<string, unknown>) => {
				v.historyStart = 0;
			},
		])
			expect(await opened(f, changed(f, update))).toBeUndefined();
		expect(await opened(f, f.bytes, encodeCanonical({ ...f.cut, extraSignedField: 1 }))).toBeUndefined();
	});
	it("rejects inconsistent Cut root/count/history and unknown carrier fields", async () => {
		const f = await fixture();
		for (const update of [
			{ closeSetRoot: "ff".repeat(32) },
			{ closeSetCount: 1 },
			{ historySize: 4 },
			{ previousHistorySize: 1 },
		])
			expect(await opened(f, f.bytes, encodeCanonical({ ...f.cut, ...update }))).toBeUndefined();
		expect(
			await opened(
				f,
				changed(f, (v) => {
					v.authority = true;
				})
			)
		).toBeUndefined();
		expect(
			await opened(
				f,
				changed(f, (v) => {
					(v.scope as Record<string, unknown>).extra = true;
				})
			)
		).toBeUndefined();
	});
	it("honors signed epoch capacity including the anchor and never a larger caller cap", async () => {
		const f = await fixture();
		for (const max of [0, 2, 4, Number.MAX_SAFE_INTEGER])
			expect(await opened(f, f.bytes, f.exactCanonicalCutValueBytes, max)).toBeUndefined();
		const cut = encodeCanonical({
			...f.cut,
			parameters: { maxEpochVertices: 2 },
		});
		expect(await opened(f, f.bytes, cut, 2)).toBeUndefined();
	});
	it("rejects oversized and malformed canonical carrier bytes within the existing image limit", async () => {
		const f = await fixture();
		expect(await opened(f, new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1))).toBeUndefined();
		expect(await opened(f, Uint8Array.from([...f.bytes, 0]))).toBeUndefined();
		expect(await opened(f, Uint8Array.of(255))).toBeUndefined();
		expect(
			await opened(
				f,
				changed(f, (v) => {
					v.orderedVertexDigests = new Uint8Array(63);
				})
			)
		).toBeUndefined();
	});
	it("detaches all bytes across async verification and successive opens", async () => {
		const f = await fixture();
		const bytes = new Uint8Array(f.bytes),
			cut = new Uint8Array(f.exactCanonicalCutValueBytes);
		const pending = opened(f, bytes, cut);
		bytes.fill(0);
		cut.fill(0);
		const first = await pending;
		expect(first?.orderedVertexDigests.map(hex)).toEqual(f.commitment.closeSetOrder);
		first!.orderedVertexDigests[0]!.fill(0);
		expect((await opened(f))?.orderedVertexDigests.map(hex)).toEqual(f.commitment.closeSetOrder);
	});
	it("encoder refuses altered commitment scope, members, order and original leaf bytes", async () => {
		const f = await fixture();
		const entries = f.commitment.closeSetEntries;
		for (const commitment of [
			{ ...f.commitment, anchorHash: "ff".repeat(32) },
			{
				...f.commitment,
				closeSetOrder: [...f.commitment.closeSetOrder].reverse(),
			},
			{ ...f.commitment, closeSetEntries: entries.slice(1) },
			{
				...f.commitment,
				closeSetEntries: [{ ...entries[0]!, ordinal: 1 }, entries[1]!],
			},
			{
				...f.commitment,
				closeSetEntries: [{ ...entries[0]!, exactCanonicalHistoryLeafBytes: Uint8Array.of(0) }, entries[1]!],
			},
		])
			await expect(
				encodeCreatorCloseMembership({
					commitment,
					exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
					exactCanonicalLatchedAclBytes: f.exactCanonicalLatchedAclBytes,
					maxEpochVertices: f.maxEpochVertices,
					localVertexWitnesses: [],
				})
			).rejects.toThrow(TypeError);
		expect(
			compareBytes(
				f.bytes,
				await encodeCreatorCloseMembership({
					commitment: f.commitment,
					exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
					exactCanonicalLatchedAclBytes: f.exactCanonicalLatchedAclBytes,
					maxEpochVertices: f.maxEpochVertices,
					localVertexWitnesses: [],
				})
			)
		).toBe(0);
	});

	it("opens original local witnesses for mixed-prefix author/sequence verification", async () => {
		const f = await fixture(2, 7, true);
		const value = await opened(f);
		expect(
			value?.localVertexWitnesses.map((w) => {
				const original = decodeCanonical(w.exactCanonicalPreimageBytes) as { author: string; authorSequence: number };
				return [w.vertexDigest, original.author, original.authorSequence];
			})
		).toEqual(f.localVertexWitnesses.map((w, index) => [w.vertexDigest, "b1".repeat(32), index]));
		expect(value?.localVertexWitnesses[0]?.exactCanonicalPreimageBytes).toEqual(
			f.localVertexWitnesses[0]?.exactCanonicalPreimageBytes
		);
	});
	it("rejects changed local preimage, digest, signature shape and unknown witness fields", async () => {
		const f = await fixture(2, 0, true);
		for (const update of [
			(w: Record<string, unknown>) => {
				(w.exactCanonicalPreimageBytes as Uint8Array)[0] ^= 1;
			},
			(w: Record<string, unknown>) => {
				w.vertexDigest = "ff".repeat(32);
			},
			(w: Record<string, unknown>) => {
				w.detachedSignature = new Uint8Array(63);
			},
			(w: Record<string, unknown>) => {
				w.author = "native-unverified-author";
			},
		])
			expect(
				await opened(
					f,
					changed(f, (v) => update((v.localVertexWitnesses as Record<string, unknown>[])[0]!))
				)
			).toBeUndefined();
	});
	it("rejects duplicate local digest and conflicting author/sequence identities", async () => {
		const f = await fixture(2, 0, true);
		expect(
			await opened(
				f,
				changed(f, (v) => {
					const witnesses = v.localVertexWitnesses as unknown[];
					witnesses[1] = witnesses[0];
				})
			)
		).toBeUndefined();
		const conflict = await fixture(2, 0, true, true);
		expect(
			await opened(
				conflict,
				changed(conflict, (v) => {
					v.localVertexWitnesses = conflict.localVertexWitnesses;
				})
			)
		).toBeUndefined();
	});
	it("rejects original source-context mismatch even when that digest belongs to the Cut", async () => {
		const f = await fixture(1, 0, true, false, true);
		expect(
			await opened(
				f,
				changed(f, (v) => {
					v.localVertexWitnesses = f.localVertexWitnesses;
				})
			)
		).toBeUndefined();
	});
	it("detaches original local witnesses and leaves actual signature verification to the protocol owner", async () => {
		const f = await fixture(1, 0, true);
		const first = await opened(f);
		first!.localVertexWitnesses[0]!.exactCanonicalPreimageBytes.fill(0);
		first!.localVertexWitnesses[0]!.detachedSignature.fill(0);
		expect((await opened(f))?.localVertexWitnesses[0]?.exactCanonicalPreimageBytes).toEqual(
			f.localVertexWitnesses[0]?.exactCanonicalPreimageBytes
		);
		const changedSignature = changed(f, (v) => {
			((v.localVertexWitnesses as Record<string, unknown>[])[0]!.detachedSignature as Uint8Array).fill(9);
		});
		// Shape is not authentication. The independent owner must reject bad signatures.
		expect(await opened(f, changedSignature)).toBeDefined();
		const witnesses = f.localVertexWitnesses.map((w) => ({
			vertexDigest: w.vertexDigest,
			exactCanonicalPreimageBytes: new Uint8Array(w.exactCanonicalPreimageBytes),
			detachedSignature: new Uint8Array(w.detachedSignature),
		}));
		const pending = encodeCreatorCloseMembership({
			commitment: f.commitment,
			exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
			exactCanonicalLatchedAclBytes: f.exactCanonicalLatchedAclBytes,
			maxEpochVertices: f.maxEpochVertices,
			localVertexWitnesses: witnesses,
		});
		for (const w of witnesses) {
			w.exactCanonicalPreimageBytes.fill(0);
			w.detachedSignature.fill(0);
		}
		expect((await opened(f, await pending))?.localVertexWitnesses[0]?.exactCanonicalPreimageBytes).toEqual(
			f.localVertexWitnesses[0]?.exactCanonicalPreimageBytes
		);
	});
	it("includes retained witness bytes in the original native carrier bound before copying or encoding", async () => {
		const f = await fixture(1, 0, true);
		await expect(
			encodeCreatorCloseMembership({
				commitment: f.commitment,
				exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
				exactCanonicalLatchedAclBytes: f.exactCanonicalLatchedAclBytes,
				maxEpochVertices: f.maxEpochVertices,
				localVertexWitnesses: [
					{
						...f.localVertexWitnesses[0]!,
						exactCanonicalPreimageBytes: new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes),
					},
				],
			})
		).rejects.toThrow(TypeError);
	});

	it("carries canonical original closed ACL bytes detached across encode/open", async () => {
		const f = await fixture(1, 0, true);
		const first = await opened(f);
		expect(first?.exactCanonicalLatchedAclBytes).toEqual(f.exactCanonicalLatchedAclBytes);
		first!.exactCanonicalLatchedAclBytes.fill(0);
		expect((await opened(f))?.exactCanonicalLatchedAclBytes).toEqual(f.exactCanonicalLatchedAclBytes);
		const acl = new Uint8Array(f.exactCanonicalLatchedAclBytes);
		const pending = encodeCreatorCloseMembership({
			commitment: f.commitment,
			exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
			exactCanonicalLatchedAclBytes: acl,
			maxEpochVertices: f.maxEpochVertices,
			localVertexWitnesses: f.localVertexWitnesses,
		});
		acl.fill(0);
		expect((await opened(f, await pending))?.exactCanonicalLatchedAclBytes).toEqual(f.exactCanonicalLatchedAclBytes);
	});
	it("rejects missing, empty, malformed, wrong-source and altered-schema carried ACL", async () => {
		const f = await fixture();
		const original = decodeCanonical(f.exactCanonicalLatchedAclBytes) as Record<string, unknown>;
		for (const bytes of [
			new Uint8Array(),
			Uint8Array.of(255),
			Uint8Array.from([...f.exactCanonicalLatchedAclBytes, 0]),
			encodeCanonical({ ...original, objectId: "ff".repeat(32) }),
			encodeCanonical({ ...original, epoch: 0 }),
			encodeCanonical({ ...original, kind: "not-an-acl" }),
			encodeCanonical({ ...original, extra: true }),
			encodeCanonical({ ...original, permissionless: 1 }),
			encodeCanonical({ ...original, version: 4 }),
			encodeCanonical({
				...original,
				members: [{ author: "b1".repeat(32), groups: [], finalityKey: null, extra: true }],
			}),
		])
			expect(
				await opened(
					f,
					changed(f, (v) => {
						v.exactCanonicalLatchedAclBytes = bytes;
					})
				)
			).toBeUndefined();
		expect(
			await opened(
				f,
				changed(f, (v) => {
					delete v.exactCanonicalLatchedAclBytes;
				})
			)
		).toBeUndefined();
	});
	it("refuses accessor-supplied original ACL without invoking it", async () => {
		const f = await fixture();
		let reads = 0;
		const input = {
			commitment: f.commitment,
			exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
			exactCanonicalLatchedAclBytes: f.exactCanonicalLatchedAclBytes,
			maxEpochVertices: f.maxEpochVertices,
			localVertexWitnesses: [],
		};
		Object.defineProperty(input, "exactCanonicalLatchedAclBytes", {
			enumerable: true,
			get: () => {
				reads++;
				return f.exactCanonicalLatchedAclBytes;
			},
		});
		await expect(encodeCreatorCloseMembership(input)).rejects.toThrow(TypeError);
		expect(reads).toBe(0);
	});
	it("counts the complete original ACL and local witnesses against the unchanged native carrier cap", async () => {
		// Exercise the current native carrier cap, not the historical packed-order
		// threshold. Each child fits independently; their complete union must not.
		const f = await fixture(1, 0, true, false, false, LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes - 6000);
		const acl = decodeCanonical(f.exactCanonicalLatchedAclBytes) as Record<string, unknown>;
		const largerAcl = encodeCanonical({
			...acl,
			members: Array.from({ length: 64 }, (_, index) => ({
				author: index.toString(16).padStart(64, "0"),
				finalityKey: null,
				groups: ["writer"],
			})),
		});
		expect(largerAcl.byteLength).toBeLessThan(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes);
		expect(f.localVertexWitnesses[0]!.exactCanonicalPreimageBytes.byteLength).toBeLessThan(
			LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
		);
		expect(f.bytes.byteLength).toBeLessThan(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes);
		expect(f.localVertexWitnesses[0]!.exactCanonicalPreimageBytes.byteLength + largerAcl.byteLength).toBeGreaterThan(
			LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
		);
		await expect(
			encodeCreatorCloseMembership({
				commitment: f.commitment,
				exactCanonicalCutValueBytes: f.exactCanonicalCutValueBytes,
				exactCanonicalLatchedAclBytes: largerAcl,
				maxEpochVertices: f.maxEpochVertices,
				localVertexWitnesses: f.localVertexWitnesses,
			})
		).rejects.toThrow(TypeError);
		expect(
			await opened(
				f,
				changed(f, (v) => {
					v.exactCanonicalLatchedAclBytes = new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1);
				})
			)
		).toBeUndefined();
	});
});
