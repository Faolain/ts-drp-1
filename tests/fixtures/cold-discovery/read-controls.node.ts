import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createNativeReadObserver, NativeReadObservationError } from "./read-observer.js";
import { nativeReadTransform, transformNativeRead } from "./read-transform.js";

void test("observation rejects missing and duplicate hooks before product work", async () => {
	for (const registrations of [0, 2]) {
		const observer = createNativeReadObserver();
		for (let i = 0; i < registrations; i += 1) observer.register("node");
		await assert.rejects(
			observer.observe(
				() => {},
				(): Promise<never> => assert.fail("product must not run")
			),
			/NATIVE_READ_HOOK_COUNT/u
		);
	}
});
void test("observation counts only its lifetime, detaches, and rejects nested ownership", async () => {
	const observer = createNativeReadObserver();
	observer.register("node");
	let reads = 0;
	observer.read("node");
	const result = Object.freeze({ native: true });
	assert.equal(
		await observer.observe(
			() => {
				reads += 1;
			},
			async () => {
				observer.read("node");
				await assert.rejects(
					observer.observe(
						() => {},
						() => Promise.resolve(undefined)
					),
					/ALREADY_ACTIVE/u
				);
				observer.read("node");
				return result;
			}
		),
		result
	);
	observer.read("node");
	assert.equal(reads, 2);
	await observer.observe(
		() => {
			reads += 1;
		},
		() => {
			observer.read("node");
			return Promise.resolve();
		}
	);
	assert.equal(reads, 3);
});
void test("observer failure is separate from fulfilled product result and detaches", async () => {
	const observer = createNativeReadObserver();
	observer.register("node");
	const product = Object.freeze({ outcome: "fulfilled" });
	await assert.rejects(
		observer.observe(
			() => {
				throw Error("observer");
			},
			() => {
				assert.doesNotThrow(() => observer.read("node"));
				return Promise.resolve(product);
			}
		),
		(error: unknown) => error instanceof NativeReadObservationError && error.productionResult === product
	);
	assert.equal(
		await observer.observe(
			() => {},
			() => Promise.resolve(product)
		),
		product
	);
});
void test("primary thrown identity survives observer and diagnostic failures", async () => {
	const observer = createNativeReadObserver();
	observer.register("node");
	const primary = Object.freeze({ primary: true });
	const original = console.error;
	try {
		console.error = (): never => {
			throw Error("diagnostic");
		};
		await assert.rejects(
			observer.observe(
				() => {
					throw Error("observer");
				},
				() => {
					observer.read("node");
					return Promise.reject(primary);
				}
			),
			(error: unknown) => error === primary
		);
	} finally {
		console.error = original;
	}
	assert.equal(
		await observer.observe(
			() => {},
			() => Promise.resolve(primary)
		),
		primary
	);
});
void test("wrong backend and late registration fail closed after product execution", async () => {
	for (const late of [false, true]) {
		const observer = createNativeReadObserver();
		observer.register("node");
		await assert.rejects(
			observer.observe(
				() => {},
				() => {
					if (late) observer.register("node");
					else observer.read("browser");
					return Promise.resolve("original");
				}
			),
			(error: unknown) => error instanceof NativeReadObservationError && error.productionResult === "original"
		);
	}
});
void test("native transforms are insertion-only and reject missing, duplicate, and repeated sites", () => {
	for (const backend of ["node", "browser"] as const) {
		const raw = readFileSync(`packages/storage-${backend}/dist/src/snapshot-transfer.js`, "utf8");
		const transformed = transformNativeRead(raw, backend);
		let reconstructed = raw;
		for (const insertion of [...transformed.insertions].sort((a, b) => b.offset - a.offset))
			reconstructed = reconstructed.slice(0, insertion.offset) + insertion.text + reconstructed.slice(insertion.offset);
		assert.equal(transformed.code, reconstructed);
		assert.throws(() => transformNativeRead("", backend), /SITE_NOT_UNIQUE/u);
		assert.throws(() => transformNativeRead(raw + raw, backend), /SITE_NOT_UNIQUE/u);
		assert.throws(() => transformNativeRead(transformed.code, backend), /ALREADY_PRESENT/u);
		assert.throws(() => nativeReadTransform(backend, "unused").finish(), /LOADED_MODULE_COUNT:0/u);
	}
});
