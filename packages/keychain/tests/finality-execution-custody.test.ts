import type * as Libp2pCryptoKeys from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
	bindCreatorIssuanceRetirementSigningRequest,
	mintCreatorIssuanceRetirementSigningRequest,
	scopeCreatorIssuanceRetirementSigningRequest,
} from "@ts-drp/protocol-v3/internal/creator-issuance-retirement-signing-request";
import {
	bindSealSigningRequest,
	mintSealSigningRequest,
	type SigningNativeAdmission,
} from "@ts-drp/protocol-v3/internal/seal-signing-request";
import { beforeEach, expect, test, vi } from "vitest";

import {
	bindCreatorAnchorSigningRequest,
	mintCreatorAnchorSigningRequest,
	scopeCreatorAnchorSigningRequest,
} from "../../protocol-v3/src/internal/seal-authority-custody.js";

import * as finality from "../src/finality.js";

const hooks = vi.hoisted(() => ({
	wait: undefined as Promise<void> | undefined,
	failure: undefined as Error | undefined,
	entered: 0,
	enteredWaiters: [] as { count: number; resolve(): void }[],
}));
vi.mock("@libp2p/crypto/keys", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof Libp2pCryptoKeys;
	return {
		...actual,
		async generateKeyPairFromSeed(type: "Ed25519", seed: Uint8Array): Promise<Ed25519PrivateKey> {
			const key = await actual.generateKeyPairFromSeed(type, seed);
			const originalSign = key.sign.bind(key);
			Object.defineProperty(key, "sign", {
				configurable: true,
				async value(digest: Uint8Array): Promise<Uint8Array> {
					const wait = hooks.wait;
					hooks.entered++;
					for (const waiter of hooks.enteredWaiters) if (hooks.entered >= waiter.count) waiter.resolve();
					await wait;
					if (hooks.failure !== undefined) throw hooks.failure;
					return originalSign(digest);
				},
			});
			return key;
		},
	};
});

const digest = new Uint8Array(32).fill(7);
const create = (): ReturnType<typeof finality.createRecoverableFinalitySigner> =>
	finality.createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(3) });
// Scoped/admitted doubles are premises of these VOLATILE custody units,
// not proof of native retirement exclusion. Native controls cover that separately.
const scope = {
	objectId: "unit:finality-custody",
	epoch: 0,
	round: 0,
	signerId: "unit",
	publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(3)),
};
// Keep the tested asynchronous admission boundary of this volatile unit double.
// eslint-disable-next-line @typescript-eslint/require-await
const nativePremise = async (): Promise<SigningNativeAdmission> => ({
	async check(): Promise<void> {},
	async release(): Promise<void> {},
});
function sign(signer: finality.FinalitySigner): Promise<Uint8Array> {
	const request = mintSealSigningRequest(digest, scope);
	bindSealSigningRequest(request, nativePremise);
	return finality.signSealRegisteredDigest({ signer, request });
}
function entered(count = 1): Promise<void> {
	return hooks.entered >= count
		? Promise.resolve()
		: new Promise((resolve) => hooks.enteredWaiters.push({ count, resolve }));
}
function waitForRelease(): () => void {
	let finish!: () => void;
	hooks.wait = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return finish;
}
beforeEach(() => {
	hooks.wait = undefined;
	hooks.failure = undefined;
	hooks.entered = 0;
	hooks.enteredWaiters = [];
});

test("finality execution: exclusion immediately refuses new work and joins entered real Ed25519 signing", async () => {
	const { signer, publicKey } = await create();
	const finish = waitForRelease();
	const admitted = sign(signer);
	await entered();
	expect(hooks.entered).toBe(1);
	let returned = false;
	const acquisition = finality.acquireFinalitySigningExclusion({ signer }).then((value) => {
		returned = true;
		return value;
	});
	await expect(sign(signer)).rejects.toThrow("finality signing is excluded");
	expect(returned).toBe(false);
	expect(hooks.entered).toBe(1);
	finish();
	const signature = await admitted;
	expect(ed25519.verify(signature, digest, publicKey, { zip215: false })).toBe(true);
	const held = await acquisition;
	await held.check();
	await expect(finality.acquireFinalitySigningExclusion({ signer })).rejects.toThrow("finality signing is excluded");
	await held.release();
	await held.release();
	await expect(held.check()).rejects.toThrow("finality signing exclusion is released");
	expect(ed25519.verify(await sign(signer), digest, publicKey, { zip215: false })).toBe(true);
	await finality.retireRecoverableFinalitySigner({ signer });
});

test("finality execution: the same exclusion covers seal, anchor and retirement requests without consuming refused requests", async () => {
	const { signer, publicKey } = await create();
	const held = await finality.acquireFinalitySigningExclusion({ signer });
	const anchor = mintCreatorAnchorSigningRequest(digest);
	scopeCreatorAnchorSigningRequest(anchor, scope);
	bindCreatorAnchorSigningRequest(anchor, nativePremise);
	const retirement = mintCreatorIssuanceRetirementSigningRequest(digest);
	scopeCreatorIssuanceRetirementSigningRequest(retirement, scope);
	bindCreatorIssuanceRetirementSigningRequest(retirement, nativePremise);
	await expect(finality.signCreatorAnchorRequest({ signer, request: anchor })).rejects.toThrow(
		"finality signing is excluded"
	);
	await expect(finality.signCreatorIssuanceRetirementRequest({ signer, request: retirement })).rejects.toThrow(
		"finality signing is excluded"
	);
	expect(hooks.entered).toBe(0);
	await held.release();
	expect(
		ed25519.verify(await finality.signCreatorAnchorRequest({ signer, request: anchor }), digest, publicKey, {
			zip215: false,
		})
	).toBe(true);
	expect(
		ed25519.verify(
			await finality.signCreatorIssuanceRetirementRequest({ signer, request: retirement }),
			digest,
			publicKey,
			{ zip215: false }
		)
	).toBe(true);
	await finality.retireRecoverableFinalitySigner({ signer });
});

test("finality execution: terminal key retirement joins the admitted failure and preserves its original cause", async () => {
	const { signer } = await create();
	const finish = waitForRelease();
	const primary = new Error("ORIGINAL_ENTERED_SIGNATURE_FAILURE");
	hooks.failure = primary;
	const admitted = sign(signer);
	const observed = expect(admitted).rejects.toBe(primary);
	await entered();
	let joined = false;
	const retiring = finality.retireRecoverableFinalitySigner({ signer }).then(() => {
		joined = true;
	});
	await expect(sign(signer)).rejects.toThrow("finality signer is retired");
	expect(joined).toBe(false);
	finish();
	await observed;
	await retiring;
	await finality.retireRecoverableFinalitySigner({ signer });
	await expect(finality.acquireFinalitySigningExclusion({ signer })).rejects.toThrow("finality signer is retired");
	expect(hooks.entered).toBe(1);
});

test("finality execution: terminal revocation during acquisition never returns a live exclusion", async () => {
	const { signer } = await create();
	const finish = waitForRelease();
	const admitted = sign(signer);
	const acquisition = finality.acquireFinalitySigningExclusion({ signer });
	const observed = expect(acquisition).rejects.toThrow("finality signer is retired");
	const retiring = finality.retireRecoverableFinalitySigner({ signer });
	finish();
	await admitted;
	await observed;
	await retiring;
});

test("finality execution: foreign signers, accessor selectors and copied exclusion facades confer no custody", async () => {
	const { signer } = await create();
	await expect(finality.acquireFinalitySigningExclusion({ signer: {} as finality.FinalitySigner })).rejects.toThrow(
		"untrusted finality signer"
	);
	let getterCalls = 0;
	const selector = Object.defineProperty({}, "signer", {
		enumerable: true,
		get() {
			getterCalls++;
			return signer;
		},
	});
	await expect(
		finality.acquireFinalitySigningExclusion(selector as { signer: finality.FinalitySigner })
	).rejects.toThrow("finality signer selector is malformed");
	expect(getterCalls).toBe(0);
	const held = await finality.acquireFinalitySigningExclusion({ signer });
	await expect({ ...held }.release()).rejects.toThrow("foreign finality signing exclusion");
	await held.check();
	await held.release();
	await finality.retireRecoverableFinalitySigner({ signer });
});

test("finality execution: exclusion waits for every independently entered signature, not only the first", async () => {
	const { signer, publicKey } = await create();
	const finishFirst = waitForRelease();
	const first = sign(signer);
	await entered();
	const finishSecond = waitForRelease();
	const second = sign(signer);
	await entered(2);
	expect(hooks.entered).toBe(2);
	let returned = false;
	const acquisition = finality.acquireFinalitySigningExclusion({ signer }).then((value) => {
		returned = true;
		return value;
	});
	finishFirst();
	expect(ed25519.verify(await first, digest, publicKey, { zip215: false })).toBe(true);
	expect(returned).toBe(false);
	await expect(sign(signer)).rejects.toThrow("finality signing is excluded");
	finishSecond();
	expect(ed25519.verify(await second, digest, publicKey, { zip215: false })).toBe(true);
	const held = await acquisition;
	await held.check();
	await held.release();
	await finality.retireRecoverableFinalitySigner({ signer });
});
