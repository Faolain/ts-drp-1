# Slice 04: Two-Client Room Exchange

Add a dedicated v3 chat artifact rather than relabeling the legacy chat. Two
isolated browser clients consume the same authenticated join bundle with two
pre-authorized P5 identities, join one room, each issue a visible message and
observe both accepted operations in the same order.

The first proof targets Chromium; Firefox and WebKit remain broader gates. The
artifact reports accepted-operation and durable transcript digests, not an
unowned general synchronization claim.
