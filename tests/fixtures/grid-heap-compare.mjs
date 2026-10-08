import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const [output, ...inputs] = process.argv.slice(2);
assert.ok(output && inputs.length === 3, "expected exclusive output and analyses for transitions10/20/30");
const snapshots = inputs.map((file) => JSON.parse(readFileSync(file, "utf8")));
const classes = snapshots.map((snapshot) => new Map(snapshot.constructors.map((row) => [row.key, row])));
const keys = new Set(classes.flatMap((map) => [...map.keys()]));
const constructors = [...keys]
	.map((key) => {
		const rows = classes.map(
			(map) => map.get(key) ?? { count: 0, shallowSize: 0, maxRetainedSize: 0, representativeIds: [] }
		);
		const count = rows.map((row) => row.count);
		const shallowSize = rows.map((row) => row.shallowSize);
		return {
			key,
			count,
			shallowSize,
			maxIndividualRetainedSize: rows.map((row) => row.maxRetainedSize),
			countDeltas: [count[1] - count[0], count[2] - count[1]],
			shallowSizeDeltas: [shallowSize[1] - shallowSize[0], shallowSize[2] - shallowSize[1]],
			representativeIds: rows.map((row) => row.representativeIds),
		};
	})
	.sort((a, b) => b.shallowSizeDeltas[1] - a.shallowSizeDeltas[1]);
const earlier = new Map(snapshots[0].selected.map((node) => [node.id, node]));
const middle = new Map(snapshots[1].selected.map((node) => [node.id, node]));
const matchedSelectedOwners = snapshots[2].selected
	.flatMap((node) => {
		const a = earlier.get(node.id),
			b = middle.get(node.id);
		if (!a || !b || a.name !== node.name || b.name !== node.name || a.type !== node.type || b.type !== node.type)
			return [];
		const retained = [a.retainedSize, b.retainedSize, node.retainedSize];
		return [
			{
				id: node.id,
				name: node.name,
				type: node.type,
				retainedSizes: retained,
				retainedSizeDeltas: [retained[1] - retained[0], retained[2] - retained[1]],
				paths: [a.retainingPath, b.retainingPath, node.retainingPath],
				properties: node.properties,
			},
		];
	})
	.sort((a, b) => b.retainedSizeDeltas[1] - a.retainedSizeDeltas[1]);
writeFileSync(
	output,
	JSON.stringify(
		{
			inputs: snapshots.map((snapshot) => ({
				path: snapshot.snapshotPath,
				hash: snapshot.snapshotHash,
				graphShallowTotal: snapshot.shallowTotal,
				nodeCount: snapshot.nodeCount,
				edgeCount: snapshot.edgeCount,
			})),
			interpretation:
				"Constructor shallow-size deltas are additive graph-byte categories, not process heap corrections. Individual retained sizes overlap and MUST NOT be summed. Matched selected IDs are only candidates; verify root paths and lifecycle before attributing.",
			constructors,
			matchedSelectedOwners,
		},
		null,
		2
	) + "\n",
	{ flag: "wx" }
);
