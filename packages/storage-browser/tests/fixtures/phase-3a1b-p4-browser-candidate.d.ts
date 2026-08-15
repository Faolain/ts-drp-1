declare module "#phase-3a1b-p4-browser-candidate" {
	export function createBrowserDurableLiveJournalStore(options: {
		readonly primaryDatabaseName: string;
	}): Promise<unknown>;
}

declare module "#phase-3a1b-p4-browser-test-control" {
	export function armPhase3a1bP4BrowserTrace(
		tuple: Readonly<{ readonly edge: string }>,
		checkpoint: (edge: string) => void
	): void;
	export function armPhase3a1bP4BrowserDurabilityDowngrade(): void;
	export function armPhase3a1bP4BrowserReadbackFault(fate: "exact-new" | "exact-old" | "mixed" | "unreadable"): void;
}
