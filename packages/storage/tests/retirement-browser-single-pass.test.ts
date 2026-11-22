import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {describe, expect, it} from "vitest";
import {boundedRetirementAdmissionSteps, type RetirementAdmissionRequest} from "../src/internal/bounded-read.js";
import {encodeGenerationRecordV1, encodeHeadRecordV1} from "../src/codecs.js";
import {AHE_BOUNDED_READ_LIMITS as limits, type GenerationRecord} from "../src/types.js";
import {digestBlob, digestClosure, parseGenerationId, parseHeadRevision, parseStorageObjectId} from "../src/values.js";

const must = <T>(value: {ok: true; value: T} | {ok: false}): T => {
	if (!value.ok) throw Error("invalid native fixture"); return value.value;
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
function fixture(count = 16) {
	const objectId = must(parseStorageObjectId(`creator:${"a".repeat(32)}`));
	const payloads = Array.from({length: count}, (_, index) => encodeCanonical({index, payload: new Uint8Array(128).fill(index)}));
	const blobs = new Map(payloads.map(bytes => [must(digestBlob(bytes)), bytes]));
	const refs = [...blobs].map(([digest, bytes]) => ({digest, byteLength: bytes.byteLength})).sort((a,b) => a.digest.localeCompare(b.digest));
	const generations: GenerationRecord[] = Array.from({length: Math.ceil(count / 7)}, (_, index) => {
		const closure = refs.slice(index * 7, index * 7 + 7);
		return {objectId, generationId: must(parseGenerationId((index + 1).toString(16).padStart(64, "0"))),
			closure, closureDigest: must(digestClosure(closure)),
			state: index === Math.ceil(count / 7) - 1 ? "Adopted" : "Superseded", baseExpectedHead: {kind: "none", objectId}};
	});
	const last = generations.at(-1)!;
	const head = {kind: "present" as const, objectId, generationId: last.generationId,
		closureDigest: last.closureDigest, revision: must(parseHeadRevision(1))};
	const promotions = generations.flatMap(g => g.closure.map(ref => ({generationId: g.generationId, digest: ref.digest})));
	const requests: RetirementAdmissionRequest[] = [];
	const replacements = new Map<string, unknown>();
	let failOn: string | undefined;
	const failure = Error("original native failure");
	function drive(browser: boolean) {
		requests.length = 0;
		const driver = boundedRetirementAdmissionSteps(objectId, 100, browser);
		let step = driver.next();
		while (!step.done) {
			const request = step.value; requests.push(request);
			if (request.kind === "blob" && request.digest === failOn) throw failure;
			let response: unknown;
			if (request.kind === "head") response = {objectId, record: encodeHeadRecordV1(head)};
			else if (request.kind === "keys") response = generations.map(g => g.generationId);
			else if (request.kind === "generation") response = {objectId, generationId: request.generationId,
				record: encodeGenerationRecordV1(generations.find(g => g.generationId === request.generationId)!)};
			else if (request.kind === "promotions") response = promotions;
			else if (request.kind === "blob-preflight") response = true;
			else if (request.kind === "blob-census-preflight") {
				let bytes = 0; response = true;
				for (const ref of request.references) {
					const raw = replacements.has(ref.digest) ? replacements.get(ref.digest) : blobs.get(ref.digest);
					if (raw instanceof Uint8Array) {
						bytes += raw.byteLength;
						if (raw.byteLength > limits.maxBlobBytes || bytes > limits.maxUnionBytes) {response = false; break;}
					}
				}
			} else if (request.kind === "blob") response = replacements.has(request.digest) ? replacements.get(request.digest) : blobs.get(request.digest)?.slice() ?? null;
			else throw Error(`unexpected request ${request.kind}`);
			step = driver.next(response);
		}
		return step.value;
	}
	return {objectId, head, generations, promotions, refs, blobs, replacements, requests, drive, failure,
		setFailOn: (digest: string) => {failOn = digest;}};
}

describe("single-pass browser native retirement census", () => {
	it("reads each blob once, preserving exact native image and full logical charges", () => {
		for (const count of [4, 16, 32]) {
			const f = fixture(count), actual = must(f.drive(true));
			expect(f.requests.filter(r => r.kind === "blob")).toHaveLength(count);
			expect(f.requests.some(r => r.kind === "blob-census-preflight")).toBe(false);
			// Independent native-row encoding oracle: full payload lengths remain
			// charged, not the smaller descriptor/hash or a cache credit.
			const key = `ahe-retirement:${f.objectId}`;
			const rowBytes = [
				encodeCanonical({store: "storageMeta", key, value: {key, record: new Uint8Array(100)}}),
				encodeCanonical({store: "objects", key: f.objectId, value: {objectId: f.objectId, record: encodeHeadRecordV1(f.head)}}),
				...f.generations.map(g => encodeCanonical({store: "generations", key: [f.objectId,g.generationId],
					value: {objectId: f.objectId, generationId: g.generationId, record: encodeGenerationRecordV1(g)}})),
				...f.promotions.map(p => encodeCanonical({store: "promotions", key: [f.objectId,p.generationId,p.digest],
					value: {objectId: f.objectId,...p}})),
				...f.refs.map(ref => encodeCanonical({store: "blobs", key: ref.digest, value: {digest: ref.digest, bytes: f.blobs.get(ref.digest)!}})),
			];
			expect(actual.logicalBytes).toBe(rowBytes.reduce((sum,bytes) => sum + bytes.length, 0));
			const image = encodeCanonical({head: encodeHeadRecordV1(f.head), generations: f.generations.map(encodeGenerationRecordV1),
				promotions: f.promotions.map(p => `${p.generationId}:${p.digest}`).sort(), presentBlobs: f.refs.map(ref => ref.digest).sort()});
			expect(actual.imageDigest).toBe(hex(hashDomain("ts-drp-storage/retirement-image/v1", image)));
			expect(actual.generations).toHaveLength(f.generations.length);
			const sql = must(f.drive(false));
			expect(f.requests.filter(r => r.kind === "blob-census-preflight")).toHaveLength(1);
			expect(sql.imageDigest).toBe(actual.imageDigest);
			expect(sql.generations).toEqual(actual.generations);
		}
	});
	it("preserves preflight budget precedence over earlier missing or corrupt material", () => {
		for (const earlier of [null, new Uint8Array(3), "not bytes"]) {
			const f = fixture(4);
			f.replacements.set(f.refs[0]!.digest, earlier);
			f.replacements.set(f.refs[3]!.digest, new Uint8Array(limits.maxBlobBytes + 1));
			expect(f.drive(true)).toEqual({ok: false, reason: "READ_BUDGET_EXCEEDED"});
			expect(f.drive(false)).toEqual({ok: false, reason: "READ_BUDGET_EXCEEDED"});
		}
	});
	it("preserves the first integrity refusal after completing the native length preflight", () => {
		for (const [replacement,reason] of [[null,"ADOPTED_BLOB_MISSING"],[new Uint8Array(3),"BLOB_CORRUPT"],["bad","BLOB_CORRUPT"]] as const) {
			const f = fixture(4); f.replacements.set(f.refs[0]!.digest,replacement);
			expect(f.drive(true)).toEqual({ok: false, reason});
			expect(f.requests.filter(r => r.kind === "blob")).toHaveLength(4);
		}
		const f = fixture(4), changed = f.blobs.get(f.refs[0]!.digest)!.slice(); changed[0] ^= 1;
		f.replacements.set(f.refs[0]!.digest, changed);
		expect(f.drive(true)).toEqual({ok: false, reason: "BLOB_CORRUPT"});
	});
	it("enforces the complete actual-byte union even when declared reference lengths are small", () => {
		const f = fixture(16);
		for (const ref of f.refs) f.replacements.set(ref.digest, new Uint8Array(limits.maxBlobBytes));
		expect(f.drive(true)).toEqual({ok: false, reason: "READ_BUDGET_EXCEEDED"});
		expect(f.drive(false)).toEqual({ok: false, reason: "READ_BUDGET_EXCEEDED"});
	});
	it("does not swallow a later native failure behind a deferred integrity refusal", () => {
		const f = fixture(4); f.replacements.set(f.refs[0]!.digest, null); f.setFailOn(f.refs[3]!.digest);
		expect(() => f.drive(true)).toThrow(f.failure);
	});
});
