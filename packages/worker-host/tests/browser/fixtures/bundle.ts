/* eslint-disable jsdoc/require-jsdoc */
import { build } from "esbuild";

export async function bundleBrowserFixture(
	entry: URL,
	format: "esm" | "iife",
	globalName = "Phase2fBHandshake"
): Promise<string> {
	const result = await build({
		bundle: true,
		entryPoints: [entry.pathname],
		format,
		...(format === "iife" ? { globalName } : {}),
		platform: "browser",
		target: "es2022",
		write: false,
	});
	const output = result.outputFiles?.[0];
	if (output === undefined) throw new Error(`no emitted browser fixture for ${entry.pathname}`);
	return output.text;
}
