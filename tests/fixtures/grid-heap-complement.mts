import assert from "node:assert/strict";

export interface HeapNode {
	id: number;
	self_size: number;
	dominatorNode: HeapNode | null | undefined;
	name: string;
	type: string;
}
export interface HeapGraph {
	nodes: { forEach(callback: (node: HeapNode) => void): void };
	getNodeById(id: number): HeapNode | null | undefined;
}
export interface ConstructorGroup {
	key: string;
	count: number;
	shallowBytes: number;
}
export interface ComplementLedger {
	graphBytes: number;
	databaseBytes: number;
	complementBytes: number;
	byConstructor: ConstructorGroup[];
	rows: [number, string, number][];
}
export interface SignedGroup {
	key: string;
	deltaCount: number;
	deltaBytes: number;
}

/** Enumerate dominator membership, not arbitrary reachability; used offline only. */
export function complementLedger(heap: HeapGraph, anchorIds: readonly number[]): ComplementLedger {
	assert.equal(new Set(anchorIds).size, anchorIds.length, "duplicate anchors");
	const anchors = new Set(anchorIds),
		memo = new Map<number, number | null>();
	function ancestry(node: HeapNode): number | null {
		const chain: HeapNode[] = [],
			visited = new Set<number>();
		let cursor: HeapNode | null | undefined = node;
		while (cursor && !memo.has(cursor.id)) {
			assert.equal(heap.getNodeById(cursor.id)?.id, cursor.id, "dangling dominator");
			assert.ok(!visited.has(cursor.id), "dominator cycle");
			visited.add(cursor.id);
			chain.push(cursor);
			const parent: HeapNode | null | undefined = cursor.dominatorNode;
			if (parent?.id === cursor.id) {
				assert.equal(cursor.id, 1, "non-root self dominator");
				cursor = null;
			} else cursor = parent;
		}
		let owner = cursor ? memo.get(cursor.id) : null;
		assert.notEqual(owner, undefined, "missing memoized dominator");
		assert.ok(owner !== undefined);
		for (const item of chain.reverse()) {
			if (anchors.has(item.id)) {
				assert.equal(owner, null, "nested anchors");
				owner = item.id;
			}
			memo.set(item.id, owner);
		}
		const result = memo.get(node.id);
		assert.ok(result !== undefined, "missing ancestry result");
		return result;
	}
	for (const id of anchors) {
		const node = heap.getNodeById(id);
		assert.ok(node && node.type === "object" && node.name === "Database", "invalid database anchor");
		ancestry(node);
	}
	const groups = new Map<string, ConstructorGroup>(),
		rows: [number, string, number][] = [];
	let graphBytes = 0,
		databaseBytes = 0,
		complementBytes = 0;
	heap.nodes.forEach((node) => {
		assert.ok(Number.isSafeInteger(node.self_size) && node.self_size >= 0);
		graphBytes += node.self_size;
		if (ancestry(node) !== null) {
			databaseBytes += node.self_size;
			return;
		}
		complementBytes += node.self_size;
		const name = ["string", "concatenated string", "sliced string", "code"].includes(node.type)
			? `(${node.type})`
			: node.name;
		const key = `${node.type}:${name}`;
		const group = groups.get(key) ?? { key, count: 0, shallowBytes: 0 };
		group.count++;
		group.shallowBytes += node.self_size;
		groups.set(key, group);
		rows.push([node.id, key, node.self_size]);
	});
	assert.equal(databaseBytes + complementBytes, graphBytes);
	return { graphBytes, databaseBytes, complementBytes, byConstructor: [...groups.values()], rows };
}

export function signedLedger(before: readonly ConstructorGroup[], after: readonly ConstructorGroup[]): SignedGroup[] {
	const a = new Map(before.map((row) => [row.key, row]));
	const b = new Map(after.map((row) => [row.key, row]));
	return [...new Set([...a.keys(), ...b.keys()])]
		.map((key) => ({
			key,
			deltaCount: (b.get(key)?.count ?? 0) - (a.get(key)?.count ?? 0),
			deltaBytes: (b.get(key)?.shallowBytes ?? 0) - (a.get(key)?.shallowBytes ?? 0),
		}))
		.sort((x, y) => y.deltaBytes - x.deltaBytes);
}
