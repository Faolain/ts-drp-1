import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [file] = process.argv.slice(2);
assert.ok(file);
const analysis = JSON.parse(readFileSync(file, "utf8"));
const group = (name) => analysis.constructors.find((row) => row.key === `object:${name}`);
const nodes = (name) => analysis.selected.filter((row) => row.type === "object" && row.name === name);
assert.equal(group("GridExclusiveOwner").count, 1);
assert.equal(group("GridSharedOwner").count, 2);
for (const name of ["GridReleasedOwner", "GridDeadKey", "GridDeadEphemeronValue"]) assert.equal(group(name), undefined);
assert.ok(group("GridExclusiveOwner").maxRetainedSize >= 128 * 1024);
assert.ok(group("GridSharedOwner").maxRetainedSize < 256 * 1024);
const shared = nodes("GridSharedOwner");
assert.equal(shared.length, 2, "select small shared owners explicitly");
const payloadId = (node) => node.properties.find((property) => property.name === "payload").target.id;
assert.equal(payloadId(shared[0]), payloadId(shared[1]), "the physical shared payload is the same graph node");
for (const name of ["GridExclusiveOwner", "GridSharedOwner", "GridLiveWeakTarget", "GridEphemeronValue"]) {
	const selected = nodes(name);
	assert.ok(selected.length > 0, name);
	for (const node of selected) {
		assert.equal(node.retainingPath.terminal, "synthetic-root");
		assert.ok(node.retainingPath.path.some((step) => step.incoming?.name === "gridHeapControl"));
		assert.ok(node.retainingPath.path.every((step) => step.incoming?.type !== "weak"));
	}
}
assert.equal(group("GridLiveKey").count, 1);
assert.equal(group("GridEphemeronValue").count, 1);
assert.ok(nodes("GridLiveWeakTarget")[0].retainingPath.path.some((step) => step.incoming?.name === "liveWeakTarget"));
console.log(
	"PASS: exclusive/shared retained sizes, physical shared identity, weak live/dead roots, live/dead-key ephemerons"
);
