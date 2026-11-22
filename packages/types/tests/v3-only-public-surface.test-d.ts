/* eslint-disable import/no-duplicates -- Each retired export needs its own independently checked compiler refusal. */
// These former public types belong to the retired live Object/attestation API.
// Original characterization files remain historical, not shipping contracts.
// Reserved protobuf codecs and current ACL Finality roles are separate owners.
// @ts-expect-error retired public Object authority
import type { IDRPObject } from "../src/index.js";
// @ts-expect-error retired public Object configuration
import type { DRPObjectConfig } from "../src/index.js";
// @ts-expect-error retired public Object creation
import type { DRPObjectOptions } from "../src/index.js";
// @ts-expect-error retired public per-vertex finality configuration
import type { FinalityConfig } from "../src/index.js";
// @ts-expect-error retired public per-vertex attestation store
import type { IFinalityStore } from "../src/index.js";
// @ts-expect-error retired public per-vertex attestation state
import type { IFinalityState } from "../src/index.js";

export type RetiredImportsMustRefuse = [
	IDRPObject,
	DRPObjectConfig,
	DRPObjectOptions,
	FinalityConfig,
	IFinalityStore,
	IFinalityState,
];
