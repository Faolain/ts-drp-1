# @ts-drp/room-worker

Opt-in: host an app's room in a dedicated worker, so the page's main thread keeps only rendering and
input. Apps that do not opt in run exactly as before; nothing here changes the main-thread API.

## The split

- **Worker**: the node, libp2p, the room session, its IndexedDB stores, the codec and signing.
- **Page**: rendering, input, identity (the Web Lock and seed), and the real `RTCPeerConnection`s.
  Workers have no `RTCPeerConnection`; the page creates each data channel and transfers it into the
  worker, so every byte of room traffic still flows worker-side.

The worker installs its RTC stand-ins before the app's network modules are evaluated (they capture
the globals then), so `serveRoomWorker` loads the app module lazily: the worker entry imports only
light modules statically.

## The contract

One module both sides import declares a closed allowlist (`defineRoomWorkerContract`):

- `call()`: a promise. Its result is posted only after every stream value the command emitted, so
  the page reads its own writes.
- `send(validate)`: fire-and-forget, for per-frame input. The validator runs on the page,
  synchronously; `send` returns a correlation id, and a refusal in the worker reaches `onRefused`
  with that id.
- `latest()`: a stream where only the newest value matters. At most one value per stream per page
  frame crosses; the rest coalesce in the worker.
- `hooks`: page functions the worker may call (authority factories, approvals). Objects they return
  stay on the page; the worker gets a handle whose methods are the object's own, and nothing else.

Commands outside the contract, malformed messages and messages of another session are dropped.

## Errors

Typed errors cross by codec (`errorCodec(id, Class)`), keeping class, name, message, fields and
cause, so `instanceof` works on the page. Standard errors need no codec. Anything else arrives as
`RoomWorkerRemoteError` with the remote name. The package's own: `RoomWorkerUnsupported`,
`RoomWorkerCrashed`, `RoomWorkerClosed`, `RoomWorkerLimit`, `RoomWorkerProtocolError`.

## Fallback

`openRoomWorker` throws, and `ready` rejects, with `RoomWorkerUnsupported` when the browser cannot
host the room in a worker. The app then opens the room on the main thread, as without the option.
There is no relay mode.

## Snapshots

An adapter's `snapshot()` returns the last value the worker published, which may be a frame old;
after any `call` resolves it includes that call's effects. `refresh()` asks the worker for the
current one.

## Crash ambiguity

When the worker dies, calls in flight reject with `RoomWorkerCrashed`, but the room may already
have durably admitted that work. The outcome is unknown, never assumed. Before re-offering, reopen
the room and look for the operation's own identity in the durable state (its id in the
projection, or in the room's unresolved accepted work or settlement status): present means it
landed and must not be offered again; absent means re-offer. A fresh operation id would turn one
intent into two operations.

## Cost

Each libp2p stream is a WebRTC data channel the page opens and transfers; `roomWorkerRtcStats()`
reports channel counts and attach latency, so an app can see what that adds to join and first
delivery. `openRoomWorker({ meter })` measures the bridge's main-thread cost per message.
