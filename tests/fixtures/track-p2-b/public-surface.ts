import { buildBlueprint } from "../../../packages/blueprint-toolchain/src/index.js";

declare const authoringDirectory: string;
declare const outputDirectory: string;

const result: Promise<void> = buildBlueprint(authoringDirectory, outputDirectory);

// @ts-expect-error P2-b preparation capabilities are consumed and discarded, never returned.
const leakedAuthority: Promise<{ readonly blueprintDigest: string }> = buildBlueprint(
	authoringDirectory,
	outputDirectory
);

void [leakedAuthority, result];
