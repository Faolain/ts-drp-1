/* eslint-disable @typescript-eslint/no-non-null-assertion -- test mechanisms use known-present entries */
import { serializeValue } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { type MutationTrackingResult, trackMutations } from "../src/proxy.js";

interface Child {
	value: number;
}

interface Attribution {
	canonicalKeys: string[];
	changedKeys: string[];
	hasChanges: boolean;
}

interface ContainerCase {
	name: string;
	make(child: Child): object;
	child(container: object): Child;
}

const containerCases: ContainerCase[] = [
	{
		name: "object",
		make: (child) => ({ child }),
		child: (container) => (container as { child: Child }).child,
	},
	{
		name: "Array",
		make: (child) => [child],
		child: (container) => (container as Child[])[0]!,
	},
	{
		name: "Map",
		make: (child) => new Map([["child", child]]),
		child: (container) => (container as Map<string, Child>).get("child")!,
	},
];

function frozenBytes(value: object): Map<string, Uint8Array> {
	return new Map(Object.entries(value).map(([key, entry]) => [key, Uint8Array.from(serializeValue(entry))]));
}

function byteDeltaKeys(before: ReadonlyMap<string, Uint8Array>, value: object): string[] {
	const after = frozenBytes(value);
	const changed: string[] = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const left = before.get(key);
		const right = after.get(key);
		if (
			left !== undefined &&
			right !== undefined &&
			left.byteLength === right.byteLength &&
			left.every((byte, index) => byte === right[index])
		) {
			continue;
		}
		changed.push(key);
	}
	return changed.sort();
}

function attribution<T extends object>(
	tracked: MutationTrackingResult<T>,
	before: ReadonlyMap<string, Uint8Array>,
	state: T
): Attribution {
	return {
		canonicalKeys: byteDeltaKeys(before, state),
		changedKeys: [...tracked.changedKeys()].sort(),
		hasChanges: tracked.hasChanges(),
	};
}

function nestedWrapperResult(observeReplacement: boolean): Attribution {
	const shared = { value: 0 };
	const state = { a: { link: { child: { value: 0 } } }, b: shared, untouched: { value: 0 } };
	const before = frozenBytes(state);
	const tracked = trackMutations(state);
	const held = tracked.proxy.b;

	tracked.proxy.a.link = { child: shared };
	if (observeReplacement) void tracked.proxy.a.link;
	held.value = 1;

	expect(state.a.link.child).toBe(state.b);
	return attribution(tracked, before, state);
}

function topLevelResult(mechanism: ContainerCase, observeReplacement: boolean): Attribution {
	const child = { value: 0 };
	const state = { container: mechanism.make(child), untouched: { value: 0 } };
	const before = frozenBytes(state);
	const tracked = trackMutations(state);
	const held = mechanism.child(tracked.proxy.container);

	tracked.proxy.container = mechanism.make(child);
	if (observeReplacement) void tracked.proxy.container;
	held.value = 1;

	return attribution(tracked, before, state);
}

describe("Phase 1d(i) unseen subtree reidentity attribution", () => {
	it("registers existing descendants when an equal nested wrapper is linked, independent of a later read", () => {
		const expected = { canonicalKeys: ["a", "b"], changedKeys: ["a", "b"], hasChanges: true };

		expect([nestedWrapperResult(false), nestedWrapperResult(true)]).toEqual([expected, expected]);
	});

	it.each(containerCases)("registers an equal top-level $name subtree independent of a later read", (mechanism) => {
		const expected = { canonicalKeys: ["container"], changedKeys: ["container"], hasChanges: true };

		expect([topLevelResult(mechanism, false), topLevelResult(mechanism, true)]).toEqual([expected, expected]);
	});

	it("keeps equal container reidentity without a descendant mutation silent", () => {
		for (const mechanism of containerCases) {
			const child = { value: 0 };
			const state = { container: mechanism.make(child), untouched: { value: 0 } };
			const before = frozenBytes(state);
			const previous = state.container;
			const tracked = trackMutations(state);

			tracked.proxy.container = mechanism.make(child);

			expect(state.container, mechanism.name).not.toBe(previous);
			expect(attribution(tracked, before, state), mechanism.name).toEqual({
				canonicalKeys: [],
				changedKeys: [],
				hasChanges: false,
			});
		}
	});

	it("keeps a held descendant silent when an equal wrapper detaches it before mutation", () => {
		const oldChild = { value: 0 };
		const state = { container: { child: oldChild }, untouched: { value: 0 } };
		const before = frozenBytes(state);
		const tracked = trackMutations(state);
		const held = tracked.proxy.container.child;

		tracked.proxy.container = { child: { value: 0 } };
		held.value = 1;

		expect(oldChild.value).toBe(1);
		expect(state.container.child.value).toBe(0);
		expect(attribution(tracked, before, state)).toEqual({
			canonicalKeys: [],
			changedKeys: [],
			hasChanges: false,
		});
	});
});
