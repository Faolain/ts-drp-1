# Received catch-up publication

Keep `installCreatorSuccessor({offer, peers})` as the public operation. When the offer is ahead, acquire and authenticate the remote checkpoint and fetch only the final snapshot. The attachment owner authorizes one exact source-to-target adoption. Skipped-epoch local source classification remains unknown unless separate original evidence proves it.

Persist a receipt binding the exact old local AHE head, old trusted floor, bounded checkpoint proof, original local source identity and final snapshot. The staged generation's `baseExpectedHead` is the actual local head. Reuse the existing strict native staging/publication sequence and preserve the two usable local rollbacks. Host pending state records the exact previous/next pair; a monotone gap is accepted only by the protocol's verified attachment owner, never by a caller-supplied epoch.

Reopen re-verifies the same receipt and resolves old XOR new. It does not advance a floor from raw durable bytes, lower an external floor, synthesize intermediary generations, or revive the old runtime. Check interruptions before staging, after staging, after floor begin, after AHE publication and after floor commit. The next issuance and a subsequent ordinary adjacent install must succeed.
