/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native prepared-runtime fixture inference is retained. */
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { applyPreparedBlueprintOperation } from "@ts-drp/protocol-v3/blueprint-application";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";

import { restoreShippingChatState, shippingChatCanonicalStateBytes } from "../examples/chat/src/v3-chat-application.js";

// Compiler/runtime component only. A syntax build's placeholder receipt is NOT
// trusted catalog material or native shipping-room acceptance.
const alice = "a".repeat(64),
	bob = "b".repeat(64);
const send = (id = "immutable-1", text = "棋 ♟ café", displayTimeMs = 1791662400000) => ({
	action: "message",
	clientOperationId: id,
	displayTimeMs,
	text,
});
let runtime: Awaited<ReturnType<typeof prepareBlueprintRuntime>>;
let blueprintDigest: string;
beforeAll(async () => {
	const directory = process.env.SHIPPING_CHAT_BUNDLE_DIR;
	if (directory === undefined) throw new TypeError("SHIPPING_CHAT_BUNDLE_DIR must name exact compiler output");
	const packageBytes = new Uint8Array(readFileSync(join(directory, "package.bin")));
	blueprintDigest = Buffer.from(hashDomain("ts-drp/blueprint-admission/v3", packageBytes)).toString("hex");
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: packageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	runtime = await prepareBlueprintRuntime({
		preparedBlueprintAdmission: admission,
		canonicalBlueprintPackageBytes: packageBytes,
		expectedBlueprintDigest: blueprintDigest,
		exactArtifactBytes: new Uint8Array(readFileSync(join(directory, "artifact.mjs"))),
	});
});
const apply = (state: unknown, operation = send(), author = alice) =>
	applyPreparedBlueprintOperation({
		expectedBlueprintDigest: blueprintDigest,
		preparedBlueprintRuntime: runtime,
		state,
		operation,
		executionContext: { author },
	});

it("compiled reducer derives sender solely from authenticated execution context and retains signed time/text", () => {
	const result = apply([]);
	expect(result.state).toEqual([
		{ author: alice, clientOperationId: "immutable-1", displayTimeMs: 1791662400000, text: "棋 ♟ café" },
	]);
	expect(() => apply([], { ...send(), author: bob } as ReturnType<typeof send>)).toThrow();
	expect(() => apply([], send(), "transport-peer-is-not-an-author")).toThrow();
});
it("compiled exact retry preserves one effect before and after exact snapshot restoration", () => {
	const first = apply([]).state;
	const retry = apply(first).state;
	expect(shippingChatCanonicalStateBytes(retry)).toEqual(shippingChatCanonicalStateBytes(first));
	const snapshot = restoreShippingChatState(shippingChatCanonicalStateBytes(first));
	expect(shippingChatCanonicalStateBytes(apply(snapshot).state)).toEqual(shippingChatCanonicalStateBytes(first));
	expect(apply(snapshot, send("independent-2")).state as unknown[]).toHaveLength(2);
});
it("compiled conflicting time/text refuses without modifying complete source state", () => {
	const first = apply([]).state;
	const exact = shippingChatCanonicalStateBytes(first);
	expect(() => apply(first, send("immutable-1", "altered"))).toThrow();
	expect(() => apply(first, send("immutable-1", "棋 ♟ café", 1791662400001))).toThrow();
	expect(shippingChatCanonicalStateBytes(first)).toEqual(exact);
});
it("identical sends by distinct authenticated authors remain distinct and order permutations have identical complete state bytes", () => {
	const forward = apply(apply([]).state, send(), bob).state;
	const reverse = apply(apply([], send(), bob).state).state;
	expect(forward as unknown[]).toHaveLength(2);
	expect(encodeCanonical(forward)).toEqual(encodeCanonical(reverse));
});
it("compiled application batch preserves sender/time and exact duplicate effect semantics", () => {
	const operation = {
		action: "applicationBatch",
		batch: {
			version: 1,
			entries: [
				{ logicalTime: 1, operation: send() },
				{ logicalTime: 2, operation: send() },
			],
		},
	};
	const result = applyPreparedBlueprintOperation({
		expectedBlueprintDigest: blueprintDigest,
		preparedBlueprintRuntime: runtime,
		state: [],
		operation,
		executionContext: { author: bob },
	});
	expect(result.state).toEqual([
		{ author: bob, clientOperationId: "immutable-1", displayTimeMs: 1791662400000, text: "棋 ♟ café" },
	]);
	expect(result.output).toHaveLength(2);
});
