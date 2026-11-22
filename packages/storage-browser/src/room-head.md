# Host-owned native room floor

The host chooses the freshness and custody boundary before opening a room. This
adapter implements the IndexedDB mechanics of that choice; it does not turn an
origin-local row into independent rollback protection, authenticate a checkpoint,
or choose credentials or a checkpoint service for the application.

Create, explicit migration and reopen are distinct intentions. A missing reopen
cannot silently create a new floor. Explicit migration may atomically replace
the original exact scope/state pair only when it agrees with the host's selected
head; it cannot reset a newer or pending state. Scope, genesis pin, predecessor
identity and adjacent successor remain exact throughout normal floor CAS.

The same native read-reservation owner used by other Browser stores keeps reads
in one actual transaction and excludes foreign writes. A retirement observation
is a one-use mechanical source image, not protocol eligibility. Its transition
revokes new read admissions, joins the held native work, then compares the whole
original floor image inside a strict write transaction. A foreign write in that
gap therefore refuses rather than inheriting stale authority.

Prepared fences pause floor mutation while the existing authenticated planner
coordinates the other participants. Matching source-owned commitments permit
abort or commit after a fresh original observation. A compact completed prefix
does not block future adjacent room transitions. A lost response requires native
readback, not a caller's guessed success flag. There is no deletion API here.

The record has bounded canonical metadata and one current control, not an epoch
catalog. This does not establish bounded browser structured-clone allocation for
an arbitrarily poisoned foreign row, native process-crash durability, or whole
cross-store retirement. Those remain separate evidence obligations.
