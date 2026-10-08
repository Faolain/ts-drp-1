import { STRING_READER_FAILURES, stringCases, stringWire } from "./canonical-controls.js";
import * as canonical from "../../../packages/canonical/dist/src/index.js";

/**
 * Check an ordinary deterministic predicate without a replacement intrinsic.
 * @param condition - Expected true condition.
 * @param message - Failure context.
 */
function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

/**
 * Match a native ordinary data error to the actual invoked module's class.
 * @param bytes - Canonical wire bytes.
 * @param message - Historical message.
 */
function rejects(bytes: Uint8Array, message: string): void {
	let rejected = false;
	try {
		canonical.decodeCanonical(bytes);
	} catch (error) {
		rejected = true;
		check(error instanceof canonical.CanonicalDecodingError, "same invoked decoder class");
		if (!(error instanceof canonical.CanonicalDecodingError)) throw error;
		check(Object.getPrototypeOf(error) === canonical.CanonicalDecodingError.prototype, "exact decoder prototype");
		check(error.code === "CANONICAL_DECODING", "decoder code");
		check(error.message === message, `message: expected ${message}, observed ${error.message}`);
	}
	check(rejected, "invalid wire unexpectedly accepted");
}

/**
 * Compare unmodified product decoding to unmodified native fatal decoding.
 * @param bytes - Raw UTF-8 STRING payload.
 * @returns Native acceptance.
 */
function compare(bytes: Uint8Array): boolean {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		check(error instanceof TypeError, "ordinary native malformed UTF-8 rejection");
		rejects(stringWire(bytes), "invalid UTF-8 string");
		return false;
	}
	check(canonical.decodeCanonical(stringWire(bytes)) === text, "native/product accepted text differs");
	return true;
}

export type BrowserControl = "named" | "messages" | "exhaustive" | "bom-surrogate-reset";
export interface BrowserResult {
	group: BrowserControl;
	moduleUrl: string;
	classBinding: string;
	cases: number;
	accepted?: number;
	rejected?: number;
	ids?: string[];
}

/**
 * Ordinary compatibility calls only; no runtime interception or fault simulation.
 * @param group - Fixed compatibility group.
 * @returns Executed case evidence.
 */
function run(group: BrowserControl): BrowserResult {
	const base = {
		group,
		moduleUrl: import.meta.url,
		classBinding: "decodeCanonical and CanonicalDecodingError from same imported canonical namespace",
	};
	if (group === "named") {
		const cases = stringCases();
		for (const item of cases) {
			try {
				compare(item.bytes);
			} catch (error) {
				throw new Error(item.id, { cause: error });
			}
		}
		return { ...base, cases: cases.length, ids: cases.map((item) => item.id) };
	}
	if (group === "messages") {
		for (const item of STRING_READER_FAILURES) rejects(Uint8Array.from(item.bytes), item.message);
		return { ...base, cases: STRING_READER_FAILURES.length, ids: STRING_READER_FAILURES.map((item) => item.id) };
	}
	if (group === "exhaustive") {
		let accepted = 0,
			rejected = 0;
		for (let first = 0; first < 256; first++) {
			if (compare(Uint8Array.of(first))) accepted++;
			else rejected++;
			for (let second = 0; second < 256; second++) {
				if (compare(Uint8Array.of(first, second))) accepted++;
				else rejected++;
			}
		}
		return { ...base, cases: accepted + rejected, accepted, rejected };
	}
	check(
		canonical.decodeCanonical(stringWire(Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 65))) === "\ufeffA",
		"exactly one leading BOM"
	);
	check(canonical.decodeCanonical(stringWire(Uint8Array.of(65, 0xef, 0xbb, 0xbf))) === "A\ufeff", "interior BOM");
	check(
		canonical.decodeCanonical(stringWire(Uint8Array.of(0xef, 0xbf, 0xbd))) === "\ufffd",
		"legitimate replacement character"
	);
	for (const value of ["\ud800", "\udfff", "A\ud800B"]) {
		let rejected = false;
		try {
			canonical.encodeCanonical(value);
		} catch (error) {
			rejected = true;
			check(error instanceof canonical.CanonicalEncodingError, "same invoked encoder class");
			if (!(error instanceof canonical.CanonicalEncodingError)) throw error;
			check(Object.getPrototypeOf(error) === canonical.CanonicalEncodingError.prototype, "exact encoder prototype");
			check(
				error.code === "CANONICAL_ENCODING" && error.message === "string contains an unpaired surrogate",
				"encoder code/message"
			);
		}
		check(rejected, "lone surrogate accepted");
	}
	for (let index = 0; index < 8; index++) {
		rejects(stringWire(Uint8Array.of(0xf0, 0x9f)), "invalid UTF-8 string");
		check(
			canonical.decodeCanonical(canonical.encodeCanonical("ready 😀 �")) === "ready 😀 �",
			"post-rejection valid text"
		);
	}
	return { ...base, cases: 14 };
}

declare global {
	interface Window {
		runCanonicalBrowserControls: typeof run;
	}
}
window.runCanonicalBrowserControls = run;
