import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	commitGenuineCreatorAdoptionFixture,
	type GenuineCreatorAdoptionFixture,
} from "./creator-adoption-contract.js";
import { REPOSITORY_ROOT } from "./creator-successor-activation-contract.js";
import { hexBytes } from "../phase-3a0-v3/controlled-anchor-trust.js";

export const D108D1A_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-handle-identity-contract.ts",
	"tests/phase-6a-creator-successor-handle-identity-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-activation-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-activation-death-red.test.ts",
	"tests/phase-3-exit-envelope-purity-red.test.ts",
] as const);

export const D108D1A_GREEN_PATHS = Object.freeze([
	"packages/node/src/creator-adoption-activate.ts",
	"packages/node/src/internal/creator-successor-live.ts",
	"packages/node/src/v3-live.ts",
] as const);

export const D108D1A_V3_LIVE_EXPORTS = Object.freeze([
	"activateV3LivePlane",
	"bindV3BlueprintLivePlane",
	"prepareV3LiveGeneration",
	"recoverV3LiveReplica",
	"republishV3RetainedTo",
	"routeV3Ingress",
	"routeV3RetainedIngress",
] as const);

export const D108D1A_HOT_BEHAVIOR =
	"returned hot wrapper retains route, admission, targeted replay and deactivation identity";
export const D108D1A_COLD_BEHAVIOR =
	"two independent cold wrappers retain identity-keyed publication after awaited release";

const PRIVATE_KEY_SEED_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

export interface D108d1aCandidateModule {
	activateCreatorSuccessorAdoption?(input: unknown): Promise<Readonly<Record<string, unknown>>>;
}

export interface D108d1aV3LiveModule {
	republishV3RetainedTo?(handle: object, targetPeerId: string): Promise<Readonly<Record<string, unknown>>>;
	routeV3RetainedIngress?(handle: object, message: Message): boolean;
}

/**
 * Reports whether the private wrapper-to-registration bridge is installed in all three frozen owners.
 * @returns The exact missing bridge facts and composite readiness decision.
 */
export function d108d1aReadiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const internalPath = resolve(REPOSITORY_ROOT, D108D1A_GREEN_PATHS[1]);
	const activationPath = resolve(REPOSITORY_ROOT, D108D1A_GREEN_PATHS[0]);
	const livePath = resolve(REPOSITORY_ROOT, D108D1A_GREEN_PATHS[2]);
	const internal = existsSync(internalPath) ? readFileSync(internalPath, "utf8") : "";
	const activation = existsSync(activationPath) ? readFileSync(activationPath, "utf8") : "";
	const live = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
	const facts = Object.freeze({
		activationConsumer: /consumeCreatorSuccessorHandleAlias\s*\(/u.test(activation),
		internalBridge:
			/installCreatorSuccessorHandleAlias/u.test(internal) && /consumeCreatorSuccessorHandleAlias/u.test(internal),
		liveInstaller: /installCreatorSuccessorHandleAlias\s*\(/u.test(live),
	});
	const missing = Object.entries(facts)
		.filter(([, value]) => !value)
		.map(([name]) => name);
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

/**
 * Checks that the private bridge did not escape through package or product surfaces.
 * @returns Exact non-export and non-consumer governance facts.
 */
export function d108d1aSourceGovernance(): Readonly<{
	readonly noManifestExport: boolean;
	readonly noProductConsumer: boolean;
	readonly noRootExport: boolean;
}> {
	const marker = /CreatorSuccessorHandleAlias|creatorSuccessorHandleAlias/u;
	const root = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/index.ts"), "utf8");
	const manifest = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/package.json"), "utf8");
	const products = ["examples/v3-chat/src/index.ts", "examples/v3-room/src/index.ts"]
		.map((path) => readFileSync(resolve(REPOSITORY_ROOT, path), "utf8"))
		.join("\n");
	return Object.freeze({
		noManifestExport: !marker.test(manifest),
		noProductConsumer: !marker.test(products),
		noRootExport: !marker.test(root),
	});
}

/**
 * Runs the genuine predecessor verification and durable adoption commit used by the hot identity gate.
 * @param fixture - Genuine sealed predecessor and successor evidence.
 * @returns The one-use committed activation capability.
 */
export async function commitD108d1aFixture(
	fixture: GenuineCreatorAdoptionFixture
): Promise<Readonly<Record<string, unknown>>> {
	return commitGenuineCreatorAdoptionFixture(fixture);
}

/**
 * Signs one registered vertex digest with the deterministic authorized fixture key.
 * @param digest - Registered v3 vertex digest.
 * @returns Detached Ed25519 signature bytes.
 */
export function signD108d1aVertexDigest(digest: Uint8Array): Promise<Uint8Array> {
	return Promise.resolve(ed25519.sign(new Uint8Array(digest), hexBytes(PRIVATE_KEY_SEED_HEX)));
}

/**
 * Authors one independently signed, not-yet-admitted epoch-one retained envelope.
 * @param input - Authenticated successor identity, current dependency and transport identities.
 * @returns Exact canonical carrier, digest, signature and wire message.
 */
export function d108d1aRetainedMessage(
	input: Readonly<{
		readonly anchorDigest: string;
		readonly author: string;
		readonly authorSequence: number;
		readonly dependency: string;
		readonly objectId: string;
		readonly sender: string;
		readonly topic: string;
	}>
): Readonly<{
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: string;
	readonly message: Message;
	readonly signature: Uint8Array;
}> {
	const canonicalPreimageBytes = encodeCanonical({
		anchor: input.anchorDigest,
		author: input.author,
		authorSequence: input.authorSequence,
		dependencies: [input.dependency],
		epoch: 1,
		kind: "drp-vertex",
		logicalTime: input.authorSequence + 20,
		objectId: input.objectId,
		operation: { action: "add", value: 11 },
		protocolMajor: 3,
	});
	const digestBytes = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	const signature = ed25519.sign(digestBytes, hexBytes(PRIVATE_KEY_SEED_HEX));
	return Object.freeze({
		canonicalPreimageBytes,
		digest: Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		message: Message.create({
			data: V3Envelope.encode({ canonicalPreimage: canonicalPreimageBytes, signature }).finish(),
			objectId: input.topic,
			sender: input.sender,
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		}),
		signature,
	});
}
