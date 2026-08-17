import type {
	CreateV3RoomSessionInput,
	V3RoomAcceptedVertex,
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

type ExpectedProjector = (vertices: readonly V3RoomAcceptedVertex[]) => ExpectedProjection;

type _Projector = Assert<Equal<V3RoomApplication<ExpectedProjection>["projectAcceptedVertices"], ExpectedProjector>>;
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
