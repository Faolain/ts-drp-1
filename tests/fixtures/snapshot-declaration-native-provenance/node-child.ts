import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installNativeHooks, type NativeBoundary, type NativeSentinel } from "./hooks.js";
import type * as Owner from "./node-owner.js";

const input = JSON.parse(readFileSync(0, "utf8")) as {
	bundle: string;
	boundary: NativeBoundary;
	sentinel: NativeSentinel;
	mode?: string;
};
const hooks = installNativeHooks(input.boundary, input.sentinel);
try {
	const owner = (await import(
		"data:text/javascript;base64," +
			Buffer.from(input.bundle + "\n//# sourceURL=native-provenance-owner.mjs\n").toString("base64")
	)) as typeof Owner;
	const filename = join(mkdtempSync(join(tmpdir(), "native-provenance-red-")), "primary.sqlite");
	console.log(JSON.stringify(await owner.run(filename, hooks, input.mode)));
} finally {
	hooks.restore();
}
