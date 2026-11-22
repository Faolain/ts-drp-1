import { expect, it } from "vitest";

function finishedCallbackCount(task: object): number {
	const callbacks: unknown = Reflect.get(task, "onFinished");
	if (callbacks === undefined) return 0;
	if (!Array.isArray(callbacks)) throw new TypeError("VITEST_FINISHED_CALLBACK_LIST_REQUIRED");
	return callbacks.length;
}

it("causal control: installed Vitest keeps a test-end callback after awaited rejects.toThrow", async ({ task }) => {
	const before = finishedCallbackCount(task);
	await expect(Promise.reject(new TypeError("genuine expected publication failure"))).rejects.toThrow();
	expect(finishedCallbackCount(task), "ASYNC_ASSERTION_CALLBACK_SURVIVES_AWAIT").toBe(before + 1);
});

it("consumes repeated genuine and non-Error rejections as void without registering test-end callbacks", async ({
	task,
}) => {
	const { assertGridExpectedPublicationFailure } = await import("./fixtures/grid-expected-publication-failure.js");
	const owner = Object.freeze({ name: "synthetic room owner", bytes: new Uint8Array(16) });
	const error = Object.freeze(new TypeError("expected transport publication failure", { cause: owner }));
	const rejectedValues: readonly unknown[] = [
		error,
		new Error("other expected failure"),
		"scalar",
		false,
		undefined,
		null,
	];
	const before = finishedCallbackCount(task);
	for (let round = 0; round < 4; round += 1) {
		for (const rejectedValue of rejectedValues) {
			const result = await assertGridExpectedPublicationFailure(Promise.reject(rejectedValue));
			expect(result, "EXPECTED_FAILURE_HELPER_MUST_NOT_RETURN_REJECTION_OR_OWNER").toBeUndefined();
			expect(finishedCallbackCount(task), "EXPECTED_FAILURE_MUST_NOT_ACCUMULATE_TEST_END_OWNER_ROOTS").toBe(before);
		}
	}
	expect(error.cause).toBe(owner);
	expect(error.message).toBe("expected transport publication failure");
});

it("does not inspect or rewrite an arbitrary rejection payload", async ({ task }) => {
	const { assertGridExpectedPublicationFailure } = await import("./fixtures/grid-expected-publication-failure.js");
	let inspections = 0;
	const rejectedValue = Object.freeze(
		Object.defineProperty({}, "message", {
			get: (): never => {
				inspections += 1;
				throw new Error("REJECTION_PAYLOAD_MUST_REMAIN_OPAQUE");
			},
		})
	);
	const before = finishedCallbackCount(task);
	const result = await assertGridExpectedPublicationFailure(Promise.reject(rejectedValue));
	expect(result).toBeUndefined();
	expect(inspections).toBe(0);
	expect(finishedCallbackCount(task)).toBe(before);
});

it.each([
	{ label: "false", value: false },
	{ label: "undefined", value: undefined },
	{ label: "Error object", value: new Error("resolved Error is not a rejection") },
	{ label: "null", value: null },
	{ label: "true", value: true },
])("rejects fulfilled $label while preserving the original workload assertion label", async ({ value }) => {
	const { assertGridExpectedPublicationFailure } = await import("./fixtures/grid-expected-publication-failure.js");
	let rejected = false;
	let detail: unknown;
	try {
		await assertGridExpectedPublicationFailure(Promise.resolve(value));
	} catch (error) {
		rejected = true;
		detail = error;
	}
	expect(rejected, "FULFILLMENT_MUST_NEVER_PASS_EXPECTED_REJECTION_CONTROL").toBe(true);
	expect(detail).toBeInstanceOf(Error);
	if (!(detail instanceof Error)) throw new Error("EXPECTED_REJECTION_ASSERTION_FAILURE_REQUIRED");
	expect(detail.message).toContain("GRID100_REAL_PENDING_PUBLICATION_FAILURE");
});
