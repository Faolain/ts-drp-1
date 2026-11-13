import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {prepareBlueprintAdmission, prepareBlueprintRuntime, type PreparedBlueprintRuntime} from "../../protocol-v3/src/public.js";
import {BlueprintStateMachine, foldBlueprintEpoch} from "../src/blueprint-fold.js";
import type {EpochVertex} from "../src/types.js";
import blueprintPackage from "../../../tests/fixtures/phase-4a-v3/blueprint-package.json" with {type: "json"};

// A staging fork does not hash its state (the room's admission-time state check forks per candidate).
// Every consumer that needs the digest still gets the exact digest of the exact bytes: snapshot(), adopt()
// into a parent, a fork of a fork, and an epoch fold's staged snapshot.

const calls = vi.hoisted(() => ({hash: 0}));
vi.mock("@ts-drp/canonical", async importOriginal => {
	const actual = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {...actual, hashDomain: (...args: Parameters<typeof actual.hashDomain>) => {calls.hash++; return actual.hashDomain(...args);}};
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const digestOf = (bytes: Uint8Array) => hex(hashDomain("ts-drp/state/v3", bytes));
let runtimePromise: Promise<PreparedBlueprintRuntime> | undefined;
function runtime() {
	return runtimePromise ??= (() => {
		const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
		const expectedBlueprintDigest = hex(hashDomain("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes));
		const preparedBlueprintAdmission = prepareBlueprintAdmission({canonicalBlueprintPackageBytes, expectedBlueprintDigest});
		return prepareBlueprintRuntime({canonicalBlueprintPackageBytes, expectedBlueprintDigest, preparedBlueprintAdmission,
			exactArtifactBytes: new Uint8Array(readFileSync(new URL("../../../tests/fixtures/phase-4a-v3/application-blueprint.mjs", import.meta.url)))});
	})();
}
function machine(prepared: PreparedBlueprintRuntime) {
	const bytes = encodeCanonical({map: {}, set: [], total: 1});
	return new BlueprintStateMachine({exactCanonicalInitialStateBytes: bytes, expectedBlueprintDigest: prepared.blueprintDigest,
		expectedInitialStateDigest: digestOf(bytes), preparedBlueprintRuntime: prepared});
}
const exact = (value: BlueprintStateMachine) => {
	const snapshot = value.snapshot();
	return {digest: snapshot.stateDigest, expected: digestOf(snapshot.exactCanonicalStateBytes)};
};

describe("digest-free staging fork", () => {
	it("a fork of a machine whose digest is not yet known hashes nothing", async () => {
		const parent = machine(await runtime());
		parent.apply({action: "mutate_inputs", value: 3}); // the parent's digest is now unknown
		calls.hash = 0;
		const staged = parent.fork();
		staged.apply({action: "mutate_inputs", value: 4});
		const next = staged.fork();
		expect(calls.hash, "staging forks and applies hash nothing").toBe(0);
		expect(next.exactStateByteLength).toBeGreaterThan(0);
	});

	it("snapshot, adopt, a fork of a fork and an epoch fold still publish the exact digest", async () => {
		const prepared = await runtime();
		const parent = machine(prepared);
		parent.apply({action: "mutate_inputs", value: 3});
		const staged = parent.fork();
		staged.apply({action: "mutate_inputs", value: 4});
		const {digest, expected} = exact(staged);
		expect(digest).toBe(expected);
		// adopt an unhashed stage: the parent publishes the stage's exact digest
		const second = parent.fork();
		second.apply({action: "mutate_inputs", value: 9});
		parent.adopt(second);
		const adopted = exact(parent);
		expect(adopted.digest).toBe(adopted.expected);
		// a fork of a fork of an unhashed parent
		parent.apply({action: "mutate_inputs", value: 10});
		const grandchild = parent.fork().fork();
		const descended = exact(grandchild);
		expect(descended.digest).toBe(descended.expected);
		expect(descended.digest).toBe(exact(parent).digest);
		// an epoch fold on an unhashed machine
		parent.apply({action: "mutate_inputs", value: 11});
		const anchorHash = "0".repeat(64), objectId = "lazy-digest", epoch = 1;
		const vertices = new Map<string, EpochVertex>([
			[anchorHash, {hash: anchorHash, kind: "drp-epoch-anchor", objectId, epoch, dependencies: []}],
			["1".repeat(64), {hash: "1".repeat(64), kind: "drp-vertex", objectId, epoch, anchor: anchorHash, dependencies: [anchorHash],
				operation: {action: "mutate_inputs", value: 12} as NonNullable<EpochVertex["operation"]>}],
		]);
		const fold = foldBlueprintEpoch({anchorHash, machine: parent, vertices, authorize: () => true});
		expect(fold.staged.stateDigest).toBe(digestOf(fold.staged.exactCanonicalStateBytes));
		const published = fold.adopt();
		expect(published.stateDigest).toBe(digestOf(published.exactCanonicalStateBytes));
	});
});
