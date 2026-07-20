import { createRecordFixture } from "./record/fixture.js";

async function main(argv: string[]): Promise<void> {
	const [command, fixtureFlag] = argv;
	if ((command !== "sign" && command !== "verify") || fixtureFlag !== "--fixture" || argv.length !== 2) {
		throw new Error("usage: pnpm --filter @ts-drp/network-spike record <sign|verify> --fixture");
	}
	const fixture = await createRecordFixture();
	if (command === "sign") {
		process.stdout.write(`${JSON.stringify(fixture.record, undefined, 2)}\n`);
		return;
	}
	const { record: _, ...redactedEvidence } = fixture;
	process.stdout.write(`${JSON.stringify(redactedEvidence, undefined, 2)}\n`);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
