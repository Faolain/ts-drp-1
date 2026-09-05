import { describe, expect, it } from "vitest";

import { type MutationTrackingResult, trackMutations } from "../src/proxy.js";

interface Captured<T> {
	ok: boolean;
	value?: T;
	error?: unknown;
}

type StructuralMethod = (this: ArrayBuffer, newByteLength?: number) => unknown;

interface OwnerOnlyFixture {
	host: ArrayBuffer & Record<string, unknown>;
	hostBacking: ArrayBuffer;
	hostBuffer: Buffer;
	tracked: MutationTrackingResult<object>;
	victim: ArrayBuffer;
	victimProxy: ArrayBuffer;
}

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

function makeOwnerOnlyFixture(
	hostBytes: readonly number[],
	victimBytes: readonly number[],
	victimScope: "governed" | "context" = "governed"
): OwnerOnlyFixture {
	const hostBacking = new ArrayBuffer(hostBytes.length);
	const hostBuffer = Buffer.from(hostBacking);
	hostBuffer.set(hostBytes);
	const victim = new ArrayBuffer(victimBytes.length);
	new Uint8Array(victim).set(victimBytes);

	if (victimScope === "governed") {
		const tracked = trackMutations({ host: hostBuffer, victim, untouched: { marker: "stable" } });
		return {
			host: tracked.proxy.host.buffer as ArrayBuffer & Record<string, unknown>,
			hostBacking,
			hostBuffer,
			tracked,
			victim,
			victimProxy: tracked.proxy.victim,
		};
	}

	const tracked = trackMutations({ context: { victim }, host: hostBuffer, untouched: { marker: "stable" } });
	return {
		host: tracked.proxy.host.buffer as ArrayBuffer & Record<string, unknown>,
		hostBacking,
		hostBuffer,
		tracked,
		victim,
		victimProxy: tracked.proxy.context.victim,
	};
}

function expectExactPolicyError(result: Captured<unknown>): void {
	expect.soft(result.ok, "the governed owner-only backing must reject before acquisition").toBe(false);
	expect.soft(result.error).toBeInstanceOf(TypeError);
	expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
}

function expectAttached(backing: ArrayBuffer, expectedBytes: readonly number[]): void {
	expect.soft(backing.byteLength, "the bare victim remains attached").toBe(expectedBytes.length);
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: expectedBytes });
}

function expectHostAttached(backing: ArrayBuffer, buffer: Buffer, expectedBytes: readonly number[]): void {
	expect.soft(backing.byteLength, "the governed Buffer backing remains attached").toBe(expectedBytes.length);
	expect.soft(buffer.byteLength, "the governed Buffer remains attached").toBe(expectedBytes.length);
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: expectedBytes });
	expect.soft(capture(() => [...buffer])).toEqual({ ok: true, value: expectedBytes });
}

function expectClean(tracked: ReturnType<typeof trackMutations>): void {
	expect.soft(tracked.hasChanges(), "rejected owner-only acquisition must not publish authored state").toBe(false);
	expect.soft([...tracked.changedKeys()]).toEqual([]);
	expect.soft(tracked.hasRawEgress(), "rejected owner-only acquisition must not publish raw egress").toBe(false);
	expect.soft([...tracked.rawEgressCandidateKeys()]).toEqual([]);
}

describe("Phase 1d(i) D.92.3-P3b owner-only bare backing egress", () => {
	it.skipIf(representativeTransfer === undefined)(
		"rejects frozen get after the ordinary post-install invariant error",
		() => {
			const transfer = requireRepresentativeTransfer();
			const hostBytes = [11, 12, 13, 14];
			const victimBytes = [21, 22, 23, 24];
			const fixture = makeOwnerOnlyFixture(hostBytes, victimBytes);

			const definition = capture(() =>
				Reflect.defineProperty(fixture.host, "frozenVictim", {
					configurable: false,
					enumerable: false,
					value: fixture.victimProxy,
					writable: false,
				})
			);
			expect.soft(definition.ok, "the post-install Proxy invariant rejects the mismatched value").toBe(false);
			expect.soft(definition.error).toBeInstanceOf(TypeError);
			expect.soft((definition.error as Error | undefined)?.message).not.toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expect.soft(Reflect.getOwnPropertyDescriptor(fixture.hostBacking, "frozenVictim")?.value).toBe(fixture.victim);
			expectClean(fixture.tracked);

			let escaped: unknown;
			const acquisition = capture(() => {
				escaped = Reflect.get(fixture.host, "frozenVictim");
				return Reflect.apply(transfer, escaped, []);
			});

			expectExactPolicyError(acquisition);
			expect.soft(escaped === undefined, "the raw victim must not cross the frozen get boundary").toBe(true);
			expectAttached(fixture.victim, victimBytes);
			expectHostAttached(fixture.hostBacking, fixture.hostBuffer, hostBytes);
			expectClean(fixture.tracked);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"rejects a configurable descriptor before byte write or captured transfer",
		() => {
			const transfer = requireRepresentativeTransfer();
			const hostBytes = [31, 32, 33, 34];
			const victimBytes = [41, 42, 43, 44];
			const fixture = makeOwnerOnlyFixture(hostBytes, victimBytes);

			expect.soft(Reflect.set(fixture.host, "descriptorVictim", fixture.victimProxy)).toBe(true);
			expectClean(fixture.tracked);

			let escaped: unknown;
			const acquisition = capture(() => {
				escaped = Reflect.getOwnPropertyDescriptor(fixture.host, "descriptorVictim")?.value;
				new Uint8Array(escaped as ArrayBuffer)[0] = 0xff;
				return Reflect.apply(transfer, escaped, []);
			});

			expectExactPolicyError(acquisition);
			expect.soft(escaped === undefined, "the raw victim must not cross the descriptor boundary").toBe(true);
			expectAttached(fixture.victim, victimBytes);
			expectHostAttached(fixture.hostBacking, fixture.hostBuffer, hostBytes);
			expectClean(fixture.tracked);
		}
	);

	it("preserves exact identity for a context-only bare backing stored on the host", () => {
		const hostBytes = [51, 52, 53, 54];
		const victimBytes = [61, 62, 63, 64];
		const fixture = makeOwnerOnlyFixture(hostBytes, victimBytes, "context");

		expect.soft(Reflect.set(fixture.host, "contextVictim", fixture.victimProxy)).toBe(true);
		expect.soft(Reflect.getOwnPropertyDescriptor(fixture.host, "contextVictim")?.value === fixture.victim).toBe(true);
		expect.soft(Reflect.get(fixture.host, "contextVictim") === fixture.victimProxy).toBe(true);
		expectAttached(fixture.victim, victimBytes);
		expectHostAttached(fixture.hostBacking, fixture.hostBuffer, hostBytes);
	});
});
