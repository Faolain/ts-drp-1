import type * as Owner from "./browser-owner.js";
import type { Case } from "./common.js";
import { observe } from "./observe.js";

const params = new URLSearchParams(location.search);
const observer = observe(params.get("instrument") === "true");
const path = "/owner.js";
const owner = (await import(path)) as typeof Owner;
try {
	const result = await owner.run("manifest-determinism-" + crypto.randomUUID(), observer, params.get("name") as Case);
	Object.assign(window, { deterministicResult: result });
} catch (error) {
	Object.assign(window, { deterministicError: error instanceof Error ? error.stack : String(error) });
} finally {
	observer.restore();
}
