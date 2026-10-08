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
	.map((method) => ({
		member: Reflect.get(ArrayBuffer.prototype, method) as StructuralMethod | undefined,
		method,
	}))
	.find(({ member }) => typeof member === "function");

function requireRepresentativeTransfer(): NonNullable<typeof representativeTransfer> {
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

function defineFrozenValue(target: ArrayBuffer, property: PropertyKey, value: unknown): void {
	const defined = Reflect.defineProperty(target, property, {
		configurable: false,
		enumerable: false,
		value,
		writable: false,
	});
	expect.soft(defined, "the descriptor is installed through the exposed backing proxy").toBe(true);
}

function expectExactPolicyError(result: Captured<unknown>): void {
	expect.soft(result.ok, "protected structural acquisition must reject").toBe(false);
	expect.soft(result.error).toBeInstanceOf(TypeError);
	expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
}

function expectAttached(backing: ArrayBuffer, buffer: Buffer, expectedBytes: readonly number[]): void {
	expect.soft(backing.byteLength, "the governed backing stays attached").toBe(expectedBytes.length);
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: expectedBytes });
	expect.soft(capture(() => [...buffer])).toEqual({ ok: true, value: expectedBytes });
}

function expectClean(tracked: ReturnType<typeof trackMutations>): void {
	expect.soft(tracked.hasChanges(), "descriptor-only backing work remains outside authored state").toBe(false);
	expect.soft([...tracked.changedKeys()]).toEqual([]);
	expect.soft(tracked.hasRawEgress(), "a rejected proxy acquisition does not expose a raw capability").toBe(false);
	expect.soft([...tracked.rawEgressCandidateKeys()]).toEqual([]);
}

describe("Phase 1d(i) D.92.3-P3b frozen native backing descriptors", () => {
	it.skipIf(representativeTransfer === undefined)(
		"rejects a frozen captured structural native before returning it from governed backing storage",
		() => {
			const transfer = requireRepresentativeTransfer();
			const expectedBytes = [11, 12, 13, 14];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			defineFrozenValue(exposedBacking, "frozenStructural", transfer.member);
			expect.soft(Reflect.getOwnPropertyDescriptor(backing, "frozenStructural")).toMatchObject({
				configurable: false,
				value: transfer.member,
				writable: false,
			});
			expectClean(tracked);

			const acquisition = capture(() => Reflect.get(exposedBacking, "frozenStructural"));

			expectExactPolicyError(acquisition);
			expectAttached(backing, buffer, expectedBytes);
			expectClean(tracked);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"uses live ownership for a frozen structural alias without violating exact native identity",
		() => {
			const transfer = requireRepresentativeTransfer();
			const { backing, buffer } = dedicatedBuffer([21, 22, 23, 24]);
			const tracked = trackMutations({ context: { buffer }, promoted: null as Buffer | null });
			const exposedBacking = tracked.proxy.context.buffer.buffer;
			defineFrozenValue(exposedBacking, "frozenStructural", transfer.member);

			expect.soft(Reflect.get(exposedBacking, "frozenStructural")).toBe(transfer.member);
			expect.soft(Reflect.getOwnPropertyDescriptor(backing, "frozenStructural")?.value).toBe(transfer.member);
			expect.soft(tracked.hasRawEgress()).toBe(false);

			tracked.proxy.promoted = tracked.proxy.context.buffer;
			expectExactPolicyError(capture(() => Reflect.get(exposedBacking, "frozenStructural")));
			expectAttached(backing, buffer, [21, 22, 23, 24]);
			expect.soft(tracked.hasRawEgress()).toBe(false);

			tracked.proxy.promoted = null;
			expect.soft(Reflect.get(exposedBacking, "frozenStructural")).toBe(transfer.member);
			expectAttached(backing, buffer, [21, 22, 23, 24]);
		}
	);

	it("preserves ordinary frozen data, function identity and undefined-getter invariants", () => {
		const { backing, buffer } = dedicatedBuffer([31, 32, 33, 34]);
		const tracked = trackMutations({ buffer });
		const exposedBacking = tracked.proxy.buffer.buffer;
		const benign = function benign(): string {
			return "stable";
		};
		defineFrozenValue(exposedBacking, "frozenData", 37);
		defineFrozenValue(exposedBacking, "frozenFunction", benign);
		expect
			.soft(
				Reflect.defineProperty(exposedBacking, "undefinedAccessor", {
					configurable: false,
					enumerable: false,
					get: undefined,
					set: undefined,
				})
			)
			.toBe(true);

		expect.soft(Reflect.get(exposedBacking, "frozenData")).toBe(37);
		expect.soft(Reflect.get(exposedBacking, "frozenFunction")).toBe(benign);
		expect.soft(Reflect.get(exposedBacking, "undefinedAccessor")).toBeUndefined();
		expect.soft(Reflect.getOwnPropertyDescriptor(backing, "undefinedAccessor")).toMatchObject({
			configurable: false,
			get: undefined,
		});
		expectAttached(backing, buffer, [31, 32, 33, 34]);
	});
});
