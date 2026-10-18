import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface Resolution {
	url: string;
}
interface Loaded {
	format: string;
	source?: string | ArrayBuffer | ArrayBufferView | null;
}
interface Hooks {
	resolve(
		specifier: string,
		context: { parentURL?: string },
		next: (specifier: string, context: { parentURL?: string }) => Resolution
	): Resolution;
	load(url: string, context: { format?: string }, next: (url: string, context: { format?: string }) => Loaded): Loaded;
}
export interface GraphReport {
	roots: string[];
	edges: { parent: string | null; specifier: string; url: string }[];
	files: { url: string; path: string; sha256: string; loadedSourceSha256: string; frozenSha256: string }[];
	maps: { path: string; sha256: string; frozenSha256: string | null; bytesBase64: string }[];
}

/**
 * Transparently observe and freeze-check the native resolver/load closure of exact product roots.
 * @param roots - Actual bare and query-isolated owner module URLs.
 * @returns A completion function which verifies held bytes and removes only these observation hooks.
 */
export function observeGraph(roots: string[]): () => GraphReport {
	const register: unknown = Reflect.get(nodeModule, "registerHooks");
	assert.equal(typeof register, "function", "requires actual Node registerHooks support");
	const manifest = JSON.parse(
		readFileSync(".logs/bounded-storage-lifecycle/declaration-discovery-provenance-red-freeze-01/manifest.json", "utf8")
	) as { entries: { path: string; sha256: string }[] };
	const frozen = new Map(manifest.entries.map((entry) => [entry.path, entry.sha256]));
	const report: GraphReport = { roots, edges: [], files: [], maps: [] };
	const selected = new Set(roots);
	const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
	const captureMap = (file: string): void => {
		let directory = dirname(file);
		for (;;) {
			const candidate = join(directory, "package.json");
			if (existsSync(candidate)) {
				const path = relative(process.cwd(), candidate);
				const bytes = readFileSync(path);
				const metadata = JSON.parse(bytes.toString("utf8")) as { name?: string };
				if (!report.maps.some((item) => item.path === path)) {
					const sha256 = digest(bytes);
					const frozenSha256 = frozen.get(path) ?? null;
					if (frozenSha256 !== null) assert.equal(sha256, frozenSha256, `frozen consulted package map: ${path}`);
					else
						assert.ok(
							/^node_modules\/\.pnpm\/@noble\+hashes@1\.7\.1\/node_modules\/@noble\/hashes\/(esm\/)?package\.json$/.test(
								path
							),
							`only dispositioned loaded third-party maps may lack historical custody: ${path}`
						);
					report.maps.push({ path, sha256, frozenSha256, bytesBase64: bytes.toString("base64") });
				}
				if (typeof metadata.name === "string") break;
			}
			const parent = dirname(directory);
			assert.notEqual(parent, directory, "loaded file has no package scope");
			directory = parent;
		}
	};
	const hooks: Hooks = {
		resolve(specifier, context, next): Resolution {
			const result = next(specifier, context);
			if (roots.includes(result.url) || (context.parentURL !== undefined && selected.has(context.parentURL))) {
				selected.add(result.url);
				report.edges.push({ parent: context.parentURL ?? null, specifier, url: result.url });
			}
			return result;
		},
		load(url, context, next): Loaded {
			if (!selected.has(url) || !url.startsWith("file:")) return next(url, context);
			const file = fileURLToPath(url);
			const path = relative(process.cwd(), file);
			const sha256 = digest(readFileSync(file));
			const frozenSha256 = frozen.get(path);
			assert.ok(frozenSha256, `every product-closure JS file must exist in immutable freeze: ${path}`);
			assert.equal(sha256, frozenSha256, `frozen loaded JS: ${path}`);
			captureMap(file);
			const result = next(url, context);
			assert.ok(result.source !== undefined && result.source !== null, "native product ESM source must be observable");
			const bytes =
				typeof result.source === "string"
					? result.source
					: ArrayBuffer.isView(result.source)
						? new Uint8Array(result.source.buffer, result.source.byteOffset, result.source.byteLength)
						: new Uint8Array(result.source);
			const loadedSourceSha256 = digest(bytes);
			assert.equal(loadedSourceSha256, sha256, "loaded product source must equal frozen raw JS, without a transform");
			report.files.push({ url, path, sha256, loadedSourceSha256, frozenSha256 });
			return result;
		},
	};
	const installed = (register as (hooks: Hooks) => { deregister(): void })(hooks);
	return (): GraphReport => {
		installed.deregister();
		for (const root of roots)
			assert.ok(
				report.files.some((item) => item.url === root),
				`actual root not loaded: ${root}`
			);
		for (const item of [...report.files, ...report.maps])
			assert.equal(
				digest(readFileSync(item.path)),
				item.sha256,
				`runtime dependency changed during case: ${item.path}`
			);
		for (const edge of report.edges)
			if (edge.url.startsWith("file:"))
				assert.ok(
					report.files.some((item) => item.url === edge.url),
					`resolved product dependency lacks load receipt: ${edge.url}`
				);
		return report;
	};
}
