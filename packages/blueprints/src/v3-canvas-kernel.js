/* eslint @typescript-eslint/explicit-function-return-type: "off", jsdoc/no-types: "off" -- Executable JavaScript artifact uses JSDoc to bind its public schema types. */
import { blueprint as artifactBlueprint } from "./v3-canvas-artifact.mjs";

// One pure reducer owner for artifact execution, projection and restored state.
export const CANVAS_LIMITS = Object.freeze({
	maxDimension: 64,
	maxPixels: 4096,
	maxIncrement: 255,
	maxCounter: Number.MAX_SAFE_INTEGER,
});

function record(value, keys) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid canvas record");
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) throw new TypeError("invalid canvas record prototype");
	const own = Reflect.ownKeys(value);
	if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
		throw new TypeError("invalid canvas fields");
	const captured = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) throw new TypeError("canvas accessor refused");
		captured[key] = descriptor.value;
	}
	return captured;
}

function integer(value, minimum, maximum) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("invalid canvas integer");
	return Object.is(value, -0) ? 0 : value;
}

function array(value, size) {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		throw new TypeError("invalid canvas array");
	const length = Object.getOwnPropertyDescriptor(value, "length");
	if (!length || length.value !== size || Reflect.ownKeys(value).length !== size + 1)
		throw new TypeError("invalid canvas array fields");
	const result = [];
	for (let i = 0; i < size; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (!descriptor || !("value" in descriptor)) throw new TypeError("invalid canvas array entry");
		result.push(descriptor.value);
	}
	return result;
}

function rgb(value, maximum) {
	return Object.freeze(array(value, 3).map((channel) => integer(channel, 0, maximum)));
}

function dimensions(width, height) {
	integer(width, 1, CANVAS_LIMITS.maxDimension);
	integer(height, 1, CANVAS_LIMITS.maxDimension);
	if (width * height > CANVAS_LIMITS.maxPixels) throw new TypeError("canvas area exceeded");
}

function frozenState(width, height, counters) {
	return Object.freeze({ version: 1, width, height, counters: Object.freeze(counters) });
}

// The wire envelope uses the existing canonical-object toolchain schema, while
// the app/kernel keep their original flat offset/rgb/size API.
/**
 * Captures one flat game operation into the exact canonical-object wire schema.
 * @param {unknown} value - Untrusted flat Canvas operation.
 * @param {string} clientOperationId - Stable identity of this logical user operation.
 * @returns {import("./v3-canvas-types.js").CanvasWireOperation} Detached immutable wire operation.
 */
export function toCanvasWireOperation(value, clientOperationId) {
	if (typeof clientOperationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(clientOperationId))
		throw new TypeError("invalid Canvas operation identity");
	const operation = createCanvasStateKernel().captureOperation(value);
	return Object.freeze({
		action: operation.action,
		clientOperationId,
		payload: Object.freeze(
			operation.action === "splash"
				? { offset: operation.offset, rgb: operation.rgb, size: operation.size }
				: { offset: operation.offset, rgb: operation.rgb }
		),
	});
}
/**
 * Captures a wire envelope without invoking caller accessors.
 * @param {unknown} value - Authenticated or caller-supplied wire operation.
 * @returns {import("./v3-canvas-types.js").CanvasOperation} Original immutable flat game operation.
 */
export function fromCanvasWireOperation(value) {
	const operation = record(value, ["action", "clientOperationId", "payload"]);
	if (typeof operation.clientOperationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(operation.clientOperationId))
		throw new TypeError("invalid Canvas operation identity");
	const splash = operation.action === "splash";
	if (!splash && operation.action !== "paint") throw new TypeError("unknown canvas action");
	const payload = record(operation.payload, splash ? ["offset", "rgb", "size"] : ["offset", "rgb"]);
	return createCanvasStateKernel().captureOperation(
		splash
			? { action: "splash", offset: payload.offset, rgb: payload.rgb, size: payload.size }
			: { action: "paint", offset: payload.offset, rgb: payload.rgb }
	);
}

/**
 * Creates the shared synchronous additive canvas reducer.
 * @returns {import("./v3-canvas-types.js").CanvasStateKernel} The immutable pure kernel.
 */
export function createCanvasStateKernel() {
	function createState(width, height) {
		dimensions(width, height);
		return frozenState(
			width,
			height,
			Array.from({ length: width * height }, () => Object.freeze([0, 0, 0]))
		);
	}
	function captureState(value) {
		const state = record(value, ["version", "width", "height", "counters"]);
		if (state.version !== 1) throw new TypeError("unsupported canvas state");
		dimensions(state.width, state.height);
		return frozenState(
			state.width,
			state.height,
			array(state.counters, state.width * state.height).map((pixel) => rgb(pixel, CANVAS_LIMITS.maxCounter))
		);
	}
	function captureOperation(value) {
		const action = Object.getOwnPropertyDescriptor(value ?? {}, "action");
		if (!action || !("value" in action)) throw new TypeError("invalid canvas action");
		const splash = action.value === "splash";
		if (!splash && action.value !== "paint") throw new TypeError("unknown canvas action");
		const op = record(value, splash ? ["action", "offset", "size", "rgb"] : ["action", "offset", "rgb"]);
		const offset = Object.freeze(array(op.offset, 2).map((n) => integer(n, 0, CANVAS_LIMITS.maxDimension - 1)));
		const increment = rgb(op.rgb, CANVAS_LIMITS.maxIncrement);
		return Object.freeze(
			splash
				? {
						action: "splash",
						offset,
						size: Object.freeze(array(op.size, 2).map((n) => integer(n, 1, CANVAS_LIMITS.maxDimension))),
						rgb: increment,
					}
				: { action: "paint", offset, rgb: increment }
		);
	}
	function apply(value, operation) {
		const state = captureState(value),
			op = captureOperation(operation);
		const payload =
			op.action === "splash" ? { offset: op.offset, rgb: op.rgb, size: op.size } : { offset: op.offset, rgb: op.rgb };
		try {
			const input = { state, operation: { action: op.action, clientOperationId: "kernel-direct", payload } };
			const result =
				op.action === "paint" ? artifactBlueprint.reducers.paint(input) : artifactBlueprint.reducers.splash(input);
			return Object.freeze({ state: captureState(result.state), output: captureOperation(result.output) });
		} catch (error) {
			throw error instanceof TypeError ? error : new TypeError(String(error));
		}
	}
	function queryCounters(value, x, y) {
		const state = captureState(value);
		integer(x, 0, state.width - 1);
		integer(y, 0, state.height - 1);
		return state.counters[x * state.height + y];
	}
	function queryColor(value, x, y) {
		return Object.freeze(queryCounters(value, x, y).map((channel) => channel % 256));
	}
	function paint(input) {
		if (Object.getOwnPropertyDescriptor(input.operation, "action")?.value !== "paint")
			throw new TypeError("paint action mismatch");
		return apply(input.state, input.operation);
	}
	function splash(input) {
		if (Object.getOwnPropertyDescriptor(input.operation, "action")?.value !== "splash")
			throw new TypeError("splash action mismatch");
		return apply(input.state, input.operation);
	}
	return Object.freeze({
		createState,
		captureState,
		captureOperation,
		apply,
		queryCounters,
		queryColor,
		reducers: Object.freeze({ paint, splash }),
	});
}

// The exact same module can be the artifact entry: no parallel reducer text.
export const blueprint = Object.freeze({
	exportSchemaVersion: 1,
	artifactId: "v3-additive-rgb-canvas.v1",
	runtimeProfile: "ecmascript-2024-sync-v1",
	reducers: createCanvasStateKernel().reducers,
});
