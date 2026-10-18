import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Artifact {
	text: string;
	sha256: string;
	inputs: Record<string, string>;
}

/** Build actual source native owner plus unchanged built dependencies before tests. */
export async function compile(name: "node-owner.ts" | "node-child.ts" | "browser-owner.ts"): Promise<Artifact> {
	const built = await build({
		entryPoints: [fileURLToPath(new URL(name, import.meta.url))],
		bundle: true,
		platform: name === "browser-owner.ts" ? "browser" : "node",
		format: "esm",
		write: false,
		metafile: true,
	});
	const output = built.outputFiles[0];
	if (output === undefined) throw new Error("reader native bundle absent");
	const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
	const inputs = Object.fromEntries(Object.keys(built.metafile.inputs).map((path) => [path, sha(readFileSync(path))]));
	if (name !== "node-child.ts") {
		const adapter = name === "browser-owner.ts" ? "storage-browser" : "storage-node";
		if (!("packages/" + adapter + "/src/snapshot-transfer.ts" in inputs))
			throw new Error("reader must use actual source native owner");
		if ("packages/" + adapter + "/dist/src/snapshot-transfer.js" in inputs)
			throw new Error("stale built native owner is forbidden");
		for (const dependency of ["storage", "protocol-v3", "canonical"]) {
			const suffix =
				"packages/" + dependency + "/dist/src/" + (dependency === "canonical" ? "index" : "snapshot-transfer") + ".js";
			if (!Object.keys(inputs).some((path) => path.endsWith(suffix)))
				throw new Error("missing actual built dependency: " + dependency);
		}
	}
	return { text: output.text, sha256: sha(output.text), inputs };
}
