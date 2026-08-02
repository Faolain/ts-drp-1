import { describe, expect, it } from "vitest";

import { detachStatePayload } from "../src/state-payload.js";

interface DetachmentWorkCounters {
	typedArrayViewsDetached: number;
	typedArrayCanonicalIndexEnumerations: number;
	typedArrayElementsRecursivelyDetached: number;
	backingStoresCopied: number;
	backingBytesCopied: number;
}

interface DetachmentWorkEvent {
	type: "state-payload-detachment";
	counters: DetachmentWorkCounters;
}

type MeteredDetach = <T>(value: T, observer?: (event: DetachmentWorkEvent) => unknown) => T;

interface MeasuredDetachment<T> {
	copy: T;
	events: DetachmentWorkEvent[];
}

function measuredDetach<T>(value: T): MeasuredDetachment<T> {
	const events: DetachmentWorkEvent[] = [];
	const detach = detachStatePayload as MeteredDetach;
	return {
		copy: detach(value, (event) => events.push(event)),
		events,
	};
}

function onlyCounters(events: readonly DetachmentWorkEvent[], label: string): DetachmentWorkCounters {
	expect(events, `${label}: one aggregate work event per top-level detachment`).toHaveLength(1);
	const event = events[0];
	if (event === undefined) throw new Error(`${label}: detachment work event missing`);
	expect(event.type, `${label}: stable event discriminant`).toBe("state-payload-detachment");
	return event.counters;
}

describe("Phase 1d(i) D.92.3-P3a owned TypedArray enumeration RED", () => {
	it("counts one canonical-index enumeration per distinct detached TypedArray view and one bulk backing copy", () => {
		const backing = new ArrayBuffer(32);
		const bytes = new Uint8Array(backing);
		bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
		const wide = new Uint8Array(backing, 4, 16);
		const overlap = new Int8Array(backing, 8, 4);
		const data = new DataView(backing, 10, 6);
		const source = { backing, wide, repeated: wide, overlap, data };

		const { copy, events } = measuredDetach(source);
		expect.soft(copy).not.toBe(source);
		expect.soft(copy.repeated, "repeated source identity is one detached view").toBe(copy.wide);
		expect.soft(new Set([copy.backing, copy.wide.buffer, copy.overlap.buffer, copy.data.buffer])).toHaveLength(1);
		expect.soft(copy.backing).not.toBe(backing);
		expect.soft([copy.wide.byteOffset, copy.wide.length]).toEqual([4, 16]);
		expect.soft([copy.overlap.byteOffset, copy.overlap.length]).toEqual([8, 4]);
		expect.soft([copy.data.byteOffset, copy.data.byteLength]).toEqual([10, 6]);
		expect.soft([...new Uint8Array(copy.backing)]).toEqual([...bytes]);
		copy.wide[4] = 91;
		expect.soft(copy.overlap[0], "overlapping output views retain their backing alias").toBe(91);
		expect.soft(bytes[8], "the bulk-copied backing is detached from the source").toBe(8);

		expect(onlyCounters(events, "overlapping view graph")).toEqual({
			typedArrayViewsDetached: 2,
			typedArrayCanonicalIndexEnumerations: 2,
			typedArrayElementsRecursivelyDetached: 0,
			backingStoresCopied: 1,
			backingBytesCopied: backing.byteLength,
		});
	});

	it("preserves enumerable string and symbol expandos while omitting non-enumerable expandos", () => {
		const symbolKey = Symbol("typed-array-expando");
		const hiddenKey = Symbol("hidden-typed-array-expando");
		const source = new Uint8Array([3, 5, 8]) as Uint8Array & Record<PropertyKey, unknown>;
		const shared = { label: "shared", owner: source };
		source.extra = shared;
		source["01"] = shared;
		source[symbolKey] = shared;
		Reflect.defineProperty(source, "hidden", { configurable: true, enumerable: false, value: shared });
		Reflect.defineProperty(source, hiddenKey, { configurable: true, enumerable: false, value: shared });

		const copy = detachStatePayload(source);
		expect.soft([...copy], "canonical indices retain their bulk-copied bytes").toEqual([3, 5, 8]);
		expect.soft(copy.extra).not.toBe(shared);
		expect.soft(copy.extra).toBe(copy["01"]);
		expect.soft(copy.extra).toBe(copy[symbolKey]);
		expect.soft((copy.extra as { owner: unknown }).owner, "expando cycles retain the detached view").toBe(copy);
		expect.soft(Object.hasOwn(copy, "hidden"), "non-enumerable string expandos remain omitted").toBe(false);
		expect.soft(Object.hasOwn(copy, hiddenKey), "non-enumerable symbol expandos remain omitted").toBe(false);
	});

	it("defines the counted family without widening Arrays, DataViews, or Node Buffers", () => {
		const plainArray = measuredDetach([1, 2, 3]);
		const dataView = measuredDetach(new DataView(new ArrayBuffer(12), 2, 4));
		const bigint = measuredDetach(new BigInt64Array([BigInt(1), BigInt(2)]));
		const buffer = measuredDetach(Buffer.from([1, 2, 3, 4]));

		expect.soft(plainArray.copy).toEqual([1, 2, 3]);
		expect.soft([dataView.copy.byteOffset, dataView.copy.byteLength]).toEqual([2, 4]);
		expect.soft([...bigint.copy]).toEqual([BigInt(1), BigInt(2)]);
		expect.soft([...buffer.copy]).toEqual([1, 2, 3, 4]);
		expect.soft(buffer.copy).not.toBe(buffer);
		expect(onlyCounters(plainArray.events, "plain Array")).toEqual({
			typedArrayViewsDetached: 0,
			typedArrayCanonicalIndexEnumerations: 0,
			typedArrayElementsRecursivelyDetached: 0,
			backingStoresCopied: 0,
			backingBytesCopied: 0,
		});
		expect(onlyCounters(dataView.events, "DataView")).toEqual({
			typedArrayViewsDetached: 0,
			typedArrayCanonicalIndexEnumerations: 0,
			typedArrayElementsRecursivelyDetached: 0,
			backingStoresCopied: 1,
			backingBytesCopied: 12,
		});
		expect(onlyCounters(bigint.events, "BigInt TypedArray")).toEqual({
			typedArrayViewsDetached: 1,
			typedArrayCanonicalIndexEnumerations: 1,
			typedArrayElementsRecursivelyDetached: 0,
			backingStoresCopied: 1,
			backingBytesCopied: 16,
		});
		expect(onlyCounters(buffer.events, "Node Buffer")).toEqual({
			typedArrayViewsDetached: 0,
			typedArrayCanonicalIndexEnumerations: 0,
			typedArrayElementsRecursivelyDetached: 0,
			backingStoresCopied: 1,
			backingBytesCopied: 4,
		});
	});

	it.runIf(typeof SharedArrayBuffer !== "undefined")(
		"counts a shared backing once while keeping subview bytes and ownership detached",
		() => {
			const backing = new SharedArrayBuffer(12);
			const source = new Uint8Array(backing, 3, 5);
			source.set([10, 11, 12, 13, 14]);
			const { copy, events } = measuredDetach({ backing, source });

			expect.soft(copy.backing).not.toBe(backing);
			expect.soft(copy.source.buffer).toBe(copy.backing);
			expect.soft([copy.source.byteOffset, copy.source.length, ...copy.source]).toEqual([3, 5, 10, 11, 12, 13, 14]);
			copy.source[0] = 99;
			expect.soft(source[0], "shared backing ownership is still detached").toBe(10);
			expect(onlyCounters(events, "SharedArrayBuffer subview")).toEqual({
				typedArrayViewsDetached: 1,
				typedArrayCanonicalIndexEnumerations: 1,
				typedArrayElementsRecursivelyDetached: 0,
				backingStoresCopied: 1,
				backingBytesCopied: 12,
			});
		}
	);
});
