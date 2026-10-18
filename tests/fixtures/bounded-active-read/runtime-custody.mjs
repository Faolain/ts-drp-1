/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native JS loader hook; return identity is delegated unchanged. */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const destination = process.env.BOUNDED_AHE_RUNTIME_CUSTODY;
if (!destination) throw new Error("exact owned runtime custody output required");
const seen = new Set();
registerHooks({
	resolve(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		if (result.url.startsWith("file:") && !seen.has(result.url)) {
			seen.add(result.url);
			const actual = realpathSync(fileURLToPath(result.url));
			appendFileSync(
				destination,
				JSON.stringify({
					pid: process.pid,
					specifier,
					parentURL: context.parentURL ?? null,
					resolvedURL: result.url,
					actual,
					sha256: createHash("sha256").update(readFileSync(actual)).digest("hex"),
				}) + "\n"
			);
		}
		return result;
	},
});
