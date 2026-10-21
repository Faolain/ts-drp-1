import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Track Y RED: the creator transition memo (packages/node/src/internal/creator-transition-advance.ts) must not keep
// E->E+1 checks for epochs the room has left. Measured on the healthy native Grid (Track Y), every hit is on the
// newest two epochs of the room's lineage; older entries are never read again, yet the memo kept them until its
// 16 MiB byte ceiling (about epoch 190, ~17 MB per client). Across many epochs the memo must hold a constant number
// of epochs per lineage, release the rest to the collector, keep other lineages' entries, keep serving the newest
// epochs, and return exactly what the original predicate returns.
//
// The memo section of the module (from its leading comment to the exported alias) is evaluated as written, with
// only its three outside names supplied: the original predicate (a recording stand-in that accepts every input
// except an explicit refusal), the trust-material resolver (a registry of test trusts, like the genuine custody
// registry: only registered trusts resolve) and compareBytes.

const SOURCE = new URL("../src/internal/creator-transition-advance.ts", import.meta.url);
const START = "// Exact-input memo for the exported VERIFY predicate.";
const END = "export { inspectCreatorTransitionAdvanceExact as inspectCreatorTransitionAdvance };";

interface Ref {
	readonly digest: string;
	readonly byteLength: number;
}
interface Candidate {
	readonly bytes: Uint8Array;
	readonly ref: Ref;
}
interface Closure {
	readonly candidates: readonly Candidate[];
	readonly closure: readonly Ref[];
}
interface Trust {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: string;
}
interface Input {
	readonly current: Closure;
	readonly currentTrust: Trust;
	readonly mode: "verify";
	readonly proofRefs: readonly Ref[];
	readonly proposed: Closure;
	readonly successorTrust: Trust;
}
type Result = Readonly<{ ok: boolean; kind?: string; reason?: string; proposed?: Closure }>;

function memoSection(): string {
	const text = readFileSync(SOURCE, "utf8");
	const start = text.indexOf(START);
	const end = text.indexOf(END);
	expect(start, "memo section start").toBeGreaterThan(0);
	expect(text.indexOf(START, start + 1), "memo section start unique").toBe(-1);
	expect(end, "memo section end").toBeGreaterThan(start);
	return text.slice(start, end);
}

function loadMemo(): {
	inspect(input: Input): Result;
	memo: Map<string, object>;
	owner(input: Input): Result;
	ownerCalls(): number;
	register(trust: Trust): void;
} {
	const js = ts.transpileModule(
		`${memoSection()}\n({ inspect: inspectCreatorTransitionAdvanceExact, memo: transitionMemo });`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
	).outputText;
	const materials = new WeakMap<Trust, Readonly<Record<string, unknown>>>();
	let calls = 0;
	const owner = (input: Input): Result =>
		input.proposed.candidates.length < 3
			? Object.freeze({ ok: false, reason: "TEST_REFUSAL" })
			: Object.freeze({ kind: "successor", ok: true, proposed: input.proposed });
	const imports = {
		inspectCreatorTransitionAdvance: (input: Input): Result => {
			calls++;
			return owner(input);
		},
		resolveSealRecoveryTrust: (trust: Trust): Readonly<Record<string, unknown>> | undefined => materials.get(trust),
		compareBytes: (left: Uint8Array, right: Uint8Array): number =>
			Buffer.compare(Buffer.from(left), Buffer.from(right)),
	};
	const loaded = Function(
		...Object.keys(imports),
		`"use strict"; return eval(${JSON.stringify(js)});`
	)(...Object.values(imports)) as { inspect(input: Input): Result; memo: Map<string, object> };
	const fill = (seed: string, size: number): Uint8Array => {
		const out = new Uint8Array(size);
		let block = createHash("sha256").update(seed).digest();
		for (let offset = 0; offset < size; offset += block.length) {
			out.set(block.subarray(0, Math.min(block.length, size - offset)), offset);
			block = createHash("sha256").update(block).digest();
		}
		return out;
	};
	return {
		...loaded,
		owner,
		ownerCalls: () => calls,
		register: (trust: Trust): void => {
			const label = `${trust.objectId}/${trust.currentEpoch}`;
			materials.set(
				trust,
				Object.freeze({
					currentAnchorDigest: trust.currentAnchorDigest,
					currentEpoch: trust.currentEpoch,
					genesisAnchorDigest: trust.genesisAnchorDigest,
					objectId: trust.objectId,
					quorum: 1,
					publicKey: fill(`${label}/key`, 32),
					exactCanonicalCurrentAnchorPreimageBytes: fill(`${label}/anchor`, 240),
					detachedCurrentAnchorSignature: fill(`${label}/signature`, 64),
					exactCanonicalProfileBytes: fill(`${label}/profile`, 120),
					exactCanonicalSignerSetBytes: fill(`${label}/signers`, 90),
				})
			);
		},
	};
}

type Memo = ReturnType<typeof loadMemo>;

function hex(seed: string): string {
	return createHash("sha256").update(seed).digest("hex");
}

function candidate(seed: string, size: number): Candidate {
	const bytes = new Uint8Array(size);
	const block = createHash("sha256").update(seed).digest();
	for (let offset = 0; offset < size; offset++) bytes[offset] = block[offset % block.length] ?? 0;
	return Object.freeze({
		bytes,
		ref: Object.freeze({ digest: createHash("sha256").update(bytes).digest("hex"), byteLength: size }),
	});
}

function closure(candidates: readonly Candidate[]): Closure {
	return Object.freeze({
		candidates: Object.freeze([...candidates]),
		closure: Object.freeze(candidates.map((item) => item.ref).sort((a, b) => (a.digest < b.digest ? -1 : 1))),
	});
}

/** One room lineage: genuine-shaped E->E+1 verify inputs whose trusts resolve through the test registry. */
function lineage(memo: Memo, name: string, candidateBytes = 4096) {
	const trusts = new Map<number, Trust>();
	const trust = (epoch: number): Trust => {
		let value = trusts.get(epoch);
		if (value === undefined) {
			value = Object.freeze({
				currentAnchorDigest: hex(`${name}/anchor/${epoch}`),
				currentEpoch: epoch,
				genesisAnchorDigest: hex(`${name}/genesis`),
				objectId: `object-${name}`,
				profileId: "creator-trusted-settlement-v1",
			});
			memo.register(value);
			trusts.set(epoch, value);
		}
		return value;
	};
	return (epoch: number, options: { refuse?: boolean; variant?: string } = {}): Input => {
		const cut = candidate(`${name}/cut/${epoch}`, 180);
		const qc = candidate(`${name}/qc/${epoch}`, 160);
		const successor = candidate(`${name}/state/${epoch + 1}${options.variant ?? ""}`, candidateBytes);
		return Object.freeze({
			current: closure([candidate(`${name}/state/${epoch}`, candidateBytes)]),
			currentTrust: trust(epoch),
			mode: "verify" as const,
			proofRefs: Object.freeze([cut.ref, qc.ref]),
			proposed: closure(options.refuse === true ? [successor] : [successor, cut, qc]),
			successorTrust: trust(epoch + 1),
		});
	};
}

/** Runs one check and, when it inserted an entry, records which lineage and epoch that entry holds. */
function check(memo: Memo, held: WeakMap<object, string>, label: string, input: Input): Result {
	const before = new Set(memo.memo.values());
	const result = memo.inspect(input);
	for (const entry of memo.memo.values()) if (!before.has(entry)) held.set(entry, label);
	return result;
}

function heldEpochs(memo: Memo, held: WeakMap<object, string>, name: string): number[] {
	return [...memo.memo.values()]
		.map((entry) => held.get(entry))
		.filter((label): label is string => label?.startsWith(`${name}/`) === true)
		.map((label) => Number(label.slice(name.length + 1)))
		.sort((a, b) => a - b);
}

async function collectGarbage(): Promise<void> {
	setFlagsFromString("--expose_gc");
	const gc = runInNewContext("gc") as () => void;
	for (let round = 0; round < 3; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
	}
}

describe("Track Y: the transition memo keeps a constant number of epochs per room lineage", () => {
	it("holds only the newest epochs of a lineage across 300 epochs and still serves them from memory", () => {
		const memo = loadMemo();
		const held = new WeakMap<object, string>();
		const room = lineage(memo, "a");
		for (let epoch = 0; epoch < 300; epoch++) {
			expect(check(memo, held, `a/${epoch}`, room(epoch))).toMatchObject({ ok: true });
			// Within a transition the verifiers re-inspect the same closure: a hit, no recomputation.
			const calls = memo.ownerCalls();
			expect(memo.inspect(room(epoch))).toMatchObject({ ok: true });
			expect(memo.ownerCalls()).toBe(calls);
		}
		const epochs = heldEpochs(memo, held, "a");
		expect(epochs.length).toBeGreaterThan(0);
		expect(epochs[0], `oldest epoch held of ${epochs.length}`).toBeGreaterThanOrEqual(296);
		expect(memo.memo.size).toBeLessThanOrEqual(4);
		// The lull re-authenticates the previous boundary: the newest two epochs stay hits.
		const calls = memo.ownerCalls();
		expect(memo.inspect(room(299))).toMatchObject({ ok: true });
		expect(memo.inspect(room(298))).toMatchObject({ ok: true });
		expect(memo.ownerCalls()).toBe(calls);
	});

	it("releases the entries of epochs the room has left to the garbage collector", async () => {
		const memo = loadMemo();
		// Synchronous helper: a suspended async frame keeps its stale registers (here the loop's last entry)
		// alive across the await, which would hold one early entry no matter what the memo does.
		const early = ((): WeakRef<object>[] => {
			const held = new WeakMap<object, string>();
			const room = lineage(memo, "a", 32 * 1024);
			const refs: WeakRef<object>[] = [];
			for (let epoch = 0; epoch < 200; epoch++) {
				const before = new Set(memo.memo.values());
				check(memo, held, `a/${epoch}`, room(epoch));
				if (epoch < 10) for (const entry of memo.memo.values()) if (!before.has(entry)) refs.push(new WeakRef(entry));
			}
			return refs;
		})();
		expect(early).toHaveLength(10);
		await collectGarbage();
		expect(early.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
	});

	it("keeps another room's entries when one room advances", () => {
		const memo = loadMemo();
		const held = new WeakMap<object, string>();
		const quiet = lineage(memo, "b");
		const busy = lineage(memo, "a");
		for (let epoch = 0; epoch < 6; epoch++) check(memo, held, `b/${epoch}`, quiet(epoch));
		for (let epoch = 0; epoch < 120; epoch++) check(memo, held, `a/${epoch}`, busy(epoch));
		expect(heldEpochs(memo, held, "b")).toContain(5);
		const calls = memo.ownerCalls();
		expect(memo.inspect(quiet(5))).toMatchObject({ ok: true });
		expect(memo.ownerCalls()).toBe(calls);
	});

	it("returns exactly the original predicate's result for every input, trimmed or not", () => {
		const memo = loadMemo();
		const held = new WeakMap<object, string>();
		const room = lineage(memo, "a");
		const compare = (input: Input): void => {
			const actual = memo.inspect(input);
			const expected = memo.owner(input);
			expect({ ok: actual.ok, kind: actual.kind, reason: actual.reason }).toEqual({
				ok: expected.ok,
				kind: expected.kind,
				reason: expected.reason,
			});
			if (expected.ok) expect(actual.proposed).toBe(input.proposed);
			expect(Object.isFrozen(actual)).toBe(true);
		};
		for (let epoch = 0; epoch < 60; epoch++) {
			check(memo, held, `a/${epoch}`, room(epoch));
			compare(room(epoch));
			if (epoch >= 1) compare(room(epoch - 1));
			if (epoch >= 7) compare(room(epoch - 7));
			compare(room(epoch, { refuse: true }));
			compare(room(epoch, { variant: "-other" }));
		}
	});
});
