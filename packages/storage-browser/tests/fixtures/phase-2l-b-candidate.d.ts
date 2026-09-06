declare module "#phase-2l-b-candidate" {
	import type { Phase2lBStore } from "./phase-2l-b-browser-issuance-contract.js";

	export function createBrowserDurableIssuanceStore(options: {
		readonly primaryDatabaseName: string;
	}): Promise<Phase2lBStore>;
}

declare module "#phase-2l-b-test-control" {
	export function runBrowserTerminalAmbiguityCase(input: {
		readonly caseId: "absent-old" | "exact-pair" | "foreign-pair" | "torn-or-inconsistent" | "unreadable";
		readonly primaryDatabaseName: string;
	}): Promise<Readonly<{ code: string; exposedKeys: readonly string[] }>>;
}
