/* eslint-disable @typescript-eslint/no-non-null-assertion -- the RED narrows explicit state entries */
import { type DRPState, DRPStateEntry, DRPStateOtherTheWire, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPObject } from "../src/index.js";
import { type DRPObjectStateManager } from "../src/state.js";

class SnapshotFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	left: unknown = undefined;
	right: unknown = undefined;
}

type SnapshotSide = "acl" | "drp";
type ReconstructionPath = "fromHash" | "fromStates";

function entry(key: string, value: unknown): DRPState["state"][number] {
	return DRPStateEntry.create({ key, value });
}

function snapshot(entries: DRPState["state"]): DRPState {
	return { state: entries } as DRPState;
}

function encoded(state: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

function stateValue(state: DRPState, key: string): unknown {
	const candidate = state.state.find((item) => item?.key === key);
	expect(candidate, `snapshot must contain ${key}`).toBeDefined();
	return candidate!.value;
}

function manager(object: DRPObject<SnapshotFixture>): DRPObjectStateManager<SnapshotFixture> {
	return object["_states"];
}

function stateFor(
	store: DRPObjectStateManager<SnapshotFixture>,
	side: SnapshotSide,
	hash: string
): DRPState | undefined {
	return side === "acl" ? store.getACLState(hash) : store.getDRPState(hash);
}

function install(object: DRPObject<SnapshotFixture>, side: SnapshotSide, hash: string, value: DRPState): void {
	if (side === "acl") object.setACLState(hash, value);
	else object.setDRPState(hash, value);
}

function installDirect(
	store: DRPObjectStateManager<SnapshotFixture>,
	side: SnapshotSide,
	hash: string,
	value: DRPState
): void {
	if (side === "acl") store.setACLState(hash, value);
	else store.setDRPState(hash, value);
}

function publicState(object: DRPObject<SnapshotFixture>, side: SnapshotSide, hash: string): DRPState | undefined {
	const [acl, drp] = object.getStates(hash);
	return side === "acl" ? acl : drp;
}

function object(): DRPObject<SnapshotFixture> {
	return new DRPObject({
		peerId: "snapshot-owner",
		acl: createACL({ admins: ["snapshot-owner"] }),
		drp: new SnapshotFixture(),
	});
}

function reconstruct(
	path: ReconstructionPath,
	states: DRPObjectStateManager<SnapshotFixture>,
	hash: string,
	drpState: DRPState,
	aclState: DRPState
): [SnapshotFixture | undefined, unknown] {
	if (path === "fromHash") {
		states.setDRPState(hash, drpState);
		states.setACLState(hash, aclState);
		return states.fromHash(hash);
	}
	return states.fromStates(drpState, aclState);
}

function otherSide(side: SnapshotSide): SnapshotSide {
	return side === "acl" ? "drp" : "acl";
}

describe("Phase 1d(i) D.92.3-P2 captured snapshot-container traversal", () => {
	it("does not invoke a caller-owned array map while preserving public and reconstruction ownership boundaries", () => {
		const target = object();
		const states = manager(target);
		const shared = { nested: { marker: "source" } };
		const aclEntries = [entry("left", shared), entry("right", shared)];
		const drpEntries = [entry("left", shared), entry("right", shared)];
		let callerMapCalls = 0;
		for (const entries of [aclEntries, drpEntries]) {
			Object.defineProperty(entries, "map", {
				configurable: true,
				value: (): never => {
					callerMapCalls++;
					throw new Error("caller-owned state container map must not run");
				},
			});
		}

		const hash = "hijacked-array-map";
		expect(() => install(target, "acl", hash, snapshot(aclEntries))).not.toThrow();
		expect(() => install(target, "drp", hash, snapshot(drpEntries))).not.toThrow();
		expect(callerMapCalls).toBe(0);

		const aclOutput = publicState(target, "acl", hash)!;
		const drpOutput = publicState(target, "drp", hash)!;
		const aclLeft = stateValue(aclOutput, "left") as typeof shared;
		const aclRight = stateValue(aclOutput, "right") as typeof shared;
		const drpLeft = stateValue(drpOutput, "left") as typeof shared;
		const drpRight = stateValue(drpOutput, "right") as typeof shared;
		expect.soft(aclLeft).not.toBe(shared);
		expect.soft(drpLeft).not.toBe(shared);
		expect.soft(aclLeft).not.toBe(aclRight);
		expect.soft(drpLeft).not.toBe(drpRight);
		expect.soft(aclLeft).not.toBe(drpLeft);

		shared.nested.marker = "source-mutated";
		expect.soft(aclLeft.nested.marker).toBe("source");
		expect.soft(drpLeft.nested.marker).toBe("source");
		aclLeft.nested.marker = "public-mutated";
		expect(stateValue(publicState(target, "acl", hash)!, "left")).toMatchObject({
			nested: { marker: "source" },
		});

		const [reconstructed] = states.fromHash(hash);
		expect(reconstructed).toBeDefined();
		expect.soft(reconstructed!.left).not.toBe(shared);
		expect.soft(reconstructed!.left).not.toBe(reconstructed!.right);
		(reconstructed!.left as typeof shared).nested.marker = "reconstruction-mutated";
		expect(stateValue(stateFor(states, "drp", hash)!, "left")).toMatchObject({
			nested: { marker: "source" },
		});
	});

	it("preserves sparse entry positions and their public entry order", () => {
		const target = object();
		const sparse = new Array<DRPState["state"][number]>(4);
		sparse[1] = entry("middle", { marker: "middle" });
		sparse[3] = entry("last", { marker: "last" });
		const hash = "sparse-state-container";

		target.setACLState(hash, snapshot(sparse));
		target.setDRPState(hash, snapshot(sparse));
		const [acl, drp] = target.getStates(hash);
		for (const copied of [acl!, drp!]) {
			expect.soft(copied.state).toHaveLength(4);
			expect.soft(0 in copied.state).toBe(false);
			expect.soft(1 in copied.state).toBe(true);
			expect.soft(2 in copied.state).toBe(false);
			expect.soft(3 in copied.state).toBe(true);
			expect.soft(copied.state[1]!.key).toBe("middle");
			expect.soft(copied.state[3]!.key).toBe("last");
		}
	});

	it.each(["length", "index"] as const)(
		"preserves the primary throwing %s access and leaves both snapshot sides unmodified",
		(kind) => {
			const target = object();
			const states = manager(target);
			const hash = `throwing-${kind}-container`;
			const initial = snapshot([entry("stable", { marker: "before" })]);
			target.setACLState(hash, initial);
			target.setDRPState(hash, initial);
			const beforeACL = states.getACLState(hash);
			const beforeDRP = states.getDRPState(hash);
			const sentinel = new Error(`controlled ${kind} access`);
			const entries = new Proxy([entry("unsafe", { marker: "after" })], {
				get(source, property, receiver): unknown {
					if (property === "length" && kind === "length") throw sentinel;
					if (property === "0" && kind === "index") throw sentinel;
					return Reflect.get(source, property, receiver);
				},
			});

			for (const side of ["acl", "drp"] as const) {
				let thrown: unknown;
				try {
					install(target, side, hash, snapshot(entries));
				} catch (error) {
					thrown = error;
				}
				expect(thrown, `${side} must preserve the original ${kind} throwable`).toBe(sentinel);
			}
			expect(states.getACLState(hash)).toBe(beforeACL);
			expect(states.getDRPState(hash)).toBe(beforeDRP);
		}
	);

	it.each(["acl", "drp"] as const)(
		"rejects a non-array %s container before its caller-owned map can replace an existing snapshot",
		(side) => {
			const target = object();
			const states = manager(target);
			const hash = `non-array-${side}-container`;
			const stable = snapshot([entry("stable", { marker: "before" })]);
			install(target, side, hash, stable);
			const before = stateFor(states, side, hash);
			let callerMapCalls = 0;
			const nonArray = {
				map(): DRPState["state"] {
					callerMapCalls++;
					return [entry("attacker", { marker: "replacement" })];
				},
			};
			let thrown: unknown;
			try {
				install(target, side, hash, { state: nonArray } as unknown as DRPState);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(TypeError);
			expect(callerMapCalls).toBe(0);
			expect(stateFor(states, side, hash)).toBe(before);
			expect(publicState(target, side, hash)).toMatchObject({
				state: [{ key: "stable", value: { marker: "before" } }],
			});
		}
	);

	it("keeps ordinary array containers as a positive public setter and reconstruction control", () => {
		const target = object();
		const states = manager(target);
		const hash = "ordinary-container-control";
		const input = snapshot([entry("left", { nested: { marker: "control" } })]);
		target.setACLState(hash, input);
		target.setDRPState(hash, input);

		const [reconstructed, reconstructedACL] = states.fromHash(hash);
		expect(reconstructed!.left).toMatchObject({ nested: { marker: "control" } });
		expect(reconstructedACL).toMatchObject({ left: { nested: { marker: "control" } } });
		expect(target.getStates(hash)).toEqual([
			expect.objectContaining({ state: [expect.objectContaining({ key: "left" })] }),
			expect.objectContaining({ state: [expect.objectContaining({ key: "left" })] }),
		]);
	});
});

describe("Phase 1d(i) D.92.3-P2 raw stored snapshot-container traversal", () => {
	it.each(["acl", "drp"] as const)("does not invoke a raw stored %s array map during public copy-out", (side) => {
		const target = object();
		const states = manager(target);
		const hash = `raw-copyout-map-${side}`;
		const source = { nested: { marker: "source" } };
		const entries = [entry("payload", source)];
		let callerMapCalls = 0;
		Object.defineProperty(entries, "map", {
			configurable: true,
			value: (): never => {
				callerMapCalls++;
				throw new Error("raw stored state container map must not run");
			},
		});
		const raw = snapshot(entries);
		const companion = snapshot([entry("stable", { marker: "companion" })]);
		installDirect(states, side, hash, raw);
		installDirect(states, otherSide(side), hash, companion);
		const beforeBytes = encoded(raw);

		const [acl, drp] = target.getStates(hash);
		const copied = side === "acl" ? acl! : drp!;
		const copiedValue = stateValue(copied, "payload") as typeof source;
		expect(callerMapCalls).toBe(0);
		expect.soft(copied).not.toBe(raw);
		expect.soft(copied.state).not.toBe(entries);
		expect.soft(copiedValue).not.toBe(source);
		expect(stateFor(states, side, hash)).toBe(raw);
		expect(encoded(raw)).toEqual(beforeBytes);

		source.nested.marker = "source-mutated";
		expect(copiedValue.nested.marker).toBe("source");
		copiedValue.nested.marker = "copyout-mutated";
		expect(stateValue(raw, "payload")).toMatchObject({ nested: { marker: "source-mutated" } });
	});

	it.each(["acl", "drp"] as const)(
		"rejects a raw stored non-array %s container before its map can affect public copy-out",
		(side) => {
			const target = object();
			const states = manager(target);
			const hash = `raw-copyout-non-array-${side}`;
			let callerMapCalls = 0;
			const container = {
				map(): DRPState["state"] {
					callerMapCalls++;
					return [entry("attacker", { marker: "replacement" })];
				},
			};
			const raw = { state: container } as unknown as DRPState;
			installDirect(states, side, hash, raw);
			installDirect(states, otherSide(side), hash, snapshot([entry("stable", { marker: "companion" })]));
			let thrown: unknown;
			try {
				target.getStates(hash);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(TypeError);
			expect(callerMapCalls).toBe(0);
			expect(stateFor(states, side, hash)).toBe(raw);
			expect(raw.state).toBe(container);
		}
	);

	it.each([
		["acl", "length"],
		["acl", "index"],
		["drp", "length"],
		["drp", "index"],
	] as const)(
		"preserves a raw stored %s copy-out primary throwing %s access without store mutation",
		(side, kind: "length" | "index") => {
			const target = object();
			const states = manager(target);
			const hash = `raw-copyout-throwing-${side}-${kind}`;
			const sentinel = new Error(`raw copy-out ${kind} sentinel`);
			const entries = new Proxy([entry("payload", { marker: "source" })], {
				get(source, property, receiver): unknown {
					if (property === "length" && kind === "length") throw sentinel;
					if (property === "0" && kind === "index") throw sentinel;
					return Reflect.get(source, property, receiver);
				},
			});
			const raw = snapshot(entries);
			installDirect(states, side, hash, raw);
			installDirect(states, otherSide(side), hash, snapshot([entry("stable", { marker: "companion" })]));
			let thrown: unknown;
			try {
				target.getStates(hash);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBe(sentinel);
			expect(stateFor(states, side, hash)).toBe(raw);
			expect(raw.state).toBe(entries);
		}
	);

	it.each(["acl", "drp"] as const)("preserves raw stored sparse %s copy-out holes and entry order", (side) => {
		const target = object();
		const states = manager(target);
		const hash = `raw-copyout-sparse-${side}`;
		const entries = new Array<DRPState["state"][number]>(4);
		entries[1] = entry("middle", { marker: "middle" });
		entries[3] = entry("last", { marker: "last" });
		const raw = snapshot(entries);
		installDirect(states, side, hash, raw);
		installDirect(states, otherSide(side), hash, snapshot([entry("stable", { marker: "companion" })]));

		const [acl, drp] = target.getStates(hash);
		const copied = side === "acl" ? acl! : drp!;
		expect.soft(copied.state).toHaveLength(4);
		expect.soft(0 in copied.state).toBe(false);
		expect.soft(1 in copied.state).toBe(true);
		expect.soft(2 in copied.state).toBe(false);
		expect.soft(3 in copied.state).toBe(true);
		expect.soft(copied.state[1]!.key).toBe("middle");
		expect.soft(copied.state[3]!.key).toBe("last");
		expect(stateFor(states, side, hash)).toBe(raw);
		expect(raw.state).toBe(entries);
	});

	it.each(["fromHash", "fromStates"] as const)(
		"does not invoke a raw stored iterator during %s reconstruction",
		(path) => {
			const target = object();
			const states = manager(target);
			const hash = `raw-reconstruction-iterator-${path}`;
			const source = { nested: { marker: "source" } };
			const entries = [entry("left", source)];
			let callerIteratorCalls = 0;
			Object.defineProperty(entries, Symbol.iterator, {
				configurable: true,
				value: (): never => {
					callerIteratorCalls++;
					throw new Error("raw stored state container iterator must not run");
				},
			});
			const raw = snapshot(entries);
			const stableACL = snapshot([entry("stable", { marker: "acl" })]);

			const [reconstructed] = reconstruct(path, states, hash, raw, stableACL);
			expect(callerIteratorCalls).toBe(0);
			expect(reconstructed!.left).not.toBe(source);
			expect(reconstructed!.left).toMatchObject({ nested: { marker: "source" } });
			expect(raw.state).toBe(entries);
			if (path === "fromHash") expect(states.getDRPState(hash)).toBe(raw);
		}
	);

	it.each(["fromHash", "fromStates"] as const)(
		"keeps sparse reconstruction wire-equivalent and prevents partial %s application",
		(path) => {
			const target = object();
			const states = manager(target);
			const hash = `raw-reconstruction-sparse-${path}`;
			const entries = new Array<DRPState["state"][number]>(3);
			entries[0] = entry("left", { marker: "before-hole" });
			entries[2] = entry("right", { marker: "after-hole" });
			const raw = snapshot(entries);
			const stableACL = snapshot([entry("stable", { marker: "acl" })]);
			const originalDescriptor = Reflect.getOwnPropertyDescriptor(SnapshotFixture.prototype, "left");
			let partialAssignments = 0;
			Reflect.defineProperty(SnapshotFixture.prototype, "left", {
				configurable: true,
				set(): void {
					partialAssignments++;
				},
			});
			let reconstructionThrowable: unknown;
			try {
				try {
					reconstruct(path, states, hash, raw, stableACL);
				} catch (error) {
					reconstructionThrowable = error;
				}
			} finally {
				if (originalDescriptor === undefined) Reflect.deleteProperty(SnapshotFixture.prototype, "left");
				else Reflect.defineProperty(SnapshotFixture.prototype, "left", originalDescriptor);
			}

			expect(() => encoded(raw)).toThrow(TypeError);
			expect(reconstructionThrowable).toBeInstanceOf(TypeError);
			expect(partialAssignments).toBe(0);
			expect(raw.state).toBe(entries);
			if (path === "fromHash") expect(states.getDRPState(hash)).toBe(raw);
		}
	);

	it.each(["fromHash", "fromStates"] as const)(
		"rejects a non-array %s reconstruction container before caller map or iterator invocation",
		(path) => {
			const target = object();
			const states = manager(target);
			const hash = `raw-reconstruction-non-array-${path}`;
			const calls = { map: 0, iterator: 0 };
			const container = {
				map(): DRPState["state"] {
					calls.map++;
					return [entry("attacker", { marker: "map" })];
				},
				[Symbol.iterator](): Iterator<DRPState["state"][number]> {
					calls.iterator++;
					return [entry("attacker", { marker: "iterator" })][Symbol.iterator]();
				},
			};
			const raw = { state: container } as unknown as DRPState;
			const stableACL = snapshot([entry("stable", { marker: "acl" })]);
			let thrown: unknown;
			try {
				reconstruct(path, states, hash, raw, stableACL);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(TypeError);
			expect(calls).toEqual({ map: 0, iterator: 0 });
			expect(raw.state).toBe(container);
			if (path === "fromHash") expect(states.getDRPState(hash)).toBe(raw);
		}
	);

	it.each([
		["fromHash", "length"],
		["fromHash", "index"],
		["fromStates", "length"],
		["fromStates", "index"],
	] as const)(
		"preserves the primary %s reconstruction proxy %s throwable without mutating its source snapshot",
		(path, kind: "length" | "index") => {
			const target = object();
			const states = manager(target);
			const hash = `raw-reconstruction-throwing-${path}-${kind}`;
			const sentinel = new Error(`raw reconstruction ${kind} sentinel`);
			const entries = new Proxy([entry("left", { marker: "source" })], {
				get(source, property, receiver): unknown {
					if (property === "length" && kind === "length") throw sentinel;
					if (property === "0" && kind === "index") throw sentinel;
					return Reflect.get(source, property, receiver);
				},
			});
			const raw = snapshot(entries);
			const stableACL = snapshot([entry("stable", { marker: "acl" })]);
			let thrown: unknown;
			try {
				reconstruct(path, states, hash, raw, stableACL);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBe(sentinel);
			expect(raw.state).toBe(entries);
			if (path === "fromHash") expect(states.getDRPState(hash)).toBe(raw);
		}
	);
});
