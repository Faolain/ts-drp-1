import { ed25519 } from "@noble/curves/ed25519.js";
import { type Serializable, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { type GenuineCreatorAdoptionFixture, openGenuineCreatorAdoptionFixture } from "./creator-adoption-contract.js";
import {
	CREATOR_SUCCESSOR_LOCAL_AUTHOR_REOPEN_INPUT_KEYS,
	REPOSITORY_ROOT,
} from "./creator-successor-activation-contract.js";
import { workspacePackageImportHook } from "../shared/workspace-package-subprocess.mjs";

export const D108D1B_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-adoption-contract.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts",
	"tests/phase-6a-creator-successor-activation-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-activation-child.mjs",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
] as const);

export const D108D1B_GREEN_PATHS = Object.freeze([
	"packages/node/src/creator-adoption-activate.ts",
	"packages/node/src/creator-adoption.ts",
	"packages/node/src/internal/creator-successor-live.ts",
] as const);

export const D108D1B_ORACLE_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
] as const);

export const D108D1B_ORACLE_GREEN_PATHS = Object.freeze([
	"packages/node/src/creator-adoption.ts",
	"packages/node/src/v3-live.ts",
] as const);

export const D108E2C_TEST_PATHS = Object.freeze([
	"tests/phase-3a1b-p3-live-transport-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
] as const);

export const D108E2C_RED_PATHS = Object.freeze([
	"tests/phase-3a1b-p3-live-transport-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
] as const);

export const D108E2C_GREEN_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
] as const);

export const D108E2D_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
] as const);

export const D108E2D_GREEN_PATHS = Object.freeze(["packages/node/src/v3-live.ts"] as const);

export const D108E2E_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
] as const);

export const D108E2E_GREEN_PATHS = Object.freeze(["packages/node/src/v3-live.ts"] as const);

export const D108E4_TEST_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.ts",
	"tests/phase-6a-creator-successor-local-author-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-activation-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts",
	"tests/phase-3a1b-p3-live-transport-red.test.ts",
	"tests/fixtures/shared/workspace-package-export-file.mjs",
	"tests/phase-6a-creator-successor-infrastructure-red.test.ts",
	"tests/phase-3a1b-d9336-two-client-room.pw.ts",
	"tests/phase-3a1b-d9346-v3-zone.pw.ts",
	"tests/e5-00-zone-trade-intent.pw.ts",
	"tests/e5-02-zone-referee-outcome.pw.ts",
] as const);

export const D108D1B_REOPEN_INPUT_KEYS = CREATOR_SUCCESSOR_LOCAL_AUTHOR_REOPEN_INPUT_KEYS;
export const D108D1B_CHILD_BEHAVIORS = Object.freeze([
	"fresh Node binds established and fresh chat peers while every ambiguous or unauthenticated cold reopen fails before live effects",
] as const);
export const D108E2D_CHILD_BEHAVIORS = Object.freeze([
	"fresh Node predecessor recovery terminates with one issued-record read per distinct current or authenticated-future row",
] as const);
export const D108E2E_CHILD_BEHAVIORS = Object.freeze([
	"fresh Node predecessor recovery enforces one cumulative authenticated future-row skip budget per recovery",
] as const);
export const D108E4_CHILD_BEHAVIORS = Object.freeze([
	"fresh Node closes the D.108e4 authenticated oracle and per-reopen budget debt",
] as const);
export const D108E4_ACTIVATION_BROWSER_BEHAVIORS = Object.freeze([
	"window observes lock authority before durable store opening and possession probes use exact suffixed databases",
] as const);
export const D108E4_INFRASTRUCTURE_BEHAVIORS = Object.freeze([
	"imports one explicit workspace package export only from its own fresh built file",
	"rejects every non-package-self workspace export-file target",
] as const);
export const D108E4_ZONE_BEHAVIORS = Object.freeze([
	"waits for reciprocal raw unreliable links before one measured movement in each direction",
] as const);
export const D108D1B_ORACLE_BROWSER_BEHAVIORS = Object.freeze([
	"wrong-key and throwing browser possession fail before writer activation",
] as const);

export interface D108d1bChildMessage {
	readonly kind: string;
	readonly message?: string;
	readonly proof?: Readonly<Record<string, unknown>>;
}

const CHAT_CLIENTS = Object.freeze([
	Object.freeze({
		groups: Object.freeze(["admin", "finality", "writer"] as const),
		id: "alice",
		seed: "d9336-v3-chat-alice",
	}),
	Object.freeze({ groups: Object.freeze(["admin", "writer"] as const), id: "bob", seed: "d9336-v3-chat-bob" }),
	Object.freeze({ groups: Object.freeze(["writer"] as const), id: "carol", seed: "d9339-v3-chat-carol" }),
	Object.freeze({ groups: Object.freeze(["finality"] as const), id: "dave", seed: "d9339-v3-chat-dave" }),
	Object.freeze({ groups: Object.freeze(["writer"] as const), id: "erin", seed: "d9339-v3-chat-erin" }),
	Object.freeze({ groups: Object.freeze(["writer"] as const), id: "frank", seed: "d9339-v3-chat-frank" }),
	Object.freeze({ groups: Object.freeze(["writer"] as const), id: "grace", seed: "d9339-v3-chat-grace" }),
	Object.freeze({ groups: Object.freeze(["writer"] as const), id: "heidi", seed: "d9339-v3-chat-heidi" }),
] as const);

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function localAuthorSeed(configuredSeed: string): Uint8Array {
	const seed = createHash("sha512").update(new TextEncoder().encode(configuredSeed)).digest();
	const domain = new TextEncoder().encode("ts-drp-keychain/local-author-ed25519/v1");
	const preimage = new Uint8Array(domain.byteLength + 1 + seed.byteLength);
	preimage.set(domain);
	preimage.set(seed, domain.byteLength + 1);
	return new Uint8Array(createHash("sha256").update(preimage).digest());
}

/**
 * Returns the shipped chat clients' exact local Ed25519 identities and ACL
 * groups. The close fixture intentionally models group projection only; it
 * does not claim exact product finality-key custody.
 * @returns The bounded authority projection used by the genuine close fixture.
 */
export function d108d1bChatAuthorities(): readonly Readonly<{
	readonly author: string;
	readonly groups: readonly ("admin" | "finality" | "writer")[];
	readonly id: (typeof CHAT_CLIENTS)[number]["id"];
	readonly privateKeySeedHex: string;
}>[] {
	return Object.freeze(
		CHAT_CLIENTS.map((client) => {
			const seed = localAuthorSeed(client.seed);
			return Object.freeze({
				author: hex(ed25519.getPublicKey(seed)),
				groups: client.groups,
				id: client.id,
				privateKeySeedHex: hex(seed),
			});
		})
	);
}

/** @returns One genuine successor close containing Bob's accepted epoch-zero vertex. */
export async function openD108d1bMultiWriterFixture(): Promise<GenuineCreatorAdoptionFixture> {
	const authorities = d108d1bChatAuthorities();
	const established = authorities.find(({ id }) => id === "bob");
	if (established === undefined) throw new TypeError("D.108d1b established chat authority is unavailable");
	return openGenuineCreatorAdoptionFixture({
		authorizedPrivateKeySeedHexes: authorities.map(({ privateKeySeedHex }) => privateKeySeedHex),
		establishedPeerPrivateKeySeedHex: established.privateKeySeedHex,
		successorAclGroups: Object.freeze(Object.fromEntries(authorities.map(({ author, groups }) => [author, groups]))),
	});
}

/**
 * Runs the genuine built-package local-author child in the labeled mode.
 * @param input - Packed durable successor material.
 * @param label - Stable child failure label.
 * @returns The child's single terminal proof message.
 */
function runLocalAuthorChild(input: unknown, label: string): Promise<D108d1bChildMessage> {
	return new Promise((resolvePromise, reject) => {
		const childPath = resolve(
			REPOSITORY_ROOT,
			"packages/storage-node/tests/fixtures/phase-6a-creator-successor-local-author-child.mjs"
		);
		const importHook = workspacePackageImportHook({
			expectedImports: {
				"@ts-drp/canonical": resolve(REPOSITORY_ROOT, "packages/canonical/dist/src/index.js"),
				"@ts-drp/message-queue": resolve(REPOSITORY_ROOT, "packages/message-queue/dist/src/index.js"),
				"@ts-drp/node/creator-adoption-activate": resolve(
					REPOSITORY_ROOT,
					"packages/node/dist/src/creator-adoption-activate.js"
				),
				"@ts-drp/node/v3-live": resolve(REPOSITORY_ROOT, "packages/node/dist/src/v3-live.js"),
				"@ts-drp/protocol-v3/latched-acl": resolve(REPOSITORY_ROOT, "packages/protocol-v3/dist/src/latched-acl.js"),
				"@ts-drp/storage-node": resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/index.js"),
				"@ts-drp/storage-node/issuance": resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/issuance.js"),
				"@ts-drp/storage-node/live-journal": resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/live-journal.js"),
				"@ts-drp/storage-node/snapshot-transfer": resolve(
					REPOSITORY_ROOT,
					"packages/storage-node/dist/src/snapshot-transfer.js"
				),
			},
		});
		const child = spawn(process.execPath, [importHook, childPath], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let observed: D108d1bChildMessage | undefined;
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${label} child timeout: ${stderr}`));
		}, 90_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: D108d1bChildMessage) => (observed = message));
		child.once("error", reject);
		child.once("spawn", () => child.send(input as Serializable));
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0 || observed === undefined || observed.kind === "child-error") {
				reject(new Error(observed?.message ?? `${label} child failed (${String(code)}): ${stderr}`));
			} else resolvePromise(observed);
		});
	});
}

/**
 * Runs the genuine D.108d1b built-package local-author matrix.
 * @param input - Packed durable successor material.
 * @returns The child's single terminal proof message.
 */
export function runD108d1bLocalAuthorChild(input: unknown): Promise<D108d1bChildMessage> {
	return runLocalAuthorChild(input, "D.108d1b");
}

/**
 * Runs the separate D.108e2e cumulative predecessor-skip proof.
 * @param input - Packed durable successor material.
 * @returns The child's single terminal proof message.
 */
export function runD108e2eSkipBudgetChild(input: unknown): Promise<D108d1bChildMessage> {
	return runLocalAuthorChild(Object.freeze({ material: input, mode: "skip-budget" }), "D.108e2e");
}
