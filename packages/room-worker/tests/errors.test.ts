import { describe, expect, it } from "vitest";

import {
	decodeError,
	encodeError,
	errorCodec,
	RoomWorkerClosed,
	RoomWorkerCrashed,
	RoomWorkerLimit,
	RoomWorkerProtocolError,
	RoomWorkerRemoteError,
	RoomWorkerUnsupported,
	ROOM_WORKER_MAX_CAUSE_DEPTH,
} from "@ts-drp/room-worker";

// The wire is the structured clone algorithm: every round trip below goes through it, as a
// postMessage between a worker and its page does.
const roundTrip = (error: unknown, codecs = [] as Parameters<typeof encodeError>[1]): unknown =>
	decodeError(structuredClone(encodeError(error, codecs)), codecs);

class KeptMove extends Error {
	readonly kind = "kept" as const;
	constructor(
		readonly operation: Readonly<Record<string, unknown>>,
		readonly epoch: number,
		options?: ErrorOptions
	) {
		super("the move is kept", options);
		this.name = "KeptMove";
	}
}

class Refused extends TypeError {
	readonly code = "REFUSED";
	constructor(readonly reason: "a" | "b", detail: string) {
		super(`REFUSED: ${reason}: ${detail}`);
		this.name = "Refused";
	}
}

const BRAND = Symbol.for("test/branded");
class Branded extends Error {
	readonly [BRAND] = true;
	constructor(readonly code: string, message?: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "Branded";
	}
}

class WithFunction extends Error {
	readonly callback = (): void => undefined;
	constructor() {
		super("has a function field");
		this.name = "WithFunction";
	}
}

describe("room worker error codec", () => {
	it("keeps the class, name, message and every data field of a registered error", () => {
		const codecs = [errorCodec("KeptMove", KeptMove), errorCodec("Refused", Refused)];
		const kept = roundTrip(new KeptMove(Object.freeze({ action: "placeBlock", id: "b1" }), 7), codecs);
		expect(kept).toBeInstanceOf(KeptMove);
		expect(kept).toBeInstanceOf(Error);
		expect(kept).toMatchObject({ name: "KeptMove", message: "the move is kept", kind: "kept", epoch: 7 });
		expect((kept as KeptMove).operation).toEqual({ action: "placeBlock", id: "b1" });

		const refused = roundTrip(new Refused("b", "behind"), codecs);
		expect(refused).toBeInstanceOf(Refused);
		expect(refused).toBeInstanceOf(TypeError);
		expect(refused).toMatchObject({ name: "Refused", code: "REFUSED", reason: "b", message: "REFUSED: b: behind" });
	});

	it("keeps the cause chain, bounded in depth", () => {
		const codecs = [errorCodec("KeptMove", KeptMove)];
		const inner = new RangeError("capacity");
		const kept = roundTrip(new KeptMove({}, 2, { cause: inner }), codecs) as KeptMove;
		expect(kept.cause).toBeInstanceOf(RangeError);
		expect((kept.cause as Error).message).toBe("capacity");

		let deep: Error = new Error("root");
		for (let index = 0; index < ROOM_WORKER_MAX_CAUSE_DEPTH + 3; index++) deep = new Error(`level ${index}`, { cause: deep });
		let decoded = roundTrip(deep) as Error | undefined;
		let depth = 0;
		while (decoded !== undefined) {
			depth++;
			decoded = decoded.cause as Error | undefined;
		}
		expect(depth).toBe(ROOM_WORKER_MAX_CAUSE_DEPTH + 1);
	});

	it("restores the standard error classes and DOMException without registration", () => {
		expect(roundTrip(new TypeError("t"))).toBeInstanceOf(TypeError);
		expect(roundTrip(new RangeError("r"))).toBeInstanceOf(RangeError);
		const plain = roundTrip(new Error("e"));
		expect(plain).toBeInstanceOf(Error);
		expect(plain).not.toBeInstanceOf(RoomWorkerRemoteError);
		const dom = roundTrip(new DOMException("quota", "QuotaExceededError")) as DOMException;
		expect(dom).toBeInstanceOf(DOMException);
		expect(dom.name).toBe("QuotaExceededError");
	});

	it("never guesses a type: an unregistered class arrives as RoomWorkerRemoteError with its name", () => {
		const remote = roundTrip(new KeptMove({}, 1)) as RoomWorkerRemoteError;
		expect(remote).toBeInstanceOf(RoomWorkerRemoteError);
		expect(remote).not.toBeInstanceOf(KeptMove);
		expect(remote.remoteName).toBe("KeptMove");
		expect(remote.message).toBe("the move is kept");
	});

	it("never guesses a type: a registered class whose fields cannot cross arrives as RoomWorkerRemoteError", () => {
		const remote = roundTrip(new WithFunction(), [errorCodec("WithFunction", WithFunction)]);
		expect(remote).toBeInstanceOf(RoomWorkerRemoteError);
		expect((remote as RoomWorkerRemoteError).remoteName).toBe("WithFunction");
	});

	it("uses a codec's own constructor when the class carries state a data copy cannot restore", () => {
		const codecs = [
			errorCodec("Branded", Branded, {
				construct: (fields, message, cause) =>
					new Branded(fields.code as string, message, cause === undefined ? undefined : { cause }),
			}),
		];
		const branded = roundTrip(new Branded("X_CODE", "branded"), codecs) as Branded;
		expect(branded).toBeInstanceOf(Branded);
		expect(branded[BRAND]).toBe(true);
		expect(branded.code).toBe("X_CODE");
	});

	it("restores a non-error throw as RoomWorkerRemoteError", () => {
		const remote = roundTrip("plain string") as RoomWorkerRemoteError;
		expect(remote).toBeInstanceOf(RoomWorkerRemoteError);
		expect(remote.message).toBe("plain string");
	});

	it("keeps the remote stack", () => {
		const error = new TypeError("where");
		const decoded = roundTrip(error) as Error & { remoteStack?: string };
		expect(decoded.remoteStack).toBe(error.stack);
	});

	it("the library's own errors round-trip without registration", () => {
		for (const error of [
			new RoomWorkerCrashed("terminated"),
			new RoomWorkerClosed(),
			new RoomWorkerUnsupported(["RTCDataChannel"]),
			new RoomWorkerLimit("calls", 256),
			new RoomWorkerProtocolError("bad"),
		]) {
			const decoded = roundTrip(error) as Error;
			expect(decoded).toBeInstanceOf(error.constructor as new () => Error);
			expect(decoded.message).toBe(error.message);
			expect((decoded as unknown as { code: string }).code).toBe((error as unknown as { code: string }).code);
		}
	});

	it("refuses two codecs with one id", () => {
		expect(() =>
			encodeError(new Error("x"), [errorCodec("Same", KeptMove), errorCodec("Same", Refused)])
		).toThrow(TypeError);
	});
});
