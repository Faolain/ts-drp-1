import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

interface Stream {
	readonly id: string;
	readonly log: { trace(...values: readonly unknown[]): void };
}
interface Connection {
	readonly id: string;
}
type Middleware = (
	stream: Stream,
	connection: Connection,
	next: (stream: Stream, connection: Connection) => void
) => void | Promise<void>;

const root = resolve(import.meta.dirname, "..");
// Detached preparation uses the existing read-only dependency symlink. Resolve
// through the network package that actually consumes libp2p, not a copied body
// or a guessed virtual-store/version directory.
const dependencyRoot = dirname(await realpath(resolve(root, "node_modules")));
const requireFromNetwork = createRequire(resolve(dependencyRoot, "packages/network/package.json"));
const entry = await realpath(requireFromNetwork.resolve("libp2p"));
const packageDirectory = resolve(dirname(entry), "../..");
const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
	name: string;
	version: string;
};
if (manifest.name !== "libp2p" || manifest.version !== "3.3.5")
	throw new TypeError("R9_LIBP2P_INSTALLED_VERSION_MISMATCH");
const filename = resolve(dirname(entry), "connection.js");
const sourceSha256 = createHash("sha256")
	.update(await readFile(filename))
	.digest("hex");
const installed = (await import(/* @vite-ignore */ pathToFileURL(filename).href)) as {
	Connection: { prototype: object };
};
const runMiddlewareChain: unknown = Reflect.get(installed.Connection.prototype, "runMiddlewareChain");
if (typeof runMiddlewareChain !== "function") throw new TypeError("R9_LIBP2P_INSTALLED_MIDDLEWARE_METHOD_MISSING");
console.info("R9_LIBP2P_MIDDLEWARE_SOURCE", JSON.stringify({ version: manifest.version, filename, sourceSha256 }));

const stream = (id: string): Stream => ({ id, log: { trace: () => undefined } });
function run(initial: Stream, connection: Connection, middleware: readonly Middleware[]): Promise<Stream> {
	return Reflect.apply(
		runMiddlewareChain as (...args: readonly unknown[]) => Promise<Stream>,
		installed.Connection.prototype,
		[initial, connection, middleware]
	);
}

it("installed libp2p middleware chain rejects a foreign-realm async rejection instead of remaining pending", async () => {
	const failure = new Error("R9_FOREIGN_ASYNC_MIDDLEWARE_FAILURE");
	const foreign = runInNewContext("(async () => { throw failure; })()", { failure }) as Promise<void>;
	expect(foreign instanceof Promise, "genuine foreign async promise bypasses instanceof check").toBe(false);
	// Suppress only the foreign promise's unhandled-rejection notification. This
	// does not attach rejection settlement to the original libp2p chain.
	const handledForeign = foreign.catch(() => undefined);
	const chain = run(stream("original"), { id: "connection" }, [(): Promise<void> => foreign]);
	let outcome: { kind: "fulfilled" } | { kind: "rejected"; cause: unknown } | undefined;
	const observed = chain.then(
		() => {
			outcome = { kind: "fulfilled" };
		},
		(cause: unknown) => {
			outcome = { kind: "rejected", cause };
		}
	);
	await handledForeign;
	// The next event-loop turn follows the entire promise-job checkpoint. This
	// is an ordering barrier, not an arbitrary sleep or performance deadline.
	await setImmediate();
	expect(outcome).toEqual({ kind: "rejected", cause: failure });
	await expect(chain).rejects.toBe(failure);
	await observed;
});

it("installed libp2p middleware preserves synchronous void next and replacement stream/connection", async () => {
	const replacement = stream("replacement");
	const replacementConnection = { id: "replacement-connection" };
	const observed: string[] = [];
	const result = await run(stream("initial"), { id: "initial-connection" }, [
		(_stream, _connection, next): void => {
			observed.push("first");
			next(replacement, replacementConnection);
		},
		(selected, connection, next): void => {
			expect(selected).toBe(replacement);
			expect(connection).toBe(replacementConnection);
			observed.push("second");
			next(selected, connection);
		},
	]);
	expect(result).toBe(replacement);
	expect(observed).toEqual(["first", "second"]);
});

it("installed libp2p middleware preserves foreign async success followed by next", async () => {
	const initial = stream("initial");
	const foreign = runInNewContext("(async () => {})()") as Promise<void>;
	expect(foreign instanceof Promise).toBe(false);
	const observed: string[] = [];
	const result = await run(initial, { id: "connection" }, [
		(selected, connection, next): Promise<void> =>
			foreign.then(() => {
				observed.push("foreign-next");
				next(selected, connection);
			}),
		(selected, connection, next): void => {
			observed.push("next-middleware");
			next(selected, connection);
		},
	]);
	expect(result).toBe(initial);
	expect(observed).toEqual(["foreign-next", "next-middleware"]);
});

it("installed libp2p middleware refuses synchronous throw without entering subsequent middleware", async () => {
	const failure = new Error("R9_SYNC_MIDDLEWARE_FAILURE");
	let advanced = false;
	const chain = run(stream("initial"), { id: "connection" }, [
		(): never => {
			throw failure;
		},
		(_stream, _connection, next): void => {
			advanced = true;
			next(_stream, _connection);
		},
	]);
	await expect(chain).rejects.toBe(failure);
	expect(advanced).toBe(false);
});
