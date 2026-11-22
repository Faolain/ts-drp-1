// Offline only: pinned MemLab is installed outside the workload/project.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [dependencyRoot, snapshotPath, outputPath, ...requestedIds] = process.argv.slice(2);
assert.ok(
	dependencyRoot && snapshotPath && outputPath,
	"usage: node grid-heap-analyze.mjs <isolated dependency root> <snapshot> <exclusive output.json> [node ids]"
);
const require = createRequire(resolve(dependencyRoot, "package.json"));
const { getFullHeapFromFile } = require("@memlab/heap-analysis");
const packageIdentity = require("@memlab/heap-analysis/package.json");
assert.equal(packageIdentity.version, "2.0.5");
const hash = createHash("sha256");
for await (const chunk of createReadStream(snapshotPath)) hash.update(chunk);
const snapshotHash = hash.digest("hex");
const started = performance.now();
const heap = await getFullHeapFromFile(snapshotPath);

function facts(node) {
	return {
		id: node.id,
		index: node.nodeIndex,
		type: node.type,
		name: node.name.slice(0, 240),
		shallowSize: node.self_size,
		retainedSize: node.retainedSize,
	};
}

function pathToRoot(node) {
	const path = [];
	const visited = new Set();
	while (node && !visited.has(node.id) && path.length < 100) {
		visited.add(node.id);
		const edge = node.pathEdge;
		path.push({
			...facts(node),
			incoming: edge ? { name: String(edge.name_or_index).slice(0, 240), type: edge.type } : null,
		});
		if (!edge) return { path, terminal: node.type === "synthetic" ? "synthetic-root" : "no-path-edge" };
		if (edge.type === "weak") return { path, terminal: "unproven-weak-edge" };
		node = edge.fromNode;
	}
	return { path, terminal: path.length >= 100 ? "truncated" : "cycle" };
}

function details(node) {
	const dominators = [];
	const visited = new Set([node.id]);
	let dominator = node.dominatorNode;
	while (dominator && !visited.has(dominator.id) && dominators.length < 60) {
		dominators.push(facts(dominator));
		visited.add(dominator.id);
		dominator = dominator.dominatorNode;
	}
	const properties = node.references
		.filter((edge) => edge.type === "property" || edge.type === "context")
		.slice(0, 30)
		.map((edge) => ({ name: String(edge.name_or_index), target: facts(edge.toNode) }));
	return { ...facts(node), properties, retainingPath: pathToRoot(node), dominators };
}

const constructors = new Map();
const largest = [];
let shallowTotal = 0;
heap.nodes.forEach((node) => {
	shallowTotal += node.self_size;
	const name = ["string", "concatenated string", "sliced string", "code"].includes(node.type)
		? `(${node.type})`
		: node.name;
	const key = `${node.type}:${name}`;
	let group = constructors.get(key);
	if (!group) {
		group = { key, count: 0, shallowSize: 0, maxRetainedSize: 0, representativeIds: [] };
		constructors.set(key, group);
	}
	group.count += 1;
	group.shallowSize += node.self_size;
	group.maxRetainedSize = Math.max(group.maxRetainedSize, node.retainedSize);
	if (group.representativeIds.length < 3) group.representativeIds.push(node.id);
	if (node.type !== "synthetic" && node.retainedSize >= 65536) {
		largest.push(facts(node));
		if (largest.length > 400) {
			largest.sort((a, b) => b.retainedSize - a.retainedSize);
			largest.length = 200;
		}
	}
});
largest.sort((a, b) => b.retainedSize - a.retainedSize);
largest.length = Math.min(largest.length, 200);
const classSelectors = new Set(
	requestedIds.filter((value) => value.startsWith("class:")).map((value) => value.slice(6))
);
const selectedIds = new Set([
	...largest.map((node) => node.id),
	...requestedIds.filter((value) => !value.startsWith("class:")).map(Number),
]);
heap.nodes.forEach((node) => {
	if (classSelectors.has(`${node.type}:${node.name}`)) selectedIds.add(node.id);
});
const selected = [...selectedIds].map((id) => {
	const node = heap.getNodeById(id);
	assert.ok(node, `missing selected node ${id}`);
	return details(node);
});
const output = {
	snapshotPath: resolve(snapshotPath),
	snapshotHash,
	analyzer: {
		name: "@memlab/heap-analysis",
		version: packageIdentity.version,
		dependencyLockHash: createHash("sha256")
			.update(readFileSync(resolve(dependencyRoot, "package-lock.json")))
			.digest("hex"),
	},
	nodeCount: heap.nodes.length,
	edgeCount: heap.edges.length,
	shallowTotal,
	semantics:
		"MemLab processed graph; counts/shallow sizes aggregate, retained sizes are individual overlapping dominators and MUST NOT be summed. Paths are representative, not exhaustive.",
	constructors: [...constructors.values()].sort((a, b) => b.shallowSize - a.shallowSize),
	selected,
	elapsedMs: performance.now() - started,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
console.log(
	JSON.stringify({ outputPath, snapshotHash, nodeCount: heap.nodes.length, shallowTotal, elapsedMs: output.elapsedMs })
);
