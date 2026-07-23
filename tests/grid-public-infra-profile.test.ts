import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../examples/grid/package.json", import.meta.url), "utf8")) as {
	readonly scripts?: Readonly<Record<string, string>>;
};
const serveSource = readFileSync(new URL("../examples/grid/demo/serve.mjs", import.meta.url), "utf8");
const deployingGuide = readFileSync(new URL("../docs/DEPLOYING.md", import.meta.url), "utf8");

describe("public-infra grid demo profile", () => {
	it("exposes a one-command package script", () => {
		expect(packageJson.scripts?.["demo:public-infra"]).toBe("GRID_DEMO_PROFILE=public-infra node demo/serve.mjs");
	});

	it("selects Nostr discovery and a routing-only local fixture", () => {
		expect(serveSource).toContain("GRID_DEMO_PROFILE");
		expect(serveSource).toContain("VITE_NOSTR_RELAYS");
		expect(serveSource).toContain("nostr-relay.mjs");
		expect(serveSource).toContain("--routing-only");
	});

	it("documents local and public Nostr discovery", () => {
		expect(deployingGuide).toContain("Infra-independent discovery via Nostr");
		expect(deployingGuide).toContain("pnpm --filter ts-drp-example-grid demo:public-infra");
		expect(deployingGuide).toContain("wss://relay.damus.io,wss://nos.lol");
		expect(deployingGuide).toMatch(/DRP signatures are the\s+authority/u);
	});
});
