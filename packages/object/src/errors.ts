import { DRPError } from "@ts-drp/errors";

/** A request attempted to replace the locally derived root ACL authority. */
export class RootACLMutationError extends DRPError {
	/**
	 * @param message - Human-readable diagnostic text.
	 */
	constructor(message: string) {
		super("ROOT_ACL_MUTATION_FORBIDDEN", message);
		this.name = "RootACLMutationError";
	}
}
