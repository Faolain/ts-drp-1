/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */

export function joinBytes(chunks) {
	const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const joined = new Uint8Array(size);
	let cursor = 0;
	for (const chunk of chunks) {
		joined.set(chunk, cursor);
		cursor += chunk.byteLength;
	}
	return joined;
}

export function compareByteSequences(left, right) {
	const shared = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < shared; index += 1) {
		const difference = left[index] - right[index];
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return Math.sign(left.byteLength - right.byteLength);
}

export function sameBytes(left, right) {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}
