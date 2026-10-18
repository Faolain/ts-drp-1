import { deepCloneCanonical, encodeCanonical } from "@ts-drp/canonical";

export interface DeterministicStateMachineOptions<State, Operation> {
	readonly initialState: State;
	reduce(state: State, operation: Operation): State | undefined;
	validateState?(state: State): void;
}

/** A reference-shaped, tests-only deterministic state-machine oracle. */
export class DeterministicStateMachine<State, Operation> {
	readonly #reduce: DeterministicStateMachineOptions<State, Operation>["reduce"];
	readonly #validateState: DeterministicStateMachineOptions<State, Operation>["validateState"];
	#state: State;

	constructor(options: DeterministicStateMachineOptions<State, Operation>) {
		if (typeof options?.reduce !== "function") throw new TypeError("a reducer function is required");
		this.#reduce = options.reduce;
		this.#validateState = options.validateState;
		this.#state = deepCloneCanonical(options.initialState);
		this.#validate(this.#state);
	}

	#validate(state: State): void {
		encodeCanonical(state);
		this.#validateState?.(state);
	}

	adopt(snapshot: State): void {
		this.#validate(snapshot);
		this.#state = deepCloneCanonical(snapshot);
	}

	apply(operation: Operation): State {
		const draft = this.snapshot();
		const result = this.#reduce(draft, deepCloneCanonical(operation));
		if (result !== null && (typeof result === "object" || typeof result === "function")) {
			if (typeof Reflect.get(result, "then") === "function") {
				throw new TypeError("reducers must be synchronous and deterministic");
			}
		}
		const next = result === undefined ? draft : result;
		this.#validate(next);
		this.#state = deepCloneCanonical(next);
		return this.snapshot();
	}

	fork(): DeterministicStateMachine<State, Operation> {
		return new DeterministicStateMachine({
			initialState: this.#state,
			reduce: this.#reduce,
			...(this.#validateState === undefined ? {} : { validateState: this.#validateState }),
		});
	}

	snapshot(): State {
		return deepCloneCanonical(this.#state);
	}
}
