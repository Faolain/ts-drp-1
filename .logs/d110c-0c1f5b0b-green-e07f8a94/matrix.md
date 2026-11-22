# RED-to-GREEN matrix

| Obligation | Corrective result |
| --- | --- |
| Legacy join/causalJoin delivery and application fold | Profile-aware control classification; legacy application intents retained |
| Settlement join/causalJoin/fence control-only | Settlement profile alone classifies these operations as controls |
| Same-store displaced sequence zero | Surfaced unless it is the authenticated activation digest |
| Cross-object activation exclusion | Categorical sequence-zero exclusion remains cross-object; authenticated activation digest excluded |
| Issued/outbox corruption latch | Cross-read restored under settlement as well as legacy |
| Ambiguous terminal transaction | Terminal intent remains `outcome-unknown` and terminal state latches |
| Malformed settlement plan | Exact detached copy returns typed fail-closed outcome; accessors/extra keys/non-array values never escape |
| Legacy completion semantics | Application-visible causalJoin remains pending; it is not silently retired |

No reservation redesign was introduced because the rejected review's broader
reservation subclaim was disproved by the corrective RED.
