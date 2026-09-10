import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";

import type { Case } from "./common.js";
import type * as Owner from "./node-owner.js";
import { observe } from "./observe.js";

const input = JSON.parse(readFileSync(0, "utf8")) as { bundle: string; name: Case; instrument: boolean };
const observer = observe(input.instrument);
const get = StatementSync.prototype.get;
if (input.instrument)
	StatementSync.prototype.get = new Proxy(get, {
		apply(target, receiver, args): ReturnType<StatementSync["get"]> {
			const result = Reflect.apply(target, receiver, args) as ReturnType<StatementSync["get"]>;
			observer.raw(result?.exact_manifest_bytes);
			return result;
		},
	});
try {
	const owner = (await import(
		"data:text/javascript;base64," +
			Buffer.from(input.bundle + "\n//# sourceURL=deterministic-node-owner.mjs\n").toString("base64")
	)) as typeof Owner;
	const filename = join(mkdtempSync(join(tmpdir(), "manifest-determinism-")), "primary.sqlite");
	console.log(JSON.stringify(await owner.run(filename, observer, input.name)));
} finally {
	if (input.instrument) StatementSync.prototype.get = get;
	observer.restore();
}
