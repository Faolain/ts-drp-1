import { expect, test } from "@playwright/test";

/**
 * WebCrypto capability matrix.
 *
 * Which curves `crypto.subtle.generateKey` accepts — and whether the resulting private key can be
 * made non-extractable — is a protocol input, not a detail. The v2 signature suite is Ed25519
 * precisely because secp256k1 is absent from WebCrypto on every engine, which makes it unusable
 * for a browser-held seal key that must be destroyed together with its vote log.
 *
 * This asserts the matrix **exactly**, so it fails on any change in either direction. A regression
 * is obviously interesting; so is an improvement, because a curve becoming available is a reason to
 * revisit the suite decision deliberately rather than to discover it years later. The matrix was
 * already ~15 months out of date once (Chromium 134 vs Chrome 137), and that staleness produced a
 * wrong answer about Ed25519 support.
 */

type CurveSupport = "non-extractable" | "extractable" | "unsupported";

/** The measured, reviewed matrix. Changing an entry is a deliberate act — see the doc comment. */
const EXPECTED: Record<string, CurveSupport> = {
	// Signature suite for v2 identity/vertex signatures and seal-voter keys.
	Ed25519: "non-extractable",
	// Retained in cryptoSuiteId only as a fallback for pre-2025 browsers.
	"ECDSA P-256": "non-extractable",
	// Never available in WebCrypto on any engine; this is why the seal key cannot be secp256k1.
	"ECDSA K-256": "unsupported",
};

const ALGORITHMS: Record<string, EcKeyGenParams | Algorithm> = {
	Ed25519: { name: "Ed25519" },
	"ECDSA P-256": { name: "ECDSA", namedCurve: "P-256" },
	"ECDSA K-256": { name: "ECDSA", namedCurve: "K-256" },
};

test("WebCrypto curve support matches the reviewed matrix exactly", async ({ page, browserName }) => {
	// Hermetic secure context: fulfil the document ourselves so `crypto.subtle` is available
	// without reaching the network.
	await page.route("**/*", (route) =>
		route.fulfill({ body: "<!doctype html><title>capability</title>", contentType: "text/html", status: 200 })
	);
	await page.goto("https://platform-capability.invalid/");

	await expect(page.evaluate(() => Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle))).resolves.toBe(
		true
	);

	const observed = await page.evaluate(async (algorithms: Record<string, EcKeyGenParams | Algorithm>) => {
		const result: Record<string, string> = {};
		for (const [label, algorithm] of Object.entries(algorithms)) {
			try {
				const pair = (await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"])) as CryptoKeyPair;
				result[label] = pair.privateKey.extractable ? "extractable" : "non-extractable";
			} catch {
				result[label] = "unsupported";
			}
		}
		return result;
	}, ALGORITHMS);

	// Equality, not a subset check: an unexpected *gain* must fail too.
	expect(observed, `WebCrypto curve support changed on ${browserName}. Re-review the v2 signature suite before updating this matrix.`).toEqual(
		EXPECTED
	);
});

test("engine build is recorded for the release matrix", async ({ browser, browserName }) => {
	const version = browser.version();
	// Not an assertion about *which* version — that belongs to the currency check. This exists so
	// every capability result in CI carries the build that produced it.
	expect(version, `${browserName} reported no version`).toMatch(/\d+/u);
	test.info().annotations.push({ description: version, type: `engine-build:${browserName}` });
});
