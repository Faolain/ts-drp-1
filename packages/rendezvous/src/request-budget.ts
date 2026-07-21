/** A bounded counter used before public network requests. */
export class RequestBudget {
	readonly limit: number;
	#consumed = 0;

	/**
	 * Creates a request budget.
	 * @param limit - Maximum requests allowed for the bounded operation.
	 */
	constructor(limit: number) {
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("request budget limit must be a positive safe integer");
		}
		this.limit = limit;
	}

	/** @returns Requests already consumed. */
	get consumed(): number {
		return this.#consumed;
	}

	/** @returns Requests still available. */
	get remaining(): number {
		return this.limit - this.#consumed;
	}

	/**
	 * Reserves capacity before requests are started.
	 * @param count - Number of requests about to be made.
	 */
	consume(count = 1): void {
		if (!Number.isSafeInteger(count) || count <= 0) {
			throw new Error("request count must be a positive safe integer");
		}
		if (this.#consumed + count > this.limit) {
			throw new Error(`public request cap exhausted (${this.#consumed}/${this.limit})`);
		}
		this.#consumed += count;
	}
}
