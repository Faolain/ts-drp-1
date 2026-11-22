export type CanvasRgb = readonly [number, number, number];
export type CanvasOffset = readonly [number, number];
export interface CanvasState {
	readonly version: 1;
	readonly width: number;
	readonly height: number;
	readonly counters: readonly CanvasRgb[];
}
export type CanvasOperation =
	| Readonly<{ action: "paint"; offset: CanvasOffset; rgb: CanvasRgb }>
	| Readonly<{ action: "splash"; offset: CanvasOffset; size: CanvasOffset; rgb: CanvasRgb }>;
export type CanvasWireOperation =
	| Readonly<{
			action: "paint";
			clientOperationId: string;
			payload: Readonly<{ offset: CanvasOffset; rgb: CanvasRgb }>;
	  }>
	| Readonly<{
			action: "splash";
			clientOperationId: string;
			payload: Readonly<{ offset: CanvasOffset; size: CanvasOffset; rgb: CanvasRgb }>;
	  }>;
export interface CanvasKernelResult {
	readonly state: CanvasState;
	readonly output: CanvasOperation;
}
export interface CanvasReducerInput {
	readonly state: unknown;
	readonly operation: unknown;
}
export interface CanvasStateKernel {
	createState(width: number, height: number): CanvasState;
	captureState(value: unknown): CanvasState;
	captureOperation(value: unknown): CanvasOperation;
	apply(state: unknown, operation: unknown): CanvasKernelResult;
	queryCounters(state: unknown, x: number, y: number): CanvasRgb;
	queryColor(state: unknown, x: number, y: number): CanvasRgb;
	readonly reducers: Readonly<{
		paint(input: CanvasReducerInput): CanvasKernelResult;
		splash(input: CanvasReducerInput): CanvasKernelResult;
	}>;
}
