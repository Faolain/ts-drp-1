# D.109e — Browser Cleanup Scheduling

Extract the advisory Web-Lock runner currently owned by the Phase-5c vote
dispatcher into one package-internal primary-dispatch primitive, migrate the
vote dispatcher to it in the same slice, and schedule cleanup through that
same primitive. Database/storage-key identity and failure fallback remain the
Phase-5c contract. A lease merely invokes the cleanup state machine.

RED proves Locks on/off/absent/non-callable/throwing/rejecting/timed-out,
unavailable lock, primary close/takeover, stale holder, `versionchange`, and
changed cleanup precondition. Every mode eventually attempts the same eligible
set; a changed precondition deletes nothing. GREEN leaves no duplicate lock
name, timeout, or fallback implementation.
