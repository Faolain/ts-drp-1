import { describe, expect, it } from "vitest";

import { trackMutations } from "../src/proxy.js";

interface Captured<T> {
	ok: boolean;
	value?: T;
	error?: unknown;
}

type StructuralMethod = (this: ArrayBuffer, newByteLength?: number) => unknown;

const GOVERNED_BUFFER_TRANSFER_ERROR = "Cannot structurally mutate an ArrayBuffer backing a governed Buffer";
const representativeTransfer = (["transfer", "transferToFixedLength"] as const)
	.map((method) => Reflect.get(ArrayBuffer.prototype, method) as StructuralMethod | undefined)
	.find((member) => typeof member === "function");

function requireRepresentativeTransfer(): StructuralMethod {
	if (representativeTransfer === undefined) throw new Error("the host-gated transfer method is unavailable");
	return representativeTransfer;
}

function capture<T>(run: () => T): Captured<T> {
	try {
		return { ok: true, value: run() };
	} catch (error) {
		return { ok: false, error };
	}
}

function dedicatedBuffer(bytes: readonly number[]): { backing: ArrayBuffer; buffer: Buffer } {
	const backing = new ArrayBuffer(bytes.length);
	const buffer = Buffer.from(backing);
	buffer.set(bytes);
	return { backing, buffer };
}

function expectExactPolicyError(result: Captured<unknown>): void {
	expect.soft(result.ok, "the self-alias must reject before raw backing acquisition").toBe(false);
	expect.soft(result.error).toBeInstanceOf(TypeError);
	expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
}

function expectAttached(backing: ArrayBuffer, buffer: Buffer, expectedBytes: readonly number[]): void {
	expect.soft(backing.byteLength, "the governed backing remains attached").toBe(expectedBytes.length);
	expect.soft(buffer.byteLength, "the governed Buffer remains attached").toBe(expectedBytes.length);
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: expectedBytes });
	expect.soft(capture(() => [...buffer])).toEqual({ ok: true, value: expectedBytes });
}

function expectClean(tracked: ReturnType<typeof trackMutations>): void {
	expect.soft(tracked.hasChanges(), "self-alias rejection must not publish authored state").toBe(false);
	expect.soft([...tracked.changedKeys()]).toEqual([]);
	expect.soft(tracked.hasRawEgress(), "self-alias rejection must not publish raw egress").toBe(false);
	expect.soft([...tracked.rawEgressCandidateKeys()]).toEqual([]);
}

describe("Phase 1d(i) D.92.3-P3b governed backing self-alias egress", () => {
	it.skipIf(representativeTransfer === undefined)(
		"rejects a frozen self-alias get after the ordinary definition invariant commits",
		() => {
			const transfer = requireRepresentativeTransfer();
			const expectedBytes = [11, 12, 13, 14];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;

			const definition = capture(() =>
				Reflect.defineProperty(exposedBacking, "self", {
					configurable: false,
					enumerable: false,
					value: exposedBacking,
					writable: false,
				})
			);
			expect.soft(definition.ok, "the post-install Proxy invariant must reject the mismatched value").toBe(false);
			expect.soft(definition.error).toBeInstanceOf(TypeError);
			expect.soft((definition.error as Error | undefined)?.message).not.toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expect
				.soft(Reflect.ownKeys(exposedBacking), "the ordinary invariant error follows physical installation")
				.toContain("self");
			expectClean(tracked);

			let escaped: unknown;
			const acquisition = capture(() => {
				escaped = Reflect.get(exposedBacking, "self");
				return Reflect.apply(transfer, escaped, []);
			});

			expectExactPolicyError(acquisition);
			expect.soft(escaped === undefined, "no raw backing may cross the governed acquisition boundary").toBe(true);
			expectAttached(backing, buffer, expectedBytes);
			expectClean(tracked);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"rejects a configurable self-alias descriptor before its value can detach governed bytes",
		() => {
			const transfer = requireRepresentativeTransfer();
			const expectedBytes = [21, 22, 23, 24];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;

			expect.soft(Reflect.set(exposedBacking, "self", exposedBacking)).toBe(true);
			expect.soft(Reflect.ownKeys(exposedBacking)).toContain("self");
			expectClean(tracked);

			let escaped: unknown;
			const acquisition = capture(() => {
				escaped = Reflect.getOwnPropertyDescriptor(exposedBacking, "self")?.value;
				return Reflect.apply(transfer, escaped, []);
			});

			expectExactPolicyError(acquisition);
			expect.soft(escaped === undefined, "the descriptor must not expose its raw governed value").toBe(true);
			expectAttached(backing, buffer, expectedBytes);
			expectClean(tracked);
		}
	);

	it("preserves an invariant-compatible frozen foreign ArrayBuffer by exact identity", () => {
		const expectedBytes = [31, 32, 33, 34];
		const { backing, buffer } = dedicatedBuffer(expectedBytes);
		const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
		const exposedBacking = tracked.proxy.buffer.buffer;
		const foreignBacking = new ArrayBuffer(2);

		expect
			.soft(
				Reflect.defineProperty(exposedBacking, "foreign", {
					configurable: false,
					enumerable: false,
					value: foreignBacking,
					writable: false,
				})
			)
			.toBe(true);
		expect.soft(Reflect.get(exposedBacking, "foreign")).toBe(foreignBacking);
		expect.soft(Reflect.getOwnPropertyDescriptor(exposedBacking, "foreign")).toMatchObject({
			configurable: false,
			value: foreignBacking,
			writable: false,
		});
		expect.soft(foreignBacking.byteLength).toBe(2);
		expectAttached(backing, buffer, expectedBytes);
		expect.soft([...tracked.changedKeys()], "foreign reference acquisition authors no governed key").toEqual([]);
	});
});
