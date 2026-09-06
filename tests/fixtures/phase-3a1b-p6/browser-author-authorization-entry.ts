import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "../../../packages/canonical/src/index.js";

// The subpath is the intentional production RED and exists only on the GREEN candidate.
/* eslint-disable import/no-unresolved */
import {
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} from "../../../packages/protocol-v3/src/author-authorization.js";
/* eslint-enable import/no-unresolved */
import { installCreatorAnchorTrustRoot } from "../../../packages/protocol-v3/src/public.js";

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PUBLIC_KEY = ed25519.getPublicKey(PRIVATE_KEY);
const AUTHOR = Array.from(PUBLIC_KEY, (byte) => byte.toString(16).padStart(2, "0")).join("");
const OBJECT_ID = "creator:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function material(): Readonly<{
	readonly anchorBytes: Uint8Array;
	readonly anchorDigest: string;
	readonly carrierBytes: Uint8Array;
	readonly profileBytes: Uint8Array;
	readonly signature: Uint8Array;
	readonly signerSetBytes: Uint8Array;
}> {
	const carrierBytes = encodeCanonical({
		authors: [AUTHOR],
		epoch: 0,
		kind: "drp-author-authorization",
		objectId: OBJECT_ID,
		profileId: "creator-author-authorization-v1",
		protocolMajor: 3,
		version: 1,
	});
	const signerSet = [{ publicKey: AUTHOR, signerId: "creator" }];
	const signerSetBytes = encodeCanonical(signerSet);
	const profileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: "creator-trusted-v1",
		quorum: 1,
		signers: signerSet,
	});
	const anchorBytes = encodeCanonical({
		aclDigest: hex(hashDomain("ts-drp/author-authorization/v3", carrierBytes)),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: "c".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "0".repeat(64),
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
		parametersDigest: "d".repeat(64),
		previousAnchor: "0".repeat(64),
		profileDigest: hex(hashDomain("ts-drp/profile/v3", profileBytes)),
		protocolMajor: 3,
		signerSetDigest: hex(hashDomain("ts-drp/signer-set/v3", signerSetBytes)),
		stateDigest: "7".repeat(64),
	});
	const anchorDigestBytes = hashDomain("ts-drp/epoch-anchor/v3", anchorBytes);
	return {
		anchorBytes,
		anchorDigest: hex(anchorDigestBytes),
		carrierBytes,
		profileBytes,
		signature: ed25519.sign(anchorDigestBytes, PRIVATE_KEY),
		signerSetBytes,
	};
}

function partial(bytes: Uint8Array): Uint8Array {
	const backing = new ArrayBuffer(bytes.byteLength + 5);
	const view = new Uint8Array(backing, 2, bytes.byteLength);
	view.set(bytes);
	new Uint8Array(backing, 0, 2).fill(0xa5);
	new Uint8Array(backing, 2 + bytes.byteLength).fill(0x5a);
	return view;
}

function summary(): Readonly<Record<string, unknown>> {
	const value = material();
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: value.signature,
		exactCanonicalGenesisAnchorPreimageBytes: value.anchorBytes,
		exactCanonicalProfileBytes: value.profileBytes,
		exactCanonicalSignerSetBytes: value.signerSetBytes,
		pinnedGenesisAnchorDigest: value.anchorDigest,
	});
	if (!installed.ok) return Object.freeze({ available: true, install: installed });
	const opened = openCurrentEpochAuthorAuthorization({
		detachedAnchorSignature: partial(value.signature),
		exactCanonicalAnchorPreimageBytes: partial(value.anchorBytes),
		exactCanonicalAuthorAuthorizationBytes: partial(value.carrierBytes),
		trust: installed.trust,
	});
	if (!opened.ok) return Object.freeze({ available: true, opened });
	const resolved = resolveCurrentEpochAuthorizedAuthor({ authorization: opened.authorization, author: AUTHOR });
	const invalidSignature = new Uint8Array(value.signature);
	invalidSignature[0] ^= 1;
	const precedence = openCurrentEpochAuthorAuthorization({
		detachedAnchorSignature: invalidSignature,
		exactCanonicalAnchorPreimageBytes: value.anchorBytes,
		exactCanonicalAuthorAuthorizationBytes: Uint8Array.of(0xff),
		trust: installed.trust,
	});
	const proxy = openCurrentEpochAuthorAuthorization({
		detachedAnchorSignature: new Proxy(value.signature, {}),
		exactCanonicalAnchorPreimageBytes: value.anchorBytes,
		exactCanonicalAuthorAuthorizationBytes: value.carrierBytes,
		trust: installed.trust,
	});
	return Object.freeze({
		available: true,
		keyHex: resolved.ok ? hex(resolved.publicKey.bytes) : undefined,
		opened: opened.ok,
		precedence,
		proxy,
		resolved: resolved.ok,
	});
}

Object.defineProperty(globalThis, "phase3a1bP6", {
	configurable: false,
	enumerable: true,
	value: Object.freeze({ summary }),
	writable: false,
});
