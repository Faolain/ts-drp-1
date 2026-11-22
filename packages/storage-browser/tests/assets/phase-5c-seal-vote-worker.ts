interface WorkerRequest {
	readonly databaseName: string;
	readonly id: string;
	readonly mode: "commit" | "reopen";
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the tests-only RED lands before the package-internal GREEN owner.
// eslint-disable-next-line import/no-unresolved
const candidate = (await import("../../src/internal/seal-vote-test-control.js")) as {
	runSealVoteWorkerRequest(input: WorkerRequest): Promise<unknown>;
};

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	void candidate.runSealVoteWorkerRequest(event.data).then(
		(value) => self.postMessage({ id: event.data.id, ok: true, value }),
		(error: unknown) => self.postMessage({ id: event.data.id, ok: false, error: String(error) })
	);
});

export {};
