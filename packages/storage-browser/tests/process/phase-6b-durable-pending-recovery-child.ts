import { chromium } from "@playwright/test";

interface ChildInput {
	readonly mode: "recover" | "stage";
	readonly name: string;
	readonly ordering?: "new-ahe" | "old-ahe";
	readonly profileDirectory: string;
	readonly url: string;
}

async function main(): Promise<void> {
	const input = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8")) as ChildInput;
	const context = await chromium.launchPersistentContext(input.profileDirectory, { headless: true });
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(input.url, { waitUntil: "load" });
	await page.waitForFunction(() => typeof window.phase6aCreatorSuccessorProduct === "object");
	await page.evaluate(
		(realmId) => window.phase6aCreatorSuccessorProduct.boot(realmId),
		`d110c-0c-${input.mode}-${input.name}`
	);
	if (input.mode === "stage") {
		if (input.ordering === undefined) throw new TypeError("D110C_0C child ordering is unavailable");
		const result = await page.evaluate(
			({ name, ordering }) => window.phase6aCreatorSuccessorProduct.d110c0cStage(name, ordering),
			{ name: input.name, ordering: input.ordering }
		);
		if (typeof process.send === "function") process.send({ kind: "checkpoint", result });
		await new Promise(() => undefined);
		return;
	}
	const result = await page.evaluate((name) => window.phase6aCreatorSuccessorProduct.d110c0cRecover(name), input.name);
	if (typeof process.send === "function") process.send({ kind: "recovery", result });
	await context.close();
}

void main().catch((error: unknown) => {
	if (typeof process.send === "function") {
		process.send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	}
	process.exitCode = 1;
});
