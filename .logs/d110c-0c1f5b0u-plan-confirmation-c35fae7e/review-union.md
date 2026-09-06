# Confirmation union and disposition

## P1

Opus identified one new executable deadlock: settlement recovery triggered
inside `rebasePromise` cannot enqueue behind a lifetime transition that is
already waiting for that same promise. The corrected plan makes the complete
startup settlement/rebase body the single enqueued lifetime transition and
runs recovery inline. RED case 8 includes migration rehearsal and activation
to prove no cycle.

## P2

- The dependency wording now says one new direct edge to the existing package.
- Successful rebind stops the predecessor creator-close handle.
- The store parser requires nonnegative safe, strictly increasing child times
  and canonical round-trip limits; RED case 1 adds negative controls.
- Store-side derivation from signed commit bytes is authoritative for the
  durable floor; Node remains the batch assembly and admission authority.

No second confirmation is run under the frozen one-confirmation cap. The exact
corrections add no public API, wire/schema, authority, cryptography, external
dependency, workload, timing, or threshold change.
