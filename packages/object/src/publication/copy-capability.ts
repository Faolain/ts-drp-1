import { type DRPState, type DRPStateEntry } from "@ts-drp/types";
import { serializedValuesEqual } from "@ts-drp/utils/serialization/equality";
import { cloneDeep } from "es-toolkit";
import { deepEqual } from "fast-equals";

const publicationCapabilityBrand: unique symbol = Symbol("PublicationCapability");

interface CopyMetadata {
	publicationId: string;
	side: "acl" | "drp";
	key: string;
	image: "pre" | "post";
}

/** Least-authority operations available to the publication pipeline. */
export interface PublicationCapability {
	readonly [publicationCapabilityBrand]: true;
	copy(value: unknown, metadata: CopyMetadata): unknown;
	createEntry(key: string, value: unknown): DRPStateEntry;
	createSnapshot(entries: readonly DRPStateEntry[]): DRPState;
	equal(left: unknown, right: unknown): boolean;
	observe(event: { type: "publication"; record: unknown }): void;
}

/**
 * Construct the sole publication capability at the applier composition root.
 * @param observer - Optional publication-work observer
 * @returns The privately branded capability
 */
export function createPublicationCapability<TEvent>(observer?: (event: TEvent) => unknown): PublicationCapability {
	const emit = (event: unknown): unknown => observer?.(event as TEvent);
	return {
		[publicationCapabilityBrand]: true,
		copy(value, metadata): unknown {
			return observer ? emit({ type: "copy", value, metadata }) : cloneDeep(value);
		},
		createEntry(key, value): DRPStateEntry {
			return { key, value };
		},
		createSnapshot(entries): DRPState {
			return { state: [...entries] };
		},
		equal(left, right): boolean {
			return deepEqual(left, right) && serializedValuesEqual(left, right);
		},
		observe(event): void {
			emit(event);
		},
	};
}
