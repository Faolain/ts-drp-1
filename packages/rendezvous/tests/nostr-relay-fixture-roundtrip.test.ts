import {
	createNostrRelayDirectory,
	createNostrSignerFromSecretKey,
	createNostrWebSocketRelayFactory,
	type RecordValidator,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { NAMESPACE, NOW, signedFixture, validator } from "./fixtures.js";

const fixturePath = fileURLToPath(new URL("../../../examples/network-spike/fixtures/nostr-relay.mjs", import.meta.url));
const encoder = new TextEncoder();
const activeFixtures = new Set<ChildProcessWithoutNullStreams>();

describe("local Nostr relay fixture", () => {
	afterEach(async (): Promise<void> => {
		await Promise.all([...activeFixtures].map((fixture) => stopFixture(fixture)));
	});

	it("round-trips two signed DRP records over real WebSockets", async () => {
		const fixture = spawn(process.execPath, [fixturePath, "0"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		activeFixtures.add(fixture);
		const relayUrl = await readyUrl(fixture);
		const directory = createNostrRelayDirectory({
			allow_insecure_loopback_fixture: true,
			connectionFactory: createNostrWebSocketRelayFactory(),
			nostrSigner: createNostrSignerFromSecretKey(Uint8Array.from({ length: 32 }, (_value, index) => index + 1)),
			now: (): number => NOW,
			relays: [{ id: "local-fixture", url: relayUrl }],
			validatorFactory: (): RecordValidator => validator(),
		});
		const first = await signedFixture(801);
		const second = await signedFixture(802);

		await expect(directory.register(first, signal())).resolves.toMatchObject({
			acceptedEndpointIds: ["local-fixture"],
		});
		await expect(directory.register(second, signal())).resolves.toMatchObject({
			acceptedEndpointIds: ["local-fixture"],
		});

		const discovered = await directory.discover(NAMESPACE, signal());
		expect(discovered).toHaveLength(2);
		expect(recordBytes(findRecord(discovered, first.peerId))).toEqual(recordBytes(first));
		expect(recordBytes(findRecord(discovered, second.peerId))).toEqual(recordBytes(second));

		await stopFixture(fixture);
		expect(activeFixtures).toHaveLength(0);
	});
});

function signal(): AbortSignal {
	return new AbortController().signal;
}

function recordBytes(record: SignedDrpRecordV1): Uint8Array {
	return encoder.encode(JSON.stringify(record));
}

function findRecord(discovered: readonly { readonly record: SignedDrpRecordV1 }[], peerId: string): SignedDrpRecordV1 {
	const match = discovered.find(({ record }) => record.peerId === peerId)?.record;
	if (match === undefined) throw new Error(`missing discovered record for ${peerId}`);
	return match;
}

function readyUrl(fixture: ChildProcessWithoutNullStreams): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => finish(new Error(`fixture ready timeout: ${stderr}`)), 5_000);
		const finish = (error?: Error, url?: string): void => {
			clearTimeout(timeout);
			fixture.stdout.off("data", onStdout);
			fixture.stderr.off("data", onStderr);
			fixture.off("exit", onExit);
			if (error !== undefined) reject(error);
			else if (url !== undefined) resolve(url);
		};
		const onStdout = (chunk: Buffer): void => {
			stdout += chunk.toString();
			const match = /nostr relay fixture listening on (ws:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);
			if (match?.[1] !== undefined) finish(undefined, match[1]);
		};
		const onStderr = (chunk: Buffer): void => {
			stderr += chunk.toString();
		};
		const onExit = (code: number | null): void => {
			finish(new Error(`fixture exited before ready (code ${code ?? "signal"}): ${stderr}`));
		};
		fixture.stdout.on("data", onStdout);
		fixture.stderr.on("data", onStderr);
		fixture.once("exit", onExit);
	});
}

async function stopFixture(fixture: ChildProcessWithoutNullStreams): Promise<void> {
	if (!activeFixtures.delete(fixture)) return;
	if (fixture.exitCode !== null || fixture.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => fixture.once("exit", () => resolve()));
	fixture.kill("SIGTERM");
	await exited;
}
