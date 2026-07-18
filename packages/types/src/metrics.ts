export interface IMetrics {
	traceFunc<Args extends unknown[], Return>(
		name: string,
		fn: (...args: Args) => Return,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		setAttributes?: (span: any, ...args: Args) => void,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		setResultAttributes?: (span: any, result: Awaited<Return>) => void
	): (...args: Args) => Return;
}
