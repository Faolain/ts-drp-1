import assert from "node:assert/strict";

const boundary = process.argv[2] ?? "encoder-self-check";
const variant = process.argv[3] ?? "range";
const NativeBytes = Uint8Array;
const sentinel: unknown =
	variant === "range"
		? new RangeError("controlled downstream allocation")
		: variant === "type"
			? new TypeError("manifest carrier is unreadable: controlled operation")
			: Object.freeze({ marker: "unbranded downstream operational sentinel" });
let phase = "setup";
let armed = false;
const events: Array<{ phase: string; stack: string; injected: boolean }> = [];
globalThis.Uint8Array = new Proxy(NativeBytes, {
	construct(target, args, newTarget): Uint8Array {
		if (args.length === 1 && typeof args[0] === "number") {
			const stack = new Error("downstream owned allocation").stack ?? "";
			const selected =
				stack.includes("copyExactCarrier") &&
				(boundary === "encoder-payload"
					? stack.includes("encodeSnapshotTransfer") && !stack.includes("decodeSnapshotManifest")
					: stack.includes("decodeSnapshotManifest"));
			if (selected && phase !== "setup") {
				events.push({ phase, stack, injected: armed });
				if (armed) {
					armed = false;
					throw sentinel;
				}
			}
		}
		return Reflect.construct(target, args, newTarget) as Uint8Array;
	},
});
const protocol = await import("../../../packages/protocol-v3/dist/src/snapshot-transfer.js");
const compaction = await import("../../../packages/compaction/dist/src/snapshot-stream.js");
const profile = { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 } as const;
const input = {
	aclDigest: "a".repeat(64),
	anchor: "b".repeat(64),
	epoch: 1,
	exactCanonicalPayloadBytes: NativeBytes.of(1, 2, 3),
	objectId: "downstream-provenance",
	profile,
	schemaVersion: 1,
	stateDigest: "c".repeat(64),
};
const encoded = protocol.encodeSnapshotTransfer(input);
const canonical = await import("../../../packages/canonical/dist/src/index.js");
const invalidCanonical = NativeBytes.of(5, 1, 255);
const invalidDigest = Array.from(canonical.hashDomain("ts-drp/snapshot-manifest/v3", invalidCanonical), (byte) =>
	byte.toString(16).padStart(2, "0")
).join("");
assert.throws(
	() =>
		protocol.decodeSnapshotManifest({
			exactCanonicalManifestBytes: invalidCanonical,
			expectedManifestDigest: invalidDigest,
			profile,
		}),
	(error) => {
		assert.ok(error instanceof Error);
		assert.equal(Reflect.get(error, "code"), "manifest-noncanonical");
		assert.ok(error.cause instanceof canonical.CanonicalDecodingError);
		assert.equal(Object.getPrototypeOf(error.cause), canonical.CanonicalDecodingError.prototype);
		return true;
	}
);
const originalBytes = [Array.from(input.exactCanonicalPayloadBytes), Array.from(encoded.exactCanonicalManifestBytes)];
let discards = 0;
let reads = 0;
let writes = 0;
const action = async (invalid = false): Promise<unknown> => {
	if (boundary.startsWith("encoder"))
		return protocol.encodeSnapshotTransfer(
			invalid ? { ...input, exactCanonicalPayloadBytes: new NativeBytes(0) } : input
		);
	const stored = new Map<number, Uint8Array>();
	const stream = compaction.verifySnapshotStream({
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		expectedManifestDigest: invalid ? "0".repeat(64) : encoded.manifestDigest,
		profile,
		quarantine: {
			discard: () => {
				discards++;
				stored.clear();
				if (phase === "fault" && boundary === "stream-discard-fails")
					return Promise.reject(new Error("controlled discard failure"));
				return Promise.resolve();
			},
			read: (descriptor) => {
				reads++;
				return Promise.resolve(stored.get(descriptor.index));
			},
			write: (descriptor, bytes) => {
				writes++;
				stored.set(descriptor.index, bytes);
				return Promise.resolve();
			},
		},
		source: { read: (descriptor) => Promise.resolve(encoded.chunks[descriptor.index]) },
	});
	const completion = await stream.completion;
	const output: Uint8Array[] = [];
	for await (const bytes of stream) output.push(bytes);
	assert.deepEqual(output, encoded.chunks);
	return completion;
};
const code = (error: unknown): unknown =>
	error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
let report: unknown;
try {
	phase = "control";
	const control = await action();
	assert.ok(events.some((event) => event.phase === "control"));
	phase = "deterministic";
	await assert.rejects(
		action(true),
		(error) => code(error) === (boundary.startsWith("encoder") ? "manifest-invalid" : "manifest-digest-mismatch")
	);
	const before = { discards, reads, writes };
	phase = "fault";
	armed = true;
	let failure: unknown;
	try {
		await action();
	} catch (error) {
		failure = error;
	} finally {
		armed = false;
	}
	assert.equal(events.filter((event) => event.injected).length, 1);
	assert.ok(failure);
	if (boundary.startsWith("stream")) {
		assert.equal(discards - before.discards, 1);
		assert.equal(reads, before.reads);
		assert.equal(writes, before.writes);
	}
	const chain: Array<{ code: unknown; message: unknown; sentinel: boolean }> = [];
	const seen = new Set<object>();
	const visit = (error: unknown): void => {
		if (error === null || typeof error !== "object" || seen.has(error) || seen.size >= 16) return;
		seen.add(error);
		chain.push({ code: code(error), message: Reflect.get(error, "message"), sentinel: error === sentinel });
		visit(Reflect.get(error, "cause"));
		if (error instanceof AggregateError) for (const nested of error.errors) visit(nested);
	};
	visit(failure);
	assert.ok(chain.some((item) => item.sentinel));
	phase = "retry";
	assert.deepEqual(await action(), control);
	assert.deepEqual(
		[Array.from(input.exactCanonicalPayloadBytes), Array.from(encoded.exactCanonicalManifestBytes)],
		originalBytes
	);
	report = {
		boundary,
		variant,
		expected:
			boundary === "encoder-payload"
				? "manifest-invalid"
				: boundary === "encoder-self-check"
					? "manifest-processing-failed"
					: boundary === "stream-discard-fails"
						? "quarantine-failed"
						: "source-failed",
		observed: code(failure),
		controls: {
			valid: true,
			deterministic: true,
			retry: true,
			sentinelReached: true,
			sameCanonicalOwner: true,
			inputUnchanged: true,
		},
		events,
		chain,
		discards,
		reads,
		writes,
	};
} finally {
	globalThis.Uint8Array = NativeBytes;
}
console.log(JSON.stringify(report));
