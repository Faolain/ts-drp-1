// The Grid zone projection continues its previous fold when the new projection only appends frozen
// accepted-operation records to the same base. Every result must equal a fresh application's full
// fold of the same input: appends, reorders, repeats, equal-but-distinct records, unfrozen records,
// a changed or removed base, and a refused operation in between.
import { expect, it } from "vitest";

import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";

const creator = "a".repeat(64);
const peer = "peer:creator";
type App = ReturnType<typeof createV3ZoneApplication>;
type Accepted = Parameters<App["projectAcceptedOperations"]>[0]["currentEpochOperations"][number];
type Base = Parameters<App["projectAcceptedOperations"]>[0]["authenticatedBase"];

const app = (): App => createV3ZoneApplication([{ author: creator, peerId: peer, order: 0 }], peer, creator);

function accepted(operation: Readonly<Record<string, unknown>>, sequence: number, frozen = true): Accepted {
	const record = {
		author: creator,
		authorSequence: sequence,
		logicalTime: sequence,
		operation: frozen ? Object.freeze({ ...operation }) : { ...operation },
		operationCount: 1,
		operationIndex: 0,
		vertexDigest: sequence.toString(16).padStart(64, "0"),
	};
	return (frozen ? Object.freeze(record) : record) as Accepted;
}
const place = (sequence: number, x = sequence): Accepted =>
	accepted({ action: "placeBlock", id: `b-${sequence % 5}`, kind: "stone", x, y: 1 }, sequence);

function fresh(operations: readonly Accepted[], base?: Base): unknown {
	return app().projectAcceptedOperations({ authenticatedBase: base, currentEpochOperations: operations });
}

it("appending, repeating, reordering and replacing records always equals a fresh full fold", () => {
	const subject = app();
	const project = (operations: readonly Accepted[], base?: Base): unknown =>
		subject.projectAcceptedOperations({ authenticatedBase: base, currentEpochOperations: operations });
	const bootstrap = accepted(subject.bootstrapOperation, 0);
	let operations: Accepted[] = [bootstrap];
	expect(project(operations)).toEqual(fresh(operations));
	for (let sequence = 1; sequence <= 24; sequence++) {
		operations = [...operations, place(sequence)];
		expect(project(operations)).toEqual(fresh(operations));
	}
	// The same list again, then an equal-content list of distinct records.
	expect(project(operations)).toEqual(fresh(operations));
	const copies = operations.map((record) => Object.freeze({ ...record }) as Accepted);
	expect(project(copies)).toEqual(fresh(copies));
	// An earlier insertion (not an append): last-writer order changes the blocks.
	const reordered = [bootstrap, place(30, 99), ...operations.slice(1)];
	expect(project(reordered)).toEqual(fresh(reordered));
	expect(project(reordered)).not.toEqual(project(operations));
	// A shorter list (a prefix of the last one) and the longer one again.
	expect(project(operations.slice(0, 5))).toEqual(fresh(operations.slice(0, 5)));
	expect(project(operations)).toEqual(fresh(operations));
});

it("unfrozen records are never continued, and a refused operation leaves no fold behind", () => {
	const subject = app();
	const project = (operations: readonly Accepted[]): unknown =>
		subject.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: operations });
	const bootstrap = accepted(subject.bootstrapOperation, 0);
	const loose = accepted({ action: "placeBlock", id: "loose", kind: "stone", x: 1, y: 1 }, 1, false);
	const first = [bootstrap, loose];
	expect(project(first)).toEqual(fresh(first));
	// Mutating the unfrozen record changes the full fold; the projection must follow it.
	(loose.operation as Record<string, unknown>).x = 7;
	const next = [...first, place(2)];
	expect(project(next)).toEqual(fresh(next));
	const refused = [...next, accepted({ action: "unknown-action" }, 3)];
	expect(() => project(refused)).toThrow();
	const after = [...next, place(4)];
	expect(project(after)).toEqual(fresh(after));
});

it("a changed, added or removed authenticated base always folds from that base", () => {
	const subject = app();
	const project = (operations: readonly Accepted[], base?: Base): unknown =>
		subject.projectAcceptedOperations({ authenticatedBase: base, currentEpochOperations: operations });
	const bootstrap = accepted(subject.bootstrapOperation, 0);
	const seed = [bootstrap, place(1), place(2)];
	const baseFor = (operations: readonly Accepted[]): Base => {
		const projection = fresh(operations) as Parameters<NonNullable<App["migration"]>["canonicalStateBytes"]>[0];
		return Object.freeze({
			blueprintDigest: "0".repeat(64),
			epoch: 1,
			exactCanonicalApplicationStateBytes: subject.migration!.canonicalStateBytes(projection),
			objectId: "zone-continuation",
			stateDigest: "0".repeat(64),
		}) as Base;
	};
	const baseA = baseFor(seed);
	const baseB = baseFor([...seed, place(3, 42)]);
	const tail = [place(5), place(6)];
	expect(project(tail, baseA)).toEqual(fresh(tail, baseA));
	expect(project([...tail, place(7)], baseB)).toEqual(fresh([...tail, place(7)], baseB));
	expect(project([...tail, place(7), place(8)])).toEqual(fresh([...tail, place(7), place(8)]));
	// Same base bytes in a new array: equal content continues; a flipped byte never does.
	const copy = Object.freeze({ ...baseB!, exactCanonicalApplicationStateBytes: baseB!.exactCanonicalApplicationStateBytes.slice() }) as Base;
	expect(project([...tail, place(7), place(8)], copy)).toEqual(fresh([...tail, place(7), place(8)], baseB));
	expect(project([...tail, place(7), place(8), place(9)], baseA)).toEqual(fresh([...tail, place(7), place(8), place(9)], baseA));
});
