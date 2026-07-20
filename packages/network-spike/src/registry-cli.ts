import { createRegistryFixture } from "./registry/fixture.js";

const command = process.argv[2] ?? "fixture";
if (command !== "fixture") throw new Error("usage: registry fixture");
void main();

async function main(): Promise<void> {
	console.log(JSON.stringify(await createRegistryFixture(), undefined, 2));
}
