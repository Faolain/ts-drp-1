import type { PrivateKey } from "@libp2p/interface";
import {
	AddressPolicy,
	createPeerCache,
	createRendezvousEnsemble,
	decodeInvite,
	encodeInvite,
	InMemoryPeerCacheStore,
	type InviteDecodeError,
	InviteDirectory,
	type InviteEncodeError,
	type InvitePayloadV1,
	LocalStoragePeerCacheStore,
	type PeerCache,
	type PeerCacheStore,
	type RecordValidator,
	type RendezvousEnsemble,
	type StoredPeerRecord,
	type VerifiedInvite,
} from "@ts-drp/rendezvous";
// eslint-disable-next-line import/no-unresolved -- Deliberately missing Phase 4b Node-only export.
import { FsPeerCacheStore } from "@ts-drp/rendezvous/node";

declare const inviteIssuer: Pick<PrivateKey, "publicKey" | "sign">;
declare const invitePayload: InvitePayloadV1;
declare const storedRecords: readonly StoredPeerRecord[];

const memoryStore: PeerCacheStore = new InMemoryPeerCacheStore(storedRecords);
const browserStore: PeerCacheStore = new LocalStoragePeerCacheStore({ key: "drp-peer-cache" });
const nodeStore: PeerCacheStore = new FsPeerCacheStore({ path: "/tmp/drp-peer-cache.json" });
const cache: PeerCache = createPeerCache({ max: 64, store: memoryStore });

async function inviteContract(): Promise<void> {
	const encoded: string = await encodeInvite(invitePayload, inviteIssuer);
	const verified: VerifiedInvite = await decodeInvite(encoded, {
		validatorFactory: (): RecordValidator => {
			throw new Error("type fixture");
		},
	});
	const inviteDirectory = new InviteDirectory({
		invite: verified,
		validatorFactory: (): RecordValidator => {
			throw new Error("type fixture");
		},
	});
	const ensemble: RendezvousEnsemble = createRendezvousEnsemble({
		addressPolicy: {
			policy: new AddressPolicy({ target: "browser" }),
			resolver: { resolve: () => Promise.resolve(["93.184.216.34"]) },
		},
		cache,
		invite: inviteDirectory,
	});
	for await (const record of ensemble.bootstrap(invitePayload.namespace, AbortSignal.timeout(100))) {
		void record.record.peerId;
	}
}

declare const decodeError: InviteDecodeError;
declare const encodeError: InviteEncodeError;
const decodeCode: "expired" | "invalid-contact" | "invalid-endpoint" | "invalid-issuer-signature" | "invalid-shape" =
	decodeError.code;
const encodeCode: "too-many-contacts" | "unsafe-contact-address" = encodeError.code;

void browserStore;
void nodeStore;
void inviteContract;
void decodeCode;
void encodeCode;
