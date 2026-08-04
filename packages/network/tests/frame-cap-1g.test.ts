import { type Stream, StreamCloseEvent, StreamMessageEvent } from "@libp2p/interface";
import { describe, expect, it } from "vitest";

import { streamToUint8Array } from "../src/stream.js";

// @libp2p/utils' byte stream already uses a 4 MiB buffering ceiling. Reusing
// that value as the explicit frame ceiling preserves the installed transport's
// nominal maximum while making an oversized declaration fail before its body.
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function encodeUnsignedVarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		const byte = remaining % 128;
		remaining = Math.floor(remaining / 128);
		bytes.push(remaining === 0 ? byte : byte | 0x80);
	} while (remaining !== 0);
	return Uint8Array.from(bytes);
}

function flushMicrotasks(rounds = 12): Promise<void> {
	return Array.from({ length: rounds }).reduce<Promise<void>>(
		(pending) => pending.then(() => Promise.resolve()),
		Promise.resolve()
	);
}

class SourceProbeStream extends EventTarget {
	readonly sourceChunks: Uint8Array[] = [];
	remoteWriteStatus: "closed" | "writable" = "writable";
	readBufferLength = 0;
	readonly log = Object.assign(() => {}, { error: () => {} });

	pushSource(chunk: Uint8Array): void {
		this.sourceChunks.push(chunk);
		this.dispatchEvent(new StreamMessageEvent(chunk));
	}

	closeSource(error: Error): void {
		this.remoteWriteStatus = "closed";
		this.dispatchEvent(new StreamCloseEvent(false, error));
	}

	push(): void {}
	priority = 0;
	send(): boolean {
		return true;
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
	closeRead(): Promise<void> {
		return Promise.resolve();
	}
}

function sourceBytes(stream: SourceProbeStream): number {
	return stream.sourceChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

describe("Phase 1g pre-decode frame cap", () => {
	it("rejects an oversized declaration from the prefix alone", async () => {
		const stream = new SourceProbeStream();
		const declaredLength = MAX_FRAME_BYTES + 1;
		const prefix = encodeUnsignedVarint(declaredLength);
		let settled: { error?: unknown; value?: Uint8Array } | undefined;
		const read = streamToUint8Array(stream as unknown as Stream).then(
			(value) => {
				settled = { value };
				return value;
			},
			(error: unknown) => {
				settled = { error };
				throw error;
			}
		);

		stream.pushSource(prefix);
		await flushMicrotasks(prefix.length * 3);

		// The source has supplied no body byte. A configured lpStream cap can
		// nevertheless reject immediately after decoding the declaration.
		expect.soft(settled?.error).toMatchObject({
			code: "ERR_MSG_DATA_TOO_LONG",
			name: "InvalidDataLengthError",
		});
		expect.soft(settled?.value).toBeUndefined();
		expect.soft(stream.sourceChunks).toHaveLength(1);
		expect.soft(sourceBytes(stream)).toBe(prefix.length);

		// Current production waits for the oversized body. Close only to leave
		// that RED path clean; the close sentinel must never be the observed error.
		if (settled === undefined) stream.closeSource(new Error("body-read-attempted"));
		await expect(read).rejects.toMatchObject({
			code: "ERR_MSG_DATA_TOO_LONG",
			name: "InvalidDataLengthError",
		});
	});

	it("accepts a frame exactly at the transport ceiling", async () => {
		const stream = new SourceProbeStream();
		const prefix = encodeUnsignedVarint(MAX_FRAME_BYTES);
		const body = new Uint8Array(MAX_FRAME_BYTES);
		body[0] = 0x1a;
		body[body.length - 1] = 0xe7;
		const read = streamToUint8Array(stream as unknown as Stream);

		// Feed prefix bytes separately so the dependency's 4 MiB byte-buffer
		// ceiling is not exceeded by prefix+body in one transport event.
		for (const byte of prefix) {
			stream.pushSource(Uint8Array.of(byte));
			await flushMicrotasks(3);
		}
		stream.pushSource(body);

		const decoded = await read;
		expect.soft(decoded.byteLength).toBe(MAX_FRAME_BYTES);
		expect.soft(decoded[0]).toBe(0x1a);
		expect.soft(decoded[decoded.length - 1]).toBe(0xe7);
		expect.soft(sourceBytes(stream)).toBe(prefix.length + MAX_FRAME_BYTES);
	});
});
