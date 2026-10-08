export const STAGES = [
	"decoder-constructor",
	"validation-encode",
	"chunk-decode",
	"flush-decode",
	"final-decode",
] as const;
export const SENTINELS = ["range", "misleading-type", "non-error"] as const;
export type Stage = (typeof STAGES)[number];
export type Sentinel = (typeof SENTINELS)[number];
interface Event {
	phase: string;
	kind: string;
	id: number;
	stage?: Stage;
	bytes?: number;
	characters?: number;
	stream?: boolean;
	fatal?: boolean;
	injected: boolean;
	stack?: string;
}

/**
 * Exercise a selected native validation operation in a fresh codec context.
 * @param stage - Contract-defined native operation, independent of private helper names.
 * @param variant - Controlled operational sentinel.
 * @returns Honest path availability, propagation and control evidence.
 */
export async function probe(
	stage: Stage,
	variant: Sentinel
): Promise<{
	stage: Stage;
	variant: Sentinel;
	controls: Record<string, boolean>;
	injections: number;
	events: Event[];
	pathPresent: boolean;
	classification: string;
	observed: { threw: boolean; originalSentinel: boolean; code: unknown };
	limitation: string;
}> {
	const NativeDecoder = globalThis.TextDecoder;
	const NativeEncoder = globalThis.TextEncoder;
	const nativeDecode = NativeDecoder.prototype.decode;
	const nativeEncode = NativeEncoder.prototype.encode;
	const sentinel: unknown =
		variant === "range"
			? new RangeError("controlled validation operation failure")
			: variant === "misleading-type"
				? new TypeError("invalid UTF-8 string: controlled validation operation failure")
				: Object.freeze({
						code: "CANONICAL_DECODING",
						message: "invalid UTF-8 string",
						marker: "non-Error validation sentinel",
					});
	const events: Event[] = [];
	let phase = "import",
		nextId = 0,
		active = false,
		armed = false,
		injections = 0,
		lateConstructors = 0;
	let chunkSeen = false,
		flushSucceeded = false;
	const reach = (event: Omit<Event, "phase" | "injected">): void => {
		const injected = armed && active && event.stage === stage;
		events.push({
			...event,
			phase,
			injected,
			...(event.stage === stage ? { stack: new Error("selected native validation stage").stack ?? "" } : {}),
		});
		if (injected) {
			armed = false;
			injections++;
			throw sentinel;
		}
	};
	globalThis.TextDecoder = new Proxy(NativeDecoder, {
		construct(target, args, newTarget): TextDecoder {
			const id = ++nextId;
			reach({ kind: "TextDecoder constructor", id, ...(active ? { stage: "decoder-constructor" as const } : {}) });
			const instance = Reflect.construct(target, args, newTarget) as TextDecoder;
			if (Object.getPrototypeOf(instance) !== NativeDecoder.prototype)
				throw new Error("native decoder slots/prototype control failed");
			Object.defineProperty(instance, "decode", {
				configurable: true,
				value: function (this: TextDecoder, ...args: Parameters<TextDecoder["decode"]>): string {
					const bytes = args[0]?.byteLength ?? 0,
						stream = args[1]?.stream === true;
					const selected: Stage | undefined = !active
						? undefined
						: stream
							? "chunk-decode"
							: bytes === 0 && chunkSeen && !flushSucceeded
								? "flush-decode"
								: bytes > 0 && flushSucceeded
									? "final-decode"
									: undefined;
					reach({
						kind: "TextDecoder.decode",
						id,
						bytes,
						stream,
						fatal: this.fatal,
						...(selected ? { stage: selected } : {}),
					});
					const result = Reflect.apply(nativeDecode, this, args) as string;
					if (active && stream) chunkSeen = true;
					if (selected === "flush-decode") flushSucceeded = true;
					return result;
				},
			});
			return instance;
		},
	});
	globalThis.TextEncoder = new Proxy(NativeEncoder, {
		construct(target, args, newTarget): TextEncoder {
			const id = ++nextId;
			reach({ kind: "TextEncoder constructor", id });
			const instance = Reflect.construct(target, args, newTarget) as TextEncoder;
			if (Object.getPrototypeOf(instance) !== NativeEncoder.prototype)
				throw new Error("native encoder slots/prototype control failed");
			Object.defineProperty(instance, "encode", {
				configurable: true,
				value: function (this: TextEncoder, ...args: Parameters<TextEncoder["encode"]>): Uint8Array {
					reach({
						kind: "TextEncoder.encode",
						id,
						characters: args[0]?.length ?? 0,
						...(active ? { stage: "validation-encode" as const } : {}),
					});
					return Reflect.apply(nativeEncode, this, args) as Uint8Array;
				},
			});
			return instance;
		},
	});
	try {
		const canonical = await import("../../../packages/canonical/dist/src/index.js");
		const importEvents = events.filter((event) => event.phase === "import");
		globalThis.TextDecoder = new Proxy(NativeDecoder, {
			construct(target, args, newTarget): TextDecoder {
				lateConstructors++;
				return Reflect.construct(target, args, newTarget) as TextDecoder;
			},
		});
		globalThis.TextEncoder = new Proxy(NativeEncoder, {
			construct(target, args, newTarget): TextEncoder {
				lateConstructors++;
				return Reflect.construct(target, args, newTarget) as TextEncoder;
			},
		});
		phase = "encoder-control";
		const text = "A😀�".repeat(2048);
		const input = canonical.encodeCanonical(text);
		const original = Array.from(input);
		const action = (nextPhase: string, fault: boolean): { value?: unknown; error?: unknown; threw: boolean } => {
			phase = nextPhase;
			active = true;
			armed = fault;
			chunkSeen = false;
			flushSucceeded = false;
			try {
				return { value: canonical.decodeCanonical(input), threw: false };
			} catch (error) {
				return { error, threw: true };
			} finally {
				active = false;
				armed = false;
			}
		};
		const valid = action("valid", false);
		const fault = action("fault", true);
		const retry = action("retry", false);
		phase = "deterministic-control";
		let sameOwner = false;
		try {
			canonical.decodeCanonical(Uint8Array.of(5, 1, 255));
		} catch (error) {
			sameOwner =
				error instanceof canonical.CanonicalDecodingError &&
				Object.getPrototypeOf(error) === canonical.CanonicalDecodingError.prototype &&
				error.message === "invalid UTF-8 string";
		}
		const selectedControl = events.filter((event) => event.phase === "valid" && event.stage === stage);
		const selectedFault = events.filter((event) => event.phase === "fault" && event.stage === stage);
		const controls = {
			valid: !valid.threw && valid.value === text,
			retry: !retry.threw && retry.value === text,
			inputUnchanged: original.length === input.length && original.every((byte, index) => byte === input[index]),
			capturedEncoder: events.some(
				(event) =>
					event.phase === "encoder-control" &&
					event.kind === "TextEncoder.encode" &&
					importEvents.some((capture) => capture.kind === "TextEncoder constructor" && capture.id === event.id)
			),
			capturedConstructorObserved: events.some(
				(event) =>
					event.kind === "TextDecoder constructor" &&
					["import", "valid"].includes(event.phase) &&
					events.some((call) => call.phase === "valid" && call.kind === "TextDecoder.decode" && call.id === event.id)
			),
			selectedCapturedEncoder:
				stage !== "validation-encode" ||
				selectedControl.every((event) =>
					importEvents.some((capture) => capture.kind === "TextEncoder constructor" && capture.id === event.id)
				),
			capturedBindings: lateConstructors === 0,
			sameCanonicalOwner: sameOwner,
			nativePrototypesUnchanged:
				NativeDecoder.prototype.decode === nativeDecode && NativeEncoder.prototype.encode === nativeEncode,
			selectionConsistent:
				selectedControl.length === 0
					? injections === 0 && selectedFault.length === 0 && !fault.threw && fault.value === text
					: injections === 1 && selectedFault.length > 0,
		};
		return {
			stage,
			variant,
			controls,
			injections,
			events,
			pathPresent: selectedControl.length > 0,
			classification: !Object.values(controls).every(Boolean)
				? "HARNESS_OR_CONTROL_FAILURE"
				: selectedControl.length === 0
					? "ABSENT_VALIDATION_PATH"
					: fault.threw && fault.error === sentinel
						? "PASS"
						: "VALIDATION_PROPAGATION_GAP",
			observed: {
				threw: fault.threw,
				originalSentinel: fault.threw && fault.error === sentinel,
				code:
					fault.error !== null && typeof fault.error === "object" ? (Reflect.get(fault.error, "code") ?? null) : null,
			},
			limitation:
				"Controlled native method boundaries, not native OOM. Zero-injection absent validation is unmet algorithm evidence, not thrown-failure classification. Internal piece nonaccumulation requires separate source verification.",
		};
	} finally {
		globalThis.TextDecoder = NativeDecoder;
		globalThis.TextEncoder = NativeEncoder;
	}
}
