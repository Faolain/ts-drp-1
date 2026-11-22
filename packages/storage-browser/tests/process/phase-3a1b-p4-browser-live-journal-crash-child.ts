import { type BrowserType, chromium, firefox, webkit } from "@playwright/test";

interface ChildInput {
	readonly browserName: "chromium" | "firefox" | "webkit";
	readonly mode: "mutate" | "recover";
	readonly profileDirectory: string;
	readonly url: string;
}

function browserType(name: ChildInput["browserName"]): BrowserType {
	if (name === "chromium") return chromium;
	if (name === "firefox") return firefox;
	return webkit;
}

async function main(): Promise<void> {
	const input = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8")) as ChildInput;
	const context = await browserType(input.browserName).launchPersistentContext(input.profileDirectory, {
		headless: true,
	});
	const page = context.pages()[0] ?? (await context.newPage());
	page.on("console", (message) => {
		const text = message.text();
		if (!text.startsWith("PHASE_3A1B_P4:")) return;
		const value = JSON.parse(text.slice("PHASE_3A1B_P4:".length)) as { readonly kind?: string };
		if (typeof process.send === "function") process.send(value);
		if (input.mode === "recover" && (value.kind === "recovery" || value.kind === "worker-error")) {
			void context.close().finally(() => process.exit(value.kind === "recovery" ? 0 : 1));
		}
	});
	await page.goto(input.url, { waitUntil: "load" });
	if (input.mode === "mutate") await new Promise(() => undefined);
}

void main().catch((error: unknown) => {
	if (typeof process.send === "function") {
		process.send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	}
	process.exitCode = 1;
});
