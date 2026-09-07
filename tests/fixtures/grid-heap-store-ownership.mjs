// Offline ownership partition. No workload imports or project runtime dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const property = (node, name) => node?.getReferenceNode(name, "property");
const scalar = (node) => (node?.isString ? node.toStringNode().stringValue : null);
const isObject = (node, name) => node?.type === "object" && node.name === name;

function rootPath(node) {
	const path = [];
	const seen = new Set();
	while (node && !seen.has(node.id) && path.length < 200) {
		seen.add(node.id);
		const edge = node.pathEdge;
		path.push({
			nodeId: node.id,
			type: node.type,
			name: node.name.slice(0, 160),
			incoming: edge ? String(edge.name_or_index) : null,
			incomingType: edge?.type ?? null,
		});
		if (!edge) return { path, terminal: node.type === "synthetic" ? "synthetic-root" : "unproven" };
		assert.notEqual(edge.type, "weak");
		node = edge.fromNode;
	}
	return { path, terminal: "truncated-or-cycle" };
}

// V8's strong Map table exposes adjacent key/value slots as numbered internal
// edges. Require a string key immediately before the candidate value; never
// traverse arbitrary descendants or infer membership from constructor/name alone.
function mapMembers(map, constructor, gaps, ownerNodeId) {
	const table = map?.getReferenceNode("table", "internal");
	if (!isObject(map, "Map") || table?.type !== "array") {
		gaps.push({ reason: "unsupported-or-missing-map-table", ownerNodeId });
		return [];
	}
	const slots = new Map(
		table.references
			.filter((edge) => edge.type === "internal" && /^\d+$/.test(String(edge.name_or_index)))
			.map((edge) => [Number(edge.name_or_index), edge.toNode])
	);
	const members = [];
	for (const [slot, node] of slots) {
		if (!isObject(node, constructor)) continue;
		const key = scalar(slots.get(slot - 1));
		if (key === null || key !== scalar(property(node, "name"))) {
			gaps.push({ reason: "map-key-name-not-proven", ownerNodeId, candidateNodeId: node.id });
			continue;
		}
		members.push({ node, key, mapNodeId: map.id, tableNodeId: table.id, keySlot: slot - 1, valueSlot: slot });
	}
	return members;
}

// Keep only uniquely owned, non-overlapping anchors. If an ancestor contains
// another requested anchor, omit the ancestor (do not subtract descendants).
export function disjointAnchors(candidates, gaps) {
	const byId = new Map();
	for (const candidate of candidates) {
		const list = byId.get(candidate.node.id) ?? [];
		list.push(candidate);
		byId.set(candidate.node.id, list);
	}
	const excluded = new Set();
	for (const [id, list] of byId) {
		if (list.length !== 1) {
			excluded.add(id);
			gaps.push({ reason: "anchor-has-multiple-owner-claims", anchorNodeId: id, claims: list.length });
		}
		const seen = new Set([id]);
		let ancestor = list[0].node.dominatorNode;
		while (ancestor && !seen.has(ancestor.id)) {
			seen.add(ancestor.id);
			if (byId.has(ancestor.id)) {
				excluded.add(ancestor.id);
				gaps.push({
					reason: "overlapping-ancestor-anchor-omitted",
					anchorNodeId: ancestor.id,
					descendantAnchorNodeId: id,
				});
			}
			ancestor = ancestor.dominatorNode;
		}
	}
	return candidates.filter(({ node }) => !excluded.has(node.id));
}

export function partition(heap, factoryIds) {
	assert.ok(
		factoryIds.length && new Set(factoryIds).size === factoryIds.length,
		"explicit unique current factory IDs required"
	);
	const gaps = [];
	const factories = [];
	const currentDatabases = new Set();
	const currentStores = new Set();
	const candidates = [];
	for (const id of factoryIds) {
		const factory = heap.getNodeById(id);
		assert.ok(isObject(factory, "FDBFactory"), `not an FDBFactory instance: ${id}`);
		factories.push({
			nodeId: id,
			currentSelection: "caller-selected; validate this root path against the worker's current indexedDB binding",
			retainingPath: rootPath(factory),
			indexedDBReferrers: factory.referrers
				.filter((edge) => edge.type === "property" && edge.name_or_index === "indexedDB")
				.map((edge) => ({ nodeId: edge.fromNode.id, name: edge.fromNode.name, type: edge.fromNode.type })),
		});
		for (const db of mapMembers(property(factory, "_databases"), "Database", gaps, id)) {
			currentDatabases.add(db.node.id);
			for (const store of mapMembers(property(db.node, "rawObjectStores"), "ObjectStore", gaps, db.node.id)) {
				if (property(store.node, "rawDatabase")?.id !== db.node.id) {
					gaps.push({
						reason: "rawDatabase-backlink-mismatch",
						storeNodeId: store.node.id,
						databaseNodeId: db.node.id,
					});
					continue;
				}
				currentStores.add(store.node.id);
				const proof = {
					factoryNodeId: id,
					databaseNodeId: db.node.id,
					databaseMapNodeId: db.mapNodeId,
					databaseTableNodeId: db.tableNodeId,
					databaseKeySlot: db.keySlot,
					databaseValueSlot: db.valueSlot,
					storeNodeId: store.node.id,
					storeMapNodeId: store.mapNodeId,
					storeTableNodeId: store.tableNodeId,
					storeKeySlot: store.keySlot,
					storeValueSlot: store.valueSlot,
					rawDatabaseBacklinkNodeId: db.node.id,
				};
				for (const [kind, expectedClass] of [
					["records", "RecordStore"],
					["rawIndexes", "Map"],
				]) {
					const node = property(store.node, kind);
					if (!isObject(node, expectedClass))
						gaps.push({ reason: "missing-or-unsupported-store-anchor", storeNodeId: store.node.id, kind });
					else candidates.push({ node, database: db.key, store: store.key, kind, proof });
				}
			}
		}
	}
	const rows = disjointAnchors(candidates, gaps).map(({ node, ...row }) => ({
		...row,
		anchorNodeId: node.id,
		shallowSize: node.self_size,
		retainedSize: node.retainedSize,
		retainingPath: rootPath(node),
	}));
	const unclassified = [];
	let graphShallowBytes = 0;
	heap.nodes.forEach((node) => {
		graphShallowBytes += node.self_size;
		if (
			(isObject(node, "Database") && !currentDatabases.has(node.id)) ||
			(isObject(node, "ObjectStore") && !currentStores.has(node.id))
		) {
			unclassified.push({
				nodeId: node.id,
				constructor: node.name,
				name: scalar(property(node, "name")),
				shallowSize: node.self_size,
				reason: "not-proven-current-map-member; possibly retired, foreign-factory, or unsupported graph",
			});
		}
	});
	const attributedGraphBytes = rows.reduce((sum, row) => sum + row.retainedSize, 0);
	assert.ok(attributedGraphBytes <= graphShallowBytes, "disjoint retained bytes exceed snapshot graph");
	return {
		factories,
		currentDatabaseCount: currentDatabases.size,
		currentStoreCount: currentStores.size,
		rows,
		gaps,
		unclassified,
		graphShallowBytes,
		attributedGraphBytes,
		unclassifiedGraphBytes: graphShallowBytes - attributedGraphBytes,
		semantics:
			"Sum of disjoint MemLab dominator subtrees rooted at current raw-store records and rawIndexes. Includes native data represented by snapshot; not process heap, external-memory correction, or serialized-byte subtraction. Shared payloads not dominated by these anchors, store/database metadata, retired handles, other factories and all other graph nodes remain unclassified. Current membership is relative to explicitly selected factories; constructor names alone prove no lifetime contract.",
	};
}

async function main() {
	const [dependencyRoot, snapshotPath, outputPath, ...ids] = process.argv.slice(2);
	assert.ok(
		dependencyRoot && snapshotPath && outputPath && ids.length,
		"usage: node grid-heap-store-ownership.mjs <isolated MemLab root> <snapshot> <exclusive output.json> <current factory node IDs...>"
	);
	const require = createRequire(resolve(dependencyRoot, "package.json"));
	const identity = require("@memlab/heap-analysis/package.json");
	assert.equal(identity.version, "2.0.5");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(snapshotPath)) hash.update(chunk);
	const heap = await require("@memlab/heap-analysis").getFullHeapFromFile(snapshotPath);
	const output = {
		snapshotPath: resolve(snapshotPath),
		snapshotHash: hash.digest("hex"),
		analyzer: {
			name: identity.name,
			version: identity.version,
			dependencyLockHash: createHash("sha256")
				.update(readFileSync(resolve(dependencyRoot, "package-lock.json")))
				.digest("hex"),
		},
		...partition(heap, ids.map(Number)),
	};
	writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
	console.log(
		JSON.stringify({
			outputPath,
			rows: output.rows.length,
			attributedGraphBytes: output.attributedGraphBytes,
			gaps: output.gaps.length,
		})
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
