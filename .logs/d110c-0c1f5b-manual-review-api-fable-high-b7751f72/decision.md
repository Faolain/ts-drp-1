# D.110c-0c1f5b manual-review API decision consultation

This is the one bounded Fable-high consultation required by the user when a
new API question arose. Fable session
`4b18e58b-28ab-4f6d-a3fd-116d3feeabf3` returned `STOP_AND_RESLICE` and
recommended `C_DEFER_RESOLUTION` with `new_api_required=false`.

Root source analysis agrees. The current product has no per-source manual-
review resolver. The authenticated remove/close/adopt/re-add/close/adopt path
can void old-incarnation custody, but it is author-wide eviction and content
discard, not moderator approval. Parent f5b therefore gains no API.

The narrow blocking prerequisite is D.110c-0c1f5b0w: held public issue must
refuse promptly and fail closed, a creator-held entry must not stop an
authenticated close, restart must retain the hold, and the settlement-plan
store must preserve one-way source/disposition safety. A future per-source
resolution API is named D.110c-0c1f5b0x, remains unauthorized and is not a
parent f5b or current Discord/MMORPG continuity prerequisite.
