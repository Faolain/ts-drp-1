import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;

/** Derives a deterministic raw-codec CID without publishing the namespace text. */
export async function namespaceCid(namespace: string): Promise<CID> {
	const value = namespace.trim();
	if (value.length < 1 || value.length > 256) throw new Error("namespace must contain 1..256 characters");
	return CID.createV1(RAW_CODEC, await sha256.digest(new TextEncoder().encode(value)));
}
