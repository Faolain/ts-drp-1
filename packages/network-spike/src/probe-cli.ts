import { runAllRefusedFixture } from "./probe/fixture.js";

async function main(argv: string[]): Promise<void> {
	if (argv.length === 2 && argv[0] === "--fixture" && argv[1] === "all-refused") {
		const fixture = await runAllRefusedFixture();
		process.stdout.write(fixture.jsonl);
		return;
	}
	if (argv.length === 2 && argv[0] === "--profile-iterations") {
		const iterations = Number(argv[1]);
		if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 100_000) {
			throw new Error("profile iterations must be within 1..100000");
		}
		let eventCount = 0;
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			eventCount += (await runAllRefusedFixture()).events.length;
		}
		process.stdout.write(`${JSON.stringify({ eventCount, iterations })}\n`);
		return;
	}
	throw new Error("usage: probe --fixture all-refused | probe --profile-iterations <1..100000>");
}

void main(process.argv.slice(2));
