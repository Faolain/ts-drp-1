type Result = Readonly<Record<string, unknown>>;
type StageOwner = (input: unknown) => Promise<Result>;

let publishOwner: StageOwner | undefined;
let stageOwner: StageOwner | undefined;

/**
 * Installs the sole private durable-stage owner.
 * @param owner - Authenticated stage kernel.
 * @returns Whether the owner was installed.
 */
export function installCreatorAdoptionStage(owner: StageOwner): boolean {
	if (stageOwner !== undefined) return false;
	stageOwner = owner;
	return true;
}

/**
 * Installs the sole private staged-publication owner.
 * @param owner - Authenticated head-publication kernel.
 * @returns Whether the owner was installed.
 */
export function installCreatorAdoptionPublish(owner: StageOwner): boolean {
	if (publishOwner !== undefined) return false;
	publishOwner = owner;
	return true;
}

/**
 * Executes the installed private durable-stage owner.
 * @param input - Exact public stage input.
 * @returns Frozen stage result.
 */
export function consumeCreatorAdoptionStage(input: unknown): Promise<Result> {
	return stageOwner === undefined
		? Promise.resolve(
				Object.freeze({
					detail: "creator adoption stage owner is unavailable",
					kind: "internal-invariant",
					ok: false,
				})
			)
		: stageOwner(input);
}

/**
 * Executes the installed private staged-publication owner.
 * @param input - Exact public publication input.
 * @returns Frozen publication result.
 */
export function consumeCreatorAdoptionPublish(input: unknown): Promise<Result> {
	return publishOwner === undefined
		? Promise.resolve(
				Object.freeze({
					detail: "creator adoption publish owner is unavailable",
					kind: "internal-invariant",
					ok: false,
				})
			)
		: publishOwner(input);
}
