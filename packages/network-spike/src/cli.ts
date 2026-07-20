import { parseExperimentManifest } from "./evidence.js";
import { createFixturePayload } from "./fixture.js";

function main(argv: string[]): void {
	if (argv.length !== 1 || argv[0] !== "--fixture") {
		throw new Error("usage: pnpm --filter @ts-drp/network-spike manifest --fixture");
	}
	const payload = createFixturePayload();
	parseExperimentManifest(payload.manifest);
	process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`);
}

main(process.argv.slice(2));
