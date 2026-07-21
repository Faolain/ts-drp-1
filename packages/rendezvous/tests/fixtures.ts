import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	RecordSigner,
	type RecordValidationContext,
	RecordValidator,
	type SignedDrpRecordV1,
	type UnsignedDrpRecordV1,
} from "@ts-drp/rendezvous";

export const NOW = 1_750_000_000_000;
export const NAMESPACE = `drp-network:v1:${"a".repeat(43)}`;
const ADMISSION = { accepted: true, mode: "invite" } as const;

/**
 *
 * @param index
 * @param overrides
 */
export async function signedFixture(
	index: number,
	overrides: Partial<UnsignedDrpRecordV1> = {}
): Promise<SignedDrpRecordV1> {
	const { peerId, signer } = await fixtureSigner(index);
	return signer.sign(fixtureInput(peerId, overrides));
}

/**
 *
 * @param index
 */
export async function fixtureSigner(index: number): Promise<{ peerId: string; signer: RecordSigner }> {
	const key = await generateKeyPairFromSeed("Ed25519", seed(index));
	return { peerId: peerIdFromPublicKey(key.publicKey).toString(), signer: new RecordSigner(key) };
}

/**
 *
 * @param peerId
 * @param overrides
 */
export function fixtureInput(peerId: string, overrides: Partial<UnsignedDrpRecordV1> = {}): UnsignedDrpRecordV1 {
	return {
		namespace: NAMESPACE,
		addresses: [address(peerId, 4001)],
		capabilities: ["drp-gossipsub", "webrtc"],
		sequence: 1,
		issuedAtMs: NOW,
		expiresAtMs: NOW + 60_000,
		...overrides,
	};
}

/**
 *
 * @param peerId
 * @param port
 */
export function address(peerId: string, port: number): string {
	return `/dns4/relay.example.test/tcp/${port}/wss/p2p/${peerId}`;
}

/**
 *
 * @param now
 */
export function validator(now: () => number = (): number => NOW): RecordValidator {
	return new RecordValidator({
		now,
		resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
	});
}

/**
 *
 * @param overrides
 */
export function context(overrides: Partial<RecordValidationContext> = {}): RecordValidationContext {
	return {
		admission: ADMISSION,
		expectedNamespace: NAMESPACE,
		signal: new AbortController().signal,
		...overrides,
	};
}

/**
 *
 * @param index
 */
export function seed(index: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, offset) => (index * 17 + offset * 13) % 256);
}
