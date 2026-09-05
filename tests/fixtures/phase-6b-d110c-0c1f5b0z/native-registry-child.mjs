/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native ESM child uses JavaScript runtime assertions. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const mode = process.argv[2];
const key = Symbol.for("@ts-drp/storage/ahe-reclamation-maintenance-v1");
const evidence = { root, mode, runtimes: {}, premises: [] };

function runtime(file) {
	const resolved = realpathSync(resolve(root, file));
	assert.ok(resolved.startsWith(`${root}/`));
	evidence.runtimes[file] = {
		path: resolved,
		sha256: createHash("sha256").update(readFileSync(resolved)).digest("hex"),
	};
	return pathToFileURL(resolved).href;
}

function report(token = null) {
	process.stdout.write(`${JSON.stringify({ token, completed: token === null, evidence })}\n`);
}

const maintenanceUrl = runtime("packages/storage/dist/src/maintenance.js");
assert.equal(Object.getOwnPropertyDescriptor(globalThis, key), undefined);
if (mode === "duplicate") {
	const backend = await import(runtime("packages/storage-node/dist/src/index.js"));
	const local = await import(runtime("packages/storage-node/dist/src/maintenance.js"));
	runtime("packages/storage-node/dist/src/internal/ahe-reclamation.js");
	const store = backend.createSqliteAheDurableStore({
		filename: join(mkdtempSync(join(tmpdir(), "f5b0z-native-")), "ahe.sqlite"),
	});
	try {
		const legacy = local.resolveNodeAheReclamationMaintenance(store);
		assert.ok(legacy);
		const objectId = `creator:${"a".repeat(32)}`;
		assert.deepEqual(await store.readHead(objectId), { ok: true, value: { kind: "none", objectId } });
		evidence.premises.push("genuine SQLite facade", "existing backend resolver", "ordinary read");
		const first = await import(`${maintenanceUrl}?f5b0z=first`);
		const second = await import(`${maintenanceUrl}?f5b0z=second`);
		assert.notEqual(first, second);
		evidence.premises.push("distinct native ESM namespaces sharing one global");
		if (first.aheReclamationMaintenanceForStore?.(store) !== legacy) {
			report("F5B0Z_NEUTRAL_MAINTENANCE_DISCOVERY_REQUIRED");
		} else {
			assert.equal(second.aheReclamationMaintenanceForStore(store), legacy);
			assert.equal(first.bindAheReclamationMaintenance(store, legacy), false);
			assert.equal(second.bindAheReclamationMaintenance(store, legacy), false);
			assert.equal(first.aheReclamationMaintenanceForStore(store), legacy);
			assert.equal(local.resolveNodeAheReclamationMaintenance(store), legacy);
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
			assert.equal(descriptor.enumerable, false);
			assert.equal(descriptor.configurable, false);
			assert.equal(descriptor.writable, false);
			assert.equal(Object.getPrototypeOf(descriptor.value), Object.prototype);
			assert.equal(Object.isFrozen(descriptor.value), true);
			assert.deepEqual(Reflect.ownKeys(descriptor.value).sort(), ["bind", "resolve"]);
			for (const name of ["bind", "resolve"]) {
				const property = Object.getOwnPropertyDescriptor(descriptor.value, name);
				assert.equal(typeof property.value, "function");
				assert.equal(property.get, undefined);
			}
			report();
		}
	} finally {
		await store.close();
	}
} else {
	assert.ok(["value", "accessor", "descriptor"].includes(mode));
	let accessorCalls = 0;
	const frozen = Object.freeze({ bind: () => false, resolve: () => undefined });
	const descriptor =
		mode === "accessor"
			? {
					configurable: false,
					enumerable: false,
					get: () => {
						accessorCalls += 1;
						throw new Error("REGISTRY_ACCESSOR_INVOKED");
					},
				}
			: {
					configurable: mode === "descriptor",
					enumerable: false,
					writable: mode === "descriptor",
					value: mode === "value" ? Object.freeze({ incompatible: true }) : frozen,
				};
	Object.defineProperty(globalThis, key, descriptor);
	const before = Object.getOwnPropertyDescriptor(globalThis, key);
	let rejection;
	try {
		await import(maintenanceUrl);
	} catch (error) {
		rejection = error;
	}
	assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), before);
	assert.equal(accessorCalls, 0);
	evidence.premises.push("fresh preoccupied global", "unchanged descriptor", "zero accessor invocations");
	if (rejection === undefined) {
		report("F5B0Z_INCOMPATIBLE_REGISTRY_REFUSAL_REQUIRED");
	} else {
		assert.equal(Object.getPrototypeOf(rejection), TypeError.prototype);
		assert.equal(rejection.message, "AHE maintenance registry is incompatible");
		report();
	}
}
