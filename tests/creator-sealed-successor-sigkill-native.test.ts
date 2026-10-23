import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function worker(directory: string, epoch: number, mode: "seal" | "reopen") {
	const child = spawn(
		process.execPath,
		["node_modules/vitest/vitest.mjs", "run", "--config", "tests/fixtures/sealed-reopen/vitest.config.ts"],
		{
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				TS_DRP_SEALED_CRASH_DIRECTORY: directory,
				TS_DRP_SEALED_CRASH_EPOCH: String(epoch),
				TS_DRP_SEALED_CRASH_MODE: mode,
			},
		}
	);
	let output = "",
		ended = false;
	const capture = (bytes: Buffer) => {
		output = (output + bytes.toString()).slice(-65536);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const result = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			ended = true;
			resolve(code);
		});
	});
	return { child, result, output: () => output, ended: () => ended };
}

it.each([0, 2])(
	"recovers after SIGKILL following seal of epoch %d with native owners open",
	async (epoch) => {
		const directory = await mkdtemp(join(tmpdir(), "creator-sealed-kill-"));
		const sealing = worker(directory, epoch, "seal");
		let nativePid: number | undefined;
		try {
			const deadline = performance.now() + 90000;
			while (performance.now() < deadline && !sealing.ended()) {
				try {
					const ready = JSON.parse(await readFile(join(directory, "sealed-ready.json"), "utf8")) as {
						pid: number;
						epoch: number;
					};
					expect(ready.epoch).toBe(epoch);
					expect(Number.isSafeInteger(ready.pid) && ready.pid > 0).toBe(true);
					nativePid = ready.pid;
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(nativePid, sealing.output()).toBeDefined();
			expect(process.kill(nativePid!, "SIGKILL")).toBe(true);
			nativePid = undefined;
			expect(await sealing.result, sealing.output()).not.toBe(0);
			const reopened = worker(directory, epoch, "reopen");
			try {
				expect(await reopened.result, reopened.output()).toBe(0);
			} finally {
				if (!reopened.ended()) reopened.child.kill("SIGKILL");
			}
		} finally {
			if (nativePid !== undefined)
				try {
					process.kill(nativePid, "SIGKILL");
				} catch {
					/* It may have exited already. */
				}
			if (!sealing.ended()) sealing.child.kill("SIGKILL");
			await rm(directory, { recursive: true, force: true });
		}
	},
	180000
);
