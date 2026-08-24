// Adapted from here: https://github.com/libp2p/js-libp2p-examples/blob/main/examples/js-libp2p-example-chat/src/stream.js
// The MIT License (MIT)
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import type { Stream } from "@libp2p/interface";
import { InvalidDataLengthLengthError, type LengthPrefixedStreamOpts, lpStream } from "@libp2p/utils";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
// The maximum frame length uses a four-byte varint. The byte-stream limit sees
// prefix and body together when a transport delivers them in one event.
const MAX_FRAME_PREFIX_BYTES = 4;

// lpStream treats RangeError as an incomplete prefix, so enforce the bound
// before returning that signal and letting it request another byte.
const decodeFrameLength: LengthPrefixedStreamOpts["lengthDecoder"] = (data) => {
	if (data.byteLength > MAX_FRAME_PREFIX_BYTES) {
		throw new InvalidDataLengthLengthError(
			`Message length length too long - ${data.byteLength} > ${MAX_FRAME_PREFIX_BYTES}`
		);
	}

	let value = 0;
	for (let index = 0; index < data.byteLength; index++) {
		const byte = data.get(index);
		value += (byte & 0x7f) * 2 ** (index * 7);
		if ((byte & 0x80) === 0) return value;
	}

	throw new RangeError("Could not decode frame length");
};

/**
 * Convert a Uint8Array to a stream.
 * @param stream - The stream to write to.
 * @param input - The Uint8Array to write.
 */
export async function uint8ArrayToStream(stream: Stream, input: Uint8Array): Promise<void> {
	const lp = lpStream(stream);
	await lp.write(input);
	await lp.unwrap().close();
}

/**
 * Write one length-prefixed frame without closing the stream.
 * Bidirectional request/response protocols use this before reading the peer's frame.
 * @param stream Exact negotiated stream.
 * @param input Bounded frame bytes.
 */
export async function writeUint8ArrayFrame(stream: Stream, input: Uint8Array): Promise<void> {
	await lpStream(stream).write(input);
}

/**
 * Read one length-prefixed frame with a caller-owned byte ceiling.
 * @param stream Exact negotiated stream.
 * @param maxDataLength Maximum accepted frame body bytes.
 * @returns The detached frame body.
 */
export async function readUint8ArrayFrame(stream: Stream, maxDataLength: number): Promise<Uint8Array> {
	return lpStream(stream, {
		lengthDecoder: decodeFrameLength,
		maxBufferSize: maxDataLength + MAX_FRAME_PREFIX_BYTES,
		maxDataLength,
	})
		.read()
		.then((data) => data.subarray());
}

/**
 * Convert a stream to a Uint8Array.
 * @param stream - The stream to read from.
 * @returns The Uint8Array.
 */
export async function streamToUint8Array(stream: Stream): Promise<Uint8Array> {
	return readUint8ArrayFrame(stream, MAX_FRAME_BYTES);
}
