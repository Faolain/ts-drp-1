import { createRelayFixture, type RelayFixtureScenario } from "./relay/fixture.js";
import { RELAY_TRANSPORT_PROFILES } from "./relay/index.js";

const scenario = (process.argv[2] ?? "mixed") as RelayFixtureScenario;
const profile =
	process.argv[3] === "wss-only" ? RELAY_TRANSPORT_PROFILES.wssOnly : RELAY_TRANSPORT_PROFILES.broadBrowser;
void main();

async function main(): Promise<void> {
	const result = await createRelayFixture(scenario, profile);
	process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
	if (result.assertions.some(({ passed }) => !passed)) process.exitCode = 1;
}
