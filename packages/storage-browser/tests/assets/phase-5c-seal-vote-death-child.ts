import { chromium } from "@playwright/test";

interface DeathInput {
	readonly checkpoint: string;
	readonly databaseName: string;
	readonly origin: string;
	readonly profileDirectory: string;
}

const input = JSON.parse(process.argv[2] ?? "null") as DeathInput | null;
if (input === null) throw new TypeError("missing Phase 5c death-child input");

async function main(selected: DeathInput): Promise<never> {
	const context = await chromium.launchPersistentContext(selected.profileDirectory, { headless: true });
	const page = context.pages()[0] ?? (await context.newPage());
	await page.exposeFunction("__phase5cDeathArmed", async (checkpoint: unknown) => {
		if (checkpoint !== selected.checkpoint) throw new Error("death checkpoint identity mismatch");
		process.stdout.write(`PHASE5C_ARMED:${selected.checkpoint}\n`);
		await new Promise<never>(() => undefined);
	});
	await page.goto(selected.origin);
	await page.evaluate(
		([databaseName, checkpoint]) => window.phase5cSealVote.runDeathCheckpoint(databaseName, checkpoint),
		[selected.databaseName, selected.checkpoint] as const
	);
	throw new Error("death checkpoint unexpectedly returned");
}

void main(input).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
