import {
	AddressPolicy,
	createHttpRegistryEndpoint,
	createRecordProducer,
	createRendezvousEnsemble,
	InMemorySequenceStore,
	reconcileValidatedRecords,
	type RecordSigner,
	type RendezvousBackendDescriptor,
	type RendezvousDirectory,
	type SequenceStore,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";

declare const directory: RendezvousDirectory;
declare const store: SequenceStore;

const httpBackend: RendezvousBackendDescriptor = {
	directory,
	id: "registry-a",
	kind: "http-registry",
};

const anchorBackend: RendezvousBackendDescriptor = {
	directory,
	id: "anchor-a",
	kind: "dht-anchor",
};

const load: Promise<number> = store.load();
const save: Promise<void> = store.save(2);
void httpBackend;
void anchorBackend;
void load;
void save;

declare const records: readonly ValidatedDrpRecord[];
declare const signer: Pick<RecordSigner, "sign">;
declare const signedRecord: SignedDrpRecordV1;

const reconciled: readonly ValidatedDrpRecord[] = reconcileValidatedRecords([records]);
const memoryStore: SequenceStore = new InMemorySequenceStore(4);
const endpoint = createHttpRegistryEndpoint({ id: "registry-a", url: "https://registry.example/" });
const ensemble: RendezvousDirectory = createRendezvousEnsemble({
	addressPolicy: {
		policy: new AddressPolicy({ target: "browser" }),
		resolver: { resolve: () => Promise.resolve(["93.184.216.34"]) },
	},
	registries: [endpoint],
});
const producer = createRecordProducer({
	addressSource: () => signedRecord.addresses,
	capabilitySource: () => signedRecord.capabilities,
	namespace: signedRecord.namespace,
	peerId: signedRecord.peerId,
	sequenceStore: memoryStore,
	signer,
	ttlMs: 60_000,
});

void reconciled;
void endpoint;
void ensemble;
void producer;
