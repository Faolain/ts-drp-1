import { expect, it, vi } from "vitest";

// Each case starts a fresh module graph at a real consumer entry. A cycle that
// reaches the trust singleton while the package index is still evaluating
// leaves its custody bindings uninitialized.
it.each([
	["package index", "../packages/protocol-v3/src/index.js"],
	["owned signing request", "../packages/protocol-v3/src/internal/owned-signing-request.js"],
	["creator checkpoint", "../packages/protocol-v3/src/creator-checkpoint.js"],
	["creator adoption", "../packages/node/src/creator-adoption.js"],
])("initializes the trust singleton when %s is the first module loaded", async (_name, entry) => {
	vi.resetModules();
	await expect(import(entry)).resolves.toBeDefined();
	const { openCurrentAnchorTrust } = await import("../packages/protocol-v3/src/anchor-trust-singleton.js");
	expect(typeof openCurrentAnchorTrust).toBe("function");
});
