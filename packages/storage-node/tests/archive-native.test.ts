import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator, deriveClosedEpochArchiveAppend, EMPTY_MERKLE_ROOT, produceClosedEpochArchive, verifyInclusion } from "@ts-drp/compaction";
import {
	digestBlob,
	type ArchiveArtifactRef,
	type ArchiveAppendDeclaration,
	type ArchiveCapacityDeclaration,
	type ArchiveIndexPosition,
	type ArchiveStorage,
	type ArchiveStorageCapacity,
} from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";

import { createNodeArchiveStorage } from "../src/archive.js";
import { SqliteNativeReadReservationOwner } from "../src/internal/native-read-reservation.js";
import { createCreatorCloseFixture, createCreatorArchiveSnapshot, CREATOR_PRIVATE_KEY_SEED_HEX, CREATOR_PUBLIC_KEY_HEX,
	EXACT_AVAILABILITY_POLICY_BYTES, EXACT_PARAMETERS_BYTES, EXACT_SIGNER_SET_BYTES, independentQc,
	loadCreatorCloseModules } from "../../../tests/fixtures/phase-5e-v3/creator-close-contract.js";
import { consumeSealSigningRequest } from "../../protocol-v3/src/internal/seal-signing-request.js";

// Mechanical native-storage scenarios only: no authenticated Chat history/Phase 7 gate is claimed.
const capacity: ArchiveStorageCapacity = {
	maxArtifactBytes: 4096,
	maxTotalEncodedBytes: 65536,
	maxArtifacts: 32,
	maxAppendArtifacts: 8,
	maxAppendEncodedBytes: 16384,
	maxControlBytes: 8192,
	maxReadPageEntries: 4,
	maxReadPageBytes: 8192,
	maxReadHandles: 1,
	maxQueuedCalls: 8,
};
const objectId = "creator:archive-native-mechanical",
	genesis = "1".repeat(64);
const directories: string[] = [],
	owners: ArchiveStorage[] = [];
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const hash = (bytes: Uint8Array): string => {
	const result = digestBlob(bytes);
	if (!result.ok) throw new Error("invalid fixture bytes");
	return result.value;
};
const hashBytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));
async function filename(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ts-drp-archive-native-"));
	directories.push(dir);
	return join(dir, "archive.sqlite");
}
function open(file: string, initialization: "create" | "reopen" = "create", policy = capacity): ArchiveStorage {
	const owner = createNodeArchiveStorage({
		filename: file,
		initialization,
		objectId,
		pinnedGenesisAnchorDigest: genesis,
		capacity: policy,
	});
	owners.push(owner);
	return owner;
}
afterEach(async () => {
	for (const owner of owners.splice(0)) await owner.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function append(expected: ArchiveIndexPosition, previous = new CompactMerkleAccumulator(), count = 2) {
	const accumulator = CompactMerkleAccumulator.fromSnapshot(previous.snapshot());
	const artifacts: Array<{ ref: { kind: "index-entry"; digest: string; byteLength: number }; bytes: Uint8Array }> = [],
		entries = [];
	for (let offset = 0; offset < count; offset++) {
		const ordinal = expected.lastOrdinal + 1 + offset;
		const body = encodeCanonical({ mechanicalFixture: true, ordinal });
		artifacts.push({ ref: { kind: "index-entry", digest: hash(body), byteLength: body.byteLength }, bytes: body });
		const leaf = encodeCanonical({
			objectId,
			startOrdinal: ordinal,
			endOrdinal: ordinal,
			recordCount: 1,
			segmentDigest: hash(body),
			payloadDigest: "2".repeat(64),
		});
		const ref = { kind: "index-entry" as const, digest: hash(leaf), byteLength: leaf.byteLength };
		artifacts.push({ ref, bytes: leaf });
		entries.push(ref);
		accumulator.append(leaf);
	}
	const declaration: ArchiveAppendDeclaration = {
		objectId,
		pinnedGenesisAnchorDigest: genesis,
		sourceEpoch: expected.revision,
		sourceAnchorDigest: "3".repeat(64),
		sourceCloseSetRoot: "4".repeat(64),
		expected,
		targetRoot: hex(accumulator.root()),
		artifacts: artifacts.map((item) => item.ref),
		indexEntries: entries,
	};
	return { declaration, artifacts, accumulator };
}
function capacityRequest(plan: ReturnType<typeof append>,continuation = plan): ArchiveCapacityDeclaration {
	const bound = (source: typeof plan) => ({artifactBytes:source.artifacts.reduce((n,artifact) => n + artifact.bytes.byteLength,0),
		artifactCount:source.artifacts.length,indexEntries:source.declaration.indexEntries.length,
		maxArtifactBytes:Math.max(...source.artifacts.map(artifact => artifact.bytes.byteLength))});
	return {objectId,pinnedGenesisAnchorDigest:genesis,sourceEpoch:plan.declaration.sourceEpoch,
		sourceAnchorDigest:plan.declaration.sourceAnchorDigest,expected:plan.declaration.expected,current:bound(plan),continuation:bound(continuation)};
}

test("native archive pre-admission promise survives concurrent retry reopen and exact interrupted conversion without double spend", async () => {
	const file = await filename();let owner = open(file);
	const plan = append((await owner.inspect()).position),request = capacityRequest(plan);
	const [left,right] = await Promise.all([owner.reserveCapacity(request),owner.reserveCapacity(request)]);
	expect(left).toEqual(right);
	const promised = await owner.inspect(),before = controlBytes(file);
	expect(promised.capacityPromise?.reservedEncodedBytes).toBeGreaterThan(request.current.artifactBytes + request.continuation.artifactBytes);
	await expect(owner.reserveCapacity({...request,sourceAnchorDigest:"5".repeat(64)})).rejects.toThrow(/BASIS_CONFLICT/);
	await expect(owner.reserveCapacity({...request,expected:{...request.expected,revision:1}})).rejects.toThrow(/STALE/);
	await expect(owner.reserveCapacity({...request,objectId:"foreign"})).rejects.toThrow(/SCOPE/);
	expect(controlBytes(file)).toEqual(before);
	await owner.close();owner = open(file,"reopen");
	expect(await owner.inspect()).toEqual(promised);
	expect(await owner.reserveCapacity(request)).toEqual(left);
	const begun = await owner.beginAppend(plan.declaration),converting = await owner.inspect();
	expect(converting.reservedAppendBytes + converting.capacityPromise!.reservedEncodedBytes).toBe(left.reservedEncodedBytes);
	await owner.writeArtifact({intentDigest:begun.intentDigest,...plan.artifacts[0]!});
	const partial = await owner.inspect();await owner.close();owner = open(file,"reopen");
	expect(await owner.inspect()).toEqual(partial);
	expect(await owner.reserveCapacity(request)).toEqual(partial.capacityPromise);
	expect(await owner.beginAppend(plan.declaration)).toEqual(begun);
	for (const artifact of plan.artifacts) await owner.writeArtifact({intentDigest:begun.intentDigest,...artifact});
	const prepared = await owner.prepareAppend(begun.intentDigest);
	const result = await owner.commitPreparedAppend({intentDigest:begun.intentDigest,expected:plan.declaration.expected});
	expect(result).toEqual(prepared.target);
	expect((await owner.inspect()).capacityPromise!.reservedEncodedBytes).toBeGreaterThan(0);
	await owner.close();owner = open(file,"reopen");
	const read = await owner.acquireRead(result);
	try {for (const artifact of plan.artifacts) expect(await read.readArtifact(artifact.ref)).toEqual(artifact.bytes);}
	finally {await read.release();}
});

test("native archive incremental promise refuses extra admission before effects while funded old current and continuation drain", async () => {
	const file = await filename(),owner = open(file,"create",{...capacity,maxArtifacts:8});
	const first = append((await owner.inspect()).position),request = capacityRequest(first);
	await owner.reserveCapacity(request);const before = controlBytes(file);
	const larger = append(first.declaration.expected,undefined,3);
	await expect(owner.reserveCapacity(capacityRequest(larger))).rejects.toThrow(/CAPACITY/);
	expect(controlBytes(file)).toEqual(before);
	const done = await complete(owner,first),next = append(done.committed,first.accumulator);
	const nextRequest = capacityRequest(next);
	await owner.reserveCapacity({...nextRequest,continuation:{artifactBytes:0,artifactCount:0,indexEntries:0,maxArtifactBytes:0}});
	const continued = await complete(owner,next);
	expect(continued.committed.lastOrdinal).toBe(3);
	expect((await owner.inspect()).storedArtifacts).toBe(8);
});
async function complete(owner: ArchiveStorage, plan: ReturnType<typeof append>) {
	const begun = await owner.beginAppend(plan.declaration);
	for (const artifact of plan.artifacts) await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	const prepared = await owner.prepareAppend(begun.intentDigest);
	const committed = await owner.commitPreparedAppend({
		intentDigest: begun.intentDigest,
		expected: plan.declaration.expected,
	});
	return { begun, prepared, committed };
}
function controlBytes(file: string): Uint8Array {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return new Uint8Array(db.prepare("SELECT bytes FROM archive_control WHERE id=1").get()!.bytes as Uint8Array);
	} finally {
		db.close();
	}
}
function independentWriter(file: string): number | null {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {DatabaseSync} from 'node:sqlite';
	const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0');
	try{db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');}catch(error){process.exitCode=error.errcode===5?5:1;}finally{db.close();}`,
			file,
		],
		{ encoding: "utf8", timeout: 5000 }
	).status;
}

test("native archive partial append exactly resumes after reopen and verifies immutable readback before mechanical commit", async () => {
	const file = await filename();
	let owner = open(file);
	const initial = (await owner.inspect()).position,
		plan = append(initial),
		begun = await owner.beginAppend(plan.declaration);
	await owner.writeArtifact({ intentDigest: begun.intentDigest, ...plan.artifacts[0]! });
	const before = await owner.inspect();
	await expect(owner.prepareAppend(begun.intentDigest)).rejects.toThrow(/MISSING/);
	await owner.close();
	owner = open(file, "reopen");
	expect(await owner.inspect()).toEqual(before);
	expect(await owner.beginAppend(plan.declaration)).toEqual(begun);
	await expect(owner.beginAppend({ ...plan.declaration, sourceAnchorDigest: "5".repeat(64) })).rejects.toThrow(
		/CONFLICT/
	);
	expect(await owner.inspect()).toEqual(before);
	for (const artifact of plan.artifacts) await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	const prepared = await owner.prepareAppend(begun.intentDigest);
	expect(prepared.verifiedArtifactBytes).toBe(
		plan.artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0)
	);
	expect((await owner.inspect()).position).toEqual(initial); // Prepared native root is not yet current/certified.
	await owner.close();
	owner = open(file, "reopen");
	expect(await owner.prepareAppend(begun.intentDigest)).toEqual(prepared);
	const committed = await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected: initial });
	expect(await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected: initial })).toEqual(committed);
	expect(await owner.beginAppend(plan.declaration)).toEqual({ intentDigest: begun.intentDigest, phase: "committed" });
	const read = await owner.acquireRead(committed);
	for (const artifact of plan.artifacts) expect(await read.readArtifact(artifact.ref)).toEqual(artifact.bytes);
	await read.release();
});

test("native archive bounded index pages verify old leaves after multiple durable appends", async () => {
	const file = await filename();
	const owner = open(file),
		first = append((await owner.inspect()).position, undefined, 3);
	const firstResult = await complete(owner, first),
		second = append(firstResult.committed, first.accumulator, 2);
	const secondResult = await complete(owner, second),
		read = await owner.acquireRead(secondResult.committed);
	const firstPage = await read.readIndexPage({ afterLeafIndex: null, limit: 3 });
	const lastPage = await read.readIndexPage({ afterLeafIndex: 2, limit: 3 });
	expect([...firstPage, ...lastPage].map((entry) => entry.leafIndex)).toEqual([0, 1, 2, 3, 4]);
	for (const entry of [...firstPage, ...lastPage])
		expect(verifyInclusion(entry.exactCanonicalEntryBytes, entry.proof, hashBytes(secondResult.committed.root))).toBe(
			true
		);
	await expect(read.readIndexPage({ afterLeafIndex: null, limit: capacity.maxReadPageEntries + 1 })).rejects.toThrow(
		/CAPACITY/
	);
	await read.release();
});

test("native archive bounded frontier captures exact current peaks, isolates mutations and revokes new reads before joined release", async () => {
	const owner = open(await filename());
	const plan = append((await owner.inspect()).position, undefined, 3);
	const completed = await complete(owner, plan);
	const read = await owner.acquireRead(completed.committed);
	const first = await read.readIndexFrontier();
	expect(first).toEqual(plan.accumulator.snapshot());
	for (const peak of first.peaks) peak?.fill(0);
	const second = await read.readIndexFrontier();
	expect(second).toEqual(plan.accumulator.snapshot());
	expect(hex(CompactMerkleAccumulator.fromSnapshot({ size: second.size, peaks: [...second.peaks] }).root())).toBe(completed.committed.root);
	const admitted = read.readIndexFrontier();
	const released = read.release();
	await expect(read.readIndexFrontier()).rejects.toThrow(/REVOKED/);
	const joined = await Promise.allSettled([admitted, released]);
	expect(joined[1]!.status).toBe("fulfilled");
	// Work not yet entered may revoke; release nevertheless joins the exact admitted request.
	if (joined[0]!.status === "rejected") expect(String(joined[0]!.reason)).toMatch(/REVOKED/);
	expect((await owner.inspect()).position).toEqual(completed.committed);
	const next = append(completed.committed, plan.accumulator, 1);
	await owner.beginAppend(next.declaration);
	const oldSource = { sourceEpoch: plan.declaration.sourceEpoch, sourceAnchorDigest: plan.declaration.sourceAnchorDigest,
		sourceCloseSetRoot: plan.declaration.sourceCloseSetRoot };
	expect((await owner.readAppendDeclaration(oldSource))?.phase).toBe("committed");
	expect((await owner.readAppendDeclaration({ ...oldSource, sourceEpoch: next.declaration.sourceEpoch }))?.phase).toBe("writing");
	expect(await owner.readAppendDeclaration({ ...oldSource, sourceAnchorDigest: "f".repeat(64) })).toBeNull();
});

test("native archive append-artifact count capacity refuses before effects while exact admitted work resumes and drains", async () => {
	const file = await filename(), owner = open(file);
	const empty = await owner.inspect();
	const oversized = append(empty.position, undefined, Math.floor(capacity.maxAppendArtifacts / 2) + 1);
	expect(oversized.declaration.artifacts.length).toBe(10);
	await expect(owner.beginAppend(oversized.declaration)).rejects.toMatchObject({
		code: "ARCHIVE_CAPACITY", capacityKind: "append-artifacts", requiredArtifacts: 10, maxAppendArtifacts: 8,
	});
	expect(await owner.inspect()).toEqual(empty);
	// Foreign scope remains malformed, rather than acquiring a capacity exception.
	await expect(owner.beginAppend({ ...oversized.declaration, objectId: "creator:foreign" }))
		.rejects.toMatchObject({ code: "ARCHIVE_INVALID_ARGUMENT" });
	expect(await owner.inspect()).toEqual(empty);
	const admitted = append(empty.position, undefined, 2);
	const begun = await owner.beginAppend(admitted.declaration);
	await owner.writeArtifact({ intentDigest: begun.intentDigest, ...admitted.artifacts[0]! });
	const retained = await owner.inspect(), retainedControl = controlBytes(file);
	await expect(owner.beginAppend(oversized.declaration)).rejects.toMatchObject({ code: "ARCHIVE_CAPACITY" });
	expect(await owner.inspect()).toEqual(retained);
	expect(controlBytes(file)).toEqual(retainedControl);
	expect(await owner.beginAppend(admitted.declaration)).toEqual(begun);
	for (const artifact of admitted.artifacts) await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	await owner.prepareAppend(begun.intentDigest);
	const committed = await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected: empty.position });
	expect(committed.root).toBe(admitted.declaration.targetRoot);
	expect((await owner.inspect()).pending).toBeNull();
	const read = await owner.acquireRead(committed);
	try {
		for (const artifact of admitted.artifacts) expect(await read.readArtifact(artifact.ref)).toEqual(artifact.bytes);
		await read.check();
	} finally { await read.release(); }
});

test("native source-derived archive bytes remain prepared until independent creator certification and persist exact target readback", async () => {
	// Scoped archive-store/Cut-QC integration, NOT full Node hold/adoption-CAS/crash acceptance.
	const source = await createCreatorCloseFixture(hex(EMPTY_MERKLE_ROOT));
	const limits = { maxSegmentBytes: 4096, maxRecordsPerSegment: 2, chunkBytes: 1024, maxChunks: 4, maxSegments: 4 };
	const archive = await produceClosedEpochArchive({ ...source.archiveSource, limits });
	const plan = await deriveClosedEpochArchiveAppend({ archive, expectedPreviousRoot: hex(EMPTY_MERKLE_ROOT),
		previousSnapshot: new CompactMerkleAccumulator().snapshot(), previousEndOrdinal: -1, limits });
	const file = await filename();
	const options = { filename: file, objectId: archive.objectId, pinnedGenesisAnchorDigest: source.anchorDigest, capacity };
	let owner = createNodeArchiveStorage({ ...options, initialization: "create" }); owners.push(owner);
	const expected = (await owner.inspect()).position;
	const declaration: ArchiveAppendDeclaration = { objectId: archive.objectId, pinnedGenesisAnchorDigest: source.anchorDigest,
		sourceEpoch: archive.epoch, sourceAnchorDigest: archive.sourceAnchorDigest, sourceCloseSetRoot: archive.closeSetRoot,
		expected, targetRoot: plan.binding.targetArchiveIndexRoot, artifacts: plan.artifacts.map(artifact => artifact.ref), indexEntries: plan.indexEntries };
	const begun = await owner.beginAppend(declaration);
	for (const artifact of plan.artifacts) await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	const prepared = await owner.prepareAppend(begun.intentDigest);
	expect((await owner.inspect()).position).toEqual(expected);
	expect(prepared.target.root).toBe(plan.binding.targetArchiveIndexRoot);
	const sourceIdentity = { sourceEpoch: archive.epoch, sourceAnchorDigest: archive.sourceAnchorDigest, sourceCloseSetRoot: archive.closeSetRoot };
	expect(await owner.readAppendDeclaration(sourceIdentity)).toEqual({ intentDigest: begun.intentDigest, declaration, phase: "prepared" });
	// Preparation does not publish the index, but its exact immutable artifacts must be
	// readable under the old-position reservation for the owner's precommit proof charges.
	const preparedRead = await owner.acquireRead(expected);
	try {
		for (const artifact of plan.artifacts) expect(await preparedRead.readArtifact(artifact.ref)).toEqual(artifact.bytes);
		await preparedRead.check();
	} finally { await preparedRead.release(); }
	expect((await owner.inspect()).position).toEqual(expected);
	const modules = await loadCreatorCloseModules();
	const targetSnapshot = createCreatorArchiveSnapshot(source, plan.binding.targetArchiveIndexRoot);
	const close = modules.creator.prepareCreatorClose({ aclDigest: targetSnapshot.aclDigest,
		archiveIndexRoot: plan.binding.targetArchiveIndexRoot, archiveAppend: plan.binding,
		blueprintDigest: String(source.currentAnchor.blueprintDigest), closeReason: "creator-requested",
		closeSetCount: source.commitment.closeSetCount, closeSetRoot: source.commitment.closeSetRoot, currentTrust: source.currentTrust,
		exactCanonicalAvailabilityPolicyBytes: EXACT_AVAILABILITY_POLICY_BYTES, exactCanonicalNextSignerSetBytes: EXACT_SIGNER_SET_BYTES,
		exactCanonicalParametersBytes: EXACT_PARAMETERS_BYTES, exactCanonicalSnapshotManifestBytes: targetSnapshot.exactCanonicalManifestBytes,
		historyRoot: source.commitment.historyRoot, historySize: source.commitment.historySize,
		snapshotManifestDigest: targetSnapshot.manifestDigest, stateDigest: targetSnapshot.stateDigest });
	if (!close.ok) throw new Error(close.reason);
	const opened = modules.seal.openSealAuthority({ signerPublicKey: hashBytes(CREATOR_PUBLIC_KEY_HEX), trust: source.currentTrust });
	if (!opened.ok) throw new Error(opened.reason);
	const vote = modules.seal.prepareSealVote({ authority: opened.authority, exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes, phase: "commit", round: 0 });
	if (!vote.ok) throw new Error(vote.reason);
	const voteDigest = consumeSealSigningRequest(vote.signingRequest);
	if (!(voteDigest instanceof Uint8Array)) throw new Error("missing one-use archive vote request");
	const qc = independentQc({ exactCanonicalPreimageBytes: vote.exactCanonicalPreimageBytes,
		signature: ed25519.sign(voteDigest, hashBytes(CREATOR_PRIVATE_KEY_SEED_HEX)) });
	const successor = modules.creator.prepareCreatorSuccessor({ authority: opened.authority, close: close.close, exactCanonicalCommitQcBytes: qc.exactCanonicalQcBytes });
	if (!successor.ok) throw new Error(successor.reason);
	const anchorDigest = modules.request.consumeCreatorAnchorSigningRequest(successor.signingRequest);
	if (!(anchorDigest instanceof Uint8Array)) throw new Error("missing one-use archive anchor request");
	const completed = modules.creator.completeCreatorSuccessor({ preparation: successor.preparation,
		detachedSignature: ed25519.sign(anchorDigest, hashBytes(CREATOR_PRIVATE_KEY_SEED_HEX)) });
	if (!completed.ok) throw new Error(completed.reason);
	expect(modules.creator.openCreatorSuccessorTrust({ currentTrust: source.currentTrust,
		exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes, exactCanonicalCommitQcBytes: qc.exactCanonicalQcBytes,
		exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes }).ok).toBe(true);
	const anchor = decodeCanonical(successor.exactCanonicalAnchorPreimageBytes) as Record<string, unknown>;
	expect(anchor.archiveIndexRoot).toBe(prepared.target.root);
	const committed = await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected });
	expect(committed).toEqual(prepared.target);
	await owner.close();
	owner = createNodeArchiveStorage({ ...options, initialization: "reopen" }); owners.push(owner);
	const durable = await owner.readAppendDeclaration(sourceIdentity);
	expect(durable).toEqual({ intentDigest: begun.intentDigest, declaration, phase: "committed" });
	if (durable !== null) Reflect.set(durable.declaration.artifacts[0]!, "digest", "f".repeat(64));
	expect(await owner.readAppendDeclaration(sourceIdentity)).toEqual({ intentDigest: begun.intentDigest, declaration, phase: "committed" });
	expect(await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected })).toEqual(committed);
	const read = await owner.acquireRead(committed);
	for (const artifact of plan.artifacts) expect(await read.readArtifact(artifact.ref)).toEqual(artifact.bytes);
	const frontier = await read.readIndexFrontier();
	expect(hex(CompactMerkleAccumulator.fromSnapshot({ size: frontier.size, peaks: [...frontier.peaks] }).root())).toBe(anchor.archiveIndexRoot);
	await read.release();
});

test("native archive unknown/capacity admission refuses before effects and exact admitted work remains drainable", async () => {
	const file = await filename();
	const owner = open(file, "create", { ...capacity, maxArtifacts: 4 });
	const first = append((await owner.inspect()).position),
		begun = await owner.beginAppend(first.declaration);
	for (const artifact of first.artifacts) await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	expect((await owner.inspect()).storedArtifacts).toBe(4);
	expect(await owner.beginAppend(first.declaration)).toEqual(begun); // Resume despite fully reserved/stored count.
	const prepared = await owner.prepareAppend(begun.intentDigest);
	const committed = await owner.commitPreparedAppend({
		intentDigest: begun.intentDigest,
		expected: first.declaration.expected,
	});
	expect(committed).toEqual(prepared.target);
	const before = controlBytes(file),
		next = append(committed, first.accumulator);
	await expect(owner.beginAppend(next.declaration)).rejects.toThrow(/CAPACITY/);
	await expect(
		owner.beginAppend({
			...next.declaration,
			artifacts: [{ digest: "6".repeat(64), byteLength: null }],
		} as unknown as ArchiveAppendDeclaration)
	).rejects.toThrow(/INVALID/);
	expect(controlBytes(file)).toEqual(before);
	const read = await owner.acquireRead(committed);
	expect(await read.readArtifact(first.artifacts[0]!.ref)).toEqual(first.artifacts[0]!.bytes);
	await read.release();
});

test("native archive substituted/missing frontier bytes refuse with existing control unchanged", async () => {
	const file = await filename();
	const owner = open(file),
		first = append((await owner.inspect()).position);
	const finished = await complete(owner, first),
		next = append(finished.committed, first.accumulator),
		before = controlBytes(file);
	const last = first.artifacts[first.artifacts.length - 1]!;
	const db = new DatabaseSync(file);
	const altered = new Uint8Array(last.bytes);
	altered[0] ^= 1;
	try {
		db.prepare("UPDATE archive_artifacts SET bytes=? WHERE digest=?").run(altered, last.ref.digest);
	} finally {
		db.close();
	}
	await expect(owner.beginAppend(next.declaration)).rejects.toThrow(/ALTERED/);
	expect(controlBytes(file)).toEqual(before);
	const repair = new DatabaseSync(file);
	try {
		repair.prepare("UPDATE archive_artifacts SET bytes=? WHERE digest=?").run(last.bytes, last.ref.digest);
	} finally {
		repair.close();
	}
	await complete(owner, next);
});

test("native archive fresh FIFO admission captures bytes and bounds queued requests without coalescing", async () => {
	const file = await filename();
	const owner = open(file, "create", { ...capacity, maxQueuedCalls: 2 });
	const a = owner.inspect(),
		b = owner.inspect(),
		excess = owner.inspect();
	await expect(excess).rejects.toThrow(/CAPACITY/);
	const [first, second] = await Promise.all([a, b]);
	expect(first).not.toBe(second);
	const plan = append(first.position),
		begun = await owner.beginAppend(plan.declaration);
	const mutable = new Uint8Array(plan.artifacts[0]!.bytes);
	const writing = owner.writeArtifact({
		intentDigest: begun.intentDigest,
		ref: plan.artifacts[0]!.ref,
		bytes: mutable,
	});
	mutable.fill(0);
	await writing;
	for (const artifact of plan.artifacts.slice(1))
		await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	await owner.prepareAppend(begun.intentDigest);
	const committed = await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected: first.position });
	const read = await owner.acquireRead(committed);
	expect(await read.readArtifact(plan.artifacts[0]!.ref)).toEqual(plan.artifacts[0]!.bytes);
	await read.release();
});

test("native archive FIFO includes real asynchronous reservation acquisition and failure/close joins", async () => {
	const file = await filename(),
		owner = open(file, "create", { ...capacity, maxQueuedCalls: 2 });
	const plan = append((await owner.inspect()).position),
		finished = await complete(owner, plan);
	const original = SqliteNativeReadReservationOwner.prototype.acquire;
	const spy = vi.spyOn(SqliteNativeReadReservationOwner.prototype, "acquire");
	const pauseNextActualAcquisition = () => {
		let acquired!: () => void, continueDelivery!: () => void;
		const reached = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const delivery = new Promise<void>((resolve) => {
			continueDelivery = resolve;
		});
		spy.mockImplementationOnce(async function (this: SqliteNativeReadReservationOwner) {
			// Preserve the real native lock/capability. Pause delivery only AFTER actual acquisition.
			const held = await original.call(this);
			acquired();
			await delivery;
			return held;
		});
		return { reached, continueDelivery };
	};
	const order: string[] = [];
	const pendingCalls: Promise<unknown>[] = [];
	let firstGate: ReturnType<typeof pauseNextActualAcquisition> | undefined;
	let closingGate: ReturnType<typeof pauseNextActualAcquisition> | undefined;
	try {
		firstGate = pauseNextActualAcquisition();
		const acquisition = owner.acquireRead(finished.committed).then((read) => {
			order.push("acquisition");
			return read;
		});
		const inspection = owner.inspect().then((status) => {
			order.push("inspection");
			return status;
		});
		pendingCalls.push(acquisition, inspection);
		await expect(owner.inspect()).rejects.toThrow(/CAPACITY/);
		await firstGate.reached;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(order).toEqual([]); // The later synchronous request may not overtake the held async turn.
		expect(independentWriter(file)).toBe(5);
		firstGate.continueDelivery();
		const read = await acquisition;
		await inspection;
		expect(order).toEqual(["acquisition", "inspection"]);
		const refused = owner.acquireRead(finished.committed),
			afterFailure = owner.inspect();
		pendingCalls.push(refused, afterFailure);
		await expect(refused).rejects.toThrow(/CAPACITY|BUSY/);
		expect((await afterFailure).position).toEqual(finished.committed); // Failure does not poison the FIFO.
		await read.release();
		expect(independentWriter(file)).toBe(0);

		closingGate = pauseNextActualAcquisition();
		const lateAcquisition = owner.acquireRead(finished.committed),
			queuedInspection = owner.inspect();
		pendingCalls.push(lateAcquisition, queuedInspection);
		const rejectedAcquisition = expect(lateAcquisition).rejects.toThrow(/CLOSED|REVOKED/);
		const rejectedInspection = expect(queuedInspection).rejects.toThrow(/CLOSED/);
		await closingGate.reached;
		let joined = false;
		const closing = owner.close().then(() => {
			joined = true;
		});
		pendingCalls.push(closing);
		await expect(owner.inspect()).rejects.toThrow(/CLOSED/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(joined).toBe(false);
		expect(independentWriter(file)).toBe(5); // Close has revoked, but cannot release an admitted acquisition early.
		closingGate.continueDelivery();
		await Promise.all([rejectedAcquisition, rejectedInspection, closing]);
		expect(joined).toBe(true);
		expect(independentWriter(file)).toBe(0);
	} finally {
		firstGate?.continueDelivery();
		closingGate?.continueDelivery();
		await Promise.allSettled(pendingCalls);
		spy.mockRestore();
	}
});

test("native archive read reservations exclude independent writers and revoke delivery before joined release", async () => {
	const file = await filename();
	const owner = open(file),
		plan = append((await owner.inspect()).position),
		finished = await complete(owner, plan);
	const read = await owner.acquireRead(finished.committed);
	expect(independentWriter(file)).toBe(5);
	await expect(owner.acquireRead(finished.committed)).rejects.toThrow(/CAPACITY|BUSY/);
	const pending = read.readArtifact(plan.artifacts[0]!.ref),
		releasing = read.release();
	await expect(pending).rejects.toThrow(/REVOKED/);
	await releasing;
	expect(independentWriter(file)).toBe(0);
	await expect(read.check()).rejects.toThrow(/REVOKED/);
	const last = await owner.acquireRead(finished.committed),
		pendingPage = last.readIndexPage({ afterLeafIndex: null, limit: 1 }),
		closing = owner.close();
	await expect(pendingPage).rejects.toThrow(/CLOSED|REVOKED/);
	await closing;
	expect(independentWriter(file)).toBe(0);
	await expect(last.check()).rejects.toThrow(/REVOKED/);
	await expect(owner.inspect()).rejects.toThrow(/CLOSED/);
});

test("native archive reopen never recreates lost storage and rejects foreign scope/local policy substitution", async () => {
	const file = await filename();
	expect(() => open(file, "reopen")).toThrow();
	await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	const owner = open(file),
		before = controlBytes(file);
	await owner.close();
	expect(() =>
		createNodeArchiveStorage({
			filename: file,
			initialization: "reopen",
			objectId: "creator:foreign",
			pinnedGenesisAnchorDigest: genesis,
			capacity,
		})
	).toThrow(/MISMATCH/);
	expect(() => open(file, "reopen", { ...capacity, maxTotalEncodedBytes: capacity.maxTotalEncodedBytes + 1 })).toThrow(
		/MISMATCH/
	);
	expect(controlBytes(file)).toEqual(before);
	expect((await open(file, "reopen").inspect()).position.size).toBe(0);
});

test("native archive registered segment/chunk addresses retain exact bytes and context without becoming wire authority", async () => {
	const file = await filename(),
		owner = open(file),
		initial = (await owner.inspect()).position;
	const payload = encodeCanonical({ mechanicalFixture: "registered artifact addressing only" });
	const payloadDigest = hex(hashDomain("ts-drp/archive-payload/v3", payload));
	const chunkDigest = hex(
		hashDomain("ts-drp/archive-chunk/v3", encodeCanonical(objectId), encodeCanonical(0), encodeCanonical(0), payload)
	);
	const chunk: ArchiveArtifactRef = {
		kind: "chunk",
		digest: chunkDigest,
		byteLength: payload.byteLength,
		startOrdinal: 0,
		chunkIndex: 0,
	};
	const descriptor = encodeCanonical({
		kind: "drp-archive-segment",
		protocolMajor: 3,
		encodingVersion: "drp-canonical-profile-1",
		schemaVersion: 1,
		objectId,
		epoch: 0,
		startOrdinal: 0,
		endOrdinal: 0,
		recordCount: 1,
		payloadDigest,
		totalBytes: payload.byteLength,
		chunks: [{ index: 0, digest: chunkDigest, byteLength: payload.byteLength }],
	});
	const segment: ArchiveArtifactRef = {
		kind: "segment",
		digest: hex(hashDomain("ts-drp/archive-segment/v3", descriptor)),
		byteLength: descriptor.byteLength,
	};
	const leaf = encodeCanonical({
		objectId,
		startOrdinal: 0,
		endOrdinal: 0,
		recordCount: 1,
		segmentDigest: segment.digest,
		payloadDigest,
	});
	const indexEntry: ArchiveArtifactRef = { kind: "index-entry", digest: hash(leaf), byteLength: leaf.byteLength };
	const accumulator = new CompactMerkleAccumulator();
	accumulator.append(leaf);
	const declaration: ArchiveAppendDeclaration = {
		objectId,
		pinnedGenesisAnchorDigest: genesis,
		sourceEpoch: 0,
		sourceAnchorDigest: "3".repeat(64),
		sourceCloseSetRoot: "4".repeat(64),
		expected: initial,
		targetRoot: hex(accumulator.root()),
		artifacts: [chunk, segment, indexEntry],
		indexEntries: [indexEntry],
	};
	const begun = await owner.beginAppend(declaration),
		before = controlBytes(file);
	await expect(
		owner.writeArtifact({ intentDigest: begun.intentDigest, ref: { ...chunk, startOrdinal: 1 }, bytes: payload })
	).rejects.toThrow(/ALTERED/);
	expect(controlBytes(file)).toEqual(before);
	for (const artifact of [
		{ ref: chunk, bytes: payload },
		{ ref: segment, bytes: descriptor },
		{ ref: indexEntry, bytes: leaf },
	])
		await owner.writeArtifact({ intentDigest: begun.intentDigest, ...artifact });
	await owner.prepareAppend(begun.intentDigest);
	const committed = await owner.commitPreparedAppend({ intentDigest: begun.intentDigest, expected: initial });
	const read = await owner.acquireRead(committed);
	expect(await read.lookupArtifact(segment.digest)).toEqual(segment);
	expect(await read.readArtifact(await read.lookupArtifact(segment.digest))).toEqual(descriptor);
	expect(await read.readArtifact(await read.lookupArtifact(chunk.digest))).toEqual(payload);
	await read.release();
});
