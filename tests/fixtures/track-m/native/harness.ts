import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

// Track M, slice 14f: the Node side of the native harness. A loopback server with
// cross-origin isolation (SharedArrayBuffer for Atomics.wait), the child runner, and the
// process-death step: on the worker's checkpoint the parent SIGKILLs every browser
// process group whose command line names the case's profile, every process holding a
// file under that profile (WebKit's networking process, which owns IndexedDB, runs
// outside the browser's group as an XPC service), and the child's own group; it asserts
// the child died by SIGKILL and waits until every killed process is gone.

export type Engine = "chromium" | "firefox" | "webkit";
export type Message = Readonly<Record<string, unknown>> & { readonly kind?: string };

export interface AssetServer {
	readonly origin: string;
	url(input: Readonly<Record<string, unknown>>): string;
	close(): Promise<void>;
}

const SERVED = new Set(["tm14f.html", "tm14f-entry.js", "tm14f-worker.js", "tm14f-foreign.js"]);

export function startAssetServer(directory: string): Promise<AssetServer> {
	const server = http.createServer((request, response) => {
		const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
		const file = path.join(directory, name);
		if (!SERVED.has(name) || !existsSync(file)) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Cache-Control": "no-store",
			"Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
		});
		response.end(readFileSync(file));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("TRACK_M_14F_SERVER"));
				return;
			}
			const origin = `http://127.0.0.1:${address.port}`;
			resolve({
				origin,
				url: (input) => `${origin}/tm14f.html?input=${Buffer.from(JSON.stringify(input)).toString("base64")}`,
				close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
			});
		});
	});
}

interface ProcessRow {
	readonly pid: number;
	readonly pgid: number;
	readonly command: string;
}

function processes(): ProcessRow[] {
	const text = execFileSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,command="], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
		maxBuffer: 64 * 1024 * 1024,
	});
	return text
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.flatMap((match) =>
			match === null ? [] : [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? "" }]
		);
}

function holders(profile: string): number[] {
	let text = "";
	try {
		text = execFileSync("lsof", ["-n", "-P", "-F", "p", "+D", profile], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		// lsof exits 1 when some files are not open by anyone; its stdout is still the answer.
		text = String((error as { stdout?: unknown }).stdout ?? "");
	}
	return text
		.split("\n")
		.filter((line) => line.startsWith("p"))
		.map((line) => Number(line.slice(1)));
}

export interface KillRecord {
	readonly browserGroups: number[];
	readonly holders: number[];
	readonly childGroup: number;
	readonly killed: number[];
	readonly survivors: number[];
	readonly signal: string | null;
	readonly ms: number;
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * SIGKILLs every process of one case: the browser groups naming its profile, every
 * holder of a file under the profile, and the child's group.
 */
function killCase(profile: string, childPid: number): Omit<KillRecord, "survivors" | "signal" | "ms"> {
	const own = new Set([process.pid, process.ppid]);
	const ownGroup = processes().find((row) => row.pid === process.pid)?.pgid;
	const all = processes();
	const browserGroups = [
		...new Set(all.filter((row) => row.command.includes(profile) && !own.has(row.pid)).map((row) => row.pgid)),
	].filter((pgid) => pgid !== ownGroup && pgid !== childPid && pgid > 1);
	const grouped = new Set(
		all.filter((row) => browserGroups.includes(row.pgid) || row.pgid === childPid).map((row) => row.pid)
	);
	const holding = holders(profile).filter((pid) => !own.has(pid) && pid > 1);
	const killed = [...new Set([...grouped, ...holding])];
	for (const pgid of browserGroups) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			/* Already gone. */
		}
	}
	for (const pid of holding) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* Already gone. */
		}
	}
	try {
		process.kill(-childPid, "SIGKILL");
	} catch {
		/* Already gone. */
	}
	return { browserGroups, holders: holding, childGroup: childPid, killed };
}

function alive(pids: readonly number[]): number[] {
	return pids.filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
}

export interface ChildRun {
	readonly messages: Message[];
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly kill?: KillRecord;
	readonly stderr: string;
	readonly ms: number;
}

/**
 * Runs one child. In mutate mode it is detached (its own process group) and is killed at
 * the first checkpoint whose edge is `edge`.
 */
export function runChild(
	options: Readonly<{
		childAsset: string;
		browserName: Engine;
		mode: "mutate" | "recover" | "run";
		/** The creator's page (origin A). */
		url: string;
		/** The recipient's page (origin B). */
		peerUrl: string;
		profile?: string;
		edge?: string;
		log: string;
		timeoutMs: number;
	}>
): Promise<ChildRun> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(
			JSON.stringify({
				browserName: options.browserName,
				mode: options.mode,
				url: options.url,
				peerUrl: options.peerUrl,
				...(options.profile === undefined ? {} : { profileDirectory: options.profile }),
			})
		).toString("base64url");
		const child = spawn(process.execPath, [options.childAsset, encoded], {
			detached: options.mode === "mutate",
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const messages: Message[] = [];
		let stderr = "";
		let kill: Omit<KillRecord, "survivors" | "signal" | "ms"> | undefined;
		let killedAt = 0;
		let failure: Error | undefined;
		const log = (entry: unknown): void => appendFileSync(options.log, `${JSON.stringify(entry)}\n`);
		log({
			kind: "harness-start",
			options: { ...options, url: options.url.slice(0, 120), peerUrl: options.peerUrl.slice(0, 120) },
			at: new Date().toISOString(),
		});
		const killAll = (): void => {
			if (kill !== undefined || child.pid === undefined) return;
			killedAt = Date.now();
			kill =
				options.profile === undefined
					? { browserGroups: [], holders: [], childGroup: child.pid, killed: [child.pid] }
					: killCase(options.profile, child.pid);
			if (options.profile === undefined) {
				try {
					process.kill(options.mode === "mutate" ? -child.pid : child.pid, "SIGKILL");
				} catch {
					/* Already gone. */
				}
			}
			log({ kind: "harness-kill", kill });
		};
		const timer = setTimeout(() => {
			failure = new Error(`TRACK_M_14F_CHILD_TIMEOUT after ${options.timeoutMs} ms: ${stderr.slice(-2000)}`);
			killAll();
		}, options.timeoutMs);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: Message) => {
			messages.push(message);
			log(message);
			if (message.kind === "child-error") {
				failure ??= new Error(`TRACK_M_14F_CHILD_ERROR ${String(message.message)}`);
				killAll();
			} else if (message.kind === "worker-error" && options.mode === "mutate") {
				failure ??= new Error(`TRACK_M_14F_WORKER_ERROR ${JSON.stringify(message).slice(0, 4000)}`);
				killAll();
			} else if (message.kind === "checkpoint" && options.mode === "mutate" && message.edge === options.edge) killAll();
		});
		child.once("error", (error) => {
			failure ??= error;
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			void (async (): Promise<void> => {
				let record: KillRecord | undefined;
				if (kill !== undefined) {
					const deadline = Date.now() + 60_000;
					let survivors = alive(kill.killed);
					while (survivors.length !== 0 && Date.now() < deadline) {
						await sleep(50);
						survivors = alive(kill.killed);
					}
					record = { ...kill, survivors, signal, ms: Date.now() - killedAt };
					log({ kind: "harness-killed", record });
				}
				log({ kind: "harness-exit", code, signal, ms: Date.now() - started });
				if (failure !== undefined) reject(failure);
				else
					resolve({
						messages,
						code,
						signal,
						...(record === undefined ? {} : { kill: record }),
						stderr,
						ms: Date.now() - started,
					});
			})();
		});
	});
}

export function one(messages: readonly Message[], kind: string): Message | undefined {
	return messages.find((message) => message.kind === kind);
}

export function resultOf(run: ChildRun): Readonly<Record<string, unknown>> {
	const errors = run.messages.filter((message) => message.kind === "worker-error" || message.kind === "page-error");
	if (errors.length !== 0) throw new Error(`TRACK_M_14F_BROWSER_ERROR ${JSON.stringify(errors).slice(0, 6000)}`);
	const result = one(run.messages, "result");
	if (result === undefined) throw new Error(`TRACK_M_14F_NO_RESULT code=${run.code} signal=${run.signal}`);
	return result.result as Readonly<Record<string, unknown>>;
}
