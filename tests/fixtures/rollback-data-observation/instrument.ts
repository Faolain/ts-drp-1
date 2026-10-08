/* eslint-disable jsdoc/require-jsdoc -- Exact insertion-only reader entry/lifetime observation. */
import type { Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function readerInstrumentation(
	root: string,
	archive: string,
	backend: "node" | "browser",
	role = false
): Plugin {
	const owner = join(root, "packages/storage-" + backend, "dist/src/snapshot-transfer.js"),
		observer = join(root, "tests/fixtures/rollback-data-observation/events.ts");
	return {
		name: "rollback-actual-reader-lifetime",
		setup(context): void {
			if (role)
				context.onLoad({ filter: /creator-closed-rollback-data\.ts$/ }, ({ path }) => {
					if (resolve(path) !== join(root, "packages/node/src/internal/creator-closed-rollback-data.ts"))
						return undefined;
					const raw = readFileSync(path, "utf8");
					const needle = "const sequences = initialBlobs.map((blob) => blob.bytes);";
					const at = raw.indexOf(needle);
					if (at < 0 || raw.indexOf(needle, at + 1) >= 0) throw new Error("ACCOUNTING_SITE_NOT_UNIQUE");
					const insertion =
						'\n__rollbackEvent("proof-accounting",undefined,undefined,{refs:initialBlobs.map(b=>b.ref).sort((a,b)=>a.digest.localeCompare(b.digest)),bytes:initialBlobs.reduce((n,b)=>n+b.bytes.byteLength,0)});';
					const chargeNeedle = "charge(exactBytes: Uint8Array): boolean {";
					const chargeAt = raw.indexOf(chargeNeedle);
					if (chargeAt < 0 || raw.indexOf(chargeNeedle, chargeAt + 1) >= 0)
						throw new Error("ACCOUNTING_CHARGE_SITE_NOT_UNIQUE");
					const chargeInsertion =
						'\n__rollbackEvent("proof-charge",undefined,undefined,{equal:sequences.some(bytes=>compareBytes(bytes,exactBytes)===0),chargedBytes,byteLength:exactBytes.byteLength});';
					const insertions = [
						{ offset: at + needle.length, text: insertion },
						{ offset: chargeAt + chargeNeedle.length, text: chargeInsertion },
					];
					let code = raw;
					for (const i of [...insertions].sort((a, b) => b.offset - a.offset))
						code = code.slice(0, i.offset) + i.text + code.slice(i.offset);
					code = "import {event as __rollbackEvent} from " + JSON.stringify(observer) + ";\n" + code;
					mkdirSync(archive, { recursive: true });
					writeFileSync(join(archive, "accounting-raw.ts"), raw, { flag: "wx" });
					writeFileSync(join(archive, "accounting-observed.ts"), code, { flag: "wx" });
					writeFileSync(
						join(archive, "accounting-insertion.json"),
						JSON.stringify({
							owner: path,
							insertions,
							rawSha256: createHash("sha256").update(raw).digest("hex"),
							observedSha256: createHash("sha256").update(code).digest("hex"),
						}),
						{ flag: "wx" }
					);
					return { contents: code, loader: "ts", resolveDir: dirname(path) };
				});
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
