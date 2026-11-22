import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// RED (real defect, found triaging phase-6b-d110c-a-repeat-close): the public
// `@ts-drp/node/creator-close` subpath crashes when it is the first module a fresh
// process loads. creator-close.ts -> internal/creator-closed-rollback-data.ts ->
// creator-adoption.ts -> v3-live.ts is a runtime import cycle; v3-live's top-level
// installation of the creator-close registration resolver then runs before
// creator-close has attached its installer to bindCreatorLiveClose, and throws
// "v3 creator close registration resolver is unavailable". Loading v3-live first works.
const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

const load = (specifiers: readonly string[]) =>
	execFileAsync(
		process.execPath,
		["--import", "tsx", "-e", `${specifiers.map((s) => `await import(${JSON.stringify(s)});`).join("")}process.stdout.write("LOADED");`],
		{ cwd: root, encoding: "utf8" }
	).then(
		({ stdout }) => stdout.trim(),
		(error: { stderr?: string }) => String(error.stderr ?? error).split("\n").find((line) => line.includes("Error")) ?? "FAILED"
	);

it("[control] creator-close loads after v3-live", async () => {
	expect(await load(["./packages/node/src/v3-live.ts", "./packages/node/src/creator-close.ts"])).toBe("LOADED");
}, 60_000);

it("[RED] creator-close loads as the first module of a fresh process (source)", async () => {
	expect(await load(["./packages/node/src/creator-close.ts"])).toBe("LOADED");
}, 60_000);

it("[RED] the built creator-close subpath loads as the first module of a fresh process", async () => {
	expect(await load(["./packages/node/dist/src/creator-close.js"])).toBe("LOADED");
}, 60_000);
