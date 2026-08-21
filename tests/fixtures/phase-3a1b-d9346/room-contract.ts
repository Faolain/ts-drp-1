import type {
	CreateV3RoomSessionInput,
	V3RoomAcceptedOperation,
	V3RoomApplication,
	V3RoomProjectionAuthority,
	V3RoomSession,
} from "../../../examples/v3-room/src/index.js";
import type { EphemeralChannel, EphemeralChannelOptions } from "../../../packages/ephemeral/src/index.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

interface ExpectedRosterEntry {
	readonly author: string;
	readonly peerId: string;
}

interface ExpectedProjection extends V3RoomProjectionAuthority {
	readonly acceptedDigests: readonly string[];
}

interface ExpectedAcceptedOperation {
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly operationCount: number;
	readonly operationIndex: number;
	readonly vertexDigest: string;
}

type ExpectedProjector = (operations: readonly V3RoomAcceptedOperation[]) => ExpectedProjection;

type _AcceptedOperation = Assert<Equal<V3RoomAcceptedOperation, ExpectedAcceptedOperation>>;
type _ApplicationKeys = Assert<
	Equal<
		keyof V3RoomApplication<ExpectedProjection>,
		| "batchableOperationActions"
		| "bootstrapOperation"
		| "canonicalBlueprintPackageBytes"
		| "catalog"
		| "projectAcceptedOperations"
	>
>;
type _BatchableActions = Assert<
	Equal<V3RoomApplication<ExpectedProjection>["batchableOperationActions"], readonly string[]>
>;
type _Projector = Assert<Equal<V3RoomApplication<ExpectedProjection>["projectAcceptedOperations"], ExpectedProjector>>;
type _Roster = Assert<Equal<V3RoomProjectionAuthority["transportPeerAuthors"], readonly ExpectedRosterEntry[]>>;
type _Writers = Assert<Equal<V3RoomProjectionAuthority["writerAuthors"], readonly string[]>>;
type _ProjectionSink = Assert<
	Equal<CreateV3RoomSessionInput<ExpectedProjection>["onProjection"], (projection: ExpectedProjection) => void>
>;

declare const session: V3RoomSession<ExpectedProjection>;
declare const options: EphemeralChannelOptions;
const channel: EphemeralChannel = session.openEphemeral(options);
const projection: ExpectedProjection = session.projection();
void channel;
void projection;
