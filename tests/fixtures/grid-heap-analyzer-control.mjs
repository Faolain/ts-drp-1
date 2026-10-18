// Deliberately tiny, independent process: validates attribution on known ownership.
import assert from "node:assert/strict";
import { getHeapSnapshot } from "node:v8";
import { createWriteStream } from "node:fs";

const [path] = process.argv.slice(2);
assert.ok(path && globalThis.gc);
class GridExclusiveOwner {
	constructor() {
		this.payload = new Uint8Array(128 * 1024);
	}
}
class GridSharedOwner {
	constructor(payload) {
		this.payload = payload;
	}
}
class GridReleasedOwner {
	constructor() {
		this.payload = new Uint8Array(64 * 1024);
	}
}
class GridLiveWeakTarget {
	constructor() {
		this.payload = new Uint8Array(32 * 1024);
	}
}
class GridLiveKey {}
class GridDeadKey {}
class GridEphemeronValue {
	constructor() {
		this.payload = new Uint8Array(64 * 1024);
	}
}
class GridDeadEphemeronValue {
	constructor(key) {
		this.key = key;
		this.payload = new Uint8Array(64 * 1024);
	}
}
globalThis.gridHeapControl = {
	exclusive: new GridExclusiveOwner(),
	shared: (() => {
		const bytes = new Uint8Array(256 * 1024);
		return [new GridSharedOwner(bytes), new GridSharedOwner(bytes)];
	})(),
	...(() => {
		const liveWeakTarget = new GridLiveWeakTarget();
		const liveKey = new GridLiveKey();
		const weakMap = new WeakMap([[liveKey, new GridEphemeronValue()]]);
		const deadKey = new GridDeadKey();
		weakMap.set(deadKey, new GridDeadEphemeronValue(deadKey));
		return { liveWeakTarget, liveWeakRef: new WeakRef(liveWeakTarget), liveKey, weakMap };
	})(),
	weak: (() => {
		const released = new GridReleasedOwner();
		return new WeakRef(released);
	})(),
};
for (let turn = 0; turn < 3; turn++) {
	await new Promise((resolve) => setImmediate(resolve));
	globalThis.gc();
}
await new Promise((resolve, reject) => {
	const source = getHeapSnapshot();
	const destination = createWriteStream(path, { flags: "wx" });
	source.once("error", reject);
	destination.once("error", reject);
	destination.once("close", resolve);
	source.pipe(destination);
});
