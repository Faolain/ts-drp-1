#!/usr/bin/env node
/**
 * Release evidence runner for the v1 exact-byte blueprint conformance corpus.
 *
 * This is deliberately package-owned tooling rather than protocol runtime API.
 * It executes the artifact bytes in each real engine and emits one JSON receipt.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { chromium, firefox, webkit } from "@playwright/test";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const HEX = (bytes) => Buffer.from(bytes).toString("hex");
const digest = (domain, value) => HEX(hashDomain(domain, encodeCanonical(value)));
const artifactDigest = (domain, bytes) => HEX(hashDomain(domain, bytes));
const exactSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(message) {
	throw new Error(`blueprint conformance failed closed: ${message}`);
}

function plainRecord(value, label) {
	if (
		value === null ||
		typeof value !== "object" ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	) {
		fail(`${label} must be a plain record`);
	}
	return value;
}

function parseArguments(argv) {
	const parsed = { contract: undefined, negativeControl: undefined, tier: "pr", nodeWorker: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--contract") parsed.contract = argv[++index];
		else if (argument === "--tier") parsed.tier = argv[++index];
		else if (argument === "--negative-control") parsed.negativeControl = argv[++index];
		else if (argument === "--node-worker") parsed.nodeWorker = true;
		else fail(`unknown command-line argument ${String(argument)}`);
	}
	if (typeof parsed.contract !== "string" || parsed.contract.length === 0) fail("--contract is required");
	if (parsed.tier !== "pr" && parsed.tier !== "nightly") fail("--tier must be pr or nightly");
	return parsed;
}

function loadContract(contractPath) {
	const absolute = realpathSync(contractPath);
	const contract = plainRecord(JSON.parse(readFileSync(absolute, "utf8")), "contract");
	if (contract.schemaVersion !== 1 || contract.runner?.receiptSchemaVersion !== 1) fail("unsupported contract schema");
	if (typeof contract.runtimeProfile !== "string" || typeof contract.artifactDigestDomain !== "string")
		fail("invalid profile contract");
	if (typeof contract.conformance?.digestDomain !== "string") fail("invalid conformance digest domain");
	const operationOrder = contract.conformance.operationOrder;
	const prOperations = contract.prOperations;
	const nightlyOperations = contract.nightlyOperations;
	if (!Array.isArray(operationOrder) || !Array.isArray(prOperations) || operationOrder.length !== prOperations.length)
		fail("operation order does not match PR corpus");
	if (!Array.isArray(nightlyOperations) || nightlyOperations.length < prOperations.length)
		fail("nightly corpus must be a strict PR superset");
	if (prOperations.some((operation, index) => plainRecord(operation, "operation").action !== operationOrder[index]))
		fail("operation order is inconsistent");
	if (
		!prOperations.every((operation, index) => {
			const expected = encodeCanonical(operation);
			const actual = encodeCanonical(nightlyOperations[index]);
			return (
				expected.byteLength === actual.byteLength && expected.every((byte, byteIndex) => byte === actual[byteIndex])
			);
		})
	)
		fail("nightly corpus does not preserve the PR prefix");
	const pr = plainRecord(contract.conformance.pr, "pr corpus");
	const nightly = plainRecord(contract.conformance.nightly, "nightly corpus");
	const additional = nightly.additionalSelectedCaseIds;
	if (!Array.isArray(additional)) fail("nightly additional selection must be an array");
	const prIds = prOperations.map((operation) => plainRecord(operation, "operation").id);
	const nightlyIds = nightlyOperations.map((operation) => plainRecord(operation, "nightly operation").id);
	if (JSON.stringify(nightlyIds) !== JSON.stringify([...prIds, ...additional]))
		fail("nightly selected case ids are inconsistent");
	for (const [name, accounting, selectedIds] of [
		["pr", pr, prIds],
		["nightly", nightly, nightlyIds],
	]) {
		if (![accounting.total, accounting.selected, accounting.dropped].every(Number.isSafeInteger))
			fail(`${name} corpus accounting must use safe integers`);
		if (accounting.selected !== selectedIds.length || accounting.selected + accounting.dropped !== accounting.total)
			fail(`${name} corpus accounting is inconsistent`);
	}
	if (nightlyIds.length <= prIds.length || !prIds.every((id) => nightlyIds.includes(id)))
		fail("nightly selection is not a strict PR superset");
	const packageTemplate = plainRecord(contract.packageTemplate, "packageTemplate");
	const implementation = plainRecord(packageTemplate.implementation, "packageTemplate.implementation");
	const manifest = plainRecord(packageTemplate.manifest, "packageTemplate.manifest");
	if (
		packageTemplate.kind !== "drp-blueprint-admission-package" ||
		packageTemplate.protocolMajor !== 3 ||
		packageTemplate.schemaVersion !== 1 ||
		manifest.schemaVersion !== 1 ||
		typeof implementation.artifactId !== "string" ||
		typeof implementation.runtimeProfile !== "string" ||
		implementation.runtimeProfile !== contract.runtimeProfile
	)
		fail("packageTemplate binding is invalid");
	if (!Array.isArray(manifest.operations)) fail("packageTemplate manifest operations are invalid");
	const manifestOperationNames = manifest.operations.map(
		(operation) => plainRecord(operation, "manifest operation").name
	);
	if (
		manifestOperationNames.some((name) => typeof name !== "string") ||
		new Set(manifestOperationNames).size !== manifestOperationNames.length
	)
		fail("packageTemplate manifest operation names must be unique strings");
	const primaryContract = plainRecord(plainRecord(contract.artifacts, "artifacts").primary, "primary artifact");
	if (primaryContract.artifactId !== implementation.artifactId) fail("packageTemplate artifactId binding mismatch");
	const fixtureDirectory = dirname(absolute);
	const artifacts = {};
	for (const [name, item] of Object.entries(plainRecord(contract.artifacts, "artifacts"))) {
		const entry = plainRecord(item, `artifact ${name}`);
		if (typeof entry.file !== "string" || typeof entry.artifactId !== "string") fail(`invalid artifact ${name}`);
		const bytes = new Uint8Array(readFileSync(resolve(fixtureDirectory, entry.file)));
		artifacts[name] = {
			artifactDigest: artifactDigest(contract.artifactDigestDomain, bytes),
			bytes,
			file: entry.file,
			id: entry.artifactId,
		};
	}
	if (
		!artifacts.primary ||
		!artifacts.ambientBad ||
		!artifacts.thenable ||
		!artifacts.intrinsicMutation ||
		!artifacts.moduleGlobalDrift ||
		!artifacts.noncanonicalIntermediate ||
		!artifacts.sparseIntermediate
	)
		fail("missing required artifact");
	if (artifacts.primary.id !== implementation.artifactId) fail("primary artifactId binding mismatch");
	return {
		absolute,
		artifacts,
		contract,
		fixtureDirectory,
		nightlyIds,
		operations: { nightly: nightlyOperations, pr: prOperations },
		packageBinding: {
			artifactDigest: artifacts.primary.artifactDigest,
			artifactId: implementation.artifactId,
			runtimeProfile: implementation.runtimeProfile,
		},
		prIds,
	};
}

function canonicalDetach(value) {
	return decodeCanonical(encodeCanonical(value));
}

function countNegativeZero(value) {
	if (typeof value === "number") return Object.is(value, -0) ? 1 : 0;
	if (value === null || typeof value !== "object") return 0;
	return Array.isArray(value)
		? value.reduce((total, item) => total + countNegativeZero(item), 0)
		: Object.values(value).reduce((total, item) => total + countNegativeZero(item), 0);
}

function asDataUrl(bytes, suffix = "") {
	return `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}${suffix}`;
}

/**
 * This function is stringified and evaluated inside each browser page as well as Node.
 * @param input Realm execution inputs.
 * @returns Raw realm evidence.
 */
async function executeInRealm(input) {
	const textEncoder = new TextEncoder();
	const intrinsic = Object.freeze({
		functionToString: Function.prototype.toString,
		getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
		getOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
		getPrototypeOf: Object.getPrototypeOf,
		hasOwn: Object.hasOwn,
		keys: Object.keys,
		ownKeys: Reflect.ownKeys,
	});
	const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
	const assert = (condition, message) => {
		if (!condition) throw new Error(`blueprint conformance failed closed: ${message}`);
	};
	const fingerprint = (value) => {
		if (value === null) return ["null"];
		if (typeof value === "number")
			return ["number", Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : String(value)];
		if (typeof value === "string" || typeof value === "boolean" || typeof value === "undefined")
			return [typeof value, value];
		if (typeof value === "function")
			return ["function", value.name, value.length, intrinsic.functionToString.call(value)];
		if (typeof value === "symbol" || typeof value === "bigint") return [typeof value, String(value)];
		return [typeof value, Object.prototype.toString.call(value)];
	};
	const stableDescriptorSnapshot = (targets) =>
		JSON.stringify(
			targets.map((target) => {
				const object = target.split(".").reduce((current, key) => current[key], globalThis);
				const descriptors = intrinsic.getOwnPropertyDescriptors(object);
				return [
					target,
					Object.keys(descriptors)
						.sort()
						.map((key) => {
							const descriptor = descriptors[key];
							return [
								key,
								Boolean(descriptor.configurable),
								Boolean(descriptor.enumerable),
								Boolean(descriptor.writable),
								fingerprint(descriptor.value),
								fingerprint(descriptor.get),
								fingerprint(descriptor.set),
							];
						}),
				];
			})
		);
	const restore = [];
	const replace = (target, key, value, label) => {
		const previous = Object.getOwnPropertyDescriptor(target, key);
		if (previous && !previous.configurable && !previous.writable)
			throw new Error(`blueprint conformance failed closed: ${label} is unavailable or unrestorable`);
		try {
			Object.defineProperty(target, key, {
				configurable: true,
				enumerable: previous?.enumerable ?? true,
				writable: true,
				value,
			});
		} catch (error) {
			throw new Error(`blueprint conformance failed closed: ${label} is unavailable or unrestorable: ${String(error)}`);
		}
		restore.push(() => {
			if (previous) Object.defineProperty(target, key, previous);
			else delete target[key];
		});
	};
	const ownDataRecord = (value, expectedKeys, label) => {
		assert(
			value &&
				typeof value === "object" &&
				(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
			`${label} must be a plain record`
		);
		const keys = intrinsic.ownKeys(value);
		assert(
			keys.every((key) => typeof key === "string") &&
				JSON.stringify(keys.slice().sort()) === JSON.stringify(expectedKeys.slice().sort()),
			`${label} has an invalid key set`
		);
		for (const key of keys) {
			const descriptor = intrinsic.getOwnPropertyDescriptor(value, key);
			assert(
				descriptor &&
					Object.hasOwn(descriptor, "value") &&
					!Object.hasOwn(descriptor, "get") &&
					!Object.hasOwn(descriptor, "set"),
				`${label}.${key} must be own data`
			);
		}
		return value;
	};
	const assertCanonicalString = (value) => {
		for (let index = 0; index < value.length; index += 1) {
			const point = value.charCodeAt(index);
			if (point >= 0xd800 && point <= 0xdbff) {
				assert(
					index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff,
					"unpaired surrogate is not canonical"
				);
				index += 1;
			} else assert(point < 0xdc00 || point > 0xdfff, "unpaired surrogate is not canonical");
		}
	};
	const detachCanonical = (value, seen = new Set()) => {
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") {
			assertCanonicalString(value);
			return value;
		}
		if (typeof value === "number") {
			assert(
				Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
				"number is outside canonical domain"
			);
			return Object.is(value, -0) ? 0 : value;
		}
		assert(value && typeof value === "object", "value is outside canonical domain");
		assert(!seen.has(value), "cyclic value is outside canonical domain");
		seen.add(value);
		if (Array.isArray(value)) {
			assert(
				intrinsic.keys(value).every((key) => /^(0|[1-9]\d*)$/u.test(key)),
				"array extra keys are outside canonical domain"
			);
			const detached = [];
			for (let index = 0; index < value.length; index += 1) {
				const key = String(index);
				assert(intrinsic.hasOwn(value, key), "sparse array is outside canonical domain");
				const descriptor = intrinsic.getOwnPropertyDescriptor(value, key);
				assert(descriptor && intrinsic.hasOwn(descriptor, "value"), "array accessor is outside canonical domain");
				detached.push(detachCanonical(descriptor.value, seen));
			}
			seen.delete(value);
			return detached;
		}
		assert(
			intrinsic.getPrototypeOf(value) === Object.prototype || intrinsic.getPrototypeOf(value) === null,
			"non-plain object is outside canonical domain"
		);
		const encodedKeyBytes = (key) => {
			assertCanonicalString(key);
			const utf8 = textEncoder.encode(key);
			const length = [];
			let remaining = utf8.byteLength;
			do {
				let byte = remaining & 0x7f;
				remaining >>>= 7;
				if (remaining !== 0) byte |= 0x80;
				length.push(byte);
			} while (remaining !== 0);
			return [0x05, ...length, ...utf8];
		};
		const compareEncodedKeys = (left, right) => {
			const leftBytes = encodedKeyBytes(left);
			const rightBytes = encodedKeyBytes(right);
			for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
				if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] < rightBytes[index] ? -1 : 1;
			}
			return leftBytes.length - rightBytes.length;
		};
		const detached = Object.create(null);
		const entries = [];
		for (const key of intrinsic.ownKeys(value)) {
			assert(typeof key === "string", "symbol key is outside canonical domain");
			assertCanonicalString(key);
			const descriptor = intrinsic.getOwnPropertyDescriptor(value, key);
			assert(descriptor && intrinsic.hasOwn(descriptor, "value"), "accessor is outside canonical domain");
			if (descriptor.enumerable) entries.push([key, descriptor.value]);
		}
		for (const [key, descriptorValue] of entries.sort(([left], [right]) => compareEncodedKeys(left, right)))
			detached[key] = detachCanonical(descriptorValue, seen);
		seen.delete(value);
		return detached;
	};
	const validateBlueprint = (namespace, expectedId) => {
		const exports = Object.keys(namespace).sort();
		assert(exports.length === 1 && exports[0] === "blueprint", "artifact must have exactly one blueprint export");
		const blueprint = ownDataRecord(
			namespace.blueprint,
			["artifactId", "exportSchemaVersion", "reducers", "runtimeProfile"],
			"blueprint envelope"
		);
		assert(
			blueprint.exportSchemaVersion === 1 &&
				blueprint.runtimeProfile === input.runtimeProfile &&
				blueprint.artifactId === expectedId,
			"blueprint envelope is invalid"
		);
		const reducers = ownDataRecord(blueprint.reducers, input.reducerNames, "reducers table");
		const reducerNames = Object.keys(reducers).sort();
		assert(
			JSON.stringify(reducerNames) === JSON.stringify(input.reducerNames.slice().sort()),
			"reducer key set is invalid"
		);
		for (const reducer of Object.values(reducers)) assert(typeof reducer === "function", "reducer must be a function");
		return reducers;
	};
	const runOperations = (reducers) => {
		let state = detachCanonical(input.initialState);
		const outputs = [];
		let normalizedNegativeZeroOutputs = 0;
		for (const operation of input.operations) {
			const reducer = reducers[operation.action];
			assert(typeof reducer === "function", `missing reducer ${operation.action}`);
			const result = reducer({ state, operation });
			assert(
				result && typeof result === "object" && typeof result.then !== "function",
				"reducer result must be a synchronous non-thenable object"
			);
			assert(own(result, "state") && own(result, "output"), "reducer result must contain state and output");
			state = detachCanonical(result.state);
			const output = detachCanonical(result.output);
			outputs.push(output);
			if (output?.normalizedNegativeZero === true) normalizedNegativeZeroOutputs += 1;
		}
		return { finalState: state, normalizedNegativeZeroOutputs, outputs };
	};
	const importAndRun = async (url, expectedId) => runOperations(validateBlueprint(await import(url), expectedId));
	const runPrimary = async () => {
		const before = stableDescriptorSnapshot(input.targets);
		const namespace = await import(input.primaryUrl);
		const reducers = validateBlueprint(namespace, input.primaryId);
		const afterEvaluation = stableDescriptorSnapshot(input.targets);
		const first = runOperations(reducers);
		const sameSecond = runOperations(reducers);
		const snapshots = [stableDescriptorSnapshot(input.targets), stableDescriptorSnapshot(input.targets)];
		const freshFirst = await importAndRun(`${input.primaryUrl}#fresh-one`, input.primaryId);
		snapshots.push(stableDescriptorSnapshot(input.targets));
		const freshSecond = await importAndRun(`${input.primaryUrl}#fresh-two`, input.primaryId);
		snapshots.push(stableDescriptorSnapshot(input.targets));
		return { afterEvaluation, before, first, fresh: [freshFirst, freshSecond], same: [first, sameSecond], snapshots };
	};
	const installSentinels = (throwing) => {
		const used = [];
		const hooks = {};
		const observe = (name) => {
			if (throwing) throw new Error(`poison ${name} invoked`);
			used.push(name);
			return `${input.engine}:${name}`;
		};
		replace(globalThis, "Date", { now: () => observe("Date") }, "Date");
		replace(Math, "random", () => observe("Math.random"), "Math.random");
		replace(globalThis.performance, "now", () => observe("performance"), "performance");
		replace(globalThis, "setTimeout", () => observe("timers"), "timers");
		replace(globalThis, "fetch", () => observe("io"), "io");
		if (typeof globalThis.document === "undefined")
			replace(globalThis, "document", { createElement: () => observe("dom") }, "document");
		else replace(globalThis.document, "createElement", () => observe("dom"), "document");
		if (!throwing) {
			for (const name of ["Date", "Math.random", "performance", "timers", "io", "dom"])
				hooks[name] = { installed: true, probe: observe(name) };
			used.length = 0;
		}
		return { hooks, used };
	};
	const primary = await runPrimary();
	assert(
		primary.before === primary.afterEvaluation && primary.snapshots.every((snapshot) => snapshot === primary.before),
		"primary mutated selected intrinsic descriptors"
	);
	const primaryResult = primary.first;
	const ambient = installSentinels(false);
	let ambientResult;
	try {
		ambientResult = await importAndRun(input.ambientUrl, input.ambientId);
	} finally {
		while (restore.length) restore.pop()();
	}
	assert(
		JSON.stringify([...new Set(ambient.used)].sort()) ===
			JSON.stringify(["Date", "Math.random", "dom", "io", "performance", "timers"].sort()),
		"ambient fixture did not consume every sentinel"
	);
	installSentinels(true);
	let throwModeFailedClosed = false;
	try {
		await importAndRun(`${input.ambientUrl}#poison`, input.ambientId);
	} catch {
		throwModeFailedClosed = true;
	} finally {
		while (restore.length) restore.pop()();
	}
	assert(throwModeFailedClosed, "throwing ambient poison did not fail closed");
	let thenableExecuted = false;
	let thenableRejected = false;
	try {
		await importAndRun(input.thenableUrl, input.thenableId);
	} catch (error) {
		thenableExecuted = String(error).includes("synchronous non-thenable");
		thenableRejected = thenableExecuted;
	}
	assert(thenableExecuted && thenableRejected, "thenable control was not executed and rejected");
	let canonicalIntermediateExecuted = false;
	let canonicalIntermediateRejected = false;
	try {
		await importAndRun(input.noncanonicalUrl, input.noncanonicalId);
	} catch (error) {
		canonicalIntermediateExecuted = String(error).includes("canonical");
		canonicalIntermediateRejected = canonicalIntermediateExecuted;
	}
	assert(
		canonicalIntermediateExecuted && canonicalIntermediateRejected,
		"noncanonical intermediate control was not executed and rejected"
	);
	let sparseIntermediateExecuted = false;
	let sparseIntermediateRejected = false;
	try {
		await importAndRun(input.sparseUrl, input.sparseId);
	} catch (error) {
		sparseIntermediateExecuted = String(error).includes("sparse array");
		sparseIntermediateRejected = sparseIntermediateExecuted;
	}
	assert(
		sparseIntermediateExecuted && sparseIntermediateRejected,
		"sparse intermediate control was not executed and rejected"
	);
	const intrinsicBefore = stableDescriptorSnapshot(input.targets);
	await import(input.intrinsicUrl);
	const intrinsicAfter = stableDescriptorSnapshot(input.targets);
	const intrinsicMutationDetected = intrinsicBefore !== intrinsicAfter;
	assert(intrinsicMutationDetected, "intrinsic mutation control was not detected");
	const driftNamespace = await import(input.moduleGlobalUrl);
	const driftReducers = validateBlueprint(driftNamespace, input.moduleGlobalId);
	const driftSame = [runOperations(driftReducers), runOperations(driftReducers)];
	const driftFresh = [
		await importAndRun(`${input.moduleGlobalUrl}#fresh-one`, input.moduleGlobalId),
		await importAndRun(`${input.moduleGlobalUrl}#fresh-two`, input.moduleGlobalId),
	];
	return {
		ambientResult,
		hooks: ambient.hooks,
		intrinsicAfter,
		intrinsicBefore,
		intrinsicMutationDetected,
		primary,
		primaryResult,
		thenable: { executed: thenableExecuted, rejected: thenableRejected },
		canonicalIntermediate: { executed: canonicalIntermediateExecuted, rejected: canonicalIntermediateRejected },
		sparseIntermediate: { executed: sparseIntermediateExecuted, rejected: sparseIntermediateRejected },
		throwModeFailedClosed,
		used: ambient.used,
		driftFresh,
		driftSame,
	};
}

function engineInput(loaded, engine, tier) {
	const { contract, artifacts } = loaded;
	const rawOperations = loaded.operations[tier];
	const operations = canonicalDetach(rawOperations);
	const normalizedNegativeZeroOperationArguments = countNegativeZero(rawOperations) - countNegativeZero(operations);
	if (tier === "pr" && normalizedNegativeZeroOperationArguments !== 1)
		fail("canonical operation normalization did not remove exactly one negative zero");
	return {
		ambientId: artifacts.ambientBad.id,
		ambientUrl: asDataUrl(artifacts.ambientBad.bytes),
		engine,
		initialState: canonicalDetach(contract.conformance.initialState),
		intrinsicUrl: asDataUrl(artifacts.intrinsicMutation.bytes),
		moduleGlobalId: artifacts.moduleGlobalDrift.id,
		moduleGlobalUrl: asDataUrl(artifacts.moduleGlobalDrift.bytes),
		noncanonicalId: artifacts.noncanonicalIntermediate.id,
		noncanonicalUrl: asDataUrl(artifacts.noncanonicalIntermediate.bytes),
		sparseId: artifacts.sparseIntermediate.id,
		sparseUrl: asDataUrl(artifacts.sparseIntermediate.bytes),
		operations,
		primaryId: artifacts.primary.id,
		primaryUrl: asDataUrl(artifacts.primary.bytes),
		reducerNames: contract.packageTemplate.manifest.operations.map((operation) => operation.name),
		runtimeProfile: contract.runtimeProfile,
		targets: contract.conformance.selectedIntrinsicDescriptorTargets,
		thenableId: artifacts.thenable.id,
		thenableUrl: asDataUrl(artifacts.thenable.bytes),
		normalizedNegativeZeroOperationArguments,
		executedCaseIds: rawOperations.map((operation) => operation.id),
		tier,
	};
}

function normalizedRun(raw, loaded, engine, build, tier) {
	const domain = loaded.contract.conformance.digestDomain;
	const detachResult = (result) => canonicalDetach({ state: result.finalState, outputs: result.outputs });
	const first = detachResult(raw.primaryResult);
	const conformanceDigest = digest(domain, first);
	const replayDigest = (result) => digest(domain, detachResult(result));
	const same = raw.primary.same.map(replayDigest);
	const fresh = raw.primary.fresh.map(replayDigest);
	if (![...same, ...fresh].every((value) => value === conformanceDigest)) fail(`${engine} primary replay drift`);
	const driftSame = raw.driftSame.map(replayDigest);
	const driftFresh = raw.driftFresh.map(replayDigest);
	if (driftSame[0] === driftSame[1] || driftFresh[0] !== driftFresh[1])
		fail(`${engine} module-global control did not prove same/fresh behavior`);
	const badFixtureDigest = digest(domain, detachResult(raw.ambientResult));
	if (badFixtureDigest === conformanceDigest) fail(`${engine} ambient control did not diverge`);
	return {
		build,
		conformanceDigest,
		finalState: first.state,
		name: engine,
		outputs: first.outputs,
		hooks: raw.hooks,
		executedCaseIds: engineInput(loaded, engine, tier).executedCaseIds,
		normalization: {
			negativeZeroOperationArguments: engineInput(loaded, engine, tier).normalizedNegativeZeroOperationArguments,
			normalizedNegativeZeroOutputs: raw.primaryResult.normalizedNegativeZeroOutputs,
		},
		replays: { freshInstances: fresh, sameModuleInstance: same },
		sentinel: {
			ambientHookConsumption: Object.keys(raw.hooks).filter((name) => raw.used.includes(name)),
			badFixtureDigest,
			badFixtureMismatch: true,
			intrinsicMutationDetected: raw.intrinsicMutationDetected,
			throwModeFailedClosed: raw.throwModeFailedClosed,
		},
		thenable: raw.thenable,
		canonicalIntermediate: raw.canonicalIntermediate,
		sparseIntermediate: raw.sparseIntermediate,
		intrinsicSnapshots: {
			afterEvaluation: raw.primary.afterEvaluation,
			afterEveryReplay: raw.primary.snapshots,
			beforeEvaluation: raw.primary.before,
		},
		negativeControl: {
			intrinsicAfter: raw.intrinsicAfter,
			intrinsicBefore: raw.intrinsicBefore,
			driftFresh,
			driftSame,
		},
	};
}

function executeNode(loaded, tier) {
	const invocation = spawnSync(
		process.execPath,
		[SCRIPT_PATH, "--node-worker", "--contract", loaded.absolute, "--tier", tier],
		{ encoding: "utf8" }
	);
	if (invocation.error) fail(`Node worker could not start: ${invocation.error.message}`);
	if (invocation.status !== 0) fail(`Node worker failed: ${invocation.stderr.trim()}`);
	try {
		return JSON.parse(invocation.stdout);
	} catch {
		fail("Node worker did not emit a machine-readable receipt");
	}
}

async function executeNodeWorker(loaded, tier) {
	const raw = await executeInRealm(engineInput(loaded, "node", tier));
	return normalizedRun(raw, loaded, "node", process.version, tier);
}

async function executeBrowser(loaded, name, browserType, tier) {
	const browser = await browserType.launch({ headless: true });
	try {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			try {
				return normalizedRun(
					await page.evaluate(executeInRealm, engineInput(loaded, name, tier)),
					loaded,
					name,
					browser.version(),
					tier
				);
			} finally {
				await page.close();
			}
		} finally {
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

async function executeAll(loaded, tier) {
	const engines = [await executeNode(loaded, tier)];
	for (const [name, type] of [
		["chromium", chromium],
		["firefox", firefox],
		["webkit", webkit],
	])
		engines.push(await executeBrowser(loaded, name, type, tier));
	return engines;
}

function makeReceipt(loaded, engines, tier) {
	const { contract, artifacts, prIds, nightlyIds } = loaded;
	const requiredEngineNames = ["node", "chromium", "firefox", "webkit"];
	if (
		engines.length !== requiredEngineNames.length ||
		new Set(engines.map((engine) => engine.name)).size !== requiredEngineNames.length ||
		!requiredEngineNames.every((name) => engines.some((engine) => engine.name === name))
	)
		fail("cross-engine conformance requires exactly one each of node, chromium, firefox, and webkit");
	if (new Set(engines.map((engine) => engine.conformanceDigest)).size !== 1)
		fail("cross-engine conformance digest disagreement");
	const node = engines.find((engine) => engine.name === "node");
	if (!node) fail("node receipt is missing");
	return {
		receiptSchemaVersion: contract.runner.receiptSchemaVersion,
		runtimeProfile: contract.runtimeProfile,
		artifactDigest: artifacts.primary.artifactDigest,
		packageBinding: loaded.packageBinding,
		executionTier: tier,
		artifacts: Object.fromEntries(
			Object.entries(artifacts).map(([name, artifact]) => [
				name,
				{ artifactDigest: artifact.artifactDigest, exactBytesSha256: exactSha256(artifact.bytes) },
			])
		),
		corpus: {
			corpusVersion: contract.conformance.corpusVersion,
			seed: contract.conformance.seed,
			operationOrder: loaded.operations[tier].map((operation) => operation.action),
			pr: { ...contract.conformance.pr, selectedCaseIds: prIds },
			nightly: {
				total: contract.conformance.nightly.total,
				selected: contract.conformance.nightly.selected,
				dropped: contract.conformance.nightly.dropped,
				selectedCaseIds: nightlyIds,
			},
		},
		selectedIntrinsicDescriptorTargets: contract.conformance.selectedIntrinsicDescriptorTargets,
		engines: engines.map(({ negativeControl: _negativeControl, ...engine }) => engine),
		negativeControls: {
			moduleGlobalDrift: {
				detected: true,
				sameModuleInstanceDigests: node.negativeControl.driftSame,
				freshInstanceDigests: node.negativeControl.driftFresh,
			},
			intrinsicMutation: {
				detected: true,
				snapshotBeforeEvaluation: node.negativeControl.intrinsicBefore,
				snapshotAfterEvaluation: node.negativeControl.intrinsicAfter,
			},
		},
		catalogEntry: {
			artifactDigest: artifacts.primary.artifactDigest,
			corpusVersion: contract.conformance.corpusVersion,
			engineBuilds: Object.fromEntries(engines.map((engine) => [engine.name, engine.build])),
			operationOrder: loaded.operations[tier].map((operation) => operation.action),
			result: "passed",
			runtimeProfile: contract.runtimeProfile,
			seed: contract.conformance.seed,
			executionTier: tier,
		},
	};
}

async function runNegativeControl(loaded, control) {
	if (control === "corpus-accounting")
		fail("corpus-accounting negative control should have failed during contract validation");
	if (
		![
			"thenable",
			"module-global-drift",
			"intrinsic-mutation",
			"noncanonical-intermediate",
			"sparse-intermediate",
		].includes(control)
	)
		fail(`unknown negative control ${String(control)}`);
	const node = await executeNode(loaded, "pr");
	if (control === "thenable" && node.thenable.executed && node.thenable.rejected)
		fail("thenable negative control executed and was rejected");
	if (
		control === "module-global-drift" &&
		node.negativeControl.driftSame[0] !== node.negativeControl.driftSame[1] &&
		node.negativeControl.driftFresh[0] === node.negativeControl.driftFresh[1]
	)
		fail("module-global-drift negative control detected same-instance drift");
	if (control === "intrinsic-mutation" && node.negativeControl.intrinsicBefore !== node.negativeControl.intrinsicAfter)
		fail("intrinsic-mutation negative control detected descriptor mutation");
	if (
		control === "noncanonical-intermediate" &&
		node.canonicalIntermediate.executed &&
		node.canonicalIntermediate.rejected
	)
		fail("noncanonical-intermediate negative control executed and was rejected");
	if (control === "sparse-intermediate" && node.sparseIntermediate.executed && node.sparseIntermediate.rejected)
		fail("sparse-intermediate negative control executed and was rejected");
	fail(`negative control ${String(control)} did not produce its expected detection`);
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const loaded = loadContract(options.contract);
	if (options.nodeWorker) {
		process.stdout.write(`${JSON.stringify(await executeNodeWorker(loaded, options.tier))}\n`);
		return;
	}
	if (options.negativeControl) await runNegativeControl(loaded, options.negativeControl);
	const receipt = makeReceipt(loaded, await executeAll(loaded, options.tier), options.tier);
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
