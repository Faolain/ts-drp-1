// Tiny offline graph control, not the grid workload or an IndexedDB lifecycle test.
// Usage: node grid-heap-store-ownership-control.mjs <isolated MemLab root> <fake-indexeddb build/esm root>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapSnapshot } from "node:v8";
import { disjointAnchors, partition } from "./grid-heap-store-ownership.mjs";

const [modeOrDependencyRoot, sourceRoot, capturePath] = process.argv.slice(2);
assert.ok(modeOrDependencyRoot && sourceRoot, "provide isolated MemLab root and fake-indexeddb build/esm root");

if (modeOrDependencyRoot === "--capture") {
	assert.ok(globalThis.gc && capturePath);
	const load = async (file) => (await import(pathToFileURL(resolve(sourceRoot, file)).href)).default;
	const FDBFactory = await load("FDBFactory.js");
	const Database = await load("lib/Database.js");
	const ObjectStore = await load("lib/ObjectStore.js");
	globalThis.indexedDB = new FDBFactory();
	// Return from the allocation frame before GC so locals do not create owners.
	(() => {
		const db = new Database("ownership-control", 1);
		indexedDB._databases.set(db.name, db);
		const alpha = new ObjectStore(db, "alpha", null, false);
		const beta = new ObjectStore(db, "beta", null, false);
		db.rawObjectStores.set(alpha.name, alpha);
		db.rawObjectStores.set(beta.name, beta);
		alpha.records.exclusive = new Uint8Array(131072);
		beta.rawIndexes.set("index", { payload: new Uint8Array(65536) });
		const shared = new Uint8Array(262144);
		alpha.records.shared = shared;
		beta.records.shared = shared;
		// Same scalar names are deliberately insufficient to establish membership.
		globalThis.retiredStore = new ObjectStore(db, "alpha", null, false);
		globalThis.retiredDb = new Database("ownership-control", 1);
		const retired = new ObjectStore(retiredDb, "alpha", null, false);
		retiredDb.rawObjectStores.set(retired.name, retired);
	})();
	for (let turn = 0; turn < 3; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
		globalThis.gc();
	}
	await new Promise((resolve, reject) => {
		const source = getHeapSnapshot();
		const destination = createWriteStream(capturePath, { flags: "wx" });
		source.once("error", reject);
		destination.once("error", reject);
		destination.once("close", resolve);
		source.pipe(destination);
	});
} else {
	const outputDirectory = mkdtempSync(join(tmpdir(), "grid-store-ownership-control-"));
	const snapshotPath = join(outputDirectory, "control.heapsnapshot");
	const child = spawnSync(
		process.execPath,
		["--expose-gc", fileURLToPath(import.meta.url), "--capture", resolve(sourceRoot), snapshotPath],
		{ encoding: "utf8", timeout: 60000 }
	);
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	const require = createRequire(resolve(modeOrDependencyRoot, "package.json"));
	assert.equal(require("@memlab/heap-analysis/package.json").version, "2.0.5");
	const heap = await require("@memlab/heap-analysis").getFullHeapFromFile(snapshotPath);
	const factoryIds = new Set();
	heap.nodes.forEach((node) => {
		const edge = node.getReference("indexedDB", "property");
		if (edge?.toNode.type === "object" && edge.toNode.name === "FDBFactory") factoryIds.add(edge.toNode.id);
	});
	assert.equal(factoryIds.size, 1, "control has exactly one strongly indexedDB-bound factory");
	const result = partition(heap, [...factoryIds]);
	assert.equal(result.currentDatabaseCount, 1);
	assert.equal(result.currentStoreCount, 2);
	assert.equal(result.rows.length, 4);
	assert.equal(result.gaps.length, 0);
	assert.equal(
		result.unclassified.filter((node) => node.constructor === "Database" && node.name === "ownership-control").length,
		1
	);
	assert.equal(
		result.unclassified.filter((node) => node.constructor === "ObjectStore" && node.name === "alpha").length,
		2
	);
	const alpha = result.rows.find((row) => row.store === "alpha" && row.kind === "records");
	const beta = result.rows.find((row) => row.store === "beta" && row.kind === "rawIndexes");
	assert.ok(
		alpha.retainedSize >= 131072 && alpha.retainedSize < 262144,
		"exclusive native payload counted, shared payload not charged to alpha"
	);
	assert.ok(beta.retainedSize >= 65536 && beta.retainedSize < 131072, "index native payload counted");
	const betaRecords = result.rows.find((row) => row.store === "beta" && row.kind === "records");
	assert.ok(betaRecords.retainedSize < 262144, "shared payload not charged to beta");
	for (const row of result.rows) {
		assert.equal(row.proof.rawDatabaseBacklinkNodeId, row.proof.databaseNodeId);
		assert.equal(row.retainingPath.terminal, "synthetic-root");
		assert.ok(row.retainingPath.path.every((step) => step.incomingType !== "weak"));
	}
	const root = { id: 0, dominatorNode: null };
	const outer = { id: 1, dominatorNode: root };
	const inner = { id: 2, dominatorNode: outer };
	const gaps = [];
	assert.deepEqual(
		disjointAnchors([{ node: outer }, { node: inner }], gaps).map(({ node }) => node.id),
		[2]
	);
	assert.equal(gaps[0].reason, "overlapping-ancestor-anchor-omitted");
	const duplicateGaps = [];
	assert.deepEqual(disjointAnchors([{ node: inner }, { node: inner }], duplicateGaps), []);
	assert.equal(duplicateGaps[0].reason, "anchor-has-multiple-owner-claims");
	const cliPath = join(outputDirectory, "partition.json");
	const cli = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("./grid-heap-store-ownership.mjs", import.meta.url)),
			resolve(modeOrDependencyRoot),
			snapshotPath,
			cliPath,
			...[...factoryIds].map(String),
		],
		{ encoding: "utf8", timeout: 60000 }
	);
	assert.ifError(cli.error);
	assert.equal(cli.status, 0, cli.stderr);
	const verification = {
		status: "passed",
		nodeVersion: process.version,
		snapshotPath,
		partitionPath: cliPath,
		factoryNodeIds: [...factoryIds],
		currentDatabaseCount: result.currentDatabaseCount,
		currentStoreCount: result.currentStoreCount,
		rows: result.rows.map(({ database, store, kind, anchorNodeId, retainedSize }) => ({
			database,
			store,
			kind,
			anchorNodeId,
			retainedSize,
		})),
		checks: [
			"current-vs-retired-map-membership",
			"native-exclusive-payload",
			"shared-payload-excluded",
			"strong-root-paths",
			"overlap-filter",
			"duplicate-owner-filter",
			"standalone-cli",
		],
		attributedGraphBytes: result.attributedGraphBytes,
	};
	writeFileSync(join(outputDirectory, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, {
		flag: "wx",
	});
	console.log(JSON.stringify(verification, null, 2));
}
