import type { ExpectedAcquisition, ExpectedReader, ExpectedStore } from "./contract.js";
import type {
	SnapshotRecoveryChunkReader,
	SnapshotRecoveryReadAcquisition,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/src/snapshot-transfer.js";
import type { SnapshotRecoveryStore as ExpectedExistingStore } from "../phase-4c-v3/snapshot-quarantine-types.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;
type Assert<Value extends true> = Value;
type Reader = Assert<Equal<SnapshotRecoveryChunkReader, ExpectedReader>>;
type Acquisition = Assert<Equal<SnapshotRecoveryReadAcquisition, ExpectedAcquisition>>;
type RequiredOwner = Assert<Equal<SnapshotRecoveryStore<SnapshotVerificationReceipt>, ExpectedStore>>;
declare const actual: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
declare const expectedExisting: ExpectedExistingStore<SnapshotVerificationReceipt>;
const requiredActual: ExpectedStore = actual;
const requiredFixture: ExpectedStore = expectedExisting;
void (0 as unknown as Reader | Acquisition | RequiredOwner);
void requiredActual;
void requiredFixture;
