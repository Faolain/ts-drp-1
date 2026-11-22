export function armPhase3a1bP4NodeReadbackInterleave(
	input: Readonly<{
		readonly appendInput: Readonly<Record<string, unknown>>;
		readonly moduleUrl: string;
		readonly primaryFilename: string;
		readonly readinessInput: Readonly<Record<string, unknown>>;
	}>
): void;
export function armPhase3a1bP4NodeReadbackFault(
	fate: "exact-new" | "exact-old" | "mixed" | "unreadable",
	callback?: () => void
): void;
export function observePhase3a1bP4NodeOperation<T>(label: string, callback: () => Promise<T> | T): Promise<T>;
export function takePhase3a1bP4NodeObservationLedger(): readonly string[];
