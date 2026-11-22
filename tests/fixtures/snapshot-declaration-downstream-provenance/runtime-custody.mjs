import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Observe native ESM resolution without changing its result.
 * @param specifier - Original ESM import specifier.
 * @param context - Native loader resolution context.
 * @param nextResolve - Native-delegating continuation.
 * @returns Unchanged native resolution result.
 */
// Native Node loader must be JavaScript before the TS loader exists.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function resolve(specifier, context, nextResolve) {
	const result = await nextResolve(specifier, context);
	if (process.env.DOWNSTREAM_CUSTODY && result.url.startsWith("file:")) {
		const path = fileURLToPath(result.url);
		const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
		const productRoot = path.match(/^(.*\/packages\/[^/]+)\//u)?.[1];
		if (productRoot) {
			const packagePath = join(productRoot, "package.json");
			if (existsSync(packagePath))
				appendFileSync(
					process.env.DOWNSTREAM_CUSTODY,
					JSON.stringify({
						kind: "runtime-product-package-map",
						url: pathToFileURL(packagePath).href,
						sha256: createHash("sha256").update(readFileSync(packagePath)).digest("hex"),
					}) + "\n"
				);
		}
		let retainedPath;
		if (path.includes("/node_modules/.vite-temp/")) {
			retainedPath = join(dirname(process.env.DOWNSTREAM_CUSTODY), `runtime-bundle-${sha256}.mjs`);
			if (!existsSync(retainedPath)) writeFileSync(retainedPath, readFileSync(path), { flag: "wx" });
		}
		appendFileSync(
			process.env.DOWNSTREAM_CUSTODY,
			JSON.stringify({ specifier, parentURL: context.parentURL, url: result.url, sha256, retainedPath }) + "\n"
		);
	}
	return result;
}
