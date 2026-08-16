# Protocol v3 freeze successor v1

This repository-only ratchet replaces five mutually stale executors with one authority over their fixed union.
It permits one recorded gossip-oracle transition followed by one atomic owner-and-workflow bootstrap, then makes
the resulting owner, workflows, and every legacy semantic identity immutable. Historical checkers remain evidence;
they are never reported as current authority.
