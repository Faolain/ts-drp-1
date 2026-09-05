# D.110c-b bounded source and architecture audit

Base commit: `3118da762c17785a4a34a1f1d6b173370dc33a4a`

Scope: read-only audit of the genuine hot `epoch N -> epoch N+1` adoption,
activation, and product-custody path. Completed D.110c-a evidence, D.110a
invocations, cold-reopen design, wire/schema, dependencies, thresholds, and
public method/key rosters are not changed.

## Demonstrated missing seams

1. `packages/node/src/creator-adoption.ts` authenticates the current closure
   but selects only `v3-live-generation-1` as predecessor (lines 371-374,
   607-612, and 664-667), and emits projection graph/descriptor epoch `1`
   (lines 539-569). A genuine epoch-1 predecessor is already represented by
   `v3-live-generation-2`; the verifier therefore cannot compose the genuine
   D.110c-a epoch-1 -> epoch-2 close into the next adoption.
2. `packages/node/src/creator-adoption-commit.ts` correctly requires every
   successor projection to be `v3-live-generation-2` (line 310), but its
   authenticated terminal and staged predecessor checks still require
   `v3-live-generation-1` (lines 432-435 and 489-492).
3. `packages/node/src/creator-adoption-activate.ts` keys the sole active owner
   by stable topic, but records only bindings and wrapper identity (lines
   52-57). Any same-bindings request returns the existing wrapper as success
   without comparing authenticated predecessor/successor trust (lines
   193-198). A wrapper's later deactivate unconditionally deletes the topic
   and releases the lock (lines 208-229), so it cannot safely transfer custody
   to an exact-next replacement.
4. `examples/v3-room/src/index.ts` exposes the existing successor authority
   with literal epoch `1` (lines 235-242 and 453-488), binds creator-close only
   during initial room setup (lines 2265-2287), returns early after the first
   adoption (line 3502), and installs the replacement live handle/authority
   without rebinding `creatorCloseHandle` (lines 3574-3586). The next call thus
   cannot perform a genuine second transition through current product custody.
5. `packages/node/src/v3-live.ts:1878-1930` already authenticates epoch zero as
   `v3-live-generation-1` and every positive epoch as
   `v3-live-generation-2`; `activateCreatorSuccessorLive()` already prepares
   predecessor/successor material using authenticated epochs. These existing
   relative rules are the composition seam; no new live-generation kind or
   wire record is indicated.

## Architecture disposition

The defect is composition/orchestration plus one narrow widening of the
existing public `V3RoomSuccessorAuthority.epoch` field from literal `1` to a
validated positive safe integer. No new public key, method, record, wire field,
authority carrier, dependency, threshold, or storage family is required by the
audit.

The hot owner must retain one stable-topic browser lock while replacing the
active epoch-N wrapper with the authenticated exact-next epoch-(N+1) wrapper.
The active-owner entry therefore needs the authenticated current trust/head and
a unique local ownership token. Same exact head plus same bindings is
idempotent. Exact-next replacement with the same bindings consumes and aliases
the new live material before atomically swapping the active entry. Stale,
same-epoch-different, skipped, cross-object, cross-genesis, or different-binding
requests fail before the swap. Failed consumption/aliasing retains the old
owner and lock. Deactivation deletes/releases the active entry only when its
token is still current, so delayed stale-wrapper cleanup cannot remove the
replacement.

Product custody must replace the one-transition latch with current-head
comparison, derive authority from authenticated trust, and bind a new
creator-close handle to the activated epoch-(N+1) plane before reporting the
transition complete. The existing vote/evidence/snapshot stores are reused. A
successful activation has already terminalized the predecessor, so a later
close-bind failure cannot truthfully restore the old close authority: the room
remains on the authenticated new live plane and floor, reports close authority
unavailable/stalled, and never exposes the stale terminal close handle as
usable.

Arbitrary epoch-N cold reopen literals in `creator-adoption.ts` remain owned by
D.110c-0b1/D.110c-c. D.110c-b preserves retained epoch-1 reopen behavior but
does not claim age-independent reopen, pruning, bounded control proof, or
long-horizon closure. If implementation demonstrates that the hot loop needs a
wire/schema change, new dependency, new authority assumption/carrier, new
public key/method, or altered threshold/workload, D.110c-b stops after RED and
reslices explicitly.
