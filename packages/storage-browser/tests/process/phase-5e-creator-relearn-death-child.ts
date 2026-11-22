import { chromium, firefox, webkit } from "@playwright/test";

interface Input {
	readonly browserName: "chromium" | "firefox" | "webkit";
	readonly databaseName: string;
	readonly evidence: unknown;
	readonly origin: string;
	readonly profileDirectory: string;
}

const input = JSON.parse(process.argv[2] ?? "null") as Input | null;
if (
	input === null ||
	typeof input !== "object" ||
	(input.browserName !== "chromium" && input.browserName !== "firefox" && input.browserName !== "webkit") ||
	typeof input.databaseName !== "string" ||
	typeof input.origin !== "string" ||
	typeof input.profileDirectory !== "string"
) {
	throw new TypeError("invalid creator relearn death-child input");
}

async function main(selected: Input): Promise<void> {
	const browserType = { chromium, firefox, webkit }[selected.browserName];
	const context = await browserType.launchPersistentContext(selected.profileDirectory, { headless: true });
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(selected.origin);
		const persisted = await page.evaluate(
			async ({ databaseName, evidence }) => window.phase5eCreatorRelearn.persistPeer(databaseName, evidence),
			{ databaseName: selected.databaseName, evidence: selected.evidence }
		);
		process.stdout.write(`PHASE5E_PERSISTED:${JSON.stringify(persisted)}\n`);
		await new Promise<never>(() => undefined);
	} finally {
		await context.close();
	}
}

void main(input).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
