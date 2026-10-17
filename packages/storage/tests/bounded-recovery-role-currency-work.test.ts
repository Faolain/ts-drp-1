import {encodeCanonical} from "@ts-drp/canonical";
import {describe, expect, it, vi} from "vitest";
import {boundedRecoveryRoleReadSteps, createBoundedRecoveryRoleRead, type BoundedReadRequest} from "../src/internal/bounded-read.js";
import {AHE_BOUNDED_READ_LIMITS} from "../src/types.js";
import {digestBlob, digestClosure, parseGenerationId, parseHeadRevision, parseStorageObjectId} from "../src/values.js";
import {encodeGenerationRecordV1, encodeHeadRecordV1} from "../src/codecs.js";

const hashing = vi.hoisted(() => ({calls: 0, bytes: 0}));
vi.mock("../src/values.js", async importOriginal => {
	const original = await importOriginal<typeof import("../src/values.js")>();
	return {...original, digestBlob: (bytes: Uint8Array) => {
		hashing.calls++; hashing.bytes += bytes.byteLength; return original.digestBlob(bytes);
	}};
});
const must = <T>(value: {ok: true; value: T} | {ok: false}) => {
	if (!value.ok) throw Error("fixture native data refused"); return value.value;
};

// Controlled native request responses exercise the actual storage algorithm;
// SQLite/browser fixtures separately establish native transaction behavior.
function fixture(count: number) {
	const objectId = must(parseStorageObjectId(`creator:${"a".repeat(32)}`)),
		bytes = Array.from({length: count}, (_, index) => encodeCanonical({index, payload: new Uint8Array(256).fill(index)})),
		byDigest = new Map(bytes.map(raw => [must(digestBlob(raw)), raw])),
		closure = [...byDigest].map(([digest, raw]) => ({digest, byteLength: raw.byteLength})).sort((a, b) => a.digest.localeCompare(b.digest)),
		generations = Array.from({length: Math.ceil(count / 7)}, (_, index) => {
			const refs = closure.slice(index * 7, (index + 1) * 7);
			return {objectId, generationId: must(parseGenerationId((index + 1).toString(16).padStart(64, "0"))), closure: refs,
				closureDigest: must(digestClosure(refs)), state: index === Math.ceil(count / 7) - 1 ? "Adopted" as const : "Superseded" as const,
				baseExpectedHead: {kind: "none" as const, objectId}};
		}), last = generations.at(-1)!,
		head = {kind: "present" as const, objectId, generationId: last.generationId, closureDigest: last.closureDigest, revision: must(parseHeadRevision(1))},
		requests: BoundedReadRequest[] = [];
	let beforeRead: ((request: BoundedReadRequest) => void) | undefined, terminal: (() => void) | undefined;
	function drive<T>(steps: Generator<BoundedReadRequest, T, unknown>): T {
		let step = steps.next();
		while (!step.done) {
			const request = step.value; requests.push(request); beforeRead?.(request);
			const response = request.kind === "head" ? {objectId, record: encodeHeadRecordV1(head)} :
				request.kind === "keys" ? generations.map(row => row.generationId) :
				request.kind === "generation" ? {objectId, generationId: request.generationId,
					record: encodeGenerationRecordV1(generations.find(row => row.generationId === request.generationId)!)} :
				request.kind === "promotion" || request.kind === "blob-preflight" ? true :
				byDigest.get(request.digest)?.slice() ?? null;
			step = steps.next(response);
		}
		return step.value;
	}
	const observation = must(drive(boundedRecoveryRoleReadSteps({objectId, limits: AHE_BOUNDED_READ_LIMITS}))),
		reader = createBoundedRecoveryRoleRead(observation, async steps => {
			const result = drive(steps); terminal?.(); return result;
		});
	requests.length = 0; hashing.calls = 0; hashing.bytes = 0;
	return {reader, requests, bytes, closure, setBeforeRead: (hook: typeof beforeRead) => {beforeRead = hook;},
		setTerminal: (hook: typeof terminal) => {terminal = hook;}};
}

describe("bounded role currency linear immutable-evidence work", () => {
	it("hashes each native/borrowed carrier a constant number of times while still reading all actual bytes", async () => {
		for (const count of [4, 16, 32]) {
			const f = fixture(count), total = f.bytes.reduce((sum, raw) => sum + raw.length, 0);
			expect(await f.reader.checkCurrency()).toEqual({ok: true, value: {kind: "current"}});
			// Entry borrowed sweep + actual native raw validation + completion
			// borrowed sweep + post-native-terminal borrowed sweep. Previously the
			// per-native-blob callback added count * wholeUnionBytes instead.
			expect(hashing.calls).toBe(4 * count); expect(hashing.bytes).toBe(4 * total);
			expect(f.requests.filter(request => request.kind === "blob")).toHaveLength(count);
			expect(f.requests.filter(request => request.kind === "promotion")).toHaveLength(count);
			await f.reader.release();
		}
	});
	it("refuses borrowed corruption before, during and after native material reading", async () => {
		for (const phase of ["entry", "matching-row", "already-read-row", "native-terminal"] as const) {
			const f = fixture(4), mutate = () => {f.reader.blobs[0]!.bytes[0] ^= 1;};
			if (phase === "entry") mutate();
			else if (phase === "native-terminal") f.setTerminal(mutate);
			else f.setBeforeRead(request => {
				if (request.kind === "blob" && request.digest === f.closure[phase === "matching-row" ? 0 : 3]!.digest) mutate();
			});
			expect(await f.reader.checkCurrency(), phase).toEqual({ok: false, reason: "READ_STALE_ROLE_VIEW"});
			await f.reader.release();
		}
	});
	it("keeps actual native corruption distinct from mutable borrowed-buffer staleness", async () => {
		const f = fixture(4);
		f.bytes[2]![0] ^= 1;
		expect(await f.reader.checkCurrency()).toEqual({ok: false, reason: "ADOPTED_BLOB_CORRUPT"});
		await f.reader.release();
	});
});
