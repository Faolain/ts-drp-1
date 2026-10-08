<task>
Independently review the signed plan amendment described below. You have no
tools; all material facts and relevant excerpts are in this packet. Decide
whether a tests-only RED may implement it without missing a required parent
settlement path. Do not propose production APIs or limit changes.
</task>

<accepted_design>
Parent case 3 must use a real two-intent displaced source, issue multiple real
replacement chunks, crash after one committed chunk, restart in the same epoch
and after an intervening close, preserve the linked prefix, issue the suffix
once, and continue across at least three closes. Tests may not inject a plan,
fence, checkpoint or settlement row. Parent case 14 and the independent wide
gate require genuine room publication, close/adopt, restart and cold reopen.
The 64-writer gate uses one real room, all 64 active writers issuing and being
applied in every epoch across four epochs/three close-adopt transitions, with
offline/rejoining cohorts and exact state, ACL, authority, lineage and operation
accounting. Product limits are 65,536 canonical bytes per application batch and
32,768 canonical bytes per application state.
</accepted_design>

<diagnosis>
The shared parent helper openRoom() currently clones the production chat app
and installs transformDisplacedOperation for every consumer. It replaces each
displaced message text with 33,000 characters. The chat reducer appends the
full text to exact state. One transformed message is about 33,046 canonical
bytes; two replacement intents form a 66,237-byte batch. Thus it creates the
required split but cannot fit the resulting state. The 64-writer final state is
about 210,773 bytes. At 256 transformed characters, its exact 262-message final
state models at 14,303 bytes.
</diagnosis>

<shared_consumers>
The 33,000-byte transform is not local to case 3 or the 64-writer test. The same
openRoom() is used by delayedDependency (case 1), displacedFixture and its
delayed-publication callers (cases 4/15/16/19), ambiguous-outcome callers
(case 25), stale-local-head/rollback paths (case 24), and other settlement
continuations. Several of those apply a transformed chat message and later
close or recover.
</shared_consumers>

<committed_amendment>
Commit f50a4637 says: preserve case 3 with a tests-only transient-payload
blueprint whose two individually valid operations preserve action/identity,
whose pair exceeds the unchanged batch limit, and whose reducer keeps exact
state under the unchanged state ceiling. Separately change the independent
64-writer append-only chat transform from 33,000 to 256 and assert its actual
final state remains under 32,768. It says the focused RED must not fail at a
new state-limit or malformed-blueprint error. It does not explicitly say how
the other shared openRoom consumers stop using the 33,000-byte transform.
</committed_amendment>

<review_questions>

1. Is the transient-payload plan truthful for case 3, or does it manufacture
   settlement state?
2. Does 256 preserve the wide golden-path semantics?
3. Does the omission concerning all other openRoom consumers constitute a
   material P1 before the tests-only RED?
4. State the smallest required correction, if any. Only P0/P1 blocks; P2 is
   nonblocking.
   </review_questions>

<output_contract>
Return exactly one JSON object and no prose/markdown:
{"verdict":"PASS|BLOCK","p0_count":0,"p1_count":0,"p2_count":0,"findings":[{"severity":"P0|P1|P2","title":"...","evidence":"...","required_action":"..."}],"summary":"..."}
Counts must match. PASS requires zero P0 and P1.
</output_contract>
