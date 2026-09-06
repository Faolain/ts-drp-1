# D.110c-0c1j-0 final GREEN review

Completed 2026-09-04T06:38:02Z against RED `507e5541`, GREEN
`b136a603`, and their signed evidence commits. Grok 4.6/high and direct Kimi
K3/100 both returned PASS with an empty P0/P1 union. Opus was not required
because this slice does not touch `packages/protocol-v3`.

The reviewers confirmed causal RED, omitted-key byte/digest/genesis identity,
the exact optional grammar, fixed-creator acceptance, reserved-mode fail-closed
behavior, unchanged legacy vectors, and no Node/protocol-v3/product expansion.

P2 union and disposition:

1. Add an explicit encode/decode invite-consumption pin in D.110c-0c1j proper;
   both current boundaries already share the same helper.
2. Own the stale protocol-v2 v5 mint/reference hash and freeze-boundary pins in
   D.110c-0c1j proper; do not bump the registry version in this reservation.
3. Correct the GREEN evidence's stale "seven-field" Node wording on the next
   evidence touch; the substantive Node non-acceptance statement is correct.
4. Keep strict grammar at the registry authority layer. Revisit the room-only
   mode check only if it ever becomes the sole admission authority.
5. Decide whether ephemeral-chain requires a non-null maximum only when that
   currently rejected mode is implemented.

No P2 changes this bounded reservation or triggers another review.
