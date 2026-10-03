/* eslint-disable jsdoc/require-jsdoc -- Exact insertion-only reader entry/lifetime observation. */
import type { Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function readerInstrumentation(root: string, archive: string, backend: "node" | "browser"): Plugin {
	const owner = join(root, "packages/storage-" + backend, "dist/src/snapshot-transfer.js"),
		observer = join(root, "tests/fixtures/rollback-data-observation/events.ts");
	return {
		name: "rollback-actual-reader-lifetime",
		setup(context): void {
			context.onLoad({ filter: /snapshot-transfer\.js$/ }, ({ path }) => {
				if (resolve(path) !== owner) return undefined;
				const raw = readFileSync(path, "utf8"),
					start = raw.indexOf("const acquireRecoveryRead ="),
					end = raw.indexOf("const recoveryStatus =", start);
				if (start < 0 || end < start) throw new Error("EXACT_READER_OWNER_CHANGED");
				const part = raw.slice(start, end);
				const insertions: { offset: number; text: string }[] = [];
				for (const [needle, text] of [
					["let released = false;", '\n__rollbackEvent("snapshot-acquire", declaration.scope.epoch);'],
					[
						"const descriptor = captureDescriptor(input, declaration);",
						'\n__rollbackEvent("snapshot-read", declaration.scope.epoch, descriptor.index);',
					],
					["released = true;", '\n__rollbackEvent("snapshot-release", declaration.scope.epoch);'],
				] as const) {
					const at = part.indexOf(needle);
					if (at < 0 || part.indexOf(needle, at + 1) >= 0) throw new Error("READER_SITE_NOT_UNIQUE:" + needle);
					insertions.push({ offset: start + at + needle.length, text });
				}
				insertions.push({
					offset: 0,
					text: "import {event as __rollbackEvent} from " + JSON.stringify(observer) + ";\n",
				});
				let code = raw;
				for (const i of [...insertions].sort((a, b) => b.offset - a.offset))
					code = code.slice(0, i.offset) + i.text + code.slice(i.offset);
				mkdirSync(archive, { recursive: true });
				writeFileSync(join(archive, "raw.js"), raw, { flag: "wx" });
				writeFileSync(join(archive, "observed.js"), code, { flag: "wx" });
				writeFileSync(
					join(archive, "insertions.json"),
					JSON.stringify({
						owner,
						observer,
						rawSha256: createHash("sha256").update(raw).digest("hex"),
						observedSha256: createHash("sha256").update(code).digest("hex"),
						insertions,
					}),
					{ flag: "wx" }
				);
				return { contents: code, loader: "js", resolveDir: dirname(path) };
			});
		},
	};
}
