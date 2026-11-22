export const NATIVE_BOUNDARIES = [
	"manifest-copy",
	"canonical-copy",
	"canonical-decode",
	"canonical-reencode",
	"incarnation-constructor",
	"incarnation-encode",
] as const;
export const NATIVE_SENTINELS = ["range-error", "misleading-type-error", "non-error"] as const;
export type NativeBoundary = (typeof NATIVE_BOUNDARIES)[number] | "sqlite-json";
export type NativeSentinel = (typeof NATIVE_SENTINELS)[number];
export interface NativeEvent {
	phase: string;
	kind: string;
	stack: string;
	injected: boolean;
	inputType?: string;
	argumentCount?: number;
	nativeSyntaxError?: boolean;
}
export interface NativeHooks {
	boundary: NativeBoundary;
	sentinel: unknown;
	events: NativeEvent[];
	injections(): number;
	phase(name: string, armed?: boolean): void;
	metadata(incarnation: unknown, descriptors: unknown): void;
	restore(): void;
}

/**
 * Install isolated pre-import, native-delegating processing-call controls.
 * @param boundary - Selected runtime processing boundary.
 * @param value - Synthetic thrown value kind.
 * @returns Test-local controller; no production API is changed.
 */
export function installNativeHooks(boundary: NativeBoundary, value: NativeSentinel): NativeHooks {
	const NativeBytes = globalThis.Uint8Array,
		NativeDecoder = globalThis.TextDecoder,
		NativeEncoder = globalThis.TextEncoder;
	const decode = NativeDecoder.prototype.decode,
		encode = NativeEncoder.prototype.encode,
		parse = JSON.parse;
	const sentinel: unknown =
		value === "range-error"
			? new RangeError("controlled native-owner processing failure")
			: value === "misleading-type-error"
				? new TypeError("invalid UTF-8 string: controlled processing failure")
				: Object.freeze({
						code: "manifest-invalid",
						message: "invalid UTF-8 string",
						marker: "controlled native-owner non-Error",
					});
	let phase = "module-import",
		armed = false,
		count = 0;
	let incarnation: unknown, descriptors: unknown;
	const events: NativeEvent[] = [];
	const reach = (kind: string, stack: string, extra: Partial<NativeEvent> = {}): NativeEvent | undefined => {
		if (phase === "module-import" || phase === "setup" || phase === "inspection") return undefined;
		const event = { phase, kind, stack, injected: armed, ...extra };
		if (!events.some((previous) => previous.phase === phase && previous.kind === kind)) events.push(event);
		if (armed) {
			armed = false;
			count++;
			throw sentinel;
		}
		return event;
	};
	globalThis.TextDecoder = new Proxy(NativeDecoder, {
		construct(target, args, newTarget): TextDecoder {
			const instance = Reflect.construct(target, args, newTarget) as TextDecoder;
			if (Object.getPrototypeOf(instance) !== NativeDecoder.prototype)
				throw new Error("native decoder prototype changed");
			Object.defineProperty(instance, "decode", {
				configurable: true,
				value: function (this: TextDecoder, ...args: Parameters<TextDecoder["decode"]>): string {
					if (boundary === "canonical-decode") {
						const stack = new Error("native discovery text decode").stack ?? "";
						if (stack.includes("decodeCanonical")) reach("TextDecoder.decode", stack);
					}
					return Reflect.apply(decode, this, args) as string;
				},
			});
			return instance;
		},
	});
	globalThis.TextEncoder = new Proxy(NativeEncoder, {
		construct(target, args, newTarget): TextEncoder {
			if (boundary === "incarnation-constructor") {
				const stack = new Error("native discovery incarnation constructor").stack ?? "";
				if (stack.includes("validateRecoveryManifest"))
					reach("TextEncoder constructor in validateRecoveryManifest", stack);
			}
			const instance = Reflect.construct(target, args, newTarget) as TextEncoder;
			if (Object.getPrototypeOf(instance) !== NativeEncoder.prototype)
				throw new Error("native encoder prototype changed");
			Object.defineProperty(instance, "encode", {
				configurable: true,
				value: function (this: TextEncoder, ...args: Parameters<TextEncoder["encode"]>): Uint8Array {
					const stack = new Error("native discovery text encode").stack ?? "";
					if (boundary === "canonical-reencode" && stack.includes("encodeCanonical") && stack.includes("decodeRecord"))
						reach("TextEncoder.encode during decodeRecord", stack);
					if (
						boundary === "incarnation-encode" &&
						args[0] === incarnation &&
						stack.includes("validateRecoveryManifest") &&
						!stack.includes("encodeCanonical")
					)
						reach("TextEncoder.encode incarnation", stack);
					return Reflect.apply(encode, this, args) as Uint8Array;
				},
			});
			return instance;
		},
	});
	globalThis.Uint8Array = new Proxy(NativeBytes, {
		construct(target, args, newTarget): Uint8Array {
			if (boundary === "canonical-copy" && args.length === 1 && args[0] instanceof NativeBytes) {
				const stack = new Error("native discovery canonical copy").stack ?? "";
				if (stack.includes("decodeCanonical")) reach("Uint8Array canonical input copy", stack);
			}
			if (boundary === "manifest-copy" && args.length === 1 && typeof args[0] === "number") {
				const stack = new Error("native discovery owned manifest copy").stack ?? "";
				if (stack.includes("copyExactCarrier")) reach("Uint8Array protocol owned allocation", stack);
			}
			return Reflect.construct(target, args, newTarget) as Uint8Array;
		},
	});
	JSON.parse = function (...args: Parameters<typeof JSON.parse>): unknown {
		let event: NativeEvent | undefined;
		if (boundary === "sqlite-json" && args[0] === descriptors)
			event = reach("native JSON.parse descriptors", new Error("native descriptor parse").stack ?? "", {
				inputType: typeof args[0],
				argumentCount: args.length,
			});
		try {
			return Reflect.apply(parse, JSON, args) as unknown;
		} catch (error) {
			if (event !== undefined) event.nativeSyntaxError = error instanceof SyntaxError;
			throw error;
		}
	};
	if (
		globalThis.Uint8Array.prototype !== NativeBytes.prototype ||
		globalThis.TextDecoder.prototype !== NativeDecoder.prototype ||
		globalThis.TextEncoder.prototype !== NativeEncoder.prototype
	)
		throw new Error("native prototype identity changed");
	return {
		boundary,
		sentinel,
		events,
		injections: () => count,
		phase: (name, enabled = false): void => {
			phase = name;
			armed = enabled;
		},
		metadata: (token, json): void => {
			incarnation = token;
			descriptors = json;
		},
		restore: (): void => {
			armed = false;
			globalThis.Uint8Array = NativeBytes;
			globalThis.TextDecoder = NativeDecoder;
			globalThis.TextEncoder = NativeEncoder;
			JSON.parse = parse;
		},
	};
}
