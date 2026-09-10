import { stringCases, stringWire } from "../snapshot-declaration-provenance/canonical-controls.js";

interface Event {
	kind: "construct-decoder" | "construct-encoder" | "decode" | "encode";
	id: number;
	bytes?: number[];
	text?: string;
	stream?: boolean;
	fatal?: boolean;
	threw?: boolean;
}

interface ProbeResult {
	imported: Event[];
	encoderControl: boolean;
	lateConstructors: number;
	results: {
		id: string;
		bytes: number;
		accepted: boolean;
		elapsedMs: number;
		checks: Record<string, boolean>;
		calls: Event[];
	}[];
	limitation: string;
}

/**
 * Exercise real product conversion with transparent native-delegating capture hooks.
 * @returns Native call telemetry and independently evaluated contract predicates.
 */
export async function probe(): Promise<ProbeResult> {
	const NativeDecoder = globalThis.TextDecoder;
	const NativeEncoder = globalThis.TextEncoder;
	const events: Event[] = [];
	let nextId = 0;
	class Decoder extends NativeDecoder {
		readonly captureId = ++nextId;
		/**
		 * Capture construction while preserving native options.
		 * @param label - Native encoding label.
		 * @param options - Native construction options.
		 */
		constructor(label?: string, options?: TextDecoderOptions) {
			super(label, options);
			events.push({ kind: "construct-decoder", id: this.captureId, fatal: this.fatal });
		}
		/**
		 * Delegate conversion and retain exact input/output evidence.
		 * @param input - Native input view.
		 * @param options - Native streaming options.
		 * @returns The unchanged native output.
		 */
		override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
			const bytes =
				input === undefined
					? []
					: Array.from(
							ArrayBuffer.isView(input)
								? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
								: new Uint8Array(input)
						);
			const event: Event = {
				kind: "decode",
				id: this.captureId,
				bytes,
				stream: options?.stream === true,
				fatal: this.fatal,
			};
			events.push(event);
			try {
				const value = super.decode(input, options);
				event.text = value;
				return value;
			} catch (error) {
				event.threw = true;
				throw error;
			}
		}
	}
	class Encoder extends NativeEncoder {
		readonly captureId = ++nextId;
		/** Capture the product encoder instance. */
		constructor() {
			super();
			events.push({ kind: "construct-encoder", id: this.captureId });
		}
		/**
		 * Delegate encoding and retain exact input/output evidence.
		 * @param input - Native input text.
		 * @returns The unchanged native bytes.
		 */
		override encode(input?: string): Uint8Array {
			const bytes = super.encode(input);
			events.push({ kind: "encode", id: this.captureId, text: input ?? "", bytes: Array.from(bytes) });
			return bytes;
		}
	}
	globalThis.TextDecoder = Decoder;
	globalThis.TextEncoder = Encoder;
	const canonical = await import("../../../packages/canonical/dist/src/index.js");
	const imported = events.splice(0);
	// Replacing globals after import proves constructor capture, without touching native prototypes.
	let lateConstructors = 0;
	globalThis.TextDecoder = class extends NativeDecoder {
		constructor(label?: string, options?: TextDecoderOptions) {
			super(label, options);
			lateConstructors++;
		}
	};
	globalThis.TextEncoder = class extends NativeEncoder {
		constructor() {
			super();
			lateConstructors++;
		}
	};
	const encodedControl = canonical.encodeCanonical("capture-control 😀");
	const encoderCalls = events.splice(0);
	const encoderControl =
		encodedControl.length > 0 &&
		encoderCalls.some(
			(event) =>
				event.kind === "encode" &&
				imported.some((capture) => capture.kind === "construct-encoder" && capture.id === event.id)
		) &&
		lateConstructors === 0;
	const cases = [
		{ id: "decisive-ascii-8192", bytes: new Uint8Array(8192).fill(65) },
		{ id: "first-chunk-invalid-16384", bytes: Uint8Array.from([255, ...new Uint8Array(16383).fill(65)]) },
		...stringCases(),
		{ id: "scaled-valid-65536", bytes: new NativeEncoder().encode("😀�A".repeat(8192)) },
	];
	const results = [];
	for (const item of cases) {
		let expected: string | undefined;
		try {
			expected = new NativeDecoder("utf-8", { fatal: true }).decode(item.bytes);
		} catch {
			/* Independent native rejection. */
		}
		let value: unknown;
		let error: unknown;
		const started = performance.now();
		try {
			value = canonical.decodeCanonical(stringWire(item.bytes));
		} catch (caught) {
			error = caught;
		}
		const elapsedMs = performance.now() - started;
		const calls = events.splice(0);
		const decodes = calls.filter((event) => event.kind === "decode");
		const encodes = calls.filter((event) => event.kind === "encode");
		const chunks = decodes.filter((event) => event.stream);
		const decoderId = calls.find((event) => event.kind === "construct-decoder")?.id;
		const hasValidationInput = item.bytes.length === 0 || chunks.length > 0;
		const checks: Record<string, boolean> = {
			compatibility:
				expected === undefined
					? error instanceof canonical.CanonicalDecodingError && error.message === "invalid UTF-8 string"
					: error === undefined && value === expected,
			hookReached: decodes.length > 0,
			freshCapturedDecoder:
				calls.filter((event) => event.kind === "construct-decoder").length === 1 && lateConstructors === 0,
			replacementMode: decodes.every((event) => event.fatal === false),
			noRetainedSharedDecoder: !imported.some((event) => event.kind === "construct-decoder"),
			boundedChunks: hasValidationInput && chunks.every((event) => (event.bytes?.length ?? Infinity) <= 4096),
			boundedPieces:
				encodes.length > 0 &&
				encodes.every(
					(event) => (event.text?.length ?? Infinity) <= 4099 && (event.bytes?.length ?? Infinity) <= 12297
				),
			reusedCapturedEncoder:
				encodes.length > 0 &&
				encodes.every((event) =>
					imported.some((capture) => capture.kind === "construct-encoder" && capture.id === event.id)
				) &&
				!calls.some((event) => event.kind === "construct-encoder"),
		};
		let offset = item.bytes[0] === 239 && item.bytes[1] === 187 && item.bytes[2] === 191 ? 3 : 0;
		let mismatch = false;
		let flush = false;
		let ordered = true;
		let carryBounded = true;
		let submitted = 0;
		let finalCount = 0;
		let pendingPiece: string | undefined;
		let pieceInputLength = 0;
		for (const event of calls) {
			if (event.kind === "decode") {
				if (event.id !== decoderId) ordered = false;
				if (mismatch || pendingPiece !== undefined) ordered = false;
				if (event.stream) {
					const bytes = event.bytes ?? [];
					if (!bytes.every((byte, index) => byte === item.bytes[submitted + index])) ordered = false;
					submitted += bytes.length;
					pieceInputLength = bytes.length;
					pendingPiece = event.text;
				} else if ((event.bytes?.length ?? 0) === 0 && !flush) {
					if (submitted !== item.bytes.length) ordered = false;
					flush = true;
					pieceInputLength = 0;
					pendingPiece = event.text;
				} else {
					finalCount++;
					if (
						!flush ||
						offset !== item.bytes.length ||
						event.id !== decoderId ||
						JSON.stringify(event.bytes) !== JSON.stringify(Array.from(item.bytes))
					)
						ordered = false;
				}
			} else if (event.kind === "encode") {
				if (mismatch || event.text !== pendingPiece) ordered = false;
				if (
					(event.text?.length ?? Infinity) > pieceInputLength + 3 ||
					(event.bytes?.length ?? Infinity) > 3 * (pieceInputLength + 3)
				)
					checks.boundedPieces = false;
				pendingPiece = undefined;
				for (const byte of event.bytes ?? []) {
					if (byte !== item.bytes[offset]) {
						mismatch = true;
						break;
					}
					offset++;
				}
				if (!mismatch && (submitted - offset > 3 || submitted - offset < -3)) carryBounded = false;
			}
		}
		checks.immediatePieceComparisonAndFinalOrdering =
			ordered &&
			hasValidationInput &&
			(expected === undefined
				? mismatch && finalCount === 0
				: flush && offset === item.bytes.length && finalCount === 1);
		checks.nativeCarryBound = hasValidationInput && carryBounded;
		if (item.id === "first-chunk-invalid-16384")
			checks.rejectFirstMismatch = mismatch && chunks.length === 1 && decodes.length === 1 && finalCount === 0;
		results.push({ id: item.id, bytes: item.bytes.length, accepted: expected !== undefined, elapsedMs, checks, calls });
	}
	globalThis.TextDecoder = NativeDecoder;
	globalThis.TextEncoder = NativeEncoder;
	return {
		imported,
		encoderControl,
		lateConstructors,
		results,
		limitation:
			"Native call/byte order bounds are observable; internal retention of already encoded pieces without further calls is not observable and requires GREEN source inspection. Harness retains telemetry intentionally; timings include instrumentation and are not uninstrumented product baselines or peak-memory measurements.",
	};
}
