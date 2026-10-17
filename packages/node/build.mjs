import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

import { esbuildConfigWithPolyfill } from "../../esbuild-config.mjs";
// proto-loader resolves the versioned schema beside the compiled service. Ship
// that actual runtime asset; source-only availability is not a packaged port.
await mkdir(new URL("./dist/src/proto/drp/node/v2/", import.meta.url), { recursive: true });
await copyFile(
	new URL("./src/proto/drp/node/v2/rpc.proto", import.meta.url),
	new URL("./dist/src/proto/drp/node/v2/rpc.proto", import.meta.url)
);
// Preserve the shipped catalog material asset exactly; TypeScript's JSON emit
// changes formatting even though the embedded authenticated bytes are unchanged.
await mkdir(new URL("./dist/src/applications/", import.meta.url), { recursive: true });
await copyFile(
	new URL("./src/applications/canvas-catalog-material.json", import.meta.url),
	new URL("./dist/src/applications/canvas-catalog-material.json", import.meta.url)
);
await esbuild.build({
	...esbuildConfigWithPolyfill,
	entryPoints: ["dist/src/index.js"],
	outfile: "dist/index.min.js",
});
