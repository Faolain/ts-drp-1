interface Phase2lDScope {
	readonly author: string;
	readonly objectId: string;
}

interface Phase2lDEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface Phase2lDCommit {
	readonly authorSequence: number;
	readonly envelope: Phase2lDEnvelope;
	readonly issuedRecord: {
		readonly authorSequence: number;
		readonly envelope: Phase2lDEnvelope;
		readonly scope: Phase2lDScope;
	};
	readonly outboxEntry: {
		readonly authorSequence: number;
		readonly envelope: Phase2lDEnvelope;
		readonly scope: Phase2lDScope;
	};
}

type Phase2lDTransactIssue = (
	scope: Phase2lDScope,
	buildAndSign: (authorSequence: number) => Promise<Phase2lDCommit>
) => Promise<Phase2lDCommit>;

interface Phase2lDStore {
	readonly transactIssue: Phase2lDTransactIssue;
	readIssued(scope: Phase2lDScope, authorSequence: number): Promise<Phase2lDCommit | null>;
	readOutboxPage(input?: {
		readonly afterKey?: readonly [string, string, number] | null;
		readonly limit?: number;
		readonly scope?: Phase2lDScope;
	}): Promise<readonly { readonly commit: Phase2lDCommit; readonly publishState: "pending" | "published" }[]>;
	readLineage(scope: Phase2lDScope): Promise<{ readonly exhausted: boolean; readonly next: number }>;
	close(): Promise<void>;
}

declare module "#phase-2l-d-shared-harness" {
	export function runPhase2lDRealAdapterConformance(store: Phase2lDStore): Promise<unknown>;
}

declare module "#phase-2l-d-unmodified-protocol" {
	interface RawPublicKey {
		readonly bytes: Uint8Array;
		readonly format: "raw";
	}

	export function createTransactionalVertexIssuer(options: {
		readonly author: string;
		readonly privateKeySeed: Uint8Array;
		readonly publicKey: RawPublicKey;
		readonly transactIssue: Phase2lDTransactIssue;
	}): {
		issue(input: {
			readonly anchor: string;
			readonly dependencies: readonly string[];
			readonly epoch: number;
			readonly logicalTime: number;
			readonly objectId: string;
			readonly operation: Readonly<Record<string, unknown>>;
		}): Promise<Phase2lDCommit>;
	};

	export function verifyReceivedVertex(input: {
		readonly domain: string;
		readonly expectedAnchor: string;
		readonly receivedCanonicalPreimageBytes: Uint8Array;
		resolveAuthorPublicKey(author: string): RawPublicKey | undefined;
		readonly signature: Uint8Array;
		readonly suiteId: string;
	}): { readonly accepted: boolean; readonly digest?: Uint8Array };
}
