import type { SignedDrpRecordV1 } from "./record.js";
import {
	type AdmissionCredential,
	type ClientRegistrationReceipt,
	type RegistryAttempt,
	type RegistryBackendSelection,
	RegistryExhaustedError,
	type RendezvousDirectory,
	type ValidatedDrpRecord,
} from "./registry.js";

/** Typed terminal for an invalid composite rendezvous catalog. */
export class CompositeRendezvousConfigurationError extends Error {
	/** @param message - Stable caller-facing configuration detail. */
	constructor(message: string) {
		super(message);
		this.name = "CompositeRendezvousConfigurationError";
	}
}

class CompositeRendezvousDirectory implements RendezvousDirectory {
	readonly #directories: readonly RendezvousDirectory[];

	constructor(directories: readonly RendezvousDirectory[]) {
		this.#directories = [...directories];
	}

	async discover(
		namespace: string,
		signal: AbortSignal,
		selection?: RegistryBackendSelection
	): Promise<readonly ValidatedDrpRecord[]> {
		const results = await Promise.allSettled(
			this.#directories.map((directory) =>
				Promise.resolve().then(() => directory.discover(namespace, signal, selection))
			)
		);
		const records: ValidatedDrpRecord[] = [];
		const attempts: RegistryAttempt[] = [];
		let successfulChildren = 0;
		for (const result of results) {
			if (result.status === "fulfilled") {
				successfulChildren += 1;
				records.push(...result.value);
			} else if (result.reason instanceof RegistryExhaustedError) {
				attempts.push(...result.reason.attempts);
			}
		}
		if (successfulChildren === 0) throw new RegistryExhaustedError("discover", attempts);
		return selection?.targetPeerId === undefined
			? records
			: records.filter(({ record }) => record.peerId === selection.targetPeerId);
	}

	async register(
		record: SignedDrpRecordV1,
		signal: AbortSignal,
		credential?: AdmissionCredential
	): Promise<ClientRegistrationReceipt> {
		const results = await Promise.allSettled(
			this.#directories.map((directory) => Promise.resolve().then(() => directory.register(record, signal, credential)))
		);
		const acceptedEndpointIds: string[] = [];
		const attempts: RegistryAttempt[] = [];
		for (const result of results) {
			if (result.status === "fulfilled") {
				acceptedEndpointIds.push(...result.value.acceptedEndpointIds);
				attempts.push(...result.value.attempts);
			} else if (result.reason instanceof RegistryExhaustedError) {
				attempts.push(...result.reason.attempts);
			}
		}
		if (acceptedEndpointIds.length === 0) throw new RegistryExhaustedError("register", attempts);
		return { acceptedEndpointIds, attempts, sequence: record.sequence };
	}
}

/**
 * Creates one rendezvous directory that fans operations across every child.
 * @param directories - Ordered child directories.
 * @returns A directory preserving child order in merged results and attempts.
 */
export function createCompositeRendezvousDirectory(directories: readonly RendezvousDirectory[]): RendezvousDirectory {
	if (directories.length === 0) {
		throw new CompositeRendezvousConfigurationError("composite rendezvous requires at least one child directory");
	}
	return new CompositeRendezvousDirectory(directories);
}
