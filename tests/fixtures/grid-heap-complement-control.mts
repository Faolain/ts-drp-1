import assert from "node:assert/strict";

import { complementLedger, type ConstructorGroup, type HeapNode, signedLedger } from "./grid-heap-complement.mts";
interface Fixture {
	nodes: HeapNode[];
	getNodeById(id: number): HeapNode | undefined;
}
function requiredNode(heap: Fixture, id: number): HeapNode {
	const node = heap.getNodeById(id);
	assert.ok(node, `missing fixture node ${id}`);
	return node;
}
function fixture(): Fixture {
	const node = (id: number, size: number, parent: HeapNode | null, name = "Object"): HeapNode => ({
		id,
		self_size: size,
		dominatorNode: parent,
		name,
		type: "object",
	});
	const root = node(1, 0, null, "root"),
		a = node(2, 8, root, "Database"),
		b = node(3, 8, root, "Database");
	const ac = node(4, 16, a),
		native = node(5, 32, ac),
		bc = node(6, 16, b),
		shared = node(7, 64, root);
	const foreign = node(8, 8, root, "Database"),
		fc = node(9, 16, foreign),
		zero = node(10, 0, root);
	const nodes = [root, a, b, ac, native, bc, shared, foreign, fc, zero];
	return { nodes, getNodeById: (id) => nodes.find((n) => n.id === id) };
}
for (const order of ["forward", "reverse", "children-first"]) {
	const h = fixture();
	if (order === "reverse") h.nodes.reverse();
	if (order === "children-first") h.nodes.sort((a, b) => b.id - a.id);
	const r = complementLedger(h, [2, 3]);
	assert.equal(r.graphBytes, 168);
	assert.equal(r.databaseBytes, 80);
	assert.equal(r.complementBytes, 88);
	assert.deepEqual(
		r.rows.map((x) => x[0]).sort((a, b) => a - b),
		[1, 7, 8, 9, 10]
	);
}
for (const ids of [[2, 2], [99], [4], [2, 4]]) assert.throws(() => complementLedger(fixture(), ids));
const nested = fixture();
requiredNode(nested, 4).name = "Database";
assert.throws(() => complementLedger(nested, [2, 4]), /nested anchors/u);
for (const mode of ["self", "cycle", "dangling"]) {
	const h = fixture(),
		n = requiredNode(h, 7);
	n.dominatorNode = mode === "self" ? n : mode === "dangling" ? { ...n, id: 99 } : requiredNode(h, 9);
	if (mode === "cycle") requiredNode(h, 9).dominatorNode = n;
	assert.throws(() => complementLedger(h, [2, 3]));
}
const selfRoot = fixture();
requiredNode(selfRoot, 1).dominatorNode = requiredNode(selfRoot, 1);
assert.equal(complementLedger(selfRoot, [2, 3]).complementBytes, 88);
const g = (key: string, bytes: number): ConstructorGroup => ({ key, count: 1, shallowBytes: bytes });
const delta = signedLedger(
	[g("up", 1), g("down", 9), g("gone", 4), g("same", 2)],
	[g("up", 7), g("down", 3), g("new", 5), g("same", 2)]
);
assert.equal(
	delta.reduce((sum, row) => sum + row.deltaBytes, 0),
	1
);
assert.equal(delta.find((row) => row.key === "gone")?.deltaBytes, -4);
assert.equal(delta.find((row) => row.key === "same")?.deltaBytes, 0);
process.stdout.write(
	"complement controls PASS: conservation, sharing, traversal order, invalid anchors/dominators, signed deltas\n"
);
