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
import { lpStream } from "@libp2p/utils";

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
 * Convert a stream to a Uint8Array.
 * @param stream - The stream to read from.
 * @returns The Uint8Array.
 */
export async function streamToUint8Array(stream: Stream): Promise<Uint8Array> {
	return lpStream(stream)
		.read()
		.then((data) => data.subarray());
}
