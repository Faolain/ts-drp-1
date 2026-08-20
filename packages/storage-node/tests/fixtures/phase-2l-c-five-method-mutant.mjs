/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
// Deliberately plausible but non-durable test-only mutant. It proves the RED
// kills behavior after import/surface resolution rather than only a missing file.
/** @returns A deliberately non-durable five-method capability. */
export function createNodeDurableIssuanceStore() {
	let closed = false;
	let closePromise;
	const commits = new Map();
	const lineages = new Map();
	const key = (scope) => `${scope.objectId}\0${scope.author}`;
	const store = {
		async transactIssue(scope, build) {
			if (closed) throw Object.assign(new Error("closed"), { code: "ISSUANCE_STORE_CLOSED" });
			const selected = lineages.get(key(scope)) ?? 0;
			const value = await build(selected);
			lineages.set(key(scope), selected + 1);
			commits.set(`${key(scope)}\0${selected}`, value);
			return structuredClone(value);
		},
		async readIssued(scope, authorSequence) {
			return structuredClone(commits.get(`${key(scope)}\0${authorSequence}`) ?? null);
		},
		async readOutboxPage() {
			return [...commits.values()].map((commit) => ({ commit: structuredClone(commit), publishState: "pending" }));
		},
		async readLineage(scope) {
			return { exhausted: false, next: lineages.get(key(scope)) ?? 0 };
		},
		close() {
			closed = true;
			closePromise ??= Promise.resolve();
			return closePromise;
		},
	};
	return Object.freeze(store);
}
