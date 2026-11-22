# Track 43: ephemeral stream continuity across epoch rollovers

Branch `perf/ephemeral-rollover-continuity` (from `perf/integration-7` f9f7a582).

## Problem

Authority-bound (v3-room) ephemeral frames carry the sender's installed context: object, epoch,
anchor digest and latched-ACL digest (D.93.48). A receiver accepted only frames whose tag equalled its
own current context. From the creator's adoption of epoch e+1 until each member installed it, every
frame between a peer on e and a peer on e+1 was dropped as `authorityMismatch`, in both directions.
Grid rolls every few seconds under play, so positions froze for the install lag at every rollover
(scorecard, 4 peers at 30 Hz: 82-88% delivery, max gap 7-11 s; 2 peers: 92%).

## The invariant the binding protects

Taken from D.93.48 ("One installed authority context", "Closed v3 frame and bounded receive work"),
the pending-floor adjunct (track 38) and the channel code:

1. **Authorization.** A frame is delivered only if the transport-authenticated sender maps to a writer
   under the receiver's *current, verified* authority. A sender removed by an installed successor is
   refused from the moment the receiver installs it; with no bound authority (replacement gap)
   nothing is delivered.
2. **Verified context.** The receiver acts only on contexts it installed itself. Tags are exact tuple
   equality (a foreign tuple at the same epoch never matches); an unverifiable claim is never the
   reason for acceptance.
3. **No replay into a later context.** Old-context traffic does not become valid again after a
   context change; replay state is per context and bounded.
4. **Bounded receive work** (charge before parse, 128 writer buckets) is unchanged.

The tags are public equality identifiers, not secrets: a writer under context e can always tag
frames with e. So for acceptance the security-relevant content is (1) plus "the tag is a context the
receiver verified".

## Design

- A sender's frame carries its current context and, when its channel holds the context it installed
  immediately before (an adjacent change, epoch + 1 on the same object), that preceding context too
  (frame version 3: the version-2 header plus the two preceding digests; the epoch is implied). The
  preceding tag is attached only while the sender is still a writer under its current context and some
  recipient has not yet been accepted by it under that context, and only if the larger frame fits;
  otherwise the version-2 frame is sent. `maxEnvelopeBytes` is unchanged.
- A receiver delivers a frame only if one of its tags equals a context the receiver itself installed:
  its current one (exact, or the sender's preceding tag when the sender is one epoch ahead) or the one
  it held immediately before (the sender is one epoch behind). Writer authorization is checked first,
  against the receiver's current authority, exactly as before.
- Per sender, the receiver records the receiver-installed context each accepted frame matched (the
  floor). Once a sender has been accepted under the receiver's current context, its frames that match
  only the previous context are refused. Frames under the receiver's current context are never refused
  by the floor (no regression from the single-context rule).
- Replay watermarks record the tag epoch per key and survive an adjacent change; when a sender is first
  accepted under a later receiver context, only keys from contexts the floor now refuses are retired.
  Any other authority change (skipped epoch, same-epoch replacement, rollback, another object) clears
  all window state as before. Floors are bounded at 128; a sender without a floor past that bound gets
  no window (single-context rule), and making room runs at most once per second.

Why it keeps the invariant: (1) is untouched and runs before decode; (2) every accepted frame matched
a context the receiver installed - the successor's digests are never trusted, the sender instead
proves the preceding context the receiver holds; the window is one epoch each way; (3) a sequenced
frame delivered under any context inside the window is never delivered again, previous-context frames
stop once the sender is seen in the current one, and nothing two epochs away is accepted. Unordered
frames had no replay protection within an epoch before; inside the window that class extends to one
adjacent epoch, which the floor closes per sender.

## Model

[`packages/ephemeral/formal/ephemeral-adjacent-authority.qnt`](../../../../packages/ephemeral/formal/ephemeral-adjacent-authority.qnt).
Four peers (x removed by epoch 1), epochs 0-3, genuine and foreign tuples, a network that replays and
reorders every frame ever sent, and forging peers. Safety: authorized delivery, removed sender refused,
verified context, bounded window, no going back across the boundary per sender, and soundness of the
sender's preceding-tag bound. Continuity: an honest fresh frame from a writer on both sides, one epoch
away, is never refused. The previous rule violates continuity; four broken controls (unverified ahead
claim, previous-ACL writer check, no floor, unbounded past) each violate one safety property.

## Evidence

See RESULT.md in this folder.
