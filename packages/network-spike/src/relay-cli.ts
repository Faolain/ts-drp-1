import { RELAY_TRANSPORT_PROFILES } from "@ts-drp/relay-policy";

import { createRelayFixture, type RelayFixtureScenario } from "./relay/fixture.js";

const scenario = (process.argv[2] ?? "mixed") as RelayFixtureScenario;
const profile =
	process.argv[3] === "wss-only" ? RELAY_TRANSPORT_PROFILES.wssOnly : RELAY_TRANSPORT_PROFILES.broadBrowser;
void main();

async function main(): Promise<void> {
	const result = await createRelayFixture(scenario, profile);
	process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
	if (result.assertions.some(({ passed }) => !passed)) process.exitCode = 1;
}
