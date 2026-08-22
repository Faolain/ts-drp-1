import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type * as V3ScopeOwner from "../packages/node/src/v3-envelope-scope.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OWNER_URL = pathToFileURL(path.join(ROOT, "packages/node/src/v3-envelope-scope.ts")).href;
const DIGEST = "a".repeat(64);
const OBJECT_ID = `creator:${"b".repeat(32)}`;

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;

type V3CurrentAnchorContext = V3ScopeOwner.V3CurrentAnchorContext;
type V3EnvelopeScope = V3ScopeOwner.V3EnvelopeScope;
type V3EnvelopeScopeClassification = V3ScopeOwner.V3EnvelopeScopeClassification;
type ClassifyV3EnvelopeScope = typeof V3ScopeOwner.classifyV3EnvelopeScope;

const exactParameters: Equal<Parameters<ClassifyV3EnvelopeScope>, [V3EnvelopeScope, V3CurrentAnchorContext]> = true;
void exactParameters;

interface CandidateModule {
	classifyV3EnvelopeScope?(envelope: V3EnvelopeScope, anchorCtx: V3CurrentAnchorContext): V3EnvelopeScopeClassification;
}

const ENVELOPE_KEYS = Object.freeze(["anchor", "epoch", "objectId", "protocolMajor"] as const);
const CONTEXT_KEYS = Object.freeze(["anchorDigest", "epoch", "objectId", "protocolMajor"] as const);
const DIGEST_HEX = /^[0-9a-f]{64}$/u;

function plainDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
		return undefined;
	if (
		Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
		Reflect.ownKeys(value).sort().join("\0") !== [...keys].sort().join("\0")
	) {
		return undefined;
	}
	const captured: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
		captured[key] = descriptor.value;
	}
	return captured;
}

function validString(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function expectedClassification(envelopeValue: unknown, contextValue: unknown): V3EnvelopeScopeClassification {
	const envelope = plainDataRecord(envelopeValue, ENVELOPE_KEYS);
	const context = plainDataRecord(contextValue, CONTEXT_KEYS);
	if (
		envelope === undefined ||
		context === undefined ||
		!validString(envelope.anchor) ||
		!DIGEST_HEX.test(envelope.anchor) ||
		!validString(envelope.objectId) ||
		!Number.isSafeInteger(envelope.epoch) ||
		(envelope.epoch as number) < 0 ||
		!Number.isSafeInteger(envelope.protocolMajor) ||
		(envelope.protocolMajor as number) < 0 ||
		!validString(context.anchorDigest) ||
		!DIGEST_HEX.test(context.anchorDigest) ||
		!validString(context.objectId) ||
		!Number.isSafeInteger(context.epoch) ||
		(context.epoch as number) < 0 ||
		context.protocolMajor !== 3
	) {
		return Object.freeze({ current: false, code: "MALFORMED_SCOPE" });
	}
	if (envelope.objectId !== context.objectId) return Object.freeze({ current: false, code: "OBJECT_MISMATCH" });
	if (envelope.protocolMajor !== context.protocolMajor) {
		return Object.freeze({ current: false, code: "PROTOCOL_MISMATCH" });
	}
	if (envelope.epoch !== context.epoch) return Object.freeze({ current: false, code: "EPOCH_MISMATCH" });
	if (envelope.anchor !== context.anchorDigest) return Object.freeze({ current: false, code: "ANCHOR_MISMATCH" });
	return Object.freeze({ current: true, code: "CURRENT" });
}

async function loadCandidate(): Promise<CandidateModule> {
	try {
		return (await import(OWNER_URL)) as CandidateModule;
	} catch {
		return Object.freeze({});
	}
}

async function loadRuntimeModule(relativePath: string): Promise<Record<string, unknown>> {
	return import(pathToFileURL(path.join(ROOT, relativePath)).href) as Promise<Record<string, unknown>>;
}

function context(): V3CurrentAnchorContext {
	return Object.freeze({ anchorDigest: DIGEST, epoch: 7, objectId: OBJECT_ID, protocolMajor: 3 });
}

function envelope(overrides: Partial<V3EnvelopeScope> = {}): V3EnvelopeScope {
	return Object.freeze({ anchor: DIGEST, epoch: 7, objectId: OBJECT_ID, protocolMajor: 3, ...overrides });
}

function deterministicStream(size: number): readonly V3EnvelopeScope[] {
	const rows: V3EnvelopeScope[] = [];
	for (let index = 0; index < size; index += 1) {
		const mask = index % 16;
		rows.push(
			envelope({
				...(mask & 1 ? { objectId: `${OBJECT_ID}:${index}` } : {}),
				...(mask & 2 ? { protocolMajor: 2 } : {}),
				...(mask & 4 ? { epoch: 8 } : {}),
				...(mask & 8 ? { anchor: "c".repeat(64) } : {}),
			})
		);
	}
	return Object.freeze(rows);
}

function nonEnumerableCopy(value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
	const copied = { ...value };
	Object.defineProperty(copied, key, { enumerable: false, value: copied[key] });
	return copied;
}

function symbolExtended(value: Readonly<Record<string, unknown>>): Record<string | symbol, unknown> {
	return Object.assign({ ...value }, { [Symbol("hostile")]: true });
}

function throwingRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return new Proxy(
		{ ...value },
		{
			getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
				throw new Error("synthetic descriptor trap");
			},
		}
	);
}

function inconsistentRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	let calls = 0;
	return new Proxy(
		{ ...value },
		{
			ownKeys(target): ArrayLike<string | symbol> {
				return calls++ === 0 ? Reflect.ownKeys(target) : [Reflect.ownKeys(target)[0] as string];
			},
		}
	);
}

describe("Phase 3 exit-c current-anchor envelope purity RED", () => {
	it("classifies the complete semantic relation with stable frozen results", async () => {
		const module = await loadCandidate();
		expect(module.classifyV3EnvelopeScope).toBeTypeOf("function");
		if (module.classifyV3EnvelopeScope === undefined) throw new TypeError("missing v3 envelope-scope evaluator");
		for (let mask = 0; mask < 16; mask += 1) {
			const row = envelope({
				...(mask & 1 ? { objectId: `${OBJECT_ID}:wrong` } : {}),
				...(mask & 2 ? { protocolMajor: 2 } : {}),
				...(mask & 4 ? { epoch: 8 } : {}),
				...(mask & 8 ? { anchor: "c".repeat(64) } : {}),
			});
			const actual = module.classifyV3EnvelopeScope(row, context());
			const expected = expectedClassification(row, context());
			const mismatchCount = [1, 2, 4, 8].filter((bit) => (mask & bit) !== 0).length;
			expect(actual.current).toBe(mask === 0);
			if (mismatchCount <= 1) expect(actual).toEqual(expected);
			else expect(module.classifyV3EnvelopeScope(row, context())).toEqual(actual);
			expect(Object.isFrozen(actual)).toBe(true);
		}
	});

	it("is history-independent and identical after a fresh child-process module load", async () => {
		const module = await loadCandidate();
		if (module.classifyV3EnvelopeScope === undefined) throw new TypeError("missing v3 envelope-scope evaluator");
		const candidate = module.classifyV3EnvelopeScope;
		const stream = deterministicStream(10_000);
		const replicaA: { accepted: string[]; delivered: number[]; pending: string[]; rejected: string[] } = {
			accepted: ["a"],
			delivered: [1, 2],
			pending: [],
			rejected: ["x"],
		};
		const replicaB: { accepted: string[]; delivered: number[]; pending: string[]; rejected: string[] } = {
			accepted: ["q", "r"],
			delivered: [],
			pending: ["z"],
			rejected: [],
		};
		const started = performance.now();
		const classify = (): readonly V3EnvelopeScopeClassification[] =>
			Object.freeze(stream.map((row) => candidate(row, context())));
		const first = classify();
		replicaA.pending.push("later");
		replicaB.rejected.push("later");
		const second = classify();
		expect(replicaA).not.toEqual(replicaB);
		expect(second).toEqual(first);

		const childInput = JSON.stringify({ anchorCtx: context(), stream });
		const script = `
			(async () => {
				const { readFileSync } = await import("node:fs");
				const candidate = await import(process.env.PHASE3_EXIT_OWNER_URL);
				const input = JSON.parse(readFileSync(0, "utf8"));
				process.stdout.write(JSON.stringify(input.stream.map((row) => candidate.classifyV3EnvelopeScope(row, input.anchorCtx))));
			})().catch((error) => { console.error(error); process.exitCode = 1; });
		`;
		const output = execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), ["-e", script], {
			cwd: ROOT,
			encoding: "utf8",
			env: { ...process.env, PHASE3_EXIT_OWNER_URL: OWNER_URL },
			input: childInput,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 4_000,
		});
		expect(JSON.parse(output)).toEqual(first);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("fails closed on hostile record shapes and snapshots before caller mutation", async () => {
		const module = await loadCandidate();
		if (module.classifyV3EnvelopeScope === undefined) throw new TypeError("missing v3 envelope-scope evaluator");
		const envelopeAccessor = Object.defineProperty({ epoch: 7, objectId: OBJECT_ID, protocolMajor: 3 }, "anchor", {
			enumerable: true,
			get: () => DIGEST,
		});
		const hostileEnvelopes = [
			envelopeAccessor,
			{ ...envelope(), extra: true },
			{ anchor: DIGEST, epoch: 7, objectId: OBJECT_ID },
			Object.assign(Object.create(null), envelope()),
			envelope({ anchor: "A".repeat(64) }),
			envelope({ objectId: "\ud800" }),
			envelope({ epoch: -1 }),
			envelope({ epoch: Number.MAX_SAFE_INTEGER + 1 }),
			envelope({ protocolMajor: -1 }),
			nonEnumerableCopy(envelope(), "anchor"),
			symbolExtended(envelope()),
			throwingRecord(envelope()),
			inconsistentRecord(envelope()),
		] as const;
		for (const row of hostileEnvelopes) {
			expect(module.classifyV3EnvelopeScope(row as V3EnvelopeScope, context())).toEqual({
				current: false,
				code: "MALFORMED_SCOPE",
			});
		}
		const contextAccessor = Object.defineProperty({ epoch: 7, objectId: OBJECT_ID, protocolMajor: 3 }, "anchorDigest", {
			enumerable: true,
			get: () => DIGEST,
		});
		const hostileContexts = [
			contextAccessor,
			{ ...context(), extra: true },
			{ anchorDigest: DIGEST, epoch: 7, objectId: OBJECT_ID },
			Object.assign(Object.create(null), context()),
			{ ...context(), anchorDigest: "A".repeat(64) },
			{ ...context(), objectId: "\ud800" },
			{ ...context(), epoch: -1 },
			{ ...context(), epoch: Number.MAX_SAFE_INTEGER + 1 },
			{ ...context(), protocolMajor: 2 },
			nonEnumerableCopy(context(), "anchorDigest"),
			symbolExtended(context()),
			throwingRecord(context()),
			inconsistentRecord(context()),
		] as const;
		for (const hostileContext of hostileContexts) {
			expect(module.classifyV3EnvelopeScope(envelope(), hostileContext as V3CurrentAnchorContext)).toEqual({
				current: false,
				code: "MALFORMED_SCOPE",
			});
		}
		const mutable = { ...envelope() };
		const result = module.classifyV3EnvelopeScope(mutable, context());
		mutable.epoch = 99;
		expect(result).toEqual({ current: true, code: "CURRENT" });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("keeps both node runtime entrypoints unchanged", async () => {
		const [root, live] = await Promise.all([
			loadRuntimeModule("packages/node/src/index.ts"),
			loadRuntimeModule("packages/node/src/v3-live.ts"),
		]);
		expect(Object.keys(root).sort()).toEqual([
			"DRPIntervalSync",
			"DRPNode",
			"INITIAL_SYNC_RETRY_INTERVAL_MS",
			"NostrRendezvousConfigurationError",
			"createConfiguredRendezvousRegistries",
			"createDRPIntervalSync",
		]);
		expect(Object.keys(live).sort()).toEqual([
			"activateV3LivePlane",
			"prepareV3LiveGeneration",
			"recoverV3LiveReplica",
			"republishV3RetainedTo",
			"routeV3Ingress",
			"routeV3RetainedIngress",
		]);
	});
});
